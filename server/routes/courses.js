/**
 * Courses: the enrollment/roster layer that sits above modules, plus a
 * weighted gradebook computed from existing score data. First pass —
 * see gradebookService.js for what's actually scored today.
 */

const express = require('express');
const { query } = require('../database/connection');
const { requireAuth, requireRoles } = require('../middleware/auth');
const gradebookService = require('../services/gradebookService');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

async function getCourseRow(courseId) {
  const q = isMySQL()
    ? await query('SELECT * FROM courses WHERE id = ?', [courseId])
    : await query('SELECT * FROM courses WHERE id = $1', [courseId]);
  return rowList(q)[0] || null;
}

async function isCourseStaff(courseId, userId) {
  const course = await getCourseRow(courseId);
  if (!course) return false;
  if (Number(course.owner_user_id) === Number(userId)) return true;
  const q = isMySQL()
    ? await query('SELECT id FROM course_staff WHERE course_id = ? AND user_id = ?', [courseId, userId])
    : await query('SELECT id FROM course_staff WHERE course_id = $1 AND user_id = $2', [courseId, userId]);
  return rowList(q).length > 0;
}

async function isCourseStudent(courseId, userId) {
  const q = isMySQL()
    ? await query("SELECT id FROM course_enrollments WHERE course_id = ? AND student_user_id = ? AND status = 'active'", [courseId, userId])
    : await query("SELECT id FROM course_enrollments WHERE course_id = $1 AND student_user_id = $2 AND status = 'active'", [courseId, userId]);
  return rowList(q).length > 0;
}

async function requireCourseStaff(req, res, next) {
  const courseId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(courseId)) return res.status(400).json({ error: 'Invalid course id' });
  if (req.user.role === 'management') return next();
  const allowed = await isCourseStaff(courseId, req.user.id);
  if (!allowed) return res.status(403).json({ error: 'You do not have access to this course' });
  next();
}

async function findUserByEmail(email) {
  const q = isMySQL()
    ? await query('SELECT id, name, email, role FROM users WHERE email = ?', [String(email).trim().toLowerCase()])
    : await query('SELECT id, name, email, role FROM users WHERE email = $1', [String(email).trim().toLowerCase()]);
  return rowList(q)[0] || null;
}

/**
 * Create a course.
 */
