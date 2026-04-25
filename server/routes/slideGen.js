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
 * Upload a PPTX template; extract unique slide backgrounds into a gallery.
 * Returns { sessionId, backgrounds: [{id, label, isDark, previewCss, imageFilename, bgXml}] }
 */
router.post('/analyse', requireAuth, (req, res) => {
  upload.single('template')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const zipPath = req.file.path;
    const sessionId = path.basename(req.file.filename, '.pptx');
    const mediaDir = path.join(SESSION_DIR, sessionId);

    try {
      const backgrounds = await slideGenService.extractTemplateBackgrounds(zipPath, mediaDir);
      // Keep zipPath and mediaDir on disk for populate + bg-asset serving
      res.json({ sessionId, backgrounds });
    } catch (error) {
      console.error('Slide analyse error:', error);
      fs.unlink(zipPath, () => {});
      fs.rm(mediaDir, { recursive: true, force: true }, () => {});
      res.status(500).json({ error: 'Failed to extract template backgrounds' });
    }
  });
});

/**
 * POST /slide-gen/generate-content
 * AI-generate a fresh slide deck (no template needed).
 * Body: { topic, subject?, level?, slideCount? }
 * Returns { content: [{slideIndex, slideType, title, bullets}] }
 */
router.post('/generate-content', requireAuth, async (req, res) => {
  const { topic, subject, level, slideCount } = req.body;

  if (!topic || !String(topic).trim()) {
    return res.status(400).json({ error: 'topic is required' });
  }

  const count = Math.max(1, Math.min(20, parseInt(slideCount) || 8));

  try {
    const content = await slideGenService.generateFreshSlideContent({
      topic: String(topic).trim().slice(0, 200),
      subject: String(subject || '').trim().slice(0, 100),
      level: String(level || 'undergraduate').trim(),
      slideCount: count,
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
 * Body: { sessionId, topic, content, backgrounds, templateBgs }
 */
router.post('/populate', requireAuth, async (req, res) => {
  const { sessionId, content, backgrounds = {}, templateBgs = [], topic = 'presentation' } = req.body;

  if (!validSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid or missing sessionId' });
  }
  if (!Array.isArray(content) || !content.length) {
    return res.status(400).json({ error: 'content array is required' });
  }

  const sessionMediaDir = path.join(SESSION_DIR, sessionId);

  try {
    const pptxBuffer = await slideGenService.buildFreshSlidePptx(
      content,
      backgrounds,
      Array.isArray(templateBgs) ? templateBgs : [],
      sessionMediaDir
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
