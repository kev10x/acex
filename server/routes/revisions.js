const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query, rowsOf, firstRow } = require('../database/connection');
const { requireAuth, requireRoles, normalizeRole } = require('../middleware/auth');
const { extractTextFromDocument } = require('../services/documentExtractService');
const { generateMarking, parseMarkingResponsePayload, parseAiJsonResponse } = require('../services/markingService');
const aiConfig = require('../config/ai-config');
const aiService = require('../services/aiService');
const { diffRevisions } = require('../services/revisionDiffService');
const { attachReviewComments } = require('../services/reviewCommentsService');

const router = express.Router();

const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE_BYTES || '50000000') },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.pdf', '.doc', '.docx', '.txt'];
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  }
});

const getInsertId = (result) => {
  if (result?.insertId != null) return result.insertId;
  if (result?.rows?.[0]?.id != null) return result.rows[0].id;
  return null;
};

const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (e) { return fallback; }
};

// The previous revision's feedback, as numbered comments to check against the changes: its
// detailed review comments (treatise, thesis, dissertation), else its per-criterion feedback.
const previousFeedbackItems = (reviewComments, scores) => {
  const review = Array.isArray(reviewComments) ? reviewComments : [];
  if (review.length) {
    return review.slice(0, 80).map((c) => ({
      id: Number(c.id),
      location: [c.section, c.page ? `p. ${c.page}` : null].filter(Boolean).join(', '),
      comment: String(c.comment || '').slice(0, 300),
      quote: c.quote ? String(c.quote).slice(0, 200) : null
    }));
  }
  return (Array.isArray(scores) ? scores : [])
    .filter((s) => s && s.feedback)
    .slice(0, 30)
    .map((s, index) => ({
      id: index + 1,
      location: s.criterion_name || '',
      comment: String(s.feedback).slice(0, 400),
      quote: null
    }));
};

const COMMENT_STATUSES = new Set(['addressed', 'partly_addressed', 'not_addressed']);

