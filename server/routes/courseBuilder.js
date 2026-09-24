/**
 * Course Builder wizard API: draft an outline with AI, then build the whole
 * course as a background job. See services/courseBuilderService.js.
 */

const express = require('express');
const { query } = require('../database/connection');
const { requireAuth, requireRoles, requireFeature } = require('../middleware/auth');
const aiService = require('../services/aiService');
const aiConfig = require('../config/ai-config');
const builder = require('../services/courseBuilderService');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const staffOnly = [requireAuth, requireRoles(['lecturer', 'management'])];

function extractJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('The AI response could not be read');
}

function toPublicJob(row) {
  return {
    id: row.id,
    status: row.status,
    course_id: row.course_id || null,
    error_message: row.error_message || null,
    progress: row.progress_json ? JSON.parse(row.progress_json) : null,
    course_name: (() => { try { return JSON.parse(row.config_json)?.course?.name || null; } catch (_) { return null; } })(),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Draft a module outline. Body: { name, description?, module_count?, level? }
 */
router.post('/outline', ...staffOnly, requireFeature('content_creation'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 255);
    const description = String(req.body?.description || '').trim().slice(0, 2000);
    const level = String(req.body?.level || '').trim().slice(0, 60);
    const count = Math.max(1, Math.min(builder.LIMITS.modules, Number.parseInt(req.body?.module_count, 10) || 5));
    if (!name) return res.status(400).json({ error: 'Enter a course name first' });

    const config = aiConfig.getTaskConfig('contentGeneration', 'openai');
    const completion = await aiService.createCompletionWithRetry({
      provider: config.provider,
      model: config.model,
      temperature: 0.5,
      maxTokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You design course structures for teachers. Reply with JSON only, in exactly this shape: {"description": string, "modules": [{"name": string, "lesson_topics": string, "quiz_topics": string}]}. "description" is one or two sentences describing the course. Each module name is short (max 8 words). "lesson_topics" is 2-4 sentences naming the concepts and subtopics the lesson should teach. "quiz_topics" is one sentence naming what the quiz should test. Modules should follow a sensible teaching order.',
        },
        {
          role: 'user',
          content: `Course: ${name}\n${description ? `About it: ${description}\n` : ''}${level ? `Audience level: ${level}\n` : ''}Design exactly ${count} modules.`,
        },
      ],
    });

    const parsed = extractJson(completion?.content);
    const modules = (Array.isArray(parsed.modules) ? parsed.modules : []).slice(0, count).map((m) => ({
      name: String(m?.name || '').trim().slice(0, 255),
      lesson_topics: String(m?.lesson_topics || '').trim().slice(0, builder.LIMITS.topicChars),
      quiz_topics: String(m?.quiz_topics || '').trim().slice(0, builder.LIMITS.topicChars),
    })).filter((m) => m.name);
    if (modules.length === 0) return res.status(502).json({ error: 'The AI did not return any modules. Try again.' });

    res.json({ success: true, description: String(parsed.description || '').trim().slice(0, 2000), modules });
  } catch (error) {
    console.error('Course outline error:', error);
    res.status(500).json({ error: error.message || 'Failed to draft an outline' });
  }
});

/**
 * Start a build. Body: the wizard configuration (see normalizeConfig).
 */
router.post('/jobs', ...staffOnly, requireFeature('content_creation'), async (req, res) => {
  try {
    const id = await builder.startJob(req.user.id, req.body);
    res.json({ success: true, job_id: id });
  } catch (error) {
    const clientError = /required|Add at least|already have/i.test(error.message);
    if (!clientError) console.error('Course build start error:', error);
    res.status(clientError ? 400 : 500).json({ error: error.message || 'Failed to start the build' });
  }
});

router.get('/jobs', ...staffOnly, async (req, res) => {
  try {
    const q = isMySQL()
      ? await query('SELECT * FROM course_build_jobs WHERE user_id = ? ORDER BY id DESC LIMIT 10', [req.user.id])
      : await query('SELECT * FROM course_build_jobs WHERE user_id = $1 ORDER BY id DESC LIMIT 10', [req.user.id]);
    res.json({ success: true, jobs: rowList(q).map(toPublicJob) });
  } catch (error) {
    console.error('Course build list error:', error);
    res.status(500).json({ error: 'Failed to load builds' });
  }
});

router.get('/jobs/:id', ...staffOnly, async (req, res) => {
  try {
    const row = await builder.getJobRow(Number.parseInt(req.params.id, 10));
    if (!row || Number(row.user_id) !== Number(req.user.id)) return res.status(404).json({ error: 'Build not found' });
    res.json({ success: true, job: toPublicJob(row) });
  } catch (error) {
    console.error('Course build status error:', error);
    res.status(500).json({ error: 'Failed to load build' });
  }
});

router.post('/jobs/:id/resume', ...staffOnly, requireFeature('content_creation'), async (req, res) => {
  try {
    await builder.resumeJob(req.user.id, Number.parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to resume the build' });
  }
});

module.exports = router;
