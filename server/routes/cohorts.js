/**
 * Cohorts: a reusable group of students (e.g. an intake), independent of any
 * one course. Built so a cohort can be bulk-enrolled into one or more
 * courses, each enrollment tagged with the cohort it came from. See
 * services/enrollmentService.js for the actual enrolment logic.
 */

const express = require('express');
const { query } = require('../database/connection');
const { requireAuth, requireRoles } = require('../middleware/auth');
const accountSetup = require('../services/accountSetupService');
const enrollmentService = require('../services/enrollmentService');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const staffOnly = [requireAuth, requireRoles(['lecturer', 'management'])];

async function getCohortRow(cohortId) {
  const q = isMySQL()
    ? await query('SELECT * FROM cohorts WHERE id = ?', [cohortId])
    : await query('SELECT * FROM cohorts WHERE id = $1', [cohortId]);
  return rowList(q)[0] || null;
}

async function requireCohortAccess(req, res, next) {
  const cohortId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(cohortId)) return res.status(400).json({ error: 'Invalid cohort id' });
  const cohort = await getCohortRow(cohortId);
  if (!cohort) return res.status(404).json({ error: 'Cohort not found' });
  if (req.user.role !== 'management' && Number(cohort.owner_user_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'You do not have access to this cohort' });
  }
  req.cohort = cohort;
  next();
}

const toDateOrNull = (v) => {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * Create a cohort.
 */
router.post('/', ...staffOnly, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 255);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const code = String(req.body?.code || '').trim().slice(0, 64) || null;
    const intakeDate = toDateOrNull(req.body?.intake_date);
    const endDate = toDateOrNull(req.body?.end_date);
    const insert = isMySQL()
      ? await query(
          'INSERT INTO cohorts (organisation_id, name, code, intake_date, end_date, owner_user_id) VALUES (?, ?, ?, ?, ?, ?)',
          [req.user.organisation_id || null, name, code, intakeDate, endDate, req.user.id]
        )
      : await query(
          'INSERT INTO cohorts (organisation_id, name, code, intake_date, end_date, owner_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [req.user.organisation_id || null, name, code, intakeDate, endDate, req.user.id]
        );
    const id = isMySQL() ? insert.insertId : rowList(insert)[0]?.id;
    res.json({ success: true, cohort: await getCohortRow(id) });
  } catch (error) {
    console.error('Create cohort error:', error);
    res.status(500).json({ error: 'Failed to create cohort' });
  }
});

/**
 * List cohorts: management sees every cohort in the organisation,
 * everyone else sees their own.
 */
router.get('/', ...staffOnly, async (req, res) => {
  try {
    const scoped = req.user.role === 'management';
    const countsSub = `(SELECT COUNT(*) FROM cohort_members cm WHERE cm.cohort_id = c.id)`;
    const q = scoped
      ? isMySQL()
        ? await query(`SELECT c.*, ${countsSub} AS member_count FROM cohorts c WHERE c.organisation_id = ? OR c.owner_user_id = ? ORDER BY c.created_at DESC`, [req.user.organisation_id || 0, req.user.id])
        : await query(`SELECT c.*, ${countsSub} AS member_count FROM cohorts c WHERE c.organisation_id = $1 OR c.owner_user_id = $2 ORDER BY c.created_at DESC`, [req.user.organisation_id || 0, req.user.id])
      : isMySQL()
        ? await query(`SELECT c.*, ${countsSub} AS member_count FROM cohorts c WHERE c.owner_user_id = ? ORDER BY c.created_at DESC`, [req.user.id])
        : await query(`SELECT c.*, ${countsSub} AS member_count FROM cohorts c WHERE c.owner_user_id = $1 ORDER BY c.created_at DESC`, [req.user.id]);
    res.json({ success: true, cohorts: rowList(q).map((c) => ({ ...c, member_count: Number(c.member_count) || 0 })) });
  } catch (error) {
    console.error('List cohorts error:', error);
    res.status(500).json({ error: 'Failed to list cohorts' });
  }
});

/**
 * Cohort detail: members, and which courses it has been enrolled into.
 */
router.get('/:id', ...staffOnly, requireCohortAccess, async (req, res) => {
  try {
    const cohortId = req.cohort.id;
    const membersQ = isMySQL()
      ? await query(
          `SELECT u.id, u.name, u.email, cm.added_at FROM cohort_members cm
           INNER JOIN users u ON u.id = cm.student_user_id WHERE cm.cohort_id = ? ORDER BY u.name ASC, u.email ASC`,
          [cohortId]
        )
      : await query(
          `SELECT u.id, u.name, u.email, cm.added_at FROM cohort_members cm
           INNER JOIN users u ON u.id = cm.student_user_id WHERE cm.cohort_id = $1 ORDER BY u.name ASC, u.email ASC`,
          [cohortId]
        );
    const coursesQ = isMySQL()
      ? await query(
          `SELECT DISTINCT c.id, c.name, c.code FROM course_enrollments ce
           INNER JOIN courses c ON c.id = ce.course_id WHERE ce.cohort_id = ?`,
          [cohortId]
        )
      : await query(
          `SELECT DISTINCT c.id, c.name, c.code FROM course_enrollments ce
           INNER JOIN courses c ON c.id = ce.course_id WHERE ce.cohort_id = $1`,
          [cohortId]
        );
    res.json({ success: true, cohort: req.cohort, members: rowList(membersQ), courses: rowList(coursesQ) });
  } catch (error) {
    console.error('Get cohort error:', error);
    res.status(500).json({ error: 'Failed to load cohort' });
  }
});

