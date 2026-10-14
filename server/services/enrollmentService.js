/**
 * Enrolling a student (by email) into a course: creates an invited account if
 * needed, inserts the enrollment, gives access to the course's modules, and
 * sends the enrolment email. Shared by the course enrollment route and
 * cohort enrolment (routes/cohorts.js), so both stay consistent.
 */

const { query } = require('../database/connection');
const emailService = require('./emailService');
const accountSetup = require('./accountSetupService');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

async function getCourseRow(courseId) {
  const q = isMySQL()
    ? await query('SELECT * FROM courses WHERE id = ?', [courseId])
    : await query('SELECT * FROM courses WHERE id = $1', [courseId]);
  return rowList(q)[0] || null;
}

async function findUserByEmail(email) {
  const q = isMySQL()
    ? await query('SELECT id, name, email, role FROM users WHERE email = ?', [String(email).trim().toLowerCase()])
    : await query('SELECT id, name, email, role FROM users WHERE email = $1', [String(email).trim().toLowerCase()]);
  return rowList(q)[0] || null;
}

async function hasPendingSetup(userId) {
  const q = isMySQL()
    ? await query("SELECT id FROM users WHERE id = ? AND setup_token_purpose = 'invite'", [userId])
    : await query("SELECT id FROM users WHERE id = $1 AND setup_token_purpose = 'invite'", [userId]);
  return rowList(q).length > 0;
}

/**
 * Enrol a list of email addresses into a course. Returns one result per
 * email: { email, success, student_user_id?, name?, invited?, email_sent?, error? }.
 * `cohortId` (optional) is recorded against each enrollment it creates, so
 * courses can see which intake group each student came from.
 */
async function enrollEmailsInCourse(courseId, emails, { enrolledByUserId, organisationId, inviterName, cohortId = null } = {}) {
  const course = await getCourseRow(courseId);
  const loginUrl = `${accountSetup.getAppUrl()}/`;
  const results = [];

  for (const rawEmail of emails) {
    const email = String(rawEmail || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.push({ email: rawEmail, success: false, error: 'Not a valid email address' });
      continue;
    }
    try {
      let user = await findUserByEmail(email);
      let invited = false;
      if (!user) {
        user = await accountSetup.createInvitedStudent({ email, organisationId });
        invited = true;
      }
      if (String(user.role || '').toLowerCase() !== 'student') {
        results.push({ email, success: false, error: 'This account is not a student account' });
        continue;
      }

      if (isMySQL()) {
        await query(
          'INSERT INTO course_enrollments (course_id, student_user_id, enrolled_by, cohort_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = \'active\', cohort_id = COALESCE(cohort_id, VALUES(cohort_id))',
          [courseId, user.id, enrolledByUserId, cohortId]
        );
      } else {
        await query(
          `INSERT INTO course_enrollments (course_id, student_user_id, enrolled_by, cohort_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (course_id, student_user_id) DO UPDATE SET status = 'active', cohort_id = COALESCE(course_enrollments.cohort_id, EXCLUDED.cohort_id)`,
          [courseId, user.id, enrolledByUserId, cohortId]
        );
      }
      // Enrolling in a course gives access to each of its modules.
      if (isMySQL()) {
        await query(
          `INSERT IGNORE INTO module_students (module_id, student_user_id)
           SELECT id, ? FROM modules WHERE course_id = ?`,
          [user.id, courseId]
        );
      } else {
        await query(
          `INSERT INTO module_students (module_id, student_user_id)
           SELECT id, $1 FROM modules WHERE course_id = $2
           ON CONFLICT DO NOTHING`,
          [user.id, courseId]
        );
      }

      let emailSent = false;
      try {
        const pending = invited || (await hasPendingSetup(user.id));
        const setupUrl = pending
          ? `${accountSetup.getAppUrl()}/setup-account?token=${await accountSetup.issueSetupToken(user.id, 'invite')}`
          : null;
        await emailService.sendEnrolmentEmail({
          email: user.email,
          name: user.name,
          courseName: course?.name || 'your course',
          courseCode: course?.code || '',
          invitedBy: inviterName,
          setupUrl,
          loginUrl,
        });
        emailSent = true;
      } catch (mailError) {
        console.error('Enrolment email failed:', mailError.message);
      }
      results.push({ email, success: true, student_user_id: user.id, name: user.name, invited, email_sent: emailSent });
    } catch (err) {
      results.push({ email, success: false, error: err.message });
    }
  }
  return results;
}

module.exports = { enrollEmailsInCourse, getCourseRow, findUserByEmail, hasPendingSetup };
