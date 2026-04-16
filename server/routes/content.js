/**
 * Content generator: create course content, export to PPTX/lecture notes, publish for students.
 * Optional Sora video; optional PowerPoint template upload. Quizzes in content are marked on submit.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const multer = require('multer');
const { query } = require('../database/connection');
const { requireAuth, requireFeature } = require('../middleware/auth');
const contentService = require('../services/contentService');
const feedbackVideoService = require('../services/feedbackVideoService');
const { runContentPlannerCycle } = require('../services/contentPlannerService');
const { buildContentScormPackage } = require('../services/contentExport');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const API_BASE = (process.env.API_PUBLIC_BASE || '').replace(/\/$/, '') || '/api';
const CONTENT_VIDEOS_DIR = path.join(__dirname, '..', 'uploads', 'content-videos');

function parseClampedInt(value, fallback, min, max) {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeClipSeconds(value, fallback = 12) {
  const parsed = parseInt(String(value ?? ''), 10);
  if (parsed === 4 || parsed === 8 || parsed === 12) return parsed;
  return fallback;
}

function buildContentVideoPromptSegments(contentTitle, numSegments = 3) {
  const safeTitle = String(contentTitle || '').slice(0, 120);
  const base =
    'Wide shot of a friendly educator in a modern classroom or office, speaking warmly to camera. Soft lighting. No real people or copyrighted characters. Suitable for all ages.';
  if (numSegments <= 1) {
    return [
      `${base} The educator introduces the lesson "${safeTitle}" and gives a welcoming overview.`
    ];
  }
  const segments = [
    `${base} The educator introduces the lesson "${safeTitle}" and explains what students will learn.`,
    `${base} The educator explains the key ideas from "${safeTitle}" clearly and confidently.`,
    `${base} The educator summarizes "${safeTitle}" and gives encouraging closing guidance for students.`
  ];
  while (segments.length < numSegments) {
    segments.push(`${base} The educator continues explaining "${safeTitle}" in a calm, structured way.`);
  }
  return segments.slice(0, numSegments);
}

function generateCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

function toSafeIsoDateTime(value) {
  const dt = new Date(String(value || ''));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function parseJsonSafe(value, fallback = null) {
  try {
    if (value == null) return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return fallback;
  }
}

const templateDir = path.join(__dirname, '../uploads/content-templates');
try {
  require('fs').mkdirSync(templateDir, { recursive: true });
} catch (_) {}
const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, templateDir),
  filename: (req, file, cb) => cb(null, `template-${Date.now()}-${(file.originalname || 'slide').replace(/[^a-zA-Z0-9.-]/g, '_')}`),
});
const uploadTemplate = multer({
  storage: templateStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || (file.originalname || '').toLowerCase().endsWith('.pptx');
    cb(null, !!ok);
  },
}).single('template');

/**
 * Generate course content with AI. Body: topics, level?, num_sections?, rubric_id?, rubric_context?, include_video? (boolean)
 */
router.post('/generate', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { topics, level, num_sections = 5, rubric_id, rubric_context, template_id = 'classroom', include_diagrams = true, include_images = true } = req.body;
    if (!topics || !String(topics).trim()) {
      return res.status(400).json({ error: 'topics is required' });
    }
    let rubricContext = rubric_context || '';
    if (rubric_id && !rubric_context) {
      const q = isMySQL()
        ? await query('SELECT name, criteria, total_points FROM rubrics WHERE id = ?', [rubric_id])
        : await query('SELECT name, criteria, total_points FROM rubrics WHERE id = $1', [rubric_id]);
      const row = Array.isArray(q) ? q[0] : (q.rows && q.rows[0]);
      if (row) {
        const crit = typeof row.criteria === 'string' ? JSON.parse(row.criteria) : row.criteria;
        rubricContext = `Rubric: ${row.name}. Criteria: ${Array.isArray(crit) ? crit.map((c) => c.name).join(', ') : ''}`;
      }
    }
    let content = await contentService.generateContentWithAI({
      topics: String(topics).trim(),
      level: level || '',
      numSections: Math.min(Math.max(parseInt(num_sections, 10) || 5, 1), 20),
      rubricContext,
      templateId: template_id,
      includeDiagrams: include_diagrams !== false,
      includeImages: include_images !== false,
    });
    if (include_images !== false) {
      content = await contentService.enrichContentWithImages(content);
    }
    res.json({ success: true, content });
  } catch (error) {
    console.error('Content generate error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate content' });
  }
});

router.get('/templates', requireAuth, requireFeature('content_creation'), async (req, res) => {
  const templates = Object.values(contentService.CONTENT_TEMPLATES || {}).map((t) => ({
    id: t.id,
    name: t.name,
    theme: t.theme,
  }));
  res.json({ success: true, templates });
});

