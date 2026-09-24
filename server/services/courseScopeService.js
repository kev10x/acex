/**
 * Filing published content/assessments under a course, so each course has its own library.
 */

const { query } = require('../database/connection');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

async function userCanUseCourse(user, courseId) {
  if (!Number.isFinite(courseId) || courseId <= 0) return false;
  const courseQ = isMySQL()
    ? await query('SELECT id, owner_user_id FROM courses WHERE id = ?', [courseId])
    : await query('SELECT id, owner_user_id FROM courses WHERE id = $1', [courseId]);
  const course = rowList(courseQ)[0];
  if (!course) return false;
  if (String(user.role || '').toLowerCase() === 'management') return true;
  if (Number(course.owner_user_id) === Number(user.id)) return true;
  const staffQ = isMySQL()
    ? await query('SELECT id FROM course_staff WHERE course_id = ? AND user_id = ?', [courseId, user.id])
    : await query('SELECT id FROM course_staff WHERE course_id = $1 AND user_id = $2', [courseId, user.id]);
  return rowList(staffQ).length > 0;
}

/**
 * Read an optional course_id from a request body. Returns { provided, courseId }
 * (courseId null means "no course"); throws an Error with .status = 403 when the
 * user has no access to the course.
 */
async function parseRequestedCourse(user, raw) {
  if (raw === undefined) return { provided: false, courseId: null };
  if (raw === null || raw === '' || raw === 'none') return { provided: true, courseId: null };
  const courseId = Number(raw);
  if (!Number.isFinite(courseId) || courseId <= 0) return { provided: true, courseId: null };
  if (!(await userCanUseCourse(user, courseId))) {
    const err = new Error('You do not have access to that course');
    err.status = 403;
    throw err;
  }
  return { provided: true, courseId };
}

async function courseIdOfModule(moduleId) {
  if (!moduleId) return null;
  const q = isMySQL()
    ? await query('SELECT course_id FROM modules WHERE id = ?', [moduleId])
    : await query('SELECT course_id FROM modules WHERE id = $1', [moduleId]);
  const id = rowList(q)[0]?.course_id;
  return id ? Number(id) : null;
}

const TABLES = { content: 'published_content', assessment: 'published_assessments' };

async function setItemCourse(kind, itemId, courseId) {
  const table = TABLES[kind];
  if (!table || !itemId) return;
  if (isMySQL()) await query(`UPDATE ${table} SET course_id = ? WHERE id = ?`, [courseId, itemId]);
  else await query(`UPDATE ${table} SET course_id = $1 WHERE id = $2`, [courseId, itemId]);
}

// An explicit course wins; otherwise the item inherits its module's course.
async function fileItemUnderCourse(kind, itemId, requested, moduleId) {
  const courseId = requested.provided ? requested.courseId : await courseIdOfModule(moduleId);
  if (courseId || requested.provided) await setItemCourse(kind, itemId, courseId);
  return courseId;
}

module.exports = { userCanUseCourse, parseRequestedCourse, courseIdOfModule, setItemCourse, fileItemUnderCourse };