router.post('/', requireAuth, requireRoles(['lecturer', 'management']), async (req, res) => {
  try {
    const { name, code, description, term, start_date, end_date } = req.body || {};
    if (!String(name || '').trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const insert = isMySQL()
      ? await query(
          `INSERT INTO courses (organisation_id, name, code, description, term, start_date, end_date, owner_user_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          [req.user.organisation_id || null, name.trim(), code || null, description || null, term || null, start_date || null, end_date || null, req.user.id]
        )
      : await query(
          `INSERT INTO courses (organisation_id, name, code, description, term, start_date, end_date, owner_user_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active') RETURNING id`,
          [req.user.organisation_id || null, name.trim(), code || null, description || null, term || null, start_date || null, end_date || null, req.user.id]
        );
    const courseId = isMySQL() ? insert.insertId : rowList(insert)[0]?.id;
    const course = await getCourseRow(courseId);
    res.json({ success: true, course });
  } catch (error) {
    console.error('Course create error:', error);
    res.status(500).json({ error: 'Failed to create course' });
  }
});

/**
 * List courses visible to the current user: owned, staffed, or enrolled in.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'student') {
      const q = isMySQL()
        ? await query(
            `SELECT c.* FROM courses c
             JOIN course_enrollments ce ON ce.course_id = c.id
             WHERE ce.student_user_id = ? AND ce.status = 'active'
             ORDER BY c.created_at DESC`,
            [req.user.id]
          )
        : await query(
            `SELECT c.* FROM courses c
             JOIN course_enrollments ce ON ce.course_id = c.id
             WHERE ce.student_user_id = $1 AND ce.status = 'active'
             ORDER BY c.created_at DESC`,
            [req.user.id]
          );
      rows = rowList(q);
    } else if (req.user.role === 'management') {
      const q = isMySQL()
        ? await query('SELECT * FROM courses ORDER BY created_at DESC')
        : await query('SELECT * FROM courses ORDER BY created_at DESC');
      rows = rowList(q);
    } else {
      const q = isMySQL()
        ? await query(
            `SELECT DISTINCT c.* FROM courses c
             LEFT JOIN course_staff cs ON cs.course_id = c.id
             WHERE c.owner_user_id = ? OR cs.user_id = ?
             ORDER BY c.created_at DESC`,
            [req.user.id, req.user.id]
          )
        : await query(
            `SELECT DISTINCT c.* FROM courses c
             LEFT JOIN course_staff cs ON cs.course_id = c.id
             WHERE c.owner_user_id = $1 OR cs.user_id = $1
             ORDER BY c.created_at DESC`,
            [req.user.id]
          );
      rows = rowList(q);
    }
    res.json({ success: true, courses: rows });
  } catch (error) {
    console.error('Course list error:', error);
    res.status(500).json({ error: 'Failed to load courses' });
  }
});

/**
 * Get one course, with staff and enrollment count.
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const course = await getCourseRow(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const isStaff = await isCourseStaff(courseId, req.user.id);
    const isStudent = req.user.role === 'student' && (await isCourseStudent(courseId, req.user.id));
    if (req.user.role !== 'management' && !isStaff && !isStudent) {
      return res.status(403).json({ error: 'You do not have access to this course' });
    }

    const staffQ = isMySQL()
      ? await query('SELECT cs.user_id, cs.role, u.name, u.email FROM course_staff cs JOIN users u ON u.id = cs.user_id WHERE cs.course_id = ?', [courseId])
      : await query('SELECT cs.user_id, cs.role, u.name, u.email FROM course_staff cs JOIN users u ON u.id = cs.user_id WHERE cs.course_id = $1', [courseId]);
    const countQ = isMySQL()
      ? await query("SELECT COUNT(*) as count FROM course_enrollments WHERE course_id = ? AND status = 'active'", [courseId])
      : await query("SELECT COUNT(*) as count FROM course_enrollments WHERE course_id = $1 AND status = 'active'", [courseId]);

    // Modules in this course; a student only sees the ones they were given access to.
    const modulesQ = isStudent && !isStaff && req.user.role !== 'management'
      ? (isMySQL()
          ? await query(
              `SELECT m.id, m.name, (SELECT COUNT(*) FROM module_items mi WHERE mi.module_id = m.id) AS item_count
               FROM modules m JOIN module_students ms ON ms.module_id = m.id
               WHERE m.course_id = ? AND ms.student_user_id = ? ORDER BY m.created_at ASC, m.id ASC`,
              [courseId, req.user.id])
          : await query(
              `SELECT m.id, m.name, (SELECT COUNT(*) FROM module_items mi WHERE mi.module_id = m.id) AS item_count
               FROM modules m JOIN module_students ms ON ms.module_id = m.id
               WHERE m.course_id = $1 AND ms.student_user_id = $2 ORDER BY m.created_at ASC, m.id ASC`,
              [courseId, req.user.id]))
      : (isMySQL()
          ? await query(
              `SELECT m.id, m.name, (SELECT COUNT(*) FROM module_items mi WHERE mi.module_id = m.id) AS item_count
               FROM modules m WHERE m.course_id = ? ORDER BY m.created_at ASC, m.id ASC`,
              [courseId])
          : await query(
              `SELECT m.id, m.name, (SELECT COUNT(*) FROM module_items mi WHERE mi.module_id = m.id) AS item_count
               FROM modules m WHERE m.course_id = $1 ORDER BY m.created_at ASC, m.id ASC`,
              [courseId]));

    res.json({
      success: true,
      course,
      staff: rowList(staffQ),
      enrollment_count: Number(rowList(countQ)[0]?.count || 0),
      modules: rowList(modulesQ).map((m) => ({ id: m.id, name: m.name, item_count: Number(m.item_count || 0) })),
    });
  } catch (error) {
    console.error('Course get error:', error);
    res.status(500).json({ error: 'Failed to load course' });
  }
});

/**
 * Update a course.
 */
router.put('/:id', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const { name, code, description, term, start_date, end_date, status } = req.body || {};
    if (isMySQL()) {
      await query(
        `UPDATE courses SET name = COALESCE(?, name), code = ?, description = ?, term = ?, start_date = ?, end_date = ?, status = COALESCE(?, status) WHERE id = ?`,
        [name || null, code || null, description || null, term || null, start_date || null, end_date || null, status || null, courseId]
      );
    } else {
      await query(
        `UPDATE courses SET name = COALESCE($1, name), code = $2, description = $3, term = $4, start_date = $5, end_date = $6, status = COALESCE($7, status) WHERE id = $8`,
        [name || null, code || null, description || null, term || null, start_date || null, end_date || null, status || null, courseId]
      );
    }
    const course = await getCourseRow(courseId);
    res.json({ success: true, course });
  } catch (error) {
    console.error('Course update error:', error);
    res.status(500).json({ error: 'Failed to update course' });
  }
});