/**
 * Publish content (store and get student link). Body: content, rubric_id?; optional: include_video (start Sora job).
 */
router.post('/publish', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content, rubric_id, include_video } = req.body;
    if (!content || !content.title) {
      return res.status(400).json({ error: 'content with title is required' });
    }
    const normalizedContent = contentService.normalizeGeneratedContent(content);
    let code;
    for (let i = 0; i < 5; i++) {
      code = generateCode();
      try {
        if (isMySQL()) {
          await query(
            'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES (?, ?, ?, ?, ?)',
            [code, normalizedContent.title, JSON.stringify(normalizedContent), rubric_id || null, req.user.id]
          );
        } else {
          await query(
            'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES ($1, $2, $3, $4, $5)',
            [code, normalizedContent.title, JSON.stringify(normalizedContent), rubric_id || null, req.user.id]
          );
        }
        break;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY' || e.message?.includes('unique') || e.code === '23505') continue;
        throw e;
      }
    }
    if (!code) return res.status(500).json({ error: 'Could not generate unique code' });

    let videoJobId = null;
    if (include_video && process.env.OPENAI_API_KEY) {
      try {
        const model = process.env.SORA_MODEL || 'sora-2';
        const clips = parseClampedInt(
          process.env.SORA_CONTENT_VIDEO_CLIPS || process.env.SORA_VIDEO_CLIPS || '1',
          1,
          1,
          5
        );
        const secondsPerClip = normalizeClipSeconds(
          process.env.SORA_CONTENT_VIDEO_SECONDS_PER_CLIP ||
            process.env.SORA_VIDEO_SECONDS_PER_CLIP ||
            process.env.SORA_CONTENT_VIDEO_SECONDS ||
            process.env.SORA_VIDEO_SECONDS ||
            '12',
          12
        );
        const prompts = buildContentVideoPromptSegments(normalizedContent.title, clips);
        const jobs = await Promise.all(
          prompts.map((prompt) =>
            feedbackVideoService.createVideoJob(prompt, {
              model,
              seconds: String(secondsPerClip),
              size: '1280x720'
            })
          )
        );
        videoJobId = jobs[0]?.id || null;
        const videoIdsJson = JSON.stringify(jobs.map((job) => job.id).filter(Boolean));
        const ins = isMySQL()
          ? await query('SELECT id FROM published_content WHERE code = ?', [code])
          : await query('SELECT id FROM published_content WHERE code = $1', [code]);
        const row = Array.isArray(ins) ? ins[0] : (ins.rows && ins.rows[0]);
        if (row) {
          const contentId = row.id;
          if (isMySQL()) {
            await query(
              'INSERT INTO content_videos (published_content_id, openai_video_id, openai_video_ids, status) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE openai_video_id = VALUES(openai_video_id), openai_video_ids = VALUES(openai_video_ids), status = VALUES(status)',
              [contentId, videoJobId, videoIdsJson, 'queued']
            );
          } else {
            await query(
              'INSERT INTO content_videos (published_content_id, openai_video_id, openai_video_ids, status) VALUES ($1, $2, $3, $4) ON CONFLICT (published_content_id) DO UPDATE SET openai_video_id = $2, openai_video_ids = $3, status = $4',
              [contentId, videoJobId, videoIdsJson, 'queued']
            );
          }
        }
      } catch (videoErr) {
        console.warn('Content video job creation failed:', videoErr.message);
      }
    }

    const base = process.env.CLIENT_URL || '';
    const takePath = base ? `${base.replace(/\/$/, '')}/take-content` : '/take-content';
    res.json({
      success: true,
      code,
      link: `${takePath}?code=${code}`,
      video_job_id: videoJobId,
      message: 'Content published. Share the link with students.',
    });
  } catch (error) {
    console.error('Content publish error:', error);
    res.status(500).json({ error: 'Failed to publish content' });
  }
});

/**
 * List current user's published content (for reusability).
 */