const generateRevisionComparison = async (prevText, currText, prevScores, currScores, rubric, previousItems = []) => {
  const config = aiConfig.getConfig('default');
  let criteria = rubric.criteria;
  if (typeof criteria === 'string') {
    try { criteria = JSON.parse(criteria); } catch (e) { criteria = []; }
  }

  const scoreTable = (Array.isArray(criteria) ? criteria : []).map(c => {
    const name = c.name || '';
    const prev = (prevScores || []).find(s => s.criterion_name === name);
    const curr = (currScores || []).find(s => s.criterion_name === name);
    const prevStr = prev ? `${prev.points_awarded}/${prev.max_points}` : '?/?';
    const currStr = curr ? `${curr.points_awarded}/${curr.max_points}` : '?/?';
    return `  - ${name}: ${prevStr} → ${currStr}`;
  }).join('\n');

  const diff = diffRevisions(prevText, currText);
  const changes = {
    mode: diff.mode,
    stats: diff.stats,
    blocks: diff.blocks,
    truncated: Boolean(diff.truncated)
  };

  let diffSection;
  if (diff.mode === 'identical') {
    diffSection = 'NOTE: The two revisions are identical: no sentences were added, removed or changed.';
  } else if (diff.mode === 'diff') {
    diffSection = `CHANGE STATISTICS (by sentence):
- Sentences added: ${diff.stats.added}
- Sentences removed: ${diff.stats.removed}
- Unchanged: ${diff.stats.unchanged} (${diff.stats.change_density}% of sentences changed)

CHANGES (lines starting with + were added, - were removed, other lines are unchanged context; a changed sentence shows as - then +):

${diff.prompt_text}`;
  } else {
    // Substantially rewritten: the sentence diff is still the best evidence, plus the start of the new text.
    const currExcerpt = String(currText || '').slice(0, 30000);
    diffSection = `NOTE: This revision is substantially rewritten (${diff.stats.change_density}% of sentences changed).

CHANGES (+ added, - removed):
${diff.prompt_text}

START OF THE CURRENT REVISION:
${currExcerpt}`;
  }

  const feedbackSection = previousItems.length
    ? `FEEDBACK GIVEN ON THE PREVIOUS REVISION (check each one against the changes):
${previousItems.map((item) => `${item.id}. ${item.location ? `[${item.location}] ` : ''}${item.comment}${item.quote ? ` (on: "${item.quote}")` : ''}`).join('\n')}
`
    : '';

  const prompt = `You are an academic evaluator comparing two revisions of a student submission.

RUBRIC CRITERIA SCORE CHANGES (previous revision → current revision):
${scoreTable || '  (no criteria data available)'}

${feedbackSection}
${diffSection}

Analyze what changed between these two revisions. Be specific: refer to the actual sentences shown above.${previousItems.length ? `
For EVERY numbered feedback item, decide from the changes whether the student addressed it: "addressed", "partly_addressed" or "not_addressed" (when nothing in the changes deals with it). Give a short note saying which change shows it, or what is still missing.` : ''}

Respond with ONLY this JSON (no markdown, no explanation):
{
  "improved_criteria": [{"criterion": "criterion name", "detail": "what specifically improved and how"}],
  "regressed_criteria": [{"criterion": "criterion name", "detail": "what got worse and why"}],
  "unchanged_criteria": [{"criterion": "criterion name", "detail": "still needs work on this specific issue"}],${previousItems.length ? `
  "previous_feedback": [{"id": 1, "status": "addressed|partly_addressed|not_addressed", "note": "short evidence"}],` : ''}
  "narrative_summary": "2-3 sentence overall summary of the revision quality and progress trajectory",
  "key_improvement": "The single most significant improvement made in this revision",
  "key_remaining_issue": "The most important issue still needing attention"
}`;

  const result = await aiService.createCompletionWithRetry({
    provider: config.provider,
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    maxTokens: previousItems.length ? 6000 : 2000
  });

  let parsed;
  try {
    parsed = parseAiJsonResponse(result.content).parsed;
  } catch (e) {
    console.warn('Could not parse comparison JSON:', e.message);
    parsed = {
      improved_criteria: [],
      regressed_criteria: [],
      unchanged_criteria: [],
      narrative_summary: 'Comparison analysis could not be parsed.',
      key_improvement: '',
      key_remaining_issue: ''
    };
  }

  // Keep the original wording of each feedback item next to its status.
  const statuses = new Map((Array.isArray(parsed.previous_feedback) ? parsed.previous_feedback : [])
    .filter((entry) => entry && COMMENT_STATUSES.has(entry.status))
    .map((entry) => [Number(entry.id), entry]));
  const previousFeedback = previousItems.map((item) => ({
    ...item,
    status: statuses.get(item.id)?.status || null,
    note: statuses.get(item.id)?.note ? String(statuses.get(item.id).note).slice(0, 400) : null
  }));

  return {
    improved_criteria: Array.isArray(parsed.improved_criteria) ? parsed.improved_criteria : [],
    regressed_criteria: Array.isArray(parsed.regressed_criteria) ? parsed.regressed_criteria : [],
    unchanged_criteria: Array.isArray(parsed.unchanged_criteria) ? parsed.unchanged_criteria : [],
    narrative_summary: parsed.narrative_summary || '',
    key_improvement: parsed.key_improvement || '',
    key_remaining_issue: parsed.key_remaining_issue || '',
    previous_feedback: previousFeedback,
    changes
  };
};

// Best-effort link to a student's own account, matched by display name
// (case-insensitive), preferring a match in the creator's own organisation.
// Returns null if no confident match is found — the series still works
// as free-text-only in that case.
async function findStudentUserId(studentName, requesterOrgId) {
  const name = String(studentName || '').trim();
  if (!name) return null;
  const rows = rowsOf(await query(
    `SELECT id, organisation_id FROM users WHERE role = 'student' AND LOWER(TRIM(name)) = LOWER(?)`,
    [name]
  ));
  if (rows.length === 0) return null;
  if (requesterOrgId != null) {
    const orgMatch = rows.find((r) => r.organisation_id === requesterOrgId);
    if (orgMatch) return orgMatch.id;
  }
  return rows.length === 1 ? rows[0].id : null;
}

