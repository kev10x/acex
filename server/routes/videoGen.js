/**
 * Standalone AI video generation tool, powered by xAI's Grok Imagine API.
 * Create a job (async), poll it, download the finished clip locally, and
 * serve it back to its owner. See services/grokVideoService.js for the
 * actual xAI API contract.
 */

const express = require('express');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { query } = require('../database/connection');
const { requireAuth, requireFeature } = require('../middleware/auth');
const grokVideoService = require('../services/grokVideoService');
const { getJobRowById, refreshJobIfProcessing } = require('../services/videoJobService');
const { assertWithinBudgetOrThrow } = require('../services/budgetGuardrailService');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

const PROJECTED_COST_USD = Number.parseFloat(process.env.VIDEO_GEN_PROJECTED_COST_USD || '0.5') || 0.5;
const HISTORY_LIMIT_MAX = 100;

function toPublicJob(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    model: row.model,
    duration_seconds: row.duration_seconds,
    aspect_ratio: row.aspect_ratio,
    resolution: row.resolution,
    generate_audio: isMySQL() ? Boolean(row.generate_audio) : row.generate_audio === true,
    status: row.status,
    video_url: row.status === 'completed' ? `/video-gen/jobs/${row.id}/video` : null,
    error_message: row.error_message || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getOwnedJobRow(jobId, userId) {
  const q = isMySQL()
    ? await query('SELECT * FROM video_generations WHERE id = ? AND user_id = ?', [jobId, userId])
    : await query('SELECT * FROM video_generations WHERE id = $1 AND user_id = $2', [jobId, userId]);
  return rowList(q)[0] || null;
}

function jsonContainsVideoId(node, jobId) {
  if (node == null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((item) => jsonContainsVideoId(item, jobId));
  if (node.kind === 'video' && Number(node.video_generation_id) === jobId) return true;
  return Object.values(node).some((value) => jsonContainsVideoId(value, jobId));
}

// A video embedded as a lesson visual needs to be watchable by whoever can
// view that lesson (e.g. a student), not just by the lecturer who generated
// it — the same "public once embedded" posture lesson images already have
// (served unauthenticated from /uploads). A cheap LIKE pre-filter narrows
// the row scan before the exact recursive check confirms a real match.
async function isVideoEmbeddedInPublishedContent(jobId) {
  const needle = `%"video_generation_id":${jobId}%`;
  const q = isMySQL()
    ? await query('SELECT content_json FROM published_content WHERE content_json LIKE ?', [needle])
    : await query('SELECT content_json FROM published_content WHERE content_json LIKE $1', [needle]);
  for (const row of rowList(q)) {
    try {
      const parsed = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
      if (jsonContainsVideoId(parsed, jobId)) return true;
    } catch (_) { /* malformed content_json — skip */ }
  }
  return false;
}

function streamMp4WithRange(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (!range) {
    res.setHeader('Content-Length', fileSize);
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= fileSize) {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Content-Length', end - start + 1);
  return fs.createReadStream(filePath, { start, end }).pipe(res);
}

/**
 * Start a new video generation job.
 * Body: { prompt, duration?, aspect_ratio?, resolution?, generate_audio? }
 */
router.post('/', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    try {
      await assertWithinBudgetOrThrow({
        userId: req.user.id,
        projectedCostUsd: PROJECTED_COST_USD,
        generationType: 'video generation',
      });
    } catch (budgetError) {
      if (budgetError?.code === 'BUDGET_GUARDRAIL_EXCEEDED') {
        return res.status(budgetError.statusCode || 429).json({
          error: budgetError.message,
          code: budgetError.code,
          budget_status: budgetError.budget_status || null,
        });
      }
      throw budgetError;
    }

    const duration = Math.max(1, Math.min(15, Number.parseInt(req.body?.duration, 10) || 10));
    const aspectRatio = grokVideoService.ALLOWED_ASPECT_RATIOS.has(req.body?.aspect_ratio) ? req.body.aspect_ratio : '16:9';
    const resolution = grokVideoService.ALLOWED_RESOLUTIONS.has(req.body?.resolution) ? req.body.resolution : '720p';
    const generateAudio = req.body?.generate_audio !== false;

    const { requestId } = await grokVideoService.createVideoJob(prompt, {
      duration,
      aspectRatio,
      resolution,
      generateAudio,
    });

    const insertResult = isMySQL()
      ? await query(
          `INSERT INTO video_generations
            (user_id, prompt, model, duration_seconds, aspect_ratio, resolution, generate_audio, xai_request_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing')`,
          [req.user.id, prompt, grokVideoService.DEFAULT_MODEL, duration, aspectRatio, resolution, generateAudio ? 1 : 0, requestId]
        )
      : await query(
          `INSERT INTO video_generations
            (user_id, prompt, model, duration_seconds, aspect_ratio, resolution, generate_audio, xai_request_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing') RETURNING id`,
          [req.user.id, prompt, grokVideoService.DEFAULT_MODEL, duration, aspectRatio, resolution, generateAudio, requestId]
        );
    const jobId = isMySQL() ? insertResult.insertId : rowList(insertResult)[0]?.id;

    const row = await getOwnedJobRow(jobId, req.user.id);
    res.json({ success: true, job: toPublicJob(row) });
  } catch (error) {
    console.error('Video generation start error:', error);
    res.status(500).json({ error: error.message || 'Failed to start video generation' });
  }
});

/**
 * List the current user's video generation history.
 */
router.get('/jobs', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(HISTORY_LIMIT_MAX, Number.parseInt(req.query?.limit, 10) || 30));
    const q = isMySQL()
      ? await query('SELECT * FROM video_generations WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [req.user.id, limit])
      : await query('SELECT * FROM video_generations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [req.user.id, limit]);
    const rows = rowList(q);

    // Refresh any still-processing jobs in this page so the list reflects current status.
    const refreshed = await Promise.all(rows.map((row) => refreshJobIfProcessing(row)));
    res.json({ success: true, jobs: refreshed.map(toPublicJob) });
  } catch (error) {
    console.error('Video generation list error:', error);
    res.status(500).json({ error: 'Failed to load video generation history' });
  }
});