router.get('/my', requireAuth, async (req, res) => {
  try {
    const q = isMySQL()
      ? await query('SELECT id, code, title, created_at FROM published_content WHERE user_id = ? ORDER BY created_at DESC', [req.user.id])
      : await query('SELECT id, code, title, created_at FROM published_content WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const rows = Array.isArray(q) ? q : (q.rows || []);
    res.json({ success: true, items: rows });
  } catch (error) {
    console.error('Content list error:', error);
    res.status(500).json({ error: 'Failed to list content' });
  }
});

/**
 * Store generated content history item for current user.
 */
router.post('/history', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content, input } = req.body || {};
    if (!content || !content.title) {
      return res.status(400).json({ error: 'content with title is required' });
    }

    const title = String(content.title || 'Untitled content').slice(0, 500);
    const normalized = contentService.normalizeGeneratedContent(content);
    let inserted;
    if (isMySQL()) {
      inserted = await query(
        `INSERT INTO content_generation_history (user_id, title, generated_content_json, input_json)
         VALUES (?, ?, ?, ?)`,
        [req.user.id, title, JSON.stringify(normalized), input ? JSON.stringify(input) : null]
      );
      const id = inserted.insertId ?? inserted.lastID;
      const rowResult = await query(
        'SELECT id, title, generated_content_json, input_json, created_at FROM content_generation_history WHERE id = ? AND user_id = ?',
        [id, req.user.id]
      );
      const row = Array.isArray(rowResult) ? rowResult[0] : (rowResult.rows && rowResult.rows[0]);
      return res.json({
        success: true,
        item: {
          id: row.id,
          title: row.title,
          content: parseJsonSafe(row.generated_content_json, null),
          input: parseJsonSafe(row.input_json, null),
          created_at: row.created_at,
        }
      });
    }

    inserted = await query(
      `INSERT INTO content_generation_history (user_id, title, generated_content_json, input_json)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, generated_content_json, input_json, created_at`,
      [req.user.id, title, JSON.stringify(normalized), input ? JSON.stringify(input) : null]
    );
    const row = inserted.rows?.[0] || inserted?.[0];
    return res.json({
      success: true,
      item: {
        id: row.id,
        title: row.title,
        content: parseJsonSafe(row.generated_content_json, null),
        input: parseJsonSafe(row.input_json, null),
        created_at: row.created_at,
      }
    });
  } catch (error) {
    console.error('Save content history error:', error);
    res.status(500).json({ error: 'Failed to save content history' });
  }
});

/**
 * List generated content history for current user.
 */
router.get('/history', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const q = isMySQL()
      ? await query(
          `SELECT id, title, generated_content_json, input_json, created_at
           FROM content_generation_history
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT 100`,
          [req.user.id]
        )
      : await query(
          `SELECT id, title, generated_content_json, input_json, created_at
           FROM content_generation_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 100`,
          [req.user.id]
        );
    const rows = Array.isArray(q) ? q : (q.rows || []);
    const items = rows.map((row) => ({
      id: row.id,
      title: row.title,
      content: parseJsonSafe(row.generated_content_json, null),
      input: parseJsonSafe(row.input_json, null),
      created_at: row.created_at,
    }));
    res.json({ success: true, items });
  } catch (error) {
    console.error('List content history error:', error);
    res.status(500).json({ error: 'Failed to fetch content history' });
  }
});

/**
 * Delete one content history item for current user.
 */
router.delete('/history/:id', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid history id' });
    }
    const deleted = isMySQL()
      ? await query('DELETE FROM content_generation_history WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('DELETE FROM content_generation_history WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'History item not found' });
    res.json({ success: true, message: 'History item removed' });
  } catch (error) {
    console.error('Delete content history error:', error);
    res.status(500).json({ error: 'Failed to delete history item' });
  }
});

/**
 * Clear all content history items for current user.
 */