/**
 * Delete a course (owner or management only).
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const course = await getCourseRow(courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (req.user.role !== 'management' && Number(course.owner_user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Only the course owner can delete it' });
    }
    if (isMySQL()) {
      await query('DELETE FROM courses WHERE id = ?', [courseId]);
    } else {
      await query('DELETE FROM courses WHERE id = $1', [courseId]);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Course delete error:', error);
    res.status(500).json({ error: 'Failed to delete course' });
  }
});

/**
 * Add a co-lecturer/TA to a course.
 */
router.post('/:id/staff', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const { email, role = 'lecturer' } = req.body || {};
    const user = await findUserByEmail(email || '');
    if (!user) return res.status(404).json({ error: 'No user found with that email' });

    if (isMySQL()) {
      await query('INSERT IGNORE INTO course_staff (course_id, user_id, role) VALUES (?, ?, ?)', [courseId, user.id, role]);
    } else {
      await query('INSERT INTO course_staff (course_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (course_id, user_id) DO NOTHING', [courseId, user.id, role]);
    }
    res.json({ success: true, staff: { user_id: user.id, name: user.name, email: user.email, role } });
  } catch (error) {
    console.error('Course staff add error:', error);
    res.status(500).json({ error: 'Failed to add course staff' });
  }
});

router.delete('/:id/staff/:userId', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const staffUserId = Number.parseInt(req.params.userId, 10);
    if (isMySQL()) {
      await query('DELETE FROM course_staff WHERE course_id = ? AND user_id = ?', [courseId, staffUserId]);
    } else {
      await query('DELETE FROM course_staff WHERE course_id = $1 AND user_id = $2', [courseId, staffUserId]);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Course staff remove error:', error);
    res.status(500).json({ error: 'Failed to remove course staff' });
  }
});

/**
 * List the roster.
 */
router.get('/:id/enrollments', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const q = isMySQL()
      ? await query(
          `SELECT ce.id, ce.student_user_id, ce.status, ce.enrolled_at, u.name, u.email
           FROM course_enrollments ce JOIN users u ON u.id = ce.student_user_id
           WHERE ce.course_id = ? ORDER BY u.name`,
          [courseId]
        )
      : await query(
          `SELECT ce.id, ce.student_user_id, ce.status, ce.enrolled_at, u.name, u.email
           FROM course_enrollments ce JOIN users u ON u.id = ce.student_user_id
           WHERE ce.course_id = $1 ORDER BY u.name`,
          [courseId]
        );
    res.json({ success: true, enrollments: rowList(q) });
  } catch (error) {
    console.error('Enrollment list error:', error);
    res.status(500).json({ error: 'Failed to load roster' });
  }
});

/**
 * Enroll a student by email (creates the enrollment; the student must
 * already have an account). Accepts a single email or an array for bulk
 * enrollment.
 */
router.post('/:id/enrollments', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const emails = Array.isArray(req.body?.emails)
      ? req.body.emails
      : req.body?.email
        ? [req.body.email]
        : [];
    if (emails.length === 0) {
      return res.status(400).json({ error: 'email or emails is required' });
    }

    const results = [];
    for (const email of emails) {
      const user = await findUserByEmail(email);
      if (!user) {
        results.push({ email, success: false, error: 'No account found with this email' });
        continue;
      }
      try {
        if (isMySQL()) {
          await query(
            'INSERT IGNORE INTO course_enrollments (course_id, student_user_id, enrolled_by) VALUES (?, ?, ?)',
            [courseId, user.id, req.user.id]
          );
        } else {
          await query(
            'INSERT INTO course_enrollments (course_id, student_user_id, enrolled_by) VALUES ($1, $2, $3) ON CONFLICT (course_id, student_user_id) DO UPDATE SET status = \'active\'',
            [courseId, user.id, req.user.id]
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
        results.push({ email, success: true, student_user_id: user.id, name: user.name });
      } catch (err) {
        results.push({ email, success: false, error: err.message });
      }
    }
    res.json({ success: true, results });
  } catch (error) {
    console.error('Enrollment create error:', error);
    res.status(500).json({ error: 'Failed to enroll student(s)' });
  }
});

router.delete('/:id/enrollments/:studentUserId', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const studentUserId = Number.parseInt(req.params.studentUserId, 10);
    if (isMySQL()) {
      await query('DELETE FROM course_enrollments WHERE course_id = ? AND student_user_id = ?', [courseId, studentUserId]);
    } else {
      await query('DELETE FROM course_enrollments WHERE course_id = $1 AND student_user_id = $2', [courseId, studentUserId]);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Enrollment remove error:', error);
    res.status(500).json({ error: 'Failed to remove enrollment' });
  }
});

/**
 * Grade categories (weighted buckets, e.g. Assignments 40%).
 */