/**
 * Get a single job's current status, refreshing it against xAI if still processing.
 */
router.get('/jobs/:id', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const jobId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: 'Invalid job id' });

    let row = await getOwnedJobRow(jobId, req.user.id);
    if (!row) return res.status(404).json({ error: 'Video generation job not found' });

    row = await refreshJobIfProcessing(row);
    res.json({ success: true, job: toPublicJob(row) });
  } catch (error) {
    console.error('Video generation status error:', error);
    res.status(500).json({ error: 'Failed to check video generation status' });
  }
});

/**
 * Stream/download a completed video (range-request aware, for scrubbing).
 */
router.get('/jobs/:id/video', requireAuth, async (req, res) => {
  try {
    const jobId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: 'Invalid job id' });

    let row = await getOwnedJobRow(jobId, req.user.id);
    if (!row) {
      const anyRow = await getJobRowById(jobId);
      if (anyRow && (await isVideoEmbeddedInPublishedContent(jobId))) {
        row = anyRow;
      }
    }
    if (!row || row.status !== 'completed' || !row.file_path) {
      return res.status(404).json({ error: 'Video not available' });
    }
    if (!fs.existsSync(row.file_path)) {
      return res.status(404).json({ error: 'Video file not found' });
    }
    streamMp4WithRange(req, res, row.file_path);
  } catch (error) {
    console.error('Video generation stream error:', error);
    res.status(500).json({ error: 'Failed to stream video' });
  }
});

/**
 * Delete a job from history (and its local file, if any).
 */
router.delete('/jobs/:id', requireAuth, async (req, res) => {
  try {
    const jobId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(jobId)) return res.status(400).json({ error: 'Invalid job id' });

    const row = await getOwnedJobRow(jobId, req.user.id);
    if (!row) return res.status(404).json({ error: 'Video generation job not found' });

    if (row.file_path) {
      try { await fsPromises.unlink(row.file_path); } catch (_) {}
    }
    if (isMySQL()) {
      await query('DELETE FROM video_generations WHERE id = ? AND user_id = ?', [jobId, req.user.id]);
    } else {
      await query('DELETE FROM video_generations WHERE id = $1 AND user_id = $2', [jobId, req.user.id]);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Video generation delete error:', error);
    res.status(500).json({ error: 'Failed to delete video generation job' });
  }
});

module.exports = router;
