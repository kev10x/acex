const express = require('express');
const path = require('path');
const fs = require('fs');
const { query } = require('../database/connection');
const { requireAuth, requireFeature, requireRoles } = require('../middleware/auth');
const feedbackVideoService = require('../services/feedbackVideoService');
const {
  inferGenerationErrorType,
  logGenerationTelemetry,
  persistGenerationTelemetryEvent,
} = require('../services/generationTelemetryService');
const { createGenerationJob, updateGenerationJob, JOB_STATUS } = require('../services/generationJobService');

const router = express.Router();
const SUPER_ADMIN_EMAIL = 'kkativu@gmail.com';

const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const normalizeRole = (role) => {
  const r = String(role || '').toLowerCase();
  if (r === 'admin') return 'management';
  if (r === 'user') return 'lecturer';
  return r || 'lecturer';
};
const isSuperAdmin = (user) => String(user?.email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL;
const getStudentIdentityKeys = (user) => {
  const keys = [];
  const name = String(user?.name || '').trim().toLowerCase();
  const email = String(user?.email || '').trim().toLowerCase();
  const emailLocal = email.includes('@') ? email.split('@')[0] : email;
  if (name) keys.push(name);
  if (email) keys.push(email);
  if (emailLocal) keys.push(emailLocal);
  return Array.from(new Set(keys));
};

const rubricNameSelect = `COALESCE(r.name, 'MCQ Assessment')`;
const reviewStatusSelect = `
  CASE
    WHEN COALESCE(m.flagged_for_moderation, 0) = 1 THEN 'queued'
    WHEN (m.custom_feedback IS NOT NULL AND TRIM(m.custom_feedback) != '')
      OR m.override_total_score IS NOT NULL
      OR (m.moderation_reason IS NOT NULL AND TRIM(m.moderation_reason) != '')
    THEN 'reviewed'
    WHEN COALESCE(mr.needs_review, 0) = 1 OR COALESCE(mr.has_low_criterion_confidence, 0) = 1 THEN 'queued'
    ELSE 'none'
  END
`;

function mapResultRow(row) {
  const plain = row && typeof row === 'object' ? JSON.parse(JSON.stringify(row)) : {};
  let scores = plain.scores;
  if (typeof scores === 'string') {
    try {
      scores = JSON.parse(scores);
    } catch (_) {
      scores = [];
    }
  }
  if (!Array.isArray(scores)) scores = [];
  let corrections = plain.corrections;
  if (corrections != null && typeof corrections === 'string') {
    try {
      corrections = JSON.parse(corrections);
    } catch (_) {
      corrections = [];
    }
  }
  if (!Array.isArray(corrections)) corrections = [];
  let language_errors = plain.language_errors;
  if (language_errors != null && typeof language_errors === 'string') {
    try {
      language_errors = JSON.parse(language_errors);
    } catch (_) {
      language_errors = [];
    }
  }
  if (!Array.isArray(language_errors)) language_errors = [];
  const review_reasons = [];
  const flagged = plain.flagged_for_moderation === true || plain.flagged_for_moderation === 1;
  const needsReview = plain.needs_review === true || plain.needs_review === 1;
  const lowConfidence = plain.has_low_criterion_confidence === true || plain.has_low_criterion_confidence === 1;
  if (flagged) review_reasons.push('moderation_flag');
  if (needsReview) review_reasons.push('low_overall_confidence');
  if (lowConfidence) review_reasons.push('low_criterion_confidence');
  const moderationNote = plain.moderation_reason != null ? String(plain.moderation_reason).trim() : '';
  if (moderationNote) review_reasons.push('lecturer_note');
  if (plain.custom_feedback != null && String(plain.custom_feedback).trim()) review_reasons.push('feedback_override');
  if (plain.override_total_score != null) review_reasons.push('score_override');
  const review_status = plain.review_status || (
    flagged || needsReview || lowConfidence
      ? 'queued'
      : (plain.custom_feedback != null || plain.override_total_score != null || moderationNote ? 'reviewed' : 'none')
  );
  return {
    ...plain,
    scores,
    corrections,
    language_errors,
    flagged_for_moderation: flagged,
    needs_review: needsReview,
    has_low_criterion_confidence: lowConfidence,
    moderation_reason: plain.moderation_reason || null,
    moderation_updated_by: plain.moderation_updated_by != null ? Number(plain.moderation_updated_by) : null,
    moderation_updated_by_name: plain.moderation_updated_by_name || null,
    moderation_updated_by_email: plain.moderation_updated_by_email || null,
    moderation_updated_at: plain.moderation_updated_at || null,
    custom_feedback: plain.custom_feedback || null,
    override_total_score: plain.override_total_score != null ? Number(plain.override_total_score) : null,
    effective_feedback: plain.custom_feedback != null && String(plain.custom_feedback).trim().length > 0 ? String(plain.custom_feedback) : (plain.feedback != null ? String(plain.feedback) : ''),
    effective_total_score: plain.override_total_score != null ? Number(plain.override_total_score) : Number(plain.total_score),
    feedback: plain.feedback != null ? String(plain.feedback) : '',
    estimated_cost_usd: plain.estimated_cost_usd != null ? Number(plain.estimated_cost_usd) : null,
    prompt_tokens: plain.prompt_tokens != null ? Number(plain.prompt_tokens) : null,
    completion_tokens: plain.completion_tokens != null ? Number(plain.completion_tokens) : null,
    total_tokens: plain.total_tokens != null ? Number(plain.total_tokens) : null,
    review_status,
    review_reasons
  };
}

// Get all marking results
router.get('/', requireAuth, async (req, res) => {
  try {
    const role = normalizeRole(req.user.role);
    let result;
    if (role === 'student') {
      const keys = getStudentIdentityKeys(req.user);
      if (keys.length === 0) {
        return res.json({ success: true, results: [] });
      }
      const placeholders = keys.map(() => '?').join(',');
      result = await query(
        `SELECT 
          mr.*,
          a.filename,
          a.file_path,
          a.uploaded_at,
          b.name as folder_name,
          ${rubricNameSelect} as rubric_name,
          r.total_points as max_points,
          m.flagged_for_moderation,
          m.moderation_reason,
          m.custom_feedback,
          m.override_total_score,
          m.updated_by_user_id as moderation_updated_by,
          m.updated_at as moderation_updated_at,
          reviewer.name as moderation_updated_by_name,
          reviewer.email as moderation_updated_by_email
        FROM marking_results mr
        JOIN assignments a ON mr.assignment_id = a.id
        JOIN users owner ON owner.id = mr.user_id
        LEFT JOIN batches b ON a.batch_id = b.id
        LEFT JOIN rubrics r ON mr.rubric_id = r.id
        LEFT JOIN marking_result_moderation m ON m.result_id = mr.id
        LEFT JOIN users reviewer ON reviewer.id = m.updated_by_user_id
        WHERE LOWER(TRIM(COALESCE(mr.student_name, ''))) IN (${placeholders})
          AND (
            (? IS NULL AND owner.organisation_id IS NULL)
            OR owner.organisation_id = ?
          )
        ORDER BY mr.marked_at DESC`,
        [...keys, req.user.organisation_id || null, req.user.organisation_id || null]
      );
    } else {
      result = await query(
        `SELECT 
          mr.*,
          a.filename,
          a.file_path,
          a.uploaded_at,
          b.name as folder_name,
          ${rubricNameSelect} as rubric_name,
          r.total_points as max_points,
          m.flagged_for_moderation,
          m.moderation_reason,
          m.custom_feedback,
          m.override_total_score,
          m.updated_by_user_id as moderation_updated_by,
          m.updated_at as moderation_updated_at,
          reviewer.name as moderation_updated_by_name,
          reviewer.email as moderation_updated_by_email
        FROM marking_results mr
        JOIN assignments a ON mr.assignment_id = a.id
        LEFT JOIN batches b ON a.batch_id = b.id
        LEFT JOIN rubrics r ON mr.rubric_id = r.id
        LEFT JOIN marking_result_moderation m ON m.result_id = mr.id
        LEFT JOIN users reviewer ON reviewer.id = m.updated_by_user_id
        WHERE mr.user_id = ?
        ORDER BY mr.marked_at DESC`,
        [req.user.id]
      );
    }
    
    // Convert rows to plain objects (MySQL RowDataPacket doesn't always spread correctly) and parse JSON/numeric fields
    const parsedResults = rowsOf(result).map(mapResultRow);
    
    res.json({
      success: true,
      results: parsedResults
	});
	} catch (error) {
    console.error('Get results error:', error);
    res.status(500).json({ error: 'Failed to fetch results' });
	}
});

router.get('/review-queue', requireAuth, requireRoles(['lecturer', 'management']), async (req, res) => {
  try {
    const result = await query(
      `SELECT
        mr.*,
        a.filename,
        a.file_path,
        a.uploaded_at,
        b.name as folder_name,
        ${rubricNameSelect} as rubric_name,
        r.total_points as max_points,
        m.flagged_for_moderation,
        m.moderation_reason,
        m.custom_feedback,
        m.override_total_score,
        ${reviewStatusSelect} as review_status,
        m.updated_by_user_id as moderation_updated_by,
        m.updated_at as moderation_updated_at,
        reviewer.name as moderation_updated_by_name,
        reviewer.email as moderation_updated_by_email
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      LEFT JOIN batches b ON a.batch_id = b.id
      LEFT JOIN rubrics r ON mr.rubric_id = r.id
      LEFT JOIN marking_result_moderation m ON m.result_id = mr.id
      LEFT JOIN users reviewer ON reviewer.id = m.updated_by_user_id
      WHERE mr.user_id = ?
      ORDER BY
        CASE
          WHEN COALESCE(m.flagged_for_moderation, 0) = 1 THEN 0
          WHEN COALESCE(mr.needs_review, 0) = 1 THEN 1
          WHEN COALESCE(mr.has_low_criterion_confidence, 0) = 1 THEN 2
          ELSE 3
        END,
        mr.marked_at DESC`,
      [req.user.id]
    );

    const parsed = rowsOf(result).map(mapResultRow);
    const queue = parsed.filter((item) => item.review_status === 'queued');
    const summary = {
      totalQueued: queue.length,
      flagged: queue.filter((item) => item.flagged_for_moderation).length,
      aiSuggested: queue.filter((item) => item.needs_review).length,
      lowConfidence: queue.filter((item) => item.has_low_criterion_confidence).length,
      reviewed: parsed.filter((item) => item.review_status === 'reviewed').length
    };

    res.json({
      success: true,
      summary,
      results: queue
    });
  } catch (error) {
    console.error('Review queue error:', error);
    res.status(500).json({ error: 'Failed to fetch review queue' });
  }
});

// Flag/unflag result for moderation
router.post('/:id/moderation-flag', requireAuth, requireRoles(['lecturer', 'management']), async (req, res) => {
  try {
    const { id } = req.params;
    const { flagged = true, moderation_reason = null } = req.body || {};
    const flaggedVal = !!flagged;

    const own = await query('SELECT id FROM marking_results WHERE id = ? AND user_id = ?', [id, req.user.id]);
    const ownRows = own.rows || own;
    if (!Array.isArray(ownRows) || ownRows.length === 0) {
      return res.status(404).json({ error: 'Result not found' });
    }

    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    if (isMySQL) {
      await query(
        `INSERT INTO marking_result_moderation (result_id, user_id, flagged_for_moderation, moderation_reason, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           flagged_for_moderation = VALUES(flagged_for_moderation),
           moderation_reason = VALUES(moderation_reason),
           updated_by_user_id = VALUES(updated_by_user_id)`,
        [id, req.user.id, flaggedVal ? 1 : 0, moderation_reason || null, req.user.id]
      );
    } else {
      await query(
        `INSERT INTO marking_result_moderation (result_id, user_id, flagged_for_moderation, moderation_reason, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (result_id) DO UPDATE SET
           flagged_for_moderation = EXCLUDED.flagged_for_moderation,
           moderation_reason = EXCLUDED.moderation_reason,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = CURRENT_TIMESTAMP`,
        [id, req.user.id, flaggedVal, moderation_reason || null, req.user.id]
      );
    }

    res.json({ success: true, flagged_for_moderation: flaggedVal, moderation_reason: moderation_reason || null });
  } catch (error) {
    console.error('Moderation flag error:', error);
    res.status(500).json({ error: 'Failed to update moderation flag' });
  }
});

// Lecturer custom feedback and mark override
router.put('/:id/lecturer-override', requireAuth, requireRoles(['lecturer', 'management']), async (req, res) => {
  try {
    const { id } = req.params;
    const { custom_feedback = null, override_total_score = null, moderation_reason = null } = req.body || {};
    const parsedOverride = override_total_score === null || override_total_score === '' ? null : Number(override_total_score);
    if (parsedOverride != null && !Number.isFinite(parsedOverride)) {
      return res.status(400).json({ error: 'override_total_score must be a valid number' });
    }
    const own = await query(
      `SELECT mr.id, mr.user_id, r.total_points as max_points
       FROM marking_results mr
       JOIN rubrics r ON r.id = mr.rubric_id
       WHERE mr.id = ? AND mr.user_id = ?`,
      [id, req.user.id]
    );
    const ownRows = own.rows || own;
    const row = Array.isArray(ownRows) ? ownRows[0] : null;
    if (!row) return res.status(404).json({ error: 'Result not found' });
    if (parsedOverride != null && parsedOverride < 0) {
      return res.status(400).json({ error: 'override_total_score cannot be negative' });
    }
    if (parsedOverride != null && row.max_points != null && parsedOverride > Number(row.max_points)) {
      return res.status(400).json({ error: `override_total_score cannot exceed max points (${row.max_points})` });
    }

    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    if (isMySQL) {
      await query(
        `INSERT INTO marking_result_moderation (result_id, user_id, custom_feedback, override_total_score, moderation_reason, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           custom_feedback = VALUES(custom_feedback),
           override_total_score = VALUES(override_total_score),
           moderation_reason = VALUES(moderation_reason),
           updated_by_user_id = VALUES(updated_by_user_id)`,
        [id, req.user.id, custom_feedback, parsedOverride, moderation_reason || null, req.user.id]
      );
    } else {
      await query(
        `INSERT INTO marking_result_moderation (result_id, user_id, custom_feedback, override_total_score, moderation_reason, updated_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (result_id) DO UPDATE SET
           custom_feedback = EXCLUDED.custom_feedback,
           override_total_score = EXCLUDED.override_total_score,
           moderation_reason = EXCLUDED.moderation_reason,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = CURRENT_TIMESTAMP`,
        [id, req.user.id, custom_feedback, parsedOverride, moderation_reason || null, req.user.id]
      );
    }
    res.json({
      success: true,
      custom_feedback,
      override_total_score: parsedOverride,
      moderation_reason: moderation_reason || null
    });
  } catch (error) {
    console.error('Lecturer override error:', error);
    res.status(500).json({ error: 'Failed to save lecturer override' });
  }
});

// Group results by rubric and date (YYYY-MM-DD)
router.get('/grouped', requireAuth, async (req, res) => {
  try {
    const byRubric = await query(`
      SELECT r.name as rubric_name, COUNT(*) as count
      FROM marking_results mr
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.user_id = ?
      GROUP BY r.name
      ORDER BY count DESC
    `, [req.user.id]);

    const byDate = await query(`
      SELECT DATE(mr.marked_at) as date, COUNT(*) as count
      FROM marking_results mr
      WHERE mr.user_id = ?
      GROUP BY DATE(mr.marked_at)
      ORDER BY DATE(mr.marked_at) DESC
    `, [req.user.id]);

    res.json({
      success: true,
      grouped: {
        byRubric: byRubric.rows,
        byDate: byDate.rows
      }
    });
  } catch (error) {
    console.error('Get grouped results error:', error);
    res.status(500).json({ error: 'Failed to fetch grouped results' });
  }
});

// Re-run AI marking using existing result id
router.post('/rerun/:result_id', requireAuth, async (req, res) => {
  try {
    const { result_id } = req.params;
    const { document_type } = req.body || {};

    const existing = await query(
      `SELECT mr.*, a.file_path, r.* as rubric_json FROM marking_results mr
       JOIN assignments a ON mr.assignment_id = a.id
       JOIN rubrics r ON mr.rubric_id = r.id
       WHERE mr.id = ? AND mr.user_id = ?`,
      [result_id, req.user.id]
    );
    if (!existing.rows || existing.rows.length === 0) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const row = existing.rows[0];

    // Extract text
    const fs = require('fs');
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(row.file_path);
    const data = await pdfParse(dataBuffer);
    if (!data.text || data.text.trim().length === 0) {
      return res.status(400).json({ error: 'No text could be extracted from the PDF' });
    }

    // Use generateMarking from mark.js indirectly to avoid circular require
    const { generateMarking: gen } = require('./mark');
    const rubric = row; // row includes rubric fields; routes/mark expects criteria under rubric.criteria

    const marking = await gen(data.text, rubric, document_type || 'treatise');

    const insert = await query(
      'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score) VALUES (?, ?, ?, ?, ?, ?)',
      [row.assignment_id, row.rubric_id, row.student_name || null, JSON.stringify(marking.scores), marking.overall_feedback, marking.total_score]
    );
    const insertedId = insert.lastID || insert.rows?.[0]?.id;

    res.json({ success: true, new_result_id: insertedId });
  } catch (error) {
    console.error('Rerun marking error:', error);
    res.status(500).json({ error: 'Failed to rerun marking' });
  }
});

// Export selected result IDs as CSV
router.post('/export/selected', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    const placeholders = ids.map(() => '?').join(',');
    const result = await query(`
      SELECT mr.id, mr.student_name, a.filename, r.name as rubric_name, mr.total_score, mr.scores, mr.feedback, mr.marked_at
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.id IN (${placeholders}) AND mr.user_id = ?
      ORDER BY mr.marked_at DESC
    `, [...ids, req.user.id]);

    let csvContent = 'ID,Student Name,Filename,Rubric,Total Score,Marked At\n';
    (result.rows || []).forEach(row => {
      csvContent += `"${row.id}","${row.student_name || ''}","${row.filename}","${row.rubric_name}","${row.total_score}","${row.marked_at}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=selected_results.csv');
    res.send(csvContent);
  } catch (error) {
    console.error('Export selected error:', error);
    res.status(500).json({ error: 'Failed to export selected results' });
  }
});

// --- Feedback video (Sora) - must be before /:id ---
const FEEDBACK_VIDEOS_DIR = path.join(__dirname, '..', 'uploads', 'feedback-videos');
// API base for returned URLs (e.g. /tools/api in production when app is at /tools). Set API_PUBLIC_BASE on the server.
const API_BASE = (process.env.API_PUBLIC_BASE || '').replace(/\/$/, '') || '/api';
function feedbackVideoContentUrl(resultId) {
  return `${API_BASE}/results/feedback-video/${resultId}/content`;
}

async function getMarkingResultForUser(resultId, userId) {
  const result = await query(
    `SELECT mr.id, mr.feedback, mr.total_score, mr.user_id, r.name as rubric_name, r.total_points as max_points
     FROM marking_results mr
     JOIN rubrics r ON mr.rubric_id = r.id
     WHERE mr.id = $1 AND mr.user_id = $2`,
    [resultId, userId]
  );
  const rows = result.rows || result;
  return Array.isArray(rows) ? rows[0] : rows;
}

const numClips = Math.min(Math.max(parseInt(process.env.SORA_VIDEO_CLIPS || '1', 10) || 1, 1), 5);
const secondsPerClip = process.env.SORA_VIDEO_SECONDS_PER_CLIP || '4';

router.post('/feedback-video/:resultId', requireAuth, requireFeature('feedback_video'), async (req, res) => {
  const requestStartedAt = Date.now();
  let generationJobId = null;
  const telemetryBase = {
    event: 'feedback_video_generate',
    generation_type: 'feedback_video_generation',
    user_id: req.user.id,
    provider: 'openai',
    model: process.env.SORA_MODEL || 'sora-2',
  };
  try {
    generationJobId = await createGenerationJob({
      user_id: req.user.id,
      job_type: 'feedback_video_generation',
      status: JOB_STATUS.QUEUED,
      source_route: '/results/feedback-video/:resultId',
      payload: { result_id: Number(req.params.resultId) || null },
    });
    const resultId = Number(req.params.resultId);
    const markingResult = await getMarkingResultForUser(resultId, req.user.id);
    if (!markingResult) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const existing = await query(
      'SELECT id, openai_video_id, openai_video_ids, status, file_path FROM feedback_videos WHERE result_id = $1 AND user_id = $2',
      [resultId, req.user.id]
    );
    const existingRows = existing.rows || existing;
    const row = Array.isArray(existingRows) ? existingRows[0] : existingRows;
    if (row && row.status === 'completed' && row.file_path) {
      return res.json({
        status: 'completed',
        video_url: feedbackVideoContentUrl(resultId),
      });
    }
    if (row && (row.status === 'queued' || row.status === 'in_progress')) {
      return res.json({
        status: row.status,
        video_id: row.openai_video_id,
        message: 'Video generation already in progress',
      });
    }
    const model = process.env.SORA_MODEL || 'sora-2';
    const size = '1280x720';
    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    if (numClips > 1) {
      const prompts = feedbackVideoService.buildFeedbackVideoPromptSegments(
        markingResult.feedback,
        markingResult.rubric_name,
        markingResult.total_score,
        markingResult.max_points,
        numClips
      );
      const jobs = await Promise.all(
        prompts.map((p) =>
          feedbackVideoService.createVideoJob(p, {
            model,
            seconds: secondsPerClip,
            size,
          })
        )
      );
      const videoIds = jobs.map((j) => j.id);
      const firstId = videoIds[0];
      const idsJson = JSON.stringify(videoIds);
      if (isMySQL) {
        await query(
          `INSERT INTO feedback_videos (result_id, user_id, openai_video_id, openai_video_ids, status)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE openai_video_id = VALUES(openai_video_id), openai_video_ids = VALUES(openai_video_ids), status = VALUES(status), updated_at = CURRENT_TIMESTAMP`,
          [resultId, req.user.id, firstId, idsJson, 'queued']
        );
      } else {
        await query(
          `INSERT INTO feedback_videos (result_id, user_id, openai_video_id, openai_video_ids, status)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (result_id) DO UPDATE SET openai_video_id = $3, openai_video_ids = $4, status = $5, updated_at = CURRENT_TIMESTAMP`,
          [resultId, req.user.id, firstId, idsJson, 'queued']
        );
      }
      const successPayload = {
        ...telemetryBase,
        status: 'success',
        duration_ms: Date.now() - requestStartedAt,
        metadata: {
          result_id: resultId,
          clips: numClips,
          seconds_per_clip: secondsPerClip,
          mode: 'multi_clip',
        },
      };
      logGenerationTelemetry(successPayload);
      try {
        await persistGenerationTelemetryEvent(successPayload);
      } catch (telemetryError) {
        console.warn('[results] Failed to persist feedback video telemetry:', telemetryError?.message || telemetryError);
      }
      if (generationJobId) {
        await updateGenerationJob(generationJobId, {
          status: JOB_STATUS.QUEUED,
          result: { status: 'queued', result_id: resultId, clips: numClips, first_video_id: firstId },
          started_at: new Date(),
        });
      }
      return res.json({
        status: 'queued',
        video_id: firstId,
        clips: numClips,
        message: `Video generation started (${numClips} clips to be stitched)`,
      });
    }
    const prompt = feedbackVideoService.buildFeedbackVideoPrompt(
      markingResult.feedback,
      markingResult.rubric_name,
      markingResult.total_score,
      markingResult.max_points
    );
    const { id: openaiVideoId, status } = await feedbackVideoService.createVideoJob(prompt, {
      model,
      seconds: process.env.SORA_VIDEO_SECONDS || '8',
      size,
    });
    if (isMySQL) {
      await query(
        `INSERT INTO feedback_videos (result_id, user_id, openai_video_id, status)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE openai_video_id = VALUES(openai_video_id), status = VALUES(status), updated_at = CURRENT_TIMESTAMP`,
        [resultId, req.user.id, openaiVideoId, status]
      );
    } else {
      await query(
        `INSERT INTO feedback_videos (result_id, user_id, openai_video_id, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (result_id) DO UPDATE SET openai_video_id = $3, status = $4, updated_at = CURRENT_TIMESTAMP`,
        [resultId, req.user.id, openaiVideoId, status]
      );
    }
    const successPayload = {
      ...telemetryBase,
      status: 'success',
      duration_ms: Date.now() - requestStartedAt,
      metadata: {
        result_id: resultId,
        clips: 1,
        seconds_per_clip: process.env.SORA_VIDEO_SECONDS || '8',
        mode: 'single_clip',
      },
    };
    logGenerationTelemetry(successPayload);
    try {
      await persistGenerationTelemetryEvent(successPayload);
    } catch (telemetryError) {
      console.warn('[results] Failed to persist feedback video telemetry:', telemetryError?.message || telemetryError);
    }
    if (generationJobId) {
      await updateGenerationJob(generationJobId, {
        status: JOB_STATUS.QUEUED,
        result: { status: 'queued', result_id: resultId, clips: 1, first_video_id: openaiVideoId },
        started_at: new Date(),
      });
    }
    res.json({ status, video_id: openaiVideoId, message: 'Video generation started' });
  } catch (err) {
    const errorPayload = {
      ...telemetryBase,
      status: 'error',
      duration_ms: Date.now() - requestStartedAt,
      error_type: inferGenerationErrorType(err),
      error_message: String(err?.message || 'Unknown error'),
      metadata: {
        result_id: Number(req.params.resultId) || null,
        clips: numClips,
      },
    };
    logGenerationTelemetry(errorPayload);
    try {
      await persistGenerationTelemetryEvent(errorPayload);
    } catch (telemetryError) {
      console.warn('[results] Failed to persist feedback video error telemetry:', telemetryError?.message || telemetryError);
    }
    if (generationJobId) {
      await updateGenerationJob(generationJobId, {
        status: JOB_STATUS.FAILED,
        error_message: String(err?.message || 'Unknown error'),
        completed_at: new Date(),
      });
    }
    console.error('Feedback video create error:', err);
    res.status(500).json({
      error: err.message || 'Failed to start video generation',
    });
  }
});

router.get('/feedback-video/:resultId/status', requireAuth, requireFeature('feedback_video'), async (req, res) => {
  try {
    const resultId = Number(req.params.resultId);
    const markingResult = await getMarkingResultForUser(resultId, req.user.id);
    if (!markingResult) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const result = await query(
      'SELECT openai_video_id, openai_video_ids, status, file_path FROM feedback_videos WHERE result_id = $1 AND user_id = $2',
      [resultId, req.user.id]
    );
    const rows = result.rows || result;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.openai_video_id) {
      return res.status(404).json({ error: 'No video job found for this result' });
    }
    if (row.status === 'completed' && row.file_path) {
      return res.json({
        status: 'completed',
        video_url: feedbackVideoContentUrl(resultId),
      });
    }
    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    let videoIds = [];
    try {
      if (row.openai_video_ids) {
        videoIds = typeof row.openai_video_ids === 'string' ? JSON.parse(row.openai_video_ids) : row.openai_video_ids;
      }
    } catch (_) {}
    if (Array.isArray(videoIds) && videoIds.length > 0) {
      const statuses = await Promise.all(videoIds.map((id) => feedbackVideoService.getVideoStatus(id)));
      const failed = statuses.find((s) => s.status === 'failed');
      if (failed) {
        if (isMySQL) {
          await query(
            'UPDATE feedback_videos SET status = ?, openai_video_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE result_id = ? AND user_id = ?',
            ['failed', null, resultId, req.user.id]
          );
        } else {
          await query(
            'UPDATE feedback_videos SET status = $1, openai_video_ids = $2, updated_at = CURRENT_TIMESTAMP WHERE result_id = $3 AND user_id = $4',
            ['failed', null, resultId, req.user.id]
          );
        }
        return res.json({ status: 'failed', error: failed.error || 'One or more clips failed' });
      }
      const allDone = statuses.every((s) => s.status === 'completed');
      if (!allDone) {
        const progress = Math.round(
          (statuses.filter((s) => s.status === 'completed').length / statuses.length) * 100
        );
        return res.json({ status: 'in_progress', progress });
      }
      const filePath = path.join(FEEDBACK_VIDEOS_DIR, `${resultId}.mp4`);
      const tempDir = path.join(FEEDBACK_VIDEOS_DIR, 'temp', String(resultId));
      const tempPaths = [];
      try {
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        if (!fs.existsSync(FEEDBACK_VIDEOS_DIR)) {
          fs.mkdirSync(FEEDBACK_VIDEOS_DIR, { recursive: true });
        }
        for (let i = 0; i < videoIds.length; i++) {
          const buf = await feedbackVideoService.getVideoContent(videoIds[i]);
          const p = path.join(tempDir, `clip-${i}.mp4`);
          fs.writeFileSync(p, buf);
          tempPaths.push(p);
        }
        await feedbackVideoService.stitchVideos(tempPaths, filePath);
      } catch (stitchErr) {
        console.error('Feedback video stitch error:', stitchErr);
        if (isMySQL) {
          await query(
            'UPDATE feedback_videos SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE result_id = ? AND user_id = ?',
            ['failed', resultId, req.user.id]
          );
        } else {
          await query(
            'UPDATE feedback_videos SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE result_id = $2 AND user_id = $3',
            ['failed', resultId, req.user.id]
          );
        }
        return res.json({
          status: 'failed',
          error: stitchErr.message || 'Failed to download or stitch clips. Is ffmpeg installed?',
        });
      } finally {
        for (const p of tempPaths) {
          try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } catch (_) {}
        }
        try {
          if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
        } catch (_) {}
      }
      if (isMySQL) {
        await query(
          'UPDATE feedback_videos SET status = ?, file_path = ?, openai_video_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE result_id = ? AND user_id = ?',
          ['completed', filePath, null, resultId, req.user.id]
        );
      } else {
        await query(
          'UPDATE feedback_videos SET status = $1, file_path = $2, openai_video_ids = $3, updated_at = CURRENT_TIMESTAMP WHERE result_id = $4 AND user_id = $5',
          ['completed', filePath, null, resultId, req.user.id]
        );
      }
      return res.json({
        status: 'completed',
        video_url: feedbackVideoContentUrl(resultId),
      });
    }
    const { status, progress, error } = await feedbackVideoService.getVideoStatus(row.openai_video_id);
    if (status === 'completed') {
      const filePath = path.join(FEEDBACK_VIDEOS_DIR, `${resultId}.mp4`);
      try {
        const buffer = await feedbackVideoService.getVideoContent(row.openai_video_id);
        if (!fs.existsSync(FEEDBACK_VIDEOS_DIR)) {
          fs.mkdirSync(FEEDBACK_VIDEOS_DIR, { recursive: true });
        }
        fs.writeFileSync(filePath, buffer);
      } catch (downloadErr) {
        console.error('Feedback video download error:', downloadErr);
        await query(
          'UPDATE feedback_videos SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE result_id = $2 AND user_id = $3',
          ['failed', resultId, req.user.id]
        );
        return res.json({ status: 'failed', error: downloadErr.message || 'Failed to download video' });
      }
      if (isMySQL) {
        await query(
          'UPDATE feedback_videos SET status = ?, file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE result_id = ? AND user_id = ?',
          ['completed', filePath, resultId, req.user.id]
        );
      } else {
        await query(
          'UPDATE feedback_videos SET status = $1, file_path = $2, updated_at = CURRENT_TIMESTAMP WHERE result_id = $3 AND user_id = $4',
          ['completed', filePath, resultId, req.user.id]
        );
      }
      return res.json({
        status: 'completed',
        video_url: feedbackVideoContentUrl(resultId),
      });
    }
    if (status === 'failed') {
      await query(
        'UPDATE feedback_videos SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE result_id = $2 AND user_id = $3',
        ['failed', resultId, req.user.id]
      );
      return res.json({ status: 'failed', error: error || 'Video generation failed' });
    }
    await query(
      'UPDATE feedback_videos SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE result_id = $2 AND user_id = $3',
      [status, resultId, req.user.id]
    );
    res.json({ status, progress: progress || 0 });
  } catch (err) {
    console.error('Feedback video status error:', err);
    res.status(500).json({ error: err.message || 'Failed to get video status' });
  }
});

router.get('/feedback-video/:resultId/content', requireAuth, requireFeature('feedback_video'), async (req, res) => {
  try {
    const resultId = Number(req.params.resultId);
    const markingResult = await getMarkingResultForUser(resultId, req.user.id);
    if (!markingResult) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const result = await query(
      'SELECT file_path FROM feedback_videos WHERE result_id = $1 AND user_id = $2 AND status = $3',
      [resultId, req.user.id, 'completed']
    );
    const rows = result.rows || result;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ error: 'Video not ready' });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="feedback-video.mp4"');
    const stream = fs.createReadStream(row.file_path);
    stream.pipe(res);
  } catch (err) {
    console.error('Feedback video content error:', err);
    res.status(500).json({ error: err.message || 'Failed to stream video' });
  }
});

// Get a specific marking result
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(`
      SELECT
        mr.*,
        a.filename,
        a.uploaded_at,
        ${rubricNameSelect} as rubric_name,
        r.criteria as rubric_criteria
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      LEFT JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.id = ? AND mr.user_id = ?
    `, [id, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Result not found' });
    }

    res.json({
      success: true,
      result: result.rows[0]
    });
  } catch (error) {
    console.error('Get result error:', error);
    res.status(500).json({ error: 'Failed to fetch result' });
  }
});

// Get results by assignment
router.get('/assignment/:assignment_id', requireAuth, async (req, res) => {
  try {
    const { assignment_id } = req.params;

    const result = await query(`
      SELECT
        mr.*,
        a.filename,
        a.uploaded_at,
        ${rubricNameSelect} as rubric_name,
        r.criteria as rubric_criteria
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      LEFT JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.assignment_id = ? AND mr.user_id = ?
      ORDER BY mr.marked_at DESC
    `, [assignment_id, req.user.id]);

    res.json({
      success: true,
      results: result.rows
    });
  } catch (error) {
    console.error('Get results by assignment error:', error);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// Get results by rubric
router.get('/rubric/:rubric_id', requireAuth, async (req, res) => {
  try {
    const { rubric_id } = req.params;

    const result = await query(`
      SELECT
        mr.*,
        a.filename,
        a.uploaded_at,
        ${rubricNameSelect} as rubric_name,
        r.criteria as rubric_criteria
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      LEFT JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.rubric_id = ? AND mr.user_id = ?
      ORDER BY mr.marked_at DESC
    `, [rubric_id, req.user.id]);

    res.json({
      success: true,
      results: result.rows
    });
  } catch (error) {
    console.error('Get results by rubric error:', error);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// Export results to CSV format
router.get('/export/csv', requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        mr.id,
        mr.student_name,
        a.filename,
        ${rubricNameSelect} as rubric_name,
        mr.total_score,
        mr.scores,
        mr.feedback,
        mr.marked_at
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      LEFT JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.user_id = ?
      ORDER BY mr.marked_at DESC
    `, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No results found to export' });
    }

    // Generate CSV content
    let csvContent = 'ID,Student Name,Filename,Rubric,Total Score,Marked At\n';
    
    result.rows.forEach(row => {
      const scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
      const scoresText = scores.map(s => `${s.criterion_name}: ${s.points_awarded}/${s.max_points}`).join('; ');
      
      csvContent += `"${row.id}","${row.student_name || ''}","${row.filename}","${row.rubric_name}","${row.total_score}","${row.marked_at}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=marking_results.csv');
    res.send(csvContent);
  } catch (error) {
    console.error('Export CSV error:', error);
    res.status(500).json({ error: 'Failed to export results' });
  }
});

// Get statistics
router.get('/stats/overview', requireAuth, async (req, res) => {
  try {
    // Total results count
    const totalResults = await query('SELECT COUNT(*) as count FROM marking_results WHERE user_id = ?', [req.user.id]);

    // Average score
    const avgScore = await query('SELECT AVG(total_score) as average FROM marking_results WHERE user_id = ?', [req.user.id]);

    // Results by status
    const statusCounts = await query(`
      SELECT
        a.status,
        COUNT(*) as count
      FROM assignments a
      LEFT JOIN marking_results mr ON a.id = mr.assignment_id
      WHERE a.user_id = ?
      GROUP BY a.status
    `, [req.user.id]);

    // Recent results (last 7 days)
    const recentResults = await query(`
      SELECT COUNT(*) as count
      FROM marking_results
      WHERE user_id = ? AND marked_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `, [req.user.id]);

    res.json({
      success: true,
      stats: {
        totalResults: parseInt(totalResults.rows?.[0]?.count ?? 0),
        averageScore: parseFloat(avgScore.rows?.[0]?.average ?? 0),
        statusCounts: statusCounts.rows ?? [],
        recentResults: parseInt(recentResults.rows?.[0]?.count ?? 0)
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Delete a marking result
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      'DELETE FROM marking_results WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Result not found' });
    }

    console.log(`[AUDIT] User ${req.user.id} (${req.user.email}) deleted marking result id=${id}`);
    res.json({
      success: true,
      message: 'Result deleted successfully'
    });
  } catch (error) {
    console.error('Delete result error:', error);
    res.status(500).json({ error: 'Failed to delete result' });
  }
});

// Delete all marking results
router.delete('/', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM marking_results WHERE user_id = ?', [req.user.id]);

    console.log(`[AUDIT] User ${req.user.id} (${req.user.email}) deleted ALL marking results (${result.changes || result.affectedRows || 0} rows)`);
    res.json({
      success: true,
      message: `All marking results deleted successfully (${result.changes || 0} results removed)`
    });
  } catch (error) {
    console.error('Delete all results error:', error);
    res.status(500).json({ error: 'Failed to delete all results' });
  }
});

// Download all results as JSON
router.get('/download/all', requireAuth, requireFeature('download_results'), async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        mr.*,
        a.filename,
        a.uploaded_at,
        ${rubricNameSelect} as rubric_name,
        r.criteria as rubric_criteria
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      LEFT JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.user_id = $1
      ORDER BY mr.marked_at DESC
    `, [req.user.id]);

    const rows = result.rows || result;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No results found to download' });
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `marking_results_${timestamp}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({
      success: true,
      exported_at: new Date().toISOString(),
      total_results: rows.length,
      results: rows
    });
  } catch (error) {
    console.error('Download all results error:', error);
    res.status(500).json({ error: 'Failed to download results' });
  }
});

// Get annotated PDF for a marking result
router.get('/annotated-pdf/:resultId', requireAuth, async (req, res) => {
  try {
    const { resultId } = req.params;

    // Get marking result with assignment file path
    const result = await query(`
      SELECT
        mr.*,
        a.filename,
        a.file_path
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      WHERE mr.id = ? AND mr.user_id = ?
    `, [resultId, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Marking result not found' });
    }

    const markingResult = result.rows[0];
    const originalPath = markingResult.file_path;
    
    // Check if annotated PDF exists
    const annotatedPath = originalPath.replace(/\.pdf$/i, '.annotated.pdf');
    
    if (!fs.existsSync(annotatedPath)) {
      return res.status(404).json({ 
        error: 'Annotated PDF not found',
        message: 'The annotated PDF file does not exist. This may occur if annotation was not selected or failed during marking.'
      });
    }

    // Send the annotated PDF file
    res.setHeader('Content-Type', 'application/pdf');
    const filename = markingResult.filename.replace(/\.pdf$/i, '') + '_annotated.pdf';
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    const fileStream = fs.createReadStream(annotatedPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('Error streaming annotated PDF:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream annotated PDF' });
      }
    });
  } catch (error) {
    console.error('Get annotated PDF error:', error);
    res.status(500).json({ 
      error: 'Failed to get annotated PDF',
      details: error.message
    });
  }
});

// Download all results as detailed CSV
router.get('/download/csv', requireAuth, requireFeature('download_results'), async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        mr.id,
        mr.student_name,
        a.filename,
        ${rubricNameSelect} as rubric_name,
        mr.total_score,
        mr.scores,
        mr.feedback,
        mr.marked_at,
        r.total_points as max_points
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      LEFT JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.user_id = $1
      ORDER BY mr.marked_at DESC
    `, [req.user.id]);

    const rows = result.rows || result;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No results found to export' });
    }

    // Generate detailed CSV content
    let csvContent = 'ID,Student Name,Filename,Rubric,Total Score,Max Points,Percentage,Marked At,Feedback\n';
    
    rows.forEach(row => {
      const percentage = row.max_points > 0 ? ((row.total_score / row.max_points) * 100).toFixed(2) : '0.00';
      const feedback = (row.feedback || '').replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, ' ');
      
      csvContent += `"${row.id}","${row.student_name || ''}","${row.filename}","${row.rubric_name}","${row.total_score}","${row.max_points}","${percentage}%","${row.marked_at}","${feedback}"\n`;
    });

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `marking_results_detailed_${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (error) {
    console.error('Download CSV error:', error);
    res.status(500).json({ error: 'Failed to download CSV' });
  }
});

// Analytics endpoints
router.get('/analytics/overview', requireAuth, async (req, res) => {
  try {
    // Get total results count
    const totalResult = await query('SELECT COUNT(*) as count FROM marking_results WHERE is_current = 1 AND user_id = ?', [req.user.id]);
    const total = totalResult.rows?.[0]?.count || totalResult?.[0]?.count || 0;

    // Get average score
    const avgResult = await query(`
      SELECT AVG(total_score) as avg_score,
             MIN(total_score) as min_score,
             MAX(total_score) as max_score
      FROM marking_results
      WHERE is_current = 1 AND user_id = ?
    `, [req.user.id]);
    const stats = avgResult.rows?.[0] || avgResult?.[0] || {};

    // Get score distribution
    const distributionResult = await query(`
      SELECT
        CASE
          WHEN total_score >= 90 THEN 'A (90-100)'
          WHEN total_score >= 80 THEN 'B (80-89)'
          WHEN total_score >= 70 THEN 'C (70-79)'
          WHEN total_score >= 60 THEN 'D (60-69)'
          ELSE 'F (<60)'
        END as grade_band,
        COUNT(*) as count
      FROM marking_results
      WHERE is_current = 1 AND user_id = ?
      GROUP BY grade_band
      ORDER BY MIN(total_score) DESC
    `, [req.user.id]);
    const scoreDistribution = distributionResult.rows || distributionResult || [];

    // Get trends over time (last 30 days)
    // Use database-agnostic date calculation
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateStr = thirtyDaysAgo.toISOString().split('T')[0];
    
    const trendsResult = await query(`
      SELECT
        DATE(marked_at) as date,
        COUNT(*) as count,
        AVG(total_score) as avg_score
      FROM marking_results
      WHERE is_current = 1 AND user_id = ? AND marked_at >= ?
      GROUP BY DATE(marked_at)
      ORDER BY date DESC
    `, [req.user.id, dateStr]);

    // Get rubric usage stats
    const rubricStatsResult = await query(`
      SELECT
        r.name as rubric_name,
        COUNT(*) as usage_count,
        AVG(mr.total_score) as avg_score,
        r.total_points as max_points
      FROM marking_results mr
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.is_current = 1 AND mr.user_id = ?
      GROUP BY r.id, r.name, r.total_points
      ORDER BY usage_count DESC
    `, [req.user.id]);

    const trends = trendsResult.rows || trendsResult || [];
    const rubricStats = rubricStatsResult.rows || rubricStatsResult || [];

    res.json({
      success: true,
      overview: {
        total_markings: total,
        average_score: parseFloat(stats.avg_score || 0).toFixed(2),
        min_score: parseFloat(stats.min_score || 0).toFixed(2),
        max_score: parseFloat(stats.max_score || 0).toFixed(2),
        score_distribution: scoreDistribution,
        trends: trends,
        rubric_stats: rubricStats
      }
    });
  } catch (error) {
    console.error('Analytics overview error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

router.get('/analytics/management-performance', requireAuth, requireRoles(['management']), async (req, res) => {
  try {
    const scopeParams = [];
    let scopeClause = '';
    if (!isSuperAdmin(req.user)) {
      if (req.user.organisation_id == null) {
        return res.json({
          success: true,
          summary: {
            total_results: 0,
            lecturer_count: 0,
            student_count: 0,
            average_percentage: 0,
            reviewed_or_flagged_results: 0
          },
          lecturer_performance: [],
          student_performance: []
        });
      }
      scopeClause = ' AND owner.organisation_id = ?';
      scopeParams.push(req.user.organisation_id);
    }

    const summaryResult = await query(
      `SELECT
         COUNT(*) as total_results,
         COUNT(DISTINCT owner.id) as lecturer_count,
         COUNT(DISTINCT CASE WHEN TRIM(COALESCE(mr.student_name, '')) <> '' THEN LOWER(TRIM(mr.student_name)) END) as student_count,
         AVG(CASE WHEN COALESCE(r.total_points, 0) > 0 THEN (mr.total_score / r.total_points) * 100 END) as average_percentage,
         SUM(CASE
           WHEN COALESCE(m.flagged_for_moderation, 0) = 1
             OR COALESCE(mr.needs_review, 0) = 1
             OR COALESCE(mr.has_low_criterion_confidence, 0) = 1
           THEN 1 ELSE 0 END) as reviewed_or_flagged_results
       FROM marking_results mr
       INNER JOIN users owner ON owner.id = mr.user_id
       LEFT JOIN rubrics r ON r.id = mr.rubric_id
       LEFT JOIN marking_result_moderation m ON m.result_id = mr.id
       WHERE mr.is_current = 1${scopeClause}`,
      scopeParams
    );

    const lecturerResult = await query(
      `SELECT
         owner.id as lecturer_id,
         COALESCE(owner.name, owner.email) as lecturer_name,
         owner.email as lecturer_email,
         COALESCE(org.name, owner.organisation_name) as organisation_name,
         COUNT(*) as total_results,
         COUNT(DISTINCT mr.assignment_id) as assignments_marked,
         AVG(mr.total_score) as average_score,
         AVG(CASE WHEN COALESCE(r.total_points, 0) > 0 THEN (mr.total_score / r.total_points) * 100 END) as average_percentage,
         SUM(CASE
           WHEN COALESCE(m.flagged_for_moderation, 0) = 1
             OR COALESCE(mr.needs_review, 0) = 1
             OR COALESCE(mr.has_low_criterion_confidence, 0) = 1
           THEN 1 ELSE 0 END) as review_queue_count,
         COUNT(DISTINCT DATE(mr.marked_at)) as active_days,
         MAX(mr.marked_at) as last_marked_at
       FROM marking_results mr
       INNER JOIN users owner ON owner.id = mr.user_id
       LEFT JOIN organisations org ON org.id = owner.organisation_id
       LEFT JOIN rubrics r ON r.id = mr.rubric_id
       LEFT JOIN marking_result_moderation m ON m.result_id = mr.id
       WHERE mr.is_current = 1${scopeClause}
       GROUP BY owner.id, owner.name, owner.email, organisation_name
       ORDER BY total_results DESC, average_percentage DESC, lecturer_name ASC`,
      scopeParams
    );

    const studentResult = await query(
      `SELECT
         LOWER(TRIM(mr.student_name)) as student_key,
         MAX(TRIM(mr.student_name)) as student_name,
         COUNT(*) as total_results,
         COUNT(DISTINCT mr.user_id) as lecturers_involved,
         AVG(mr.total_score) as average_score,
         AVG(CASE WHEN COALESCE(r.total_points, 0) > 0 THEN (mr.total_score / r.total_points) * 100 END) as average_percentage,
         MIN(CASE WHEN COALESCE(r.total_points, 0) > 0 THEN (mr.total_score / r.total_points) * 100 END) as min_percentage,
         MAX(CASE WHEN COALESCE(r.total_points, 0) > 0 THEN (mr.total_score / r.total_points) * 100 END) as max_percentage,
         SUM(CASE WHEN COALESCE(r.total_points, 0) > 0 AND ((mr.total_score / r.total_points) * 100) >= 50 THEN 1 ELSE 0 END) as pass_count,
         MAX(mr.marked_at) as last_marked_at
       FROM marking_results mr
       INNER JOIN users owner ON owner.id = mr.user_id
       LEFT JOIN rubrics r ON r.id = mr.rubric_id
       WHERE mr.is_current = 1
         AND TRIM(COALESCE(mr.student_name, '')) <> ''${scopeClause}
       GROUP BY LOWER(TRIM(mr.student_name))
       ORDER BY total_results DESC, average_percentage DESC, student_name ASC`,
      scopeParams
    );

    const summary = rowsOf(summaryResult)[0] || {};
    const lecturerPerformance = rowsOf(lecturerResult).map((row) => ({
      lecturer_id: Number(row.lecturer_id),
      lecturer_name: row.lecturer_name || row.lecturer_email,
      lecturer_email: row.lecturer_email,
      organisation_name: row.organisation_name || null,
      total_results: Number(row.total_results || 0),
      assignments_marked: Number(row.assignments_marked || 0),
      average_score: Number(row.average_score || 0),
      average_percentage: Number(row.average_percentage || 0),
      review_queue_count: Number(row.review_queue_count || 0),
      active_days: Number(row.active_days || 0),
      last_marked_at: row.last_marked_at || null
    }));
    const studentPerformance = rowsOf(studentResult).map((row) => {
      const totalResults = Number(row.total_results || 0);
      const passCount = Number(row.pass_count || 0);
      return {
        student_key: row.student_key,
        student_name: row.student_name,
        total_results: totalResults,
        lecturers_involved: Number(row.lecturers_involved || 0),
        average_score: Number(row.average_score || 0),
        average_percentage: Number(row.average_percentage || 0),
        min_percentage: Number(row.min_percentage || 0),
        max_percentage: Number(row.max_percentage || 0),
        pass_rate: totalResults > 0 ? (passCount / totalResults) * 100 : 0,
        last_marked_at: row.last_marked_at || null
      };
    });

    res.json({
      success: true,
      summary: {
        total_results: Number(summary.total_results || 0),
        lecturer_count: Number(summary.lecturer_count || 0),
        student_count: Number(summary.student_count || 0),
        average_percentage: Number(summary.average_percentage || 0),
        reviewed_or_flagged_results: Number(summary.reviewed_or_flagged_results || 0)
      },
      lecturer_performance: lecturerPerformance,
      student_performance: studentPerformance
    });
  } catch (error) {
    console.error('Management performance analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch management performance analytics' });
  }
});

// Get criterion-level analytics
router.get('/analytics/criteria/:rubric_id', requireAuth, async (req, res) => {
  try {
    const { rubric_id } = req.params;

    const result = await query(`
      SELECT
        mr.scores,
        mr.total_score
      FROM marking_results mr
      WHERE mr.rubric_id = ? AND mr.is_current = 1 AND mr.user_id = ?
    `, [rubric_id, req.user.id]);

    if (!result.rows || result.rows.length === 0) {
      return res.json({
        success: true,
        criteria_analytics: []
      });
    }

    // Parse scores and aggregate by criterion
    const criterionStats = {};
    
    result.rows.forEach(row => {
      const scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
      if (Array.isArray(scores)) {
        scores.forEach(score => {
          if (!criterionStats[score.criterion_name]) {
            criterionStats[score.criterion_name] = {
              criterion_name: score.criterion_name,
              max_points: score.max_points,
              total_marks: 0,
              count: 0,
              avg_score: 0,
              min_score: score.max_points,
              max_score: 0
            };
          }
          
          const points = score.points_awarded || 0;
          criterionStats[score.criterion_name].total_marks += points;
          criterionStats[score.criterion_name].count += 1;
          criterionStats[score.criterion_name].min_score = Math.min(criterionStats[score.criterion_name].min_score, points);
          criterionStats[score.criterion_name].max_score = Math.max(criterionStats[score.criterion_name].max_score, points);
        });
      }
    });

    // Calculate averages
    const criteriaAnalytics = Object.values(criterionStats).map(stat => ({
      ...stat,
      avg_score: (stat.total_marks / stat.count).toFixed(2),
      avg_percentage: ((stat.total_marks / stat.count) / stat.max_points * 100).toFixed(2) + '%'
    }));

    res.json({
      success: true,
      criteria_analytics: criteriaAnalytics
    });
  } catch (error) {
    console.error('Criteria analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch criteria analytics' });
  }
});

// Get common issues/feedback patterns
router.get('/analytics/common-issues', requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        mr.scores,
        mr.feedback
      FROM marking_results mr
      WHERE mr.is_current = 1 AND mr.user_id = ?
      LIMIT 100
    `, [req.user.id]);

    // Extract common keywords from feedback
    const issueKeywords = ['missing', 'incomplete', 'unclear', 'weak', 'lacks', 'needs improvement', 'incorrect', 'error'];
    const issueCounts = {};

    result.rows.forEach(row => {
      const scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
      const feedback = (row.feedback || '').toLowerCase();
      
      if (Array.isArray(scores)) {
        scores.forEach(score => {
          const criterionFeedback = (score.feedback || '').toLowerCase();
          issueKeywords.forEach(keyword => {
            if (criterionFeedback.includes(keyword) || feedback.includes(keyword)) {
              issueCounts[keyword] = (issueCounts[keyword] || 0) + 1;
            }
          });
        });
      }
    });

    const commonIssues = Object.entries(issueCounts)
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      success: true,
      common_issues: commonIssues
    });
  } catch (error) {
    console.error('Common issues analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch common issues' });
  }
});

module.exports = router;

