/**
 * POPIA support: consent record, data-subject export, erasure requests.
 * Kept self-contained (own schema check, own routes) so it is not overwritten
 * when shared server files are synced from markmateio.
 */

const { query } = require('../database/connection');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

// Bump when the privacy notice changes materially; users are asked to accept again.
const POLICY_VERSION = '2026-09-24';

async function ensureColumn(table, column, mysqlDef, pgDef) {
  const check = isMySQL()
    ? await query(
        `SELECT COUNT(*) as count FROM information_schema.COLUMNS
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column])
    : await query(
        `SELECT COUNT(*) as count FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column]);
  const count = Number(rowList(check)[0]?.count || 0);
  if (count === 0) await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${isMySQL() ? mysqlDef : pgDef}`);
}

async function ensureSchema() {
  await ensureColumn('users', 'privacy_accepted_at', 'TIMESTAMP NULL', 'TIMESTAMP NULL');
  await ensureColumn('users', 'privacy_policy_version', 'VARCHAR(20) NULL', 'VARCHAR(20) NULL');
}

async function getStatus(userId) {
  const q = isMySQL()
    ? await query('SELECT privacy_accepted_at, privacy_policy_version FROM users WHERE id = ?', [userId])
    : await query('SELECT privacy_accepted_at, privacy_policy_version FROM users WHERE id = $1', [userId]);
  const row = rowList(q)[0] || {};
  return {
    current_version: POLICY_VERSION,
    accepted_at: row.privacy_accepted_at || null,
    accepted_version: row.privacy_policy_version || null,
    needs_acceptance: row.privacy_policy_version !== POLICY_VERSION,
  };
}

async function recordAcceptance(userId) {
  if (isMySQL()) await query('UPDATE users SET privacy_accepted_at = NOW(), privacy_policy_version = ? WHERE id = ?', [POLICY_VERSION, userId]);
  else await query('UPDATE users SET privacy_accepted_at = NOW(), privacy_policy_version = $1 WHERE id = $2', [POLICY_VERSION, userId]);
}

// Run one lookup for the export; a missing/renamed table must not break the whole export.
async function safeRows(label, sqlMy, sqlPg, params) {
  try {
    const q = isMySQL() ? await query(sqlMy, params) : await query(sqlPg, params);
    return rowList(q);
  } catch (err) {
    console.warn(`[privacy] export section "${label}" skipped:`, err?.message || err);
    return [];
  }
}

/** Everything the platform holds about this person, as a JSON-serialisable object. */
async function collectUserData(userId) {
  const one = (sql, sqlPg = sql) => [sql, sqlPg, [userId]];
  const profile = await safeRows('profile',
    ...one('SELECT id, email, name, role, account_type, organisation_id, department_id, email_verified, is_approved, created_at, last_login, privacy_accepted_at, privacy_policy_version FROM users WHERE id = ?',
           'SELECT id, email, name, role, account_type, organisation_id, department_id, email_verified, is_approved, created_at, last_login, privacy_accepted_at, privacy_policy_version FROM users WHERE id = $1'));
  const email = profile[0]?.email || '';
  const name = profile[0]?.name || '';

  const enrollments = await safeRows('enrollments',
    ...one(`SELECT ce.course_id, c.name AS course_name, ce.status, ce.created_at FROM course_enrollments ce LEFT JOIN courses c ON c.id = ce.course_id WHERE ce.student_user_id = ?`,
           `SELECT ce.course_id, c.name AS course_name, ce.status, ce.created_at FROM course_enrollments ce LEFT JOIN courses c ON c.id = ce.course_id WHERE ce.student_user_id = $1`));
  const modules = await safeRows('modules',
    ...one(`SELECT m.id, m.name FROM module_students ms INNER JOIN modules m ON m.id = ms.module_id WHERE ms.student_user_id = ?`,
           `SELECT m.id, m.name FROM module_students ms INNER JOIN modules m ON m.id = ms.module_id WHERE ms.student_user_id = $1`));
  const submissions = await safeRows('submissions',
    ...one(`SELECT s.id, s.submission_code, s.status, s.submitted_at, s.completed_at, s.student_name,
                   mr.total_score, mr.feedback, mr.scores, mr.marked_at
            FROM assessment_submissions s
            LEFT JOIN marking_results mr ON mr.id = s.result_id
            WHERE s.student_user_id = ?`,
           `SELECT s.id, s.submission_code, s.status, s.submitted_at, s.completed_at, s.student_name,
                   mr.total_score, mr.feedback, mr.scores, mr.marked_at
            FROM assessment_submissions s
            LEFT JOIN marking_results mr ON mr.id = s.result_id
            WHERE s.student_user_id = $1`));
  const lessonProgress = await safeRows('lesson_progress',
    `SELECT published_content_id, student_name, current_section, completed, score, updated_at FROM content_progress
     WHERE LOWER(TRIM(student_name)) IN (?, ?)`,
    `SELECT published_content_id, student_name, current_section, completed, score, updated_at FROM content_progress
     WHERE LOWER(TRIM(student_name)) IN ($1, $2)`,
    [String(email).toLowerCase().trim(), String(name).toLowerCase().trim()]);
  const revisions = await safeRows('revision_submissions',
    ...one(`SELECT id, name, student_name, created_at FROM revision_series WHERE student_user_id = ?`,
           `SELECT id, name, student_name, created_at FROM revision_series WHERE student_user_id = $1`));
  const sessions = await safeRows('sessions',
    ...one(`SELECT ip_address, user_agent, logged_in_at, last_seen_at FROM user_sessions WHERE user_id = ? ORDER BY logged_in_at DESC LIMIT 200`,
           `SELECT ip_address, user_agent, logged_in_at, last_seen_at FROM user_sessions WHERE user_id = $1 ORDER BY logged_in_at DESC LIMIT 200`));
  const activity = await safeRows('activity',
    `SELECT category, action, outcome, created_at FROM audit_events WHERE user_id = ? OR target_user_id = ? ORDER BY created_at DESC LIMIT 500`,
    `SELECT category, action, outcome, created_at FROM audit_events WHERE user_id = $1 OR target_user_id = $1 ORDER BY created_at DESC LIMIT 500`,
    isMySQL() ? [userId, userId] : [userId]);

  return {
    generated_at: new Date().toISOString(),
    policy_version: POLICY_VERSION,
    note: 'Password hashes and security tokens are never included. Marks and feedback are included where they belong to you.',
    profile: profile[0] || null,
    course_enrollments: enrollments,
    modules,
    assessment_submissions: submissions,
    lesson_progress: lessonProgress,
    revision_series: revisions,
    login_sessions: sessions,
    activity_log: activity,
  };
}

module.exports = { POLICY_VERSION, ensureSchema, getStatus, recordAcceptance, collectUserData };
