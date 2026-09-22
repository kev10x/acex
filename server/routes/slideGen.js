/**
 * Slide Template Populator (Labs): upload a PPTX template to extract backgrounds,
 * generate content on fresh blank slides, then apply backgrounds and export.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const slideGenService = require('../services/slideGenService');
const slideBatchService = require('../services/slideBatchService');
const { listGenerationJobs } = require('../services/generationJobService');

const router = express.Router();

const SESSION_DIR = path.join(__dirname, '../uploads/slide-gen-sessions');
try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch (_) {}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SESSION_DIR),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.pptx`)
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      || (file.originalname || '').toLowerCase().endsWith('.pptx');
    if (!ok) return cb(new Error('Only .pptx files are accepted'));
    cb(null, true);
  }
});

function validSessionId(id) {
  return typeof id === 'string' && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).test(id);
}

/**
 * POST /slide-gen/analyse
 * Upload a PPTX template; extract unique slide backgrounds and media assets.
 * Returns { sessionId, backgrounds: [...], images: [...] }
 */
router.post('/analyse', requireAuth, (req, res) => {
  upload.single('template')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const zipPath = req.file.path;
    const sessionId = path.basename(req.file.filename, '.pptx');
    const mediaDir = path.join(SESSION_DIR, sessionId);

    try {
      const { backgrounds, images } = await slideGenService.extractTemplateAssets(zipPath, mediaDir, {
        useVision: true,
      });
      // Keep zipPath and mediaDir on disk for populate + bg-asset serving
      res.json({ sessionId, backgrounds, images });
    } catch (error) {
      console.error('Slide analyse error:', error);
      fs.unlink(zipPath, () => {});
      fs.rm(mediaDir, { recursive: true, force: true }, () => {});
      res.status(500).json({ error: 'Failed to extract template assets' });
    }
  });
});

/**
 * POST /slide-gen/generate-content
 * AI-generate a fresh slide deck (no template needed).
 * Body: { topic, subject?, level?, slideCount?, backgrounds? }
 * Returns { content: [{slideIndex, slideType, title, bullets}] }
 */
router.post('/generate-content', requireAuth, async (req, res) => {
  const { topic, subject, level, slideCount, detailLevel, backgrounds } = req.body;

  if (!topic || !String(topic).trim()) {
    return res.status(400).json({ error: 'topic is required' });
  }

  const count = Math.max(1, Math.min(20, parseInt(slideCount) || 8));
  const validDetailLevels = ['minimal', 'standard', 'detailed', 'comprehensive'];
  const safeDetailLevel = validDetailLevels.includes(detailLevel) ? detailLevel : 'standard';

  try {
    const content = await slideGenService.generateFreshSlideContent({
      topic: String(topic).trim().slice(0, 200),
      subject: String(subject || '').trim().slice(0, 100),
      level: String(level || 'undergraduate').trim(),
      slideCount: count,
      detailLevel: safeDetailLevel,
      backgrounds: Array.isArray(backgrounds) ? backgrounds : [],
    });
    res.json({ content });
  } catch (error) {
    console.error('Slide content generation error:', error);
    res.status(500).json({ error: 'Failed to generate slide content' });
  }
});

/**
 * POST /slide-gen/populate
 * Build a fresh PPTX with generated content + chosen backgrounds, return as download.
 * Body: { sessionId, topic, content, backgrounds, templateBgs, templateImages }
 */
router.post('/populate', requireAuth, async (req, res) => {
  const { sessionId, content, backgrounds = {}, templateBgs = [], templateImages = [], topic = 'presentation', subject, level, generateImages = false } = req.body;

  if (!validSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid or missing sessionId' });
  }
  if (!Array.isArray(content) || !content.length) {
    return res.status(400).json({ error: 'content array is required' });
  }

  const sessionMediaDir = path.join(SESSION_DIR, sessionId);

  try {
    let slideImages = {};
    if (generateImages) {
      slideImages = await slideGenService.generateSlideImages(content, sessionMediaDir, {
        topic: String(topic || '').trim(),
        subject: String(subject || '').trim(),
        level: String(level || '').trim(),
      });
    }

    const pptxBuffer = await slideGenService.buildFreshSlidePptx(
      content,
      backgrounds,
      Array.isArray(templateBgs) ? templateBgs : [],
      Array.isArray(templateImages) ? templateImages : [],
      sessionMediaDir,
      slideImages
    );

    const safeTitle = String(topic).replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'presentation';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_slides.pptx"`);
    res.setHeader('Content-Length', pptxBuffer.length);
    res.send(pptxBuffer);

    // Cleanup session files after response is sent
    const zipPath = path.join(SESSION_DIR, `${sessionId}.pptx`);
    fs.unlink(zipPath, () => {});
    fs.rm(sessionMediaDir, { recursive: true, force: true }, () => {});
  } catch (error) {
    console.error('Slide populate error:', error);
    res.status(500).json({ error: 'Failed to build presentation' });
  }
});

/**
 * GET /slide-gen/batch
 * List the authenticated user's past slide batch jobs.
 * Returns { jobs: [{ id, status, createdAt, scheduledFor, unitCount, units, subject, level, errorMessage }] }
 */
