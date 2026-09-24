/**
 * Computes a weighted gradebook for a course from existing score data.
 * Deliberately does not store computed grades — grade_categories/grade_items
 * are just configuration (which items belong to which weighted bucket); the
 * actual scores are read live from the tables that already own them, so
 * there's no separate ledger that could drift from the real results.
 *
 * First-pass scope: only item_type 'assessment' is actually scored (via
 * assessment_submissions -> marking_results, the one path that already ties
 * a score to a real student_user_id). Other item_types are returned with a
 * null score so the gradebook shape is stable as more types are wired up.
 */

const { query } = require('../database/connection');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

async function getEnrolledStudents(courseId) {
  const q = isMySQL()
    ? await query(
        `SELECT ce.student_user_id, u.name, u.email
         FROM course_enrollments ce
         JOIN users u ON u.id = ce.student_user_id
         WHERE ce.course_id = ? AND ce.status = 'active'
         ORDER BY u.name`,
        [courseId]
      )
    : await query(
        `SELECT ce.student_user_id, u.name, u.email
         FROM course_enrollments ce
         JOIN users u ON u.id = ce.student_user_id
         WHERE ce.course_id = $1 AND ce.status = 'active'
         ORDER BY u.name`,
        [courseId]
      );
  return rowList(q).map((r) => ({ student_user_id: r.student_user_id, name: r.name, email: r.email }));
}

async function getGradeCategories(courseId) {
  const q = isMySQL()
    ? await query('SELECT id, name, weight_percent FROM grade_categories WHERE course_id = ? ORDER BY id', [courseId])
    : await query('SELECT id, name, weight_percent FROM grade_categories WHERE course_id = $1 ORDER BY id', [courseId]);
  return rowList(q).map((r) => ({ id: r.id, name: r.name, weight_percent: Number(r.weight_percent) }));
}

async function getGradeItems(courseId) {
  const q = isMySQL()
    ? await query('SELECT id, grade_category_id, item_type, item_id, title, max_points FROM grade_items WHERE course_id = ? ORDER BY id', [courseId])
    : await query('SELECT id, grade_category_id, item_type, item_id, title, max_points FROM grade_items WHERE course_id = $1 ORDER BY id', [courseId]);
  return rowList(q).map((r) => ({
    id: r.id,
    grade_category_id: r.grade_category_id,
    item_type: r.item_type,
    item_id: r.item_id,
    title: r.title,
    max_points: r.max_points === null ? null : Number(r.max_points),
  }));
}

/**
 * For 'assessment' items, fetch every enrolled student's best/most-recent
 * score against that published assessment.
 * @returns {Map<string, number>} key `${itemId}:${studentUserId}` -> score
 */
async function getAssessmentScores(assessmentGradeItems) {
  const scores = new Map();
  if (assessmentGradeItems.length === 0) return scores;

  const publishedAssessmentIds = assessmentGradeItems.map((item) => item.item_id);
  const placeholders = isMySQL() ? publishedAssessmentIds.map(() => '?').join(',') : publishedAssessmentIds.map((_, i) => `$${i + 1}`).join(',');
  const sql = `
    SELECT s.published_assessment_id, s.student_user_id, mr.total_score
    FROM assessment_submissions s
    JOIN marking_results mr ON mr.id = s.result_id
    WHERE s.published_assessment_id IN (${placeholders})
      AND s.student_user_id IS NOT NULL
      AND s.result_id IS NOT NULL
  `;
  const q = await query(sql, publishedAssessmentIds);
  const rows = rowList(q);

  const itemsByAssessmentId = new Map();
  assessmentGradeItems.forEach((item) => {
    if (!itemsByAssessmentId.has(item.item_id)) itemsByAssessmentId.set(item.item_id, []);
    itemsByAssessmentId.get(item.item_id).push(item);
  });

  rows.forEach((row) => {
    const items = itemsByAssessmentId.get(row.published_assessment_id) || [];
    items.forEach((item) => {
      scores.set(`${item.id}:${row.student_user_id}`, Number(row.total_score));
    });
  });

  return scores;
}

/**
 * Compute the full gradebook for a course.
 */
async function computeGradebook(courseId) {
  const [students, categories, items] = await Promise.all([
    getEnrolledStudents(courseId),
    getGradeCategories(courseId),
    getGradeItems(courseId),
  ]);

  const assessmentItems = items.filter((item) => item.item_type === 'assessment');
  const assessmentScores = await getAssessmentScores(assessmentItems);

  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const grades = students.map((student) => {
    const itemScores = {};
    // percent-score accumulator per category: { sum, count }
    const categoryAccum = new Map();

    items.forEach((item) => {
      let score = null;
      if (item.item_type === 'assessment') {
        const key = `${item.id}:${student.student_user_id}`;
        score = assessmentScores.has(key) ? assessmentScores.get(key) : null;
      }
      itemScores[item.id] = score;

      if (score !== null && item.max_points) {
        const percent = Math.max(0, Math.min(100, (score / item.max_points) * 100));
        const catId = item.grade_category_id;
        if (!categoryAccum.has(catId)) categoryAccum.set(catId, { sum: 0, count: 0 });
        const accum = categoryAccum.get(catId);
        accum.sum += percent;
        accum.count += 1;
      }
    });

    const categoryAverages = {};
    let weightedSum = 0;
    let weightUsed = 0;
    categoryAccum.forEach((accum, catId) => {
      const avg = accum.count > 0 ? accum.sum / accum.count : null;
      categoryAverages[catId] = avg;
      const category = categoryById.get(catId);
      if (avg !== null && category) {
        weightedSum += avg * (category.weight_percent / 100);
        weightUsed += category.weight_percent;
      }
    });

    const finalGradePercent = weightUsed > 0 ? Math.round((weightedSum / (weightUsed / 100)) * 100) / 100 : null;

    return {
      student_user_id: student.student_user_id,
      name: student.name,
      email: student.email,
      item_scores: itemScores,
      category_averages: categoryAverages,
      final_grade_percent: finalGradePercent,
    };
  });

  return { categories, items, grades };
}

module.exports = {
  computeGradebook,
  getEnrolledStudents,
  getGradeCategories,
  getGradeItems,
};
