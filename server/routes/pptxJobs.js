const path = require('path');
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { query } = require('../database/connection');
const { createJob, getJobState, retryJob, getFinalBuffer, getPartialBuffer } = require('../services/pptxJobService');

const router = express.Router();
router.use(authenticateToken);

const TEMPLATE_DIR = path.join(__dirname, '..', 'uploads', 'content-templates');
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');

async function resolveTemplatePath(userId, templateToken) {
  const token = String(templateToken || '');
  const match = token.match(/^uploaded:(\d+)$/i);
  if (!match) return null;
  const templateId = Number(match[1]);
  if (!Number.isFinite(templateId) || templateId <= 0) return null;
  const q = isMySQL()
    ? await query('SELECT file_name FROM uploaded_ppt_templates WHERE id = ? AND user_id = ?', [templateId, userId])
    : await query('SELECT file_name FROM uploaded_ppt_templates WHERE id = $1 AND user_id = $2', [templateId, userId]);
  const row = Array.isArray(q) ? q[0] : q?.rows?.[0];
  if (!row?.file_name) return null;
  return path.join(TEMPLATE_DIR, row.file_name);
}

// POST /pptx-jobs — create a new batch job
router.post('/', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !Array.isArray(content.sections) || !content.sections.length) {
      return res.status(400).json({ error: 'content.sections is required and must not be empty' });
    }
    const templatePath = await resolveTemplatePath(req.user.id, content.template_id);
    const useAI = req.body.useAI !== false; // default true
    const jobId = await createJob(req.user.id, content, { templatePath, useAI });
    res.json({ success: true, jobId });
  } catch (err) {
    console.error('[pptxJobs] create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create job' });
  }
});

// GET /pptx-jobs/:id — poll status
router.get('/:id', async (req, res) => {
  try {
    const state = await getJobState(Number(req.params.id), req.user.id);
    if (!state) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true, ...state });
  } catch (err) {
    console.error('[pptxJobs] status error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to get job' });
  }
});

// POST /pptx-jobs/:id/retry — retry from last failed batch
router.post('/:id/retry', async (req, res) => {
  try {
    await retryJob(Number(req.params.id), req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[pptxJobs] retry error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to retry job' });
  }
});

// GET /pptx-jobs/:id/download — download completed PPTX
router.get('/:id/download', async (req, res) => {
  try {
    const buf = await getFinalBuffer(Number(req.params.id), req.user.id);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="presentation.pptx"`,
      'Content-Length': buf.length,
    });
    res.send(buf);
  } catch (err) {
    console.error('[pptxJobs] download error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Download failed' });
  }
});

// GET /pptx-jobs/:id/download-partial — download partial from completed batches
router.get('/:id/download-partial', async (req, res) => {
  try {
    const buf = await getPartialBuffer(Number(req.params.id), req.user.id);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="presentation-partial.pptx"`,
      'Content-Length': buf.length,
    });
    res.send(buf);
  } catch (err) {
    console.error('[pptxJobs] download-partial error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Partial download failed' });
  }
});

module.exports = router;