router.get('/batch', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  try {
    const rows = await listGenerationJobs({ user_id: req.user.id, job_type: 'slide_batch', limit });
    const jobs = rows.map((row) => {
      let payload = {};
      let progress = {};
      try { payload = JSON.parse(row.payload_json || '{}'); } catch (_) {}
      try { progress = JSON.parse(row.result_json || '{}'); } catch (_) {}
      return {
        id: row.id,
        status: row.status,
        createdAt: row.created_at,
        scheduledFor: row.scheduled_for || null,
        errorMessage: row.error_message || null,
        unitCount: Array.isArray(payload.units) ? payload.units.length : (progress.unitCount || 0),
        units: Array.isArray(payload.units) ? payload.units.map((u) => ({
          title: u.title || '',
          slideCount: u.slideCount || 8,
          includeQuiz: !!u.includeQuiz,
        })) : [],
        subject: payload.subject || '',
        level: payload.level || '',
        detailLevel: payload.detailLevel || 'standard',
      };
    });
    res.json({ success: true, jobs });
  } catch (error) {
    console.error('List slide batches error:', error);
    res.status(500).json({ error: 'Failed to list batch jobs' });
  }
});

/**
 * POST /slide-gen/batch
 * Submit a batch of slide decks for generation via Anthropic Batches API (50% cheaper).
 * Body: { units: [{title, slideCount, includeQuiz}], subject?, level?, detailLevel?,
 *         scheduledFor?, sessionId?, backgrounds?, templateBgs?, templateImages? }
 * Returns { jobId }
 */
router.post('/batch', requireAuth, async (req, res) => {
  const { units, subject, level, detailLevel, scheduledFor, sessionId, backgrounds, templateBgs, templateImages, generateImages } = req.body;

  if (!Array.isArray(units) || units.length === 0) {
    return res.status(400).json({ error: 'units array is required' });
  }
  if (units.length > 30) {
    return res.status(400).json({ error: 'Maximum 30 units per batch' });
  }

  const validDetailLevels = ['minimal', 'standard', 'detailed', 'comprehensive'];
  const safeDetailLevel = validDetailLevels.includes(detailLevel) ? detailLevel : 'standard';

  const cleanUnits = units.map((u) => ({
    title: String(u.title || '').trim().slice(0, 200),
    slideCount: Math.max(1, Math.min(20, parseInt(u.slideCount) || 8)),
    includeQuiz: !!u.includeQuiz,
  })).filter((u) => u.title);

  if (!cleanUnits.length) {
    return res.status(400).json({ error: 'At least one unit with a title is required' });
  }

  let scheduledDate = null;
  if (scheduledFor) {
    const d = new Date(scheduledFor);
    if (!isNaN(d.getTime()) && d > new Date()) scheduledDate = d;
  }

  const sessionMediaDir = sessionId && validSessionId(sessionId)
    ? path.join(SESSION_DIR, sessionId)
    : null;

  try {
    const jobId = await slideBatchService.createBatchJob({
      userId: req.user.id,
      units: cleanUnits,
      subject: String(subject || '').trim().slice(0, 100),
      level: String(level || 'undergraduate').trim(),
      detailLevel: safeDetailLevel,
      scheduledFor: scheduledDate,
      sessionId: sessionId || null,
      backgrounds: Array.isArray(backgrounds) ? backgrounds : [],
      templateBgs: Array.isArray(templateBgs) ? templateBgs : [],
      templateImages: Array.isArray(templateImages) ? templateImages : [],
      generateImages: !!generateImages,
    });
    res.json({ success: true, jobId });
  } catch (error) {
    console.error('Slide batch create error:', error);
    res.status(500).json({ error: 'Failed to create batch job' });
  }
});

/**
 * GET /slide-gen/batch/:jobId
 * Poll batch status. Triggers Anthropic batch submission if scheduled time has arrived.
 * Returns { id, status, scheduledFor, unitCount, progress, errorMessage }
 */
router.get('/batch/:jobId', requireAuth, async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'Invalid jobId' });
  }

  try {
    const status = await slideBatchService.getBatchStatus(jobId, req.user.id);
    if (!status) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Slide batch status error:', error);
    res.status(500).json({ error: 'Failed to get batch status' });
  }
});

/**
 * GET /slide-gen/batch/:jobId/download
 * Build all unit PPTXs and return as a ZIP. Only available when status is 'completed'.
 */
router.get('/batch/:jobId/download', requireAuth, async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'Invalid jobId' });
  }

  try {
    const status = await slideBatchService.getBatchStatus(jobId, req.user.id);
    if (!status) return res.status(404).json({ error: 'Job not found' });
    if (status.status !== 'completed') {
      return res.status(409).json({ error: `Batch not ready — status: ${status.status}` });
    }

    const sessionId = status.progress?.sessionId || null;
    const sessionMediaDir = sessionId && validSessionId(sessionId)
      ? path.join(SESSION_DIR, sessionId)
      : null;

    // Retrieve payload for template + image settings
    const { getGenerationJobById } = require('../services/generationJobService');
    const jobRow = await getGenerationJobById(jobId, req.user.id);
    let jobPayload = {};
    try { jobPayload = JSON.parse(jobRow?.payload_json || '{}'); } catch (_) {}

    const zipBuffer = await slideBatchService.buildBatchZip(jobId, {
      templateBgs: jobPayload.templateBgs || [],
      templateImages: jobPayload.templateImages || [],
      sessionMediaDir: sessionMediaDir || '',
      generateImages: !!jobPayload.generateImages,
      subject: jobPayload.subject || '',
      level: jobPayload.level || '',
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="slide_batch_${jobId}.zip"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (error) {
    console.error('Slide batch download error:', error);
    res.status(500).json({ error: 'Failed to build batch ZIP' });
  }
});

/**
 * GET /slide-gen/bg-asset/:sessionId/:filename
 * Serve an image background extracted from the template.
 */
router.get('/bg-asset/:sessionId/:filename', requireAuth, (req, res) => {
  const { sessionId, filename } = req.params;

  if (!validSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }

  // Prevent path traversal — only allow the basename
  const safeFilename = path.basename(filename);
  if (!safeFilename || safeFilename !== filename) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(SESSION_DIR, sessionId, safeFilename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  res.sendFile(filePath);
});

module.exports = router;