router.delete('/history', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    if (isMySQL()) {
      await query('DELETE FROM content_generation_history WHERE user_id = ?', [req.user.id]);
    } else {
      await query('DELETE FROM content_generation_history WHERE user_id = $1', [req.user.id]);
    }
    res.json({ success: true, message: 'History cleared' });
  } catch (error) {
    console.error('Clear content history error:', error);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

/**
 * Schedule planner-based content generation and publishing.
 */
router.post('/planner/schedule', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const {
      topics,
      level,
      num_sections = 5,
      rubric_id,
      rubric_context,
      template_id = 'classroom',
      scheduled_for,
    } = req.body || {};

    const cleanedTopics = String(topics || '').trim();
    if (!cleanedTopics) {
      return res.status(400).json({ error: 'topics is required' });
    }
    const scheduleTime = toSafeIsoDateTime(scheduled_for);
    if (!scheduleTime) {
      return res.status(400).json({ error: 'scheduled_for must be a valid datetime' });
    }
    if (scheduleTime.getTime() < Date.now() - 60 * 1000) {
      return res.status(400).json({ error: 'scheduled_for must be now or a future datetime' });
    }

    const maxSections = Math.min(Math.max(parseInt(num_sections, 10) || 5, 1), 20);
    const dbScheduled = scheduleTime.toISOString().slice(0, 19).replace('T', ' ');

    let insert;
    try {
      if (isMySQL()) {
        insert = await query(
          `INSERT INTO content_planner_jobs
            (user_id, topics, level, num_sections, template_id, rubric_id, rubric_context, scheduled_for, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, cleanedTopics, level || null, maxSections, template_id || 'classroom', rubric_id || null, rubric_context || null, dbScheduled, 'scheduled']
        );
      } else {
        insert = await query(
          `INSERT INTO content_planner_jobs
            (user_id, topics, level, num_sections, template_id, rubric_id, rubric_context, scheduled_for, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [req.user.id, cleanedTopics, level || null, maxSections, template_id || 'classroom', rubric_id || null, rubric_context || null, dbScheduled, 'scheduled']
        );
      }
    } catch (insertErr) {
      const msg = String(insertErr?.message || '').toLowerCase();
      const columnMissing = msg.includes('template_id') && (msg.includes('unknown column') || msg.includes('does not exist'));
      if (!columnMissing) throw insertErr;
      if (isMySQL()) {
        insert = await query(
          `INSERT INTO content_planner_jobs
            (user_id, topics, level, num_sections, rubric_id, rubric_context, scheduled_for, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, cleanedTopics, level || null, maxSections, rubric_id || null, rubric_context || null, dbScheduled, 'scheduled']
        );
      } else {
        insert = await query(
          `INSERT INTO content_planner_jobs
            (user_id, topics, level, num_sections, rubric_id, rubric_context, scheduled_for, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [req.user.id, cleanedTopics, level || null, maxSections, rubric_id || null, rubric_context || null, dbScheduled, 'scheduled']
        );
      }
    }
    const id = insert?.insertId ?? insert?.lastID ?? insert?.rows?.[0]?.id ?? null;
    runContentPlannerCycle().catch((err) => {
      console.error('Planner cycle kick-off failed:', err);
    });

    res.json({
      success: true,
      job: {
        id,
        status: 'scheduled',
        scheduled_for: scheduleTime.toISOString(),
        topics: cleanedTopics,
        level: level || null,
        num_sections: maxSections,
        template_id: template_id || 'classroom',
      },
    });
  } catch (error) {
    console.error('Schedule content planner error:', error);
    res.status(500).json({ error: 'Failed to schedule planner content' });
  }
});

/**
 * List current user's planner jobs.
 */
router.get('/planner/jobs', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    let q;
    try {
      q = isMySQL()
        ? await query(
            `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                    template_id, published_content_id, published_code, created_at, updated_at
             FROM content_planner_jobs
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT 200`,
            [req.user.id]
          )
        : await query(
            `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                    template_id, published_content_id, published_code, created_at, updated_at
             FROM content_planner_jobs
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 200`,
            [req.user.id]
          );
    } catch (selectErr) {
      const msg = String(selectErr?.message || '').toLowerCase();
      const columnMissing = msg.includes('template_id') && (msg.includes('unknown column') || msg.includes('does not exist'));
      if (!columnMissing) throw selectErr;
      q = isMySQL()
        ? await query(
            `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                    published_content_id, published_code, created_at, updated_at
             FROM content_planner_jobs
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT 200`,
            [req.user.id]
          )
        : await query(
            `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                    published_content_id, published_code, created_at, updated_at
             FROM content_planner_jobs
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 200`,
            [req.user.id]
          );
    }
    const rows = Array.isArray(q) ? q : (q.rows || []);
    res.json({ success: true, jobs: rows });
  } catch (error) {
    console.error('List content planner jobs error:', error);
    res.status(500).json({ error: 'Failed to fetch planner jobs' });
  }
});

/**
 * Cancel a scheduled planner job (before processing starts).
 */
router.post('/planner/:id/cancel', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid planner job id' });
    }

    const existing = isMySQL()
      ? await query('SELECT id, status FROM content_planner_jobs WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('SELECT id, status FROM content_planner_jobs WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const row = Array.isArray(existing) ? existing[0] : (existing.rows && existing.rows[0]);
    if (!row) return res.status(404).json({ error: 'Planner job not found' });
    if (row.status !== 'scheduled') {
      return res.status(400).json({ error: 'Only scheduled jobs can be cancelled' });
    }

    if (isMySQL()) {
      await query('UPDATE content_planner_jobs SET status = ?, updated_at = NOW() WHERE id = ? AND user_id = ?', ['cancelled', id, req.user.id]);
    } else {
      await query('UPDATE content_planner_jobs SET status = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', ['cancelled', id, req.user.id]);
    }
    res.json({ success: true, message: 'Planner job cancelled' });
  } catch (error) {
    console.error('Cancel content planner job error:', error);
    res.status(500).json({ error: 'Failed to cancel planner job' });
  }
});

/**
 * Delete one of the current user's published content items.
 */
