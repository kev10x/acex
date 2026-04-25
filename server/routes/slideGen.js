/**
 * Slide Template Populator (Labs): upload a PPTX template, AI analyses each slide's
 * purpose, then populates the template with AI-generated content for a given topic.
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
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    cb(null, `${id}.pptx`);
  }
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

/**
 * POST /slide-gen/analyse
 * Upload a PPTX template and get AI-classified slide types back.
 */
router.post('/analyse', requireAuth, (req, res) => {
  upload.single('template')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const zipPath = req.file.path;
      const sessionId = path.basename(req.file.filename, '.pptx');

      const slides = await slideGenService.readAllSlideXmls(zipPath);
      if (!slides.length) {
        fs.unlink(zipPath, () => {});
        return res.status(422).json({ error: 'No slides found in the uploaded PPTX. Make sure it is a valid PowerPoint file.' });
      }

      const analysis = await slideGenService.analyseSlideTypes(slides);

      res.json({ sessionId, slideCount: slides.length, slides: analysis });
    } catch (error) {
      console.error('Slide analysis error:', error);
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: 'Failed to analyse template' });
    }
  });
});

/**
 * POST /slide-gen/populate
 * Generate content and return a populated PPTX for download.
 */
router.post('/populate', requireAuth, async (req, res) => {
  const { sessionId, topic, subject, level, slides: clientSlides } = req.body;

  if (!sessionId || !topic) {
    return res.status(400).json({ error: 'sessionId and topic are required' });
  }

  // Sanitise sessionId — must be a UUID (no path traversal)
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  const zipPath = path.join(SESSION_DIR, `${sessionId}.pptx`);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Session not found or expired. Please re-upload your template.' });
  }

  try {
    const originalSlides = await slideGenService.readAllSlideXmls(zipPath);

    // Use client-corrected slide types when provided
    const analysisToUse = Array.isArray(clientSlides) && clientSlides.length
      ? clientSlides
      : await slideGenService.analyseSlideTypes(originalSlides);

    const generated = await slideGenService.generateSlideContent(analysisToUse, {
      topic: String(topic).trim().slice(0, 200),
      subject: String(subject || '').trim().slice(0, 100),
      level: String(level || 'undergraduate').trim()
    });

    // Build a map from slideIndex to generated content
    const contentMap = new Map(generated.map((g) => [g.slideIndex, g]));

    // Inject content into each slide XML
    const modifiedSlides = originalSlides.map((slide) => {
      const content = contentMap.get(slide.index);
      if (!content) return { entryName: slide.entryName, modifiedXml: slide.xml };
      const modifiedXml = slideGenService.injectContentIntoSlide(slide.xml, {
        title: content.title,
        bullets: Array.isArray(content.bullets) ? content.bullets : []
      });
      return { entryName: slide.entryName, modifiedXml };
    });

    const pptxBuffer = await slideGenService.buildPopulatedPptx(zipPath, modifiedSlides);

    const safeTitle = String(topic).replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'presentation';
    const filename = `${safeTitle}_populated.pptx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pptxBuffer.length);
    res.send(pptxBuffer);

    // Clean up session file after response
    fs.unlink(zipPath, () => {});
  } catch (error) {
    console.error('Slide populate error:', error);
    res.status(500).json({ error: 'Failed to generate populated presentation' });
  }
});

module.exports = router;
