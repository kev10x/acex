/**
 * Content generator: create course content, export to PPTX/lecture notes, publish for students.
 * Optional Sora video; optional PowerPoint template upload. Quizzes in content are marked on submit.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer');
const { query } = require('../database/connection');
const { requireAuth, requireFeature } = require('../middleware/auth');
const contentService = require('../services/contentService');
const feedbackVideoService = require('../services/feedbackVideoService');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');

function generateCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
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
router.post('/generate', requireAuth, requireFeature('generate_assessments'), async (req, res) => {
  try {
    const { topics, level, num_sections = 5, rubric_id, rubric_context, include_video } = req.body;
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
    const content = await contentService.generateContentWithAI({
      topics: String(topics).trim(),
      level: level || '',
      numSections: Math.min(Math.max(parseInt(num_sections, 10) || 5, 1), 20),
      rubricContext,
    });
    res.json({ success: true, content });
  } catch (error) {
    console.error('Content generate error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate content' });
  }
});

/**
 * Publish content (store and get student link). Body: content, rubric_id?; optional: include_video (start Sora job).
 */
router.post('/publish', requireAuth, requireFeature('generate_assessments'), async (req, res) => {
  try {
    const { content, rubric_id, include_video } = req.body;
    if (!content || !content.title) {
      return res.status(400).json({ error: 'content with title is required' });
    }
    let code;
    for (let i = 0; i < 5; i++) {
      code = generateCode();
      try {
        if (isMySQL()) {
          await query(
            'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES (?, ?, ?, ?, ?)',
            [code, content.title, JSON.stringify(content), rubric_id || null, req.user.id]
          );
        } else {
          await query(
            'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES ($1, $2, $3, $4, $5)',
            [code, content.title, JSON.stringify(content), rubric_id || null, req.user.id]
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
        const prompt = `Wide shot of a friendly educator in a modern classroom or office, speaking warmly to camera. Soft lighting. Explaining the course: "${(content.title || '').slice(0, 100)}". No real people or copyrighted characters. Suitable for all ages.`;
        const { id } = await feedbackVideoService.createVideoJob(prompt, { seconds: process.env.SORA_VIDEO_SECONDS || '6' });
        videoJobId = id;
        const ins = isMySQL()
          ? await query('SELECT id FROM published_content WHERE code = ?', [code])
          : await query('SELECT id FROM published_content WHERE code = $1', [code]);
        const row = Array.isArray(ins) ? ins[0] : (ins.rows && ins.rows[0]);
        if (row) {
          const contentId = row.id;
          if (isMySQL()) {
            await query(
              'INSERT INTO content_videos (published_content_id, openai_video_id, status) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE openai_video_id = VALUES(openai_video_id), status = VALUES(status)',
              [contentId, videoJobId, 'queued']
            );
          } else {
            await query(
              'INSERT INTO content_videos (published_content_id, openai_video_id, status) VALUES ($1, $2, $3) ON CONFLICT (published_content_id) DO UPDATE SET openai_video_id = $2, status = $3',
              [contentId, videoJobId, 'queued']
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
    const content = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
    if (content.quiz && content.quiz.questions) {
      content.quiz.questions = content.quiz.questions.map((q) => {
        const { correct_answer, ...rest } = q;
        return rest;
      });
    }
    const videoRow = isMySQL()
      ? await query('SELECT openai_video_id, status, file_path FROM content_videos WHERE published_content_id = (SELECT id FROM published_content WHERE code = ? LIMIT 1)', [code])
      : await query('SELECT cv.openai_video_id, cv.status, cv.file_path FROM content_videos cv JOIN published_content pc ON pc.id = cv.published_content_id WHERE pc.code = $1', [code]);
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
 * Export content as PowerPoint. Body: { content }.
 */
router.post('/export/pptx', requireAuth, requireFeature('generate_assessments'), async (req, res) => {
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
router.post('/export/lecture-notes', requireAuth, requireFeature('generate_assessments'), async (req, res) => {
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
 * Upload PowerPoint template (stored for future use / slide styling).
 */
router.post('/template', requireAuth, requireFeature('generate_assessments'), (req, res) => {
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
      ? await query('SELECT openai_video_id, status, file_path FROM content_videos WHERE published_content_id = ?', [pcRow.id])
      : await query('SELECT openai_video_id, status, file_path FROM content_videos WHERE published_content_id = $1', [pcRow.id]);
    const cvRow = Array.isArray(cv) ? cv[0] : (cv.rows && cv.rows[0]);
    if (!cvRow) return res.json({ status: null, video_url: null });
    if (cvRow.status === 'completed' && cvRow.file_path) {
      const base = process.env.API_PUBLIC_BASE || '/api';
      return res.json({ status: 'completed', video_url: `${base}/content/video/${code}/content` });
    }
    const { status, progress, error } = await feedbackVideoService.getVideoStatus(cvRow.openai_video_id);
    if (status === 'completed') {
      const uploadsDir = path.join(__dirname, '../uploads');
      const filePath = path.join(uploadsDir, `content-video-${pcRow.id}.mp4`);
      const buffer = await feedbackVideoService.getVideoContent(cvRow.openai_video_id);
      await fs.writeFile(filePath, buffer);
      if (isMySQL()) {
        await query('UPDATE content_videos SET status = ?, file_path = ? WHERE published_content_id = ?', ['completed', filePath, pcRow.id]);
      } else {
        await query('UPDATE content_videos SET status = $1, file_path = $2 WHERE published_content_id = $3', ['completed', filePath, pcRow.id]);
      }
      const apiBase = process.env.API_PUBLIC_BASE || '/api';
      return res.json({ status: 'completed', video_url: `${apiBase}/content/video/${code}/content` });
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
    const fs = require('fs');
    if (!fs.existsSync(cvRow.file_path)) return res.status(404).end();
    res.setHeader('Content-Type', 'video/mp4');
    res.sendFile(path.resolve(cvRow.file_path));
  } catch (error) {
    console.error('Content video serve error:', error);
    res.status(500).end();
  }
});

module.exports = router;