router.get('/:id/grade-categories', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const categories = await gradebookService.getGradeCategories(Number.parseInt(req.params.id, 10));
    res.json({ success: true, categories });
  } catch (error) {
    console.error('Grade categories list error:', error);
    res.status(500).json({ error: 'Failed to load grade categories' });
  }
});

router.post('/:id/grade-categories', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const { name, weight_percent } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'name is required' });
    const weight = Math.max(0, Math.min(100, Number.parseFloat(weight_percent) || 0));
    const insert = isMySQL()
      ? await query('INSERT INTO grade_categories (course_id, name, weight_percent) VALUES (?, ?, ?)', [courseId, name.trim(), weight])
      : await query('INSERT INTO grade_categories (course_id, name, weight_percent) VALUES ($1, $2, $3) RETURNING id', [courseId, name.trim(), weight]);
    const id = isMySQL() ? insert.insertId : rowList(insert)[0]?.id;
    res.json({ success: true, category: { id, name: name.trim(), weight_percent: weight } });
  } catch (error) {
    console.error('Grade category create error:', error);
    res.status(500).json({ error: 'Failed to create grade category' });
  }
});

router.delete('/:id/grade-categories/:categoryId', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const categoryId = Number.parseInt(req.params.categoryId, 10);
    if (isMySQL()) {
      await query('DELETE FROM grade_categories WHERE id = ?', [categoryId]);
    } else {
      await query('DELETE FROM grade_categories WHERE id = $1', [categoryId]);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Grade category delete error:', error);
    res.status(500).json({ error: 'Failed to delete grade category' });
  }
});

/**
 * Grade items: link an existing gradable thing (currently: a published
 * assessment) into a course + weighted category.
 */
router.get('/:id/grade-items', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const items = await gradebookService.getGradeItems(Number.parseInt(req.params.id, 10));
    res.json({ success: true, items });
  } catch (error) {
    console.error('Grade items list error:', error);
    res.status(500).json({ error: 'Failed to load grade items' });
  }
});

router.post('/:id/grade-items', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const { grade_category_id, item_type, item_id, title, max_points } = req.body || {};
    if (!item_type || !item_id) {
      return res.status(400).json({ error: 'item_type and item_id are required' });
    }
    const insert = isMySQL()
      ? await query(
          'INSERT INTO grade_items (course_id, grade_category_id, item_type, item_id, title, max_points) VALUES (?, ?, ?, ?, ?, ?)',
          [courseId, grade_category_id || null, item_type, item_id, title || null, max_points || null]
        )
      : await query(
          'INSERT INTO grade_items (course_id, grade_category_id, item_type, item_id, title, max_points) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [courseId, grade_category_id || null, item_type, item_id, title || null, max_points || null]
        );
    const id = isMySQL() ? insert.insertId : rowList(insert)[0]?.id;
    res.json({ success: true, item: { id, grade_category_id, item_type, item_id, title, max_points } });
  } catch (error) {
    console.error('Grade item create error:', error);
    res.status(500).json({ error: 'Failed to create grade item' });
  }
});

router.delete('/:id/grade-items/:itemId', requireAuth, requireCourseStaff, async (req, res) => {
  try {
    const itemId = Number.parseInt(req.params.itemId, 10);
    if (isMySQL()) {
      await query('DELETE FROM grade_items WHERE id = ?', [itemId]);
    } else {
      await query('DELETE FROM grade_items WHERE id = $1', [itemId]);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Grade item delete error:', error);
    res.status(500).json({ error: 'Failed to delete grade item' });
  }
});

/**
 * Gradebook: full weighted view for staff, or the requesting student's own
 * row if they're enrolled.
 */
router.get('/:id/gradebook', requireAuth, async (req, res) => {
  try {
    const courseId = Number.parseInt(req.params.id, 10);
    const isStaff = req.user.role === 'management' || (await isCourseStaff(courseId, req.user.id));
    const isStudent = req.user.role === 'student' && (await isCourseStudent(courseId, req.user.id));
    if (!isStaff && !isStudent) {
      return res.status(403).json({ error: 'You do not have access to this course gradebook' });
    }

    const gradebook = await gradebookService.computeGradebook(courseId);
    if (isStudent && !isStaff) {
      const own = gradebook.grades.find((g) => Number(g.student_user_id) === Number(req.user.id));
      return res.json({ success: true, categories: gradebook.categories, items: gradebook.items, grades: own ? [own] : [] });
    }
    res.json({ success: true, ...gradebook });
  } catch (error) {
    console.error('Gradebook error:', error);
    res.status(500).json({ error: 'Failed to compute gradebook' });
  }
});

module.exports = router;