router.delete(['/my/:id', '/:id'], requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }

    const existing = isMySQL()
      ? await query(
          `SELECT pc.id, cv.file_path
           FROM published_content pc
           LEFT JOIN content_videos cv ON cv.published_content_id = pc.id
           WHERE pc.id = ? AND pc.user_id = ?`,
          [id, req.user.id]
        )
      : await query(
          `SELECT pc.id, cv.file_path
           FROM published_content pc
           LEFT JOIN content_videos cv ON cv.published_content_id = pc.id
           WHERE pc.id = $1 AND pc.user_id = $2`,
          [id, req.user.id]
        );
    const existingRows = Array.isArray(existing) ? existing : (existing.rows || []);
    const row = existingRows[0];
    if (!row) {
      return res.status(404).json({ error: 'Published content not found' });
    }

    const deleted = isMySQL()
      ? await query('DELETE FROM published_content WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('DELETE FROM published_content WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) {
      return res.status(404).json({ error: 'Published content not found' });
    }

    if (row.file_path) {
      try {
        if (fsSync.existsSync(row.file_path)) {
          await fs.unlink(row.file_path);
        }
      } catch (_) {}
    }

    res.json({ success: true, message: 'Published content deleted' });
  } catch (error) {
    console.error('Content delete error:', error);
    res.status(500).json({ error: 'Failed to delete published content' });
  }
});

/**
 * Get content by code (public) for students. Strips answer key from quiz.
 */
router.get('/take/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const q = isMySQL()
      ? await query('SELECT content_json, title FROM published_content WHERE code = ?', [code])
      : await query('SELECT content_json, title FROM published_content WHERE code = $1', [code]);
    const row = Array.isArray(q) ? q[0] : (q.rows && q.rows[0]);
    if (!row) return res.status(404).json({ error: 'Content not found or link expired' });
    const parsedContent = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
    const content = contentService.normalizeGeneratedContent(parsedContent || {});
    if (content.quiz && content.quiz.questions) {
      content.quiz.questions = content.quiz.questions.map((q) => {
        const { correct_answer, ...rest } = q;
        return rest;
      });
    }
    const videoRow = isMySQL()
      ? await query('SELECT openai_video_id, openai_video_ids, status, file_path FROM content_videos WHERE published_content_id = (SELECT id FROM published_content WHERE code = ? LIMIT 1)', [code])
      : await query('SELECT cv.openai_video_id, cv.openai_video_ids, cv.status, cv.file_path FROM content_videos cv JOIN published_content pc ON pc.id = cv.published_content_id WHERE pc.code = $1', [code]);
    const vr = Array.isArray(videoRow) ? videoRow[0] : (videoRow.rows && videoRow.rows[0]);
    const video = vr ? { status: vr.status, file_path: vr.file_path } : null;
    res.json({ success: true, content, video });
  } catch (error) {
    console.error('Content take error:', error);
    res.status(500).json({ error: 'Failed to load content' });
  }
});

/**
 * Submit quiz answers for content. Body: code, student_name, answers: [{ question_number, value }].
 * Runs marking and returns result (reuse assessment marking with synthetic rubric from quiz).
 */
router.post('/submit-quiz', async (req, res) => {
  try {
    const { code, student_name, answers } = req.body;
    if (!code || !student_name || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'code, student_name, and answers array are required' });
    }
    if (String(code).length > 32) return res.status(400).json({ error: 'code too long' });
    if (String(student_name).length > 200) return res.status(400).json({ error: 'student_name too long' });
    const pubQ = isMySQL()
      ? await query('SELECT id, content_json, user_id FROM published_content WHERE code = ?', [code])
      : await query('SELECT id, content_json, user_id FROM published_content WHERE code = $1', [code]);
    const pub = Array.isArray(pubQ) ? pubQ[0] : (pubQ.rows && pubQ.rows[0]);
    if (!pub) return res.status(404).json({ error: 'Content not found or link expired' });
    const content = typeof pub.content_json === 'string' ? JSON.parse(pub.content_json) : pub.content_json;
    const questions = (content.quiz && content.quiz.questions) || [];
    if (questions.length === 0) {
      return res.json({ success: true, result: { total_score: 0, feedback: 'No quiz in this content.', scores: [] } });
    }
    const answerMap = new Map(answers.map((a) => [a.question_number, a.value]));
    const scriptLines = questions.map((q) => {
      const num = q.number != null ? q.number : 0;
      const ans = answerMap.get(num) ?? answerMap.get(Number(num)) ?? '';
      return `Question ${num}: ${ans}`;
    });
    const scriptText = scriptLines.join('\n\n');
    const criteria = questions.map((q, i) => ({
      name: `Q${q.number != null ? q.number : i + 1}`,
      max_points: q.points != null ? q.points : 1,
      description: (q.question || '').slice(0, 200),
    }));
    const totalPoints = criteria.reduce((s, c) => s + (c.max_points || 0), 0);
    const rubricData = {
      id: null,
      name: 'Content quiz',
      total_points: totalPoints,
      criteria,
      rubric_type: 'rubric',
    };
    const { generateMarking } = require('./mark');
    const markingResult = await generateMarking(scriptText, rubricData, 'assignment', null, null, 'strict', null, null);
    const answerPayload = JSON.stringify(Array.isArray(answers) ? answers : []);
    if (isMySQL()) {
      await query(
        `INSERT INTO content_progress
         (published_content_id, student_name, current_section, checkpoint_answers_json, completed, score, progress_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           checkpoint_answers_json = VALUES(checkpoint_answers_json),
           completed = VALUES(completed),
           score = VALUES(score),
           progress_json = VALUES(progress_json)`,
        [pub.id, String(student_name).trim(), 9999, answerPayload, 1, Number(markingResult.total_score || 0), answerPayload]
      );
    } else {
      await query(
        `INSERT INTO content_progress
         (published_content_id, student_name, current_section, checkpoint_answers_json, completed, score, progress_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (published_content_id, student_name) DO UPDATE
         SET checkpoint_answers_json = EXCLUDED.checkpoint_answers_json,
             completed = EXCLUDED.completed,
             score = EXCLUDED.score,
             progress_json = EXCLUDED.progress_json,
             updated_at = NOW()`,
        [pub.id, String(student_name).trim(), 9999, answerPayload, true, Number(markingResult.total_score || 0), answerPayload]
      );
    }
    res.json({
      success: true,
      result: {
        total_score: markingResult.total_score,
        feedback: markingResult.feedback,
        scores: markingResult.scores,
      },
    });
  } catch (error) {
    console.error('Content submit-quiz error:', error);
    res.status(500).json({ error: 'Failed to mark quiz' });
  }
});