router.put('/:id', ...staffOnly, requireCohortAccess, async (req, res) => {
  try {
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 255) : req.cohort.name;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const code = req.body?.code !== undefined ? (String(req.body.code).trim().slice(0, 64) || null) : req.cohort.code;
    const intakeDate = req.body?.intake_date !== undefined ? toDateOrNull(req.body.intake_date) : req.cohort.intake_date;
    const endDate = req.body?.end_date !== undefined ? toDateOrNull(req.body.end_date) : req.cohort.end_date;
    const status = ['active', 'archived'].includes(req.body?.status) ? req.body.status : req.cohort.status;
    if (isMySQL()) {
      await query('UPDATE cohorts SET name = ?, code = ?, intake_date = ?, end_date = ?, status = ? WHERE id = ?', [name, code, intakeDate, endDate, status, req.cohort.id]);
    } else {
      await query('UPDATE cohorts SET name = $1, code = $2, intake_date = $3, end_date = $4, status = $5 WHERE id = $6', [name, code, intakeDate, endDate, status, req.cohort.id]);
    }
    res.json({ success: true, cohort: await getCohortRow(req.cohort.id) });
  } catch (error) {
    console.error('Update cohort error:', error);
    res.status(500).json({ error: 'Failed to update cohort' });
  }
});

router.delete('/:id', ...staffOnly, requireCohortAccess, async (req, res) => {
  try {
    if (isMySQL()) await query('DELETE FROM cohorts WHERE id = ?', [req.cohort.id]);
    else await query('DELETE FROM cohorts WHERE id = $1', [req.cohort.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete cohort error:', error);
    res.status(500).json({ error: 'Failed to delete cohort' });
  }
});

/**
 * Add students to the cohort's roster by email (does not enrol them in any
 * course). An account is created and invited for anyone who does not have one.
 */
router.post('/:id/members', ...staffOnly, requireCohortAccess, async (req, res) => {
  try {
    const emails = Array.isArray(req.body?.emails) ? req.body.emails : [];
    if (emails.length === 0) return res.status(400).json({ error: 'emails is required' });
    const results = [];
    for (const rawEmail of emails.slice(0, 500)) {
      const email = String(rawEmail || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        results.push({ email: rawEmail, success: false, error: 'Not a valid email address' });
        continue;
      }
      try {
        let user = await enrollmentService.findUserByEmail(email);
        if (!user) user = await accountSetup.createInvitedStudent({ email, organisationId: req.user.organisation_id });
        if (String(user.role || '').toLowerCase() !== 'student') {
          results.push({ email, success: false, error: 'This account is not a student account' });
          continue;
        }
        if (isMySQL()) {
          await query('INSERT IGNORE INTO cohort_members (cohort_id, student_user_id) VALUES (?, ?)', [req.cohort.id, user.id]);
        } else {
          await query('INSERT INTO cohort_members (cohort_id, student_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.cohort.id, user.id]);
        }
        results.push({ email, success: true, student_user_id: user.id, name: user.name });
      } catch (err) {
        results.push({ email, success: false, error: err.message });
      }
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Add cohort members error:', error);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

router.delete('/:id/members/:studentUserId', ...staffOnly, requireCohortAccess, async (req, res) => {
  try {
    const studentUserId = Number.parseInt(req.params.studentUserId, 10);
    if (isMySQL()) await query('DELETE FROM cohort_members WHERE cohort_id = ? AND student_user_id = ?', [req.cohort.id, studentUserId]);
    else await query('DELETE FROM cohort_members WHERE cohort_id = $1 AND student_user_id = $2', [req.cohort.id, studentUserId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Remove cohort member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

/**
 * Enrol every current member of the cohort into a course in one go. Each
 * resulting enrollment is tagged with this cohort.
 */
router.post('/:id/enrol-course', ...staffOnly, requireCohortAccess, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.body?.course_id, 10);
    if (!Number.isFinite(courseId)) return res.status(400).json({ error: 'course_id is required' });
    const courseQ = isMySQL()
      ? await query('SELECT id, owner_user_id FROM courses WHERE id = ?', [courseId])
      : await query('SELECT id, owner_user_id FROM courses WHERE id = $1', [courseId]);
    const course = rowList(courseQ)[0];
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (req.user.role !== 'management' && Number(course.owner_user_id) !== Number(req.user.id)) {
      const staffQ = isMySQL()
        ? await query('SELECT id FROM course_staff WHERE course_id = ? AND user_id = ?', [courseId, req.user.id])
        : await query('SELECT id FROM course_staff WHERE course_id = $1 AND user_id = $2', [courseId, req.user.id]);
      if (rowList(staffQ).length === 0) return res.status(403).json({ error: 'You do not have access to that course' });
    }

    const membersQ = isMySQL()
      ? await query(`SELECT u.email FROM cohort_members cm INNER JOIN users u ON u.id = cm.student_user_id WHERE cm.cohort_id = ?`, [req.cohort.id])
      : await query(`SELECT u.email FROM cohort_members cm INNER JOIN users u ON u.id = cm.student_user_id WHERE cm.cohort_id = $1`, [req.cohort.id]);
    const emails = rowList(membersQ).map((r) => r.email);
    if (emails.length === 0) return res.status(400).json({ error: 'This cohort has no members yet' });

    const results = await enrollmentService.enrollEmailsInCourse(courseId, emails, {
      enrolledByUserId: req.user.id,
      organisationId: req.user.organisation_id,
      inviterName: req.user.name || req.user.email || null,
      cohortId: req.cohort.id,
    });
    res.json({ success: true, results });
  } catch (error) {
    console.error('Cohort course enrolment error:', error);
    res.status(500).json({ error: 'Failed to enrol the cohort' });
  }
});

module.exports = router;