// POST /api/revisions — create a new revision series
router.post('/', requireAuth, requireRoles(['management', 'lecturer']), async (req, res) => {
  try {
    const { name, student_name, rubric_id } = req.body;
    if (!name || !student_name || !rubric_id) {
      return res.status(400).json({ error: 'name, student_name, and rubric_id are required' });
    }

    const rubric = firstRow(await query(
      'SELECT id FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    ));
    if (!rubric) return res.status(404).json({ error: 'Rubric not found' });

    const studentUserId = await findStudentUserId(student_name, req.user.organisation_id);

    const isMySQL = process.env.DATABASE_URL?.startsWith('mysql:');
    let seriesId;
    if (isMySQL) {
      const result = await query(
        'INSERT INTO revision_series (user_id, rubric_id, name, student_name, student_user_id) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, rubric_id, name.trim(), student_name.trim(), studentUserId]
      );
      seriesId = getInsertId(result);
    } else {
      const result = await query(
        'INSERT INTO revision_series (user_id, rubric_id, name, student_name, student_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [req.user.id, rubric_id, name.trim(), student_name.trim(), studentUserId]
      );
      seriesId = result.rows[0].id;
    }

    const series = firstRow(await query(
      'SELECT rs.*, r.name AS rubric_name, r.total_points FROM revision_series rs JOIN rubrics r ON r.id = rs.rubric_id WHERE rs.id = ?',
      [seriesId]
    ));

    res.json({ success: true, series });
  } catch (err) {
    console.error('Error creating revision series:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/revisions/:id/upload — upload a new revision and trigger marking
router.post('/:id/upload', requireAuth, requireRoles(['management', 'lecturer']), upload.single('file'), async (req, res) => {
  const file = req.file;
  try {
    const seriesId = parseInt(req.params.id);
    if (!seriesId) return res.status(400).json({ error: 'Invalid series id' });

    const series = firstRow(await query(
      'SELECT rs.*, r.criteria, r.total_points, r.name AS rubric_name FROM revision_series rs JOIN rubrics r ON r.id = rs.rubric_id WHERE rs.id = ? AND rs.user_id = ?',
      [seriesId, req.user.id]
    ));
    if (!series) {
      if (file) fs.unlink(file.path, () => {});
      return res.status(404).json({ error: 'Revision series not found' });
    }

    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    // Get current revision count to determine next revision number
    const countResult = firstRow(await query(
      'SELECT COUNT(*) AS cnt FROM revision_submissions WHERE series_id = ?',
      [seriesId]
    ));
    const revisionNumber = (parseInt(countResult?.cnt || countResult?.count || 0)) + 1;

    // Store the assignment record
    const isMySQL = process.env.DATABASE_URL?.startsWith('mysql:');
    let assignmentId;
    if (isMySQL) {
      const assignResult = await query(
        'INSERT INTO assignments (filename, file_path, file_size, status, user_id) VALUES (?, ?, ?, ?, ?)',
        [file.originalname, file.path, file.size, 'processing', req.user.id]
      );
      assignmentId = getInsertId(assignResult);
    } else {
      const assignResult = await query(
        'INSERT INTO assignments (filename, file_path, file_size, status, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [file.originalname, file.path, file.size, 'processing', req.user.id]
      );
      assignmentId = assignResult.rows[0].id;
    }

    // Extract text
    let extractedText = '';
    try {
      extractedText = await extractTextFromDocument(file.path, file.originalname);
      await query('UPDATE assignments SET extracted_text = ?, status = ? WHERE id = ?',
        [extractedText, 'completed', assignmentId]);
    } catch (e) {
      console.warn('Text extraction failed:', e.message);
      await query('UPDATE assignments SET status = ? WHERE id = ?', ['completed', assignmentId]);
    }

    // Get rubric object for marking
    const rubricRow = firstRow(await query(
      'SELECT * FROM rubrics WHERE id = ?', [series.rubric_id]
    ));
    if (!rubricRow) {
      return res.status(400).json({ error: 'Rubric no longer exists' });
    }
    let rubricCriteria = rubricRow.criteria;
    if (typeof rubricCriteria === 'string') {
      try { rubricCriteria = JSON.parse(rubricCriteria); } catch (e) { /* keep as-is */ }
    }
    const rubricObj = { ...rubricRow, criteria: rubricCriteria };

    // Run standard marking
    let markingResult;
    try {
      markingResult = await generateMarking(extractedText, rubricObj, null, null, null, 'strict', assignmentId);
    } catch (e) {
      console.error('Marking failed:', e.message);
      return res.status(500).json({ error: `AI marking failed: ${e.message}` });
    }

    // Treatise, thesis or dissertation: detailed comments tied to locations (checked on the next revision).
    await attachReviewComments({ markingResult, text: extractedText, documentType: markingResult.document_type, rubric: rubricObj });

    const totalPoints = parseFloat(series.total_points) || 1;
    const progressScore = Math.min(100, Math.round((markingResult.total_score / totalPoints) * 100 * 10) / 10);

    // Store marking result
    const scoresJson = JSON.stringify(markingResult.scores || []);
    const correctionsJson = JSON.stringify(markingResult.corrections || []);
    let markingResultId;
    if (isMySQL) {
      const mrResult = await query(
        `INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score,
          version, is_current, corrections, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [assignmentId, series.rubric_id, series.student_name, scoresJson,
          markingResult.overall_feedback, markingResult.total_score,
          1, 1, correctionsJson, req.user.id]
      );
      markingResultId = getInsertId(mrResult);
    } else {
      const mrResult = await query(
        `INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score,
          version, is_current, corrections, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [assignmentId, series.rubric_id, series.student_name, scoresJson,
          markingResult.overall_feedback, markingResult.total_score,
          1, true, correctionsJson, req.user.id]
      );
      markingResultId = mrResult.rows[0].id;
    }
    if (markingResult.review_comments?.length && markingResultId) {
      await query('UPDATE marking_results SET review_comments = ? WHERE id = ?', [JSON.stringify(markingResult.review_comments), markingResultId]);
    }

    // If this is revision 2+, run comparison with previous revision
    let comparisonData = null;
    if (revisionNumber > 1) {
      try {
        const prevRevision = firstRow(await query(
          `SELECT rs.*, a.extracted_text, mr.scores AS prev_scores, mr.review_comments AS prev_review_comments
           FROM revision_submissions rs
           JOIN assignments a ON a.id = rs.assignment_id
           LEFT JOIN marking_results mr ON mr.id = rs.marking_result_id
           WHERE rs.series_id = ? ORDER BY rs.revision_number DESC LIMIT 1`,
          [seriesId]
        ));
        if (prevRevision) {
          const prevScores = typeof prevRevision.prev_scores === 'string'
            ? JSON.parse(prevRevision.prev_scores)
            : (prevRevision.prev_scores || []);
          comparisonData = await generateRevisionComparison(
            prevRevision.extracted_text || '',
            extractedText,
            prevScores,
            markingResult.scores,
            rubricObj,
            previousFeedbackItems(parseJson(prevRevision.prev_review_comments, []), prevScores)
          );
        }
      } catch (e) {
        console.warn('Comparison generation failed:', e.message);
      }
    }

    // Store revision submission record
    const comparisonJson = comparisonData ? JSON.stringify(comparisonData) : null;
    let revisionSubmissionId;
    if (isMySQL) {
      const rvResult = await query(
        `INSERT INTO revision_submissions (series_id, revision_number, assignment_id, marking_result_id,
          progress_score, comparison_json) VALUES (?, ?, ?, ?, ?, ?)`,
        [seriesId, revisionNumber, assignmentId, markingResultId, progressScore, comparisonJson]
      );
      revisionSubmissionId = getInsertId(rvResult);
    } else {
      const rvResult = await query(
        `INSERT INTO revision_submissions (series_id, revision_number, assignment_id, marking_result_id,
          progress_score, comparison_json) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [seriesId, revisionNumber, assignmentId, markingResultId, progressScore, comparisonJson]
      );
      revisionSubmissionId = rvResult.rows[0].id;
    }

    res.json({
      success: true,
      revision_number: revisionNumber,
      revision_submission_id: revisionSubmissionId,
      progress_score: progressScore,
      total_score: markingResult.total_score,
      total_points: totalPoints,
      scores: markingResult.scores,
      overall_feedback: markingResult.overall_feedback,
      corrections: markingResult.corrections,
      review_comments: markingResult.review_comments || null,
      comparison: comparisonData
    });
  } catch (err) {
    if (file) fs.unlink(file.path, () => {});
    console.error('Error uploading revision:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/revisions — list revision series. Staff see series they created;
// students see only series linked to their own account (their own uploads).
router.get('/', requireAuth, async (req, res) => {
  try {
    const isStudent = normalizeRole(req.user.role) === 'student';
    const whereClause = isStudent ? 'rs.student_user_id = ?' : 'rs.user_id = ?';
    const rows = rowsOf(await query(
      `SELECT rs.id, rs.name, rs.student_name, rs.created_at,
              r.id AS rubric_id, r.name AS rubric_name, r.total_points,
              COUNT(rv.id) AS revision_count,
              MAX(rv.progress_score) AS latest_progress,
              MAX(rv.uploaded_at) AS last_uploaded
       FROM revision_series rs
       JOIN rubrics r ON r.id = rs.rubric_id
       LEFT JOIN revision_submissions rv ON rv.series_id = rs.id
       WHERE ${whereClause}
       GROUP BY rs.id, rs.name, rs.student_name, rs.created_at, r.id, r.name, r.total_points
       ORDER BY MAX(rv.uploaded_at) DESC, rs.created_at DESC`,
      [req.user.id]
    ));

    // Group by student name
    const byStudent = {};
    for (const row of rows) {
      const key = row.student_name;
      if (!byStudent[key]) byStudent[key] = [];
      byStudent[key].push({
        id: row.id,
        name: row.name,
        rubric_id: row.rubric_id,
        rubric_name: row.rubric_name,
        total_points: row.total_points,
        revision_count: parseInt(row.revision_count || 0),
        latest_progress: parseFloat(row.latest_progress || 0),
        last_uploaded: row.last_uploaded,
        created_at: row.created_at
      });
    }

    res.json({ series: rows, by_student: byStudent });
  } catch (err) {
    console.error('Error listing revision series:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/revisions/:id — get full detail for a single series.
// Staff can view series they created; students can view series linked to
// their own account (read-only — enforced client-side and by the
// staff-only create/upload/delete routes above).
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const seriesId = parseInt(req.params.id);
    const isStudent = normalizeRole(req.user.role) === 'student';
    const whereClause = isStudent ? 'rs.id = ? AND rs.student_user_id = ?' : 'rs.id = ? AND rs.user_id = ?';
    const series = firstRow(await query(
      `SELECT rs.*, r.name AS rubric_name, r.total_points, r.criteria
       FROM revision_series rs JOIN rubrics r ON r.id = rs.rubric_id
       WHERE ${whereClause}`,
      [seriesId, req.user.id]
    ));
    if (!series) return res.status(404).json({ error: 'Series not found' });

    const revisions = rowsOf(await query(
      `SELECT rv.id, rv.revision_number, rv.progress_score, rv.comparison_json, rv.uploaded_at,
              mr.scores, mr.feedback AS overall_feedback, mr.total_score, mr.corrections, mr.review_comments,
              a.filename, a.file_path
       FROM revision_submissions rv
       JOIN assignments a ON a.id = rv.assignment_id
       LEFT JOIN marking_results mr ON mr.id = rv.marking_result_id
       WHERE rv.series_id = ?
       ORDER BY rv.revision_number ASC`,
      [seriesId]
    ));

    const parsedRevisions = revisions.map(r => {
      let scores = r.scores;
      if (typeof scores === 'string') { try { scores = JSON.parse(scores); } catch (e) { scores = []; } }
      let corrections = r.corrections;
      if (typeof corrections === 'string') { try { corrections = JSON.parse(corrections); } catch (e) { corrections = []; } }
      let comparison = r.comparison_json;
      if (typeof comparison === 'string') { try { comparison = JSON.parse(comparison); } catch (e) { comparison = null; } }

      return {
        id: r.id,
        revision_number: r.revision_number,
        progress_score: parseFloat(r.progress_score || 0),
        overall_feedback: r.overall_feedback,
        total_score: parseFloat(r.total_score || 0),
        scores: scores || [],
        corrections: corrections || [],
        review_comments: parseJson(r.review_comments, null),
        comparison,
        filename: r.filename,
        uploaded_at: r.uploaded_at
      };
    });

    let criteria = series.criteria;
    if (typeof criteria === 'string') { try { criteria = JSON.parse(criteria); } catch (e) { criteria = []; } }

    res.json({
      series: {
        id: series.id,
        name: series.name,
        student_name: series.student_name,
        rubric_id: series.rubric_id,
        rubric_name: series.rubric_name,
        total_points: series.total_points,
        criteria,
        created_at: series.created_at
      },
      revisions: parsedRevisions
    });
  } catch (err) {
    console.error('Error fetching revision series:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/revisions/:id — delete a series and all its revisions
router.delete('/:id', requireAuth, requireRoles(['management', 'lecturer']), async (req, res) => {
  try {
    const seriesId = parseInt(req.params.id);
    const series = firstRow(await query(
      'SELECT id FROM revision_series WHERE id = ? AND user_id = ?',
      [seriesId, req.user.id]
    ));
    if (!series) return res.status(404).json({ error: 'Series not found' });

    // Cascade deletes revision_submissions and related assignments
    await query('DELETE FROM revision_series WHERE id = ?', [seriesId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting revision series:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// For tests.
module.exports.generateRevisionComparison = generateRevisionComparison;
module.exports.previousFeedbackItems = previousFeedbackItems;