/**
 * Save learner progress/checkpoint state for content.
 */
router.post('/progress', async (req, res) => {
  try {
    const { code, student_name, current_section = 0, checkpoint_answers = null, progress = null, completed = false, score = null } = req.body || {};
    if (!code || !student_name) {
      return res.status(400).json({ error: 'code and student_name are required' });
    }
    const pubQ = isMySQL()
      ? await query('SELECT id FROM published_content WHERE code = ?', [code])
      : await query('SELECT id FROM published_content WHERE code = $1', [code]);
    const pub = Array.isArray(pubQ) ? pubQ[0] : (pubQ.rows && pubQ.rows[0]);
    if (!pub) return res.status(404).json({ error: 'Content not found or link expired' });
    const student = String(student_name).trim().slice(0, 255);
    const section = Number.isFinite(Number(current_section)) ? Number(current_section) : 0;
    const checkpointJson = checkpoint_answers != null ? JSON.stringify(checkpoint_answers) : null;
    const progressJson = progress != null ? JSON.stringify(progress) : null;
    const numericScore = score == null ? null : Number(score);

    if (isMySQL()) {
      await query(
        `INSERT INTO content_progress
         (published_content_id, student_name, current_section, checkpoint_answers_json, completed, score, progress_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          current_section = VALUES(current_section),
          checkpoint_answers_json = COALESCE(VALUES(checkpoint_answers_json), checkpoint_answers_json),
          completed = VALUES(completed),
          score = COALESCE(VALUES(score), score),
          progress_json = COALESCE(VALUES(progress_json), progress_json)`,
        [pub.id, student, section, checkpointJson, completed ? 1 : 0, Number.isFinite(numericScore) ? numericScore : null, progressJson]
      );
    } else {
      await query(
        `INSERT INTO content_progress
         (published_content_id, student_name, current_section, checkpoint_answers_json, completed, score, progress_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (published_content_id, student_name) DO UPDATE
         SET current_section = EXCLUDED.current_section,
             checkpoint_answers_json = COALESCE(EXCLUDED.checkpoint_answers_json, content_progress.checkpoint_answers_json),
             completed = EXCLUDED.completed,
             score = COALESCE(EXCLUDED.score, content_progress.score),
             progress_json = COALESCE(EXCLUDED.progress_json, content_progress.progress_json),
             updated_at = NOW()`,
        [pub.id, student, section, checkpointJson, !!completed, Number.isFinite(numericScore) ? numericScore : null, progressJson]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Content progress save error:', error);
    res.status(500).json({ error: 'Failed to save content progress' });
  }
});

/**
 * Load learner progress/checkpoint state for content.
 */
router.get('/progress/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const studentName = String(req.query.student_name || '').trim();
    if (!studentName) return res.status(400).json({ error: 'student_name query is required' });

    const q = isMySQL()
      ? await query(
          `SELECT cp.current_section, cp.checkpoint_answers_json, cp.completed, cp.score, cp.progress_json
           FROM content_progress cp
           JOIN published_content pc ON pc.id = cp.published_content_id
           WHERE pc.code = ? AND cp.student_name = ?
           LIMIT 1`,
          [code, studentName]
        )
      : await query(
          `SELECT cp.current_section, cp.checkpoint_answers_json, cp.completed, cp.score, cp.progress_json
           FROM content_progress cp
           JOIN published_content pc ON pc.id = cp.published_content_id
           WHERE pc.code = $1 AND cp.student_name = $2
           LIMIT 1`,
          [code, studentName]
        );
    const row = Array.isArray(q) ? q[0] : (q.rows && q.rows[0]);
    if (!row) return res.json({ success: true, progress: null });

    let checkpointAnswers = null;
    let progress = null;
    try { checkpointAnswers = row.checkpoint_answers_json ? JSON.parse(row.checkpoint_answers_json) : null; } catch (_) {}
    try { progress = row.progress_json ? JSON.parse(row.progress_json) : null; } catch (_) {}

    res.json({
      success: true,
      progress: {
        current_section: Number(row.current_section || 0),
        checkpoint_answers: checkpointAnswers,
        completed: !!row.completed,
        score: row.score == null ? null : Number(row.score),
        progress,
      },
    });
  } catch (error) {
    console.error('Content progress load error:', error);
    res.status(500).json({ error: 'Failed to load content progress' });
  }
});

