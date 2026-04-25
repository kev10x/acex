/**
 * Slide Template Populator (Labs): upload a PPTX template, AI analyses each slide's
 * purpose, generates content, then user applies background styles before export.
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
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
}

/**
 * POST /slide-gen/analyse
 * Upload a PPTX and get AI-classified slide types.
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
        return res.status(422).json({ error: 'No slides found. Make sure the file is a valid PowerPoint (.pptx).' });
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
 * POST /slide-gen/generate-content
 * AI-generate title + bullets for each slide type. Does not need the session file.
 */
router.post('/generate-content', requireAuth, async (req, res) => {
  const { slides, topic, subject, level } = req.body;

  if (!Array.isArray(slides) || !slides.length) {
    return res.status(400).json({ error: 'slides array is required' });
  }
  if (!topic || !String(topic).trim()) {
    return res.status(400).json({ error: 'topic is required' });
  }

  try {
    const content = await slideGenService.generateSlideContent(slides, {
      topic: String(topic).trim().slice(0, 200),
      subject: String(subject || '').trim().slice(0, 100),
      level: String(level || 'undergraduate').trim()
    });
    res.json({ content });
  } catch (error) {
    console.error('Slide content generation error:', error);
    res.status(500).json({ error: 'Failed to generate slide content' });
  }
});

/**
 * POST /slide-gen/populate
 * Inject pre-generated content and chosen backgrounds, return populated PPTX.
 * body: { sessionId, content: [{slideIndex, title, bullets}], backgrounds: {[slideIndex]: bgId}, topic }
 */
router.post('/populate', requireAuth, async (req, res) => {
  const { sessionId, content, backgrounds = {}, topic = 'presentation' } = req.body;

  if (!validSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid or missing sessionId' });
  }
  if (!Array.isArray(content) || !content.length) {
    return res.status(400).json({ error: 'content array is required' });
  }

  const zipPath = path.join(SESSION_DIR, `${sessionId}.pptx`);
  if (!fs.existsSync(zipPath)) {
    return res.status(404).json({ error: 'Session not found or expired. Please re-upload your template.' });
  }

  try {
    const originalSlides = await slideGenService.readAllSlideXmls(zipPath);
    const contentMap = new Map((content || []).map((c) => [c.slideIndex, c]));

    const modifiedSlides = originalSlides.map((slide) => {
      const c = contentMap.get(slide.index);
      const bgId = String(backgrounds?.[slide.index] || '');
      const bgMeta = slideGenService.PPTX_BACKGROUNDS[bgId] || null;
      const textColor = bgMeta?.textColor || null;

      let xml = slide.xml;

      // Inject content (with text colour matching the background)
      if (c) {
        xml = slideGenService.injectContentIntoSlide(xml, {
          title: c.title,
          bullets: Array.isArray(c.bullets) ? c.bullets : [],
          textColor
        });
      }

      // Inject background
      if (bgId) {
        xml = slideGenService.injectBackgroundIntoSlide(xml, bgId);
      }

      return { entryName: slide.entryName, modifiedXml: xml };
    });

    const pptxBuffer = await slideGenService.buildPopulatedPptx(zipPath, modifiedSlides);

    const safeTitle = String(topic).replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'presentation';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_populated.pptx"`);
    res.setHeader('Content-Length', pptxBuffer.length);
    res.send(pptxBuffer);

    fs.unlink(zipPath, () => {});
  } catch (error) {
    console.error('Slide populate error:', error);
    res.status(500).json({ error: 'Failed to build presentation' });
  }
});

module.exports = router;