/**
 * Export content as PowerPoint. Body: { content }.
 */
router.post('/export/pptx', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const buffer = await contentService.buildPptx(content);
    const filename = `${(content.title || 'content').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pptx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Content PPTX export error:', error);
    res.status(500).json({ error: 'Failed to export PPTX' });
  }
});

/**
 * Export content as lecture notes (HTML, includes answer key).
 */
router.post('/export/lecture-notes', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const html = contentService.buildLectureNotesHtml(content, true);
    const filename = `${(content.title || 'lecture-notes').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (error) {
    console.error('Content lecture notes export error:', error);
    res.status(500).json({ error: 'Failed to export lecture notes' });
  }
});

/**
 * Export content as SCORM 1.2 package ZIP (includes sections, visuals, checkpoint, SCORM runtime updates).
 */
router.post('/export/scorm', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const normalized = contentService.normalizeGeneratedContent(content);
    const zipBuffer = await buildContentScormPackage(normalized);
    const filename = `${(normalized.title || 'content').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_scorm.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (error) {
    console.error('Content SCORM export error:', error);
    res.status(500).json({ error: 'Failed to export SCORM package' });
  }
});

/**
 * Upload PowerPoint template (stored for future use / slide styling).
 */
router.post('/template', requireAuth, requireFeature('content_creation'), (req, res) => {
  uploadTemplate(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Template upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({
      success: true,
      template_path: req.file.filename,
      original_name: req.file.originalname,
      message: 'Template stored. It will be used for slide styling when supported.',
    });
  });
});

/**
 * Video status for published content (poll from take-content page).
 */
router.get('/video-status/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const pc = isMySQL()
      ? await query('SELECT id FROM published_content WHERE code = ?', [code])
      : await query('SELECT id FROM published_content WHERE code = $1', [code]);
    const pcRow = Array.isArray(pc) ? pc[0] : (pc.rows && pc.rows[0]);
    if (!pcRow) return res.status(404).json({ error: 'Not found' });
    const cv = isMySQL()
      ? await query('SELECT openai_video_id, openai_video_ids, status, file_path FROM content_videos WHERE published_content_id = ?', [pcRow.id])
      : await query('SELECT openai_video_id, openai_video_ids, status, file_path FROM content_videos WHERE published_content_id = $1', [pcRow.id]);
    const cvRow = Array.isArray(cv) ? cv[0] : (cv.rows && cv.rows[0]);
    if (!cvRow) return res.json({ status: null, video_url: null });
    if (cvRow.status === 'completed' && cvRow.file_path) {
      return res.json({ status: 'completed', video_url: `${API_BASE}/content/video/${code}/content` });
    }

    let videoIds = [];
    try {
      if (cvRow.openai_video_ids) {
        videoIds = typeof cvRow.openai_video_ids === 'string'
          ? JSON.parse(cvRow.openai_video_ids)
          : cvRow.openai_video_ids;
      }
    } catch (_) {}

    if (Array.isArray(videoIds) && videoIds.length > 1) {
      const statuses = await Promise.all(videoIds.map((id) => feedbackVideoService.getVideoStatus(id)));
      const failed = statuses.find((s) => s.status === 'failed');
      if (failed) {
        if (isMySQL()) {
          await query('UPDATE content_videos SET status = ?, openai_video_ids = ? WHERE published_content_id = ?', ['failed', null, pcRow.id]);
        } else {
          await query('UPDATE content_videos SET status = $1, openai_video_ids = $2 WHERE published_content_id = $3', ['failed', null, pcRow.id]);
        }
        return res.json({ status: 'failed', error: failed.error || 'One or more clips failed' });
      }

      const allDone = statuses.every((s) => s.status === 'completed');
      if (!allDone) {
        const progress = Math.round((statuses.filter((s) => s.status === 'completed').length / statuses.length) * 100);
        return res.json({ status: 'in_progress', progress });
      }

      const filePath = path.join(CONTENT_VIDEOS_DIR, `${pcRow.id}.mp4`);
      const tempDir = path.join(CONTENT_VIDEOS_DIR, 'temp', String(pcRow.id));
      const tempPaths = [];
      try {
        if (!fsSync.existsSync(tempDir)) fsSync.mkdirSync(tempDir, { recursive: true });
        if (!fsSync.existsSync(CONTENT_VIDEOS_DIR)) fsSync.mkdirSync(CONTENT_VIDEOS_DIR, { recursive: true });
        for (let i = 0; i < videoIds.length; i++) {
          const buf = await feedbackVideoService.getVideoContent(videoIds[i]);
          const clipPath = path.join(tempDir, `clip-${i}.mp4`);
          fsSync.writeFileSync(clipPath, buf);
          tempPaths.push(clipPath);
        }
        await feedbackVideoService.stitchVideos(tempPaths, filePath);
      } catch (stitchErr) {
        if (isMySQL()) {
          await query('UPDATE content_videos SET status = ? WHERE published_content_id = ?', ['failed', pcRow.id]);
        } else {
          await query('UPDATE content_videos SET status = $1 WHERE published_content_id = $2', ['failed', pcRow.id]);
        }
        return res.json({ status: 'failed', error: stitchErr.message || 'Failed to stitch clips. Ensure ffmpeg is installed.' });
      } finally {
        for (const clipPath of tempPaths) {
          try {
            if (fsSync.existsSync(clipPath)) fsSync.unlinkSync(clipPath);
          } catch (_) {}
        }
        try {
          if (fsSync.existsSync(tempDir)) fsSync.rmdirSync(tempDir);
        } catch (_) {}
      }

      if (isMySQL()) {
        await query('UPDATE content_videos SET status = ?, file_path = ?, openai_video_ids = ? WHERE published_content_id = ?', ['completed', filePath, null, pcRow.id]);
      } else {
        await query('UPDATE content_videos SET status = $1, file_path = $2, openai_video_ids = $3 WHERE published_content_id = $4', ['completed', filePath, null, pcRow.id]);
      }
      return res.json({ status: 'completed', video_url: `${API_BASE}/content/video/${code}/content` });
    }

    const { status, progress, error } = await feedbackVideoService.getVideoStatus(cvRow.openai_video_id);
    if (status === 'completed') {
      const filePath = path.join(CONTENT_VIDEOS_DIR, `${pcRow.id}.mp4`);
      if (!fsSync.existsSync(CONTENT_VIDEOS_DIR)) {
        fsSync.mkdirSync(CONTENT_VIDEOS_DIR, { recursive: true });
      }
      const buffer = await feedbackVideoService.getVideoContent(cvRow.openai_video_id);
      await fs.writeFile(filePath, buffer);
      if (isMySQL()) {
        await query('UPDATE content_videos SET status = ?, file_path = ? WHERE published_content_id = ?', ['completed', filePath, pcRow.id]);
      } else {
        await query('UPDATE content_videos SET status = $1, file_path = $2 WHERE published_content_id = $3', ['completed', filePath, pcRow.id]);
      }
      return res.json({ status: 'completed', video_url: `${API_BASE}/content/video/${code}/content` });
    }
    res.json({ status: status || cvRow.status, progress, error });
  } catch (error) {
    console.error('Content video status error:', error);
    res.status(500).json({ error: 'Failed to get video status' });
  }
});

/**
 * Serve content video file (for take-content page).
 */
router.get('/video/:code/content', async (req, res) => {
  try {
    const { code } = req.params;
    const pc = isMySQL()
      ? await query('SELECT id FROM published_content WHERE code = ?', [code])
      : await query('SELECT id FROM published_content WHERE code = $1', [code]);
    const pcRow = Array.isArray(pc) ? pc[0] : (pc.rows && pc.rows[0]);
    if (!pcRow) return res.status(404).end();
    const cv = isMySQL()
      ? await query('SELECT file_path FROM content_videos WHERE published_content_id = ? AND status = ?', [pcRow.id, 'completed'])
      : await query('SELECT file_path FROM content_videos WHERE published_content_id = $1 AND status = $2', [pcRow.id, 'completed']);
    const cvRow = Array.isArray(cv) ? cv[0] : (cv.rows && cv.rows[0]);
    if (!cvRow || !cvRow.file_path) return res.status(404).end();
    if (!fsSync.existsSync(cvRow.file_path)) return res.status(404).end();
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(path.resolve(cvRow.file_path));
  } catch (error) {
    console.error('Content video serve error:', error);
    res.status(500).end();
  }
});

module.exports = router;
