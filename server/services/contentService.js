/**
 * Content generation and export: AI-generated course content, PPTX, lecture notes.
 */

const aiService = require('./aiService');
const aiConfig = require('../config/ai-config');
const PptxGenJS = require('pptxgenjs').default || require('pptxgenjs');

/**
 * Generate course content (sections + optional quiz) using AI.
 * @param {object} opts - { topics, level, numSections, rubricContext?, title? }
 * @returns {Promise<{ title, instructions, sections: [{ title, body }], quiz?: { questions } }>}
 */
async function generateContentWithAI(opts) {
  const { topics, level = '', numSections = 5, rubricContext = '', title: suggestedTitle = '' } = opts;
  const config = aiConfig.getConfig('assignment', 'openai');
  const prompt = `You are an expert educator creating course/lecture content for students. Use the assertion-evidence model of slide design (Carnegie Mellon): each slide has ONE clear message in a complete sentence, with minimal supporting text—no long bullet lists or text-heavy slides.

TOPICS TO COVER (create clear sections that teach these):
${topics}
${level ? `TARGET LEVEL: ${level}\n` : ''}
${rubricContext ? `CONTEXT FROM RUBRIC/MEMO:\n${rubricContext}\n` : ''}

Generate a structured course with exactly ${numSections} sections. For each section provide:
- heading: ONE complete sentence that states the main idea (like a newspaper headline). This will be the slide title. Example: "Triple therapy reduced gastric ulcer recurrence by 60% over traditional ranitidine treatments."
- support: ONE short line or key takeaway for the slide only (optional). Keep it minimal so slides are not text-heavy.
- body: Full explanation for lecture notes and detailed reading (2–4 short paragraphs). Use \\n for paragraph breaks.

Include one optional short knowledge-check quiz at the end (3–5 multiple choice questions with correct_answer and options).

Respond with a JSON object only (no markdown), in this exact format:
{
  "title": "${suggestedTitle || 'Course Title'}",
  "instructions": "Brief instructions for the learner (1–2 sentences).",
  "sections": [
    {
      "heading": "One complete sentence stating this slide's main idea.",
      "support": "One short supporting line or key takeaway.",
      "body": "Full explanation for notes and reading. Use \\n for paragraph breaks."
    }
  ],
  "quiz": {
    "questions": [
      {
        "number": 1,
        "type": "multiple_choice",
        "question": "Question text?",
        "points": 2,
        "options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],
        "correct_answer": "A"
      }
    ],
    "total_points": 10
  }
}

Rules: heading must be a complete sentence (message, not just a topic). support is brief. body has the full teaching content. Quiz questions must have options and correct_answer.`;

  const completion = await aiService.createCompletionWithRetry({
    provider: config.provider,
    model: config.model,
    messages: [
      { role: 'system', content: 'You are an expert educator. Respond only with valid JSON, no markdown.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.6,
    maxTokens: config.maxTokens?.assignment ?? 4096,
  });

  const raw = completion.content || completion.choices?.[0]?.message?.content || '';
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('```json')) jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  else if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
  const data = JSON.parse(jsonStr);

  if (!data.title || !data.sections || !Array.isArray(data.sections)) {
    throw new Error('Invalid content structure: need title and sections array');
  }
  return data;
}

// Normalize section for assertion-evidence: support both legacy (title, body) and new (heading, support, body)
function getSectionAssertion(sec) {
  return sec.heading || sec.title || 'Section';
}
function getSectionSupport(sec) {
  if (sec.support && String(sec.support).trim()) return String(sec.support).trim();
  const body = sec.body || '';
  const first = body.split(/\n/)[0] || '';
  return first.length > 120 ? first.slice(0, 117) + '...' : first;
}
function getSectionBody(sec) {
  return sec.body || '';
}

/**
 * Build a PowerPoint buffer from content using assertion-evidence design (CMU).
 * One clear sentence per slide, minimal supporting text, no bullet lists.
 * @param {object} content - { title, instructions, sections: [{ heading?, title?, support?, body }] }
 * @returns {Promise<Buffer>}
 */
async function buildPptx(content) {
  const pptx = new PptxGenJS();
  const title = content.title || 'Course Content';
  pptx.title = title;
  pptx.author = 'MarkMate';
  pptx.subject = title;
  const slideW = 10;
  const margin = 0.6;

  // Title slide: one main message, brief instructions only
  const slide1 = pptx.addSlide();
  slide1.addText(title, { x: margin, y: 1.2, w: slideW - 2 * margin, h: 1.4, fontSize: 32, bold: true, align: 'center', valign: 'middle' });
  if (content.instructions) {
    slide1.addText(content.instructions, { x: margin, y: 2.8, w: slideW - 2 * margin, h: 1.2, fontSize: 14, align: 'center', color: '363636' });
  }

  const sections = content.sections || [];
  for (const sec of sections) {
    const slide = pptx.addSlide();
    const assertion = getSectionAssertion(sec);
    const support = getSectionSupport(sec);
    // Assertion at top (complete sentence) – main idea only
    slide.addText(assertion, { x: margin, y: 0.5, w: slideW - 2 * margin, h: 1.6, fontSize: 24, bold: true, valign: 'top', wrap: true });
    // One short supporting line only – no long paragraphs or bullets
    if (support) {
      slide.addText(support, { x: margin, y: 2.3, w: slideW - 2 * margin, h: 1.2, fontSize: 16, color: '404040', valign: 'top', wrap: true });
    }
    // White space below; no body text on slide (keeps slides readable and focused)
  }

  if (content.quiz && content.quiz.questions && content.quiz.questions.length > 0) {
    const quizSlide = pptx.addSlide();
    quizSlide.addText('Knowledge check', { x: margin, y: 0.6, w: slideW - 2 * margin, h: 0.7, fontSize: 26, bold: true });
    const lines = content.quiz.questions.map((q, i) => `${i + 1}. ${(q.question || '').slice(0, 70)}${(q.question || '').length > 70 ? '…' : ''}`);
    quizSlide.addText(lines.join('\n'), { x: margin, y: 1.5, w: slideW - 2 * margin, h: 5, fontSize: 14, valign: 'top' });
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

/**
 * Build lecture notes as HTML string (with optional answers section).
 * @param {object} content - same as buildPptx
 * @param {boolean} includeAnswerKey - include quiz answers at the end
 * @returns {string}
 */
function buildLectureNotesHtml(content, includeAnswerKey = true) {
  const title = content.title || 'Lecture notes';
  const sections = content.sections || [];
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
    h1 { color: #333; }
    .instructions { background: #f5f5f5; padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
    .section { margin-bottom: 2rem; }
    .section h2 { color: #1a1a1a; font-size: 1.25rem; margin-bottom: 0.5rem; line-height: 1.35; }
    .section-support { color: #555; font-size: 0.95rem; margin-bottom: 0.75rem; }
    .quiz { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #ddd; }
    .answer-key { margin-top: 2rem; background: #e8f5e9; padding: 1rem; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${content.instructions ? `<div class="instructions">${escapeHtml(content.instructions).replace(/\n/g, '<br/>')}</div>` : ''}
`;
  sections.forEach((sec) => {
    const heading = getSectionAssertion(sec);
    const body = getSectionBody(sec);
    const support = sec.support && String(sec.support).trim() ? escapeHtml(sec.support) : '';
    html += `  <div class="section">
    <h2>${escapeHtml(heading)}</h2>
    ${support ? `<p class="section-support">${support}</p>` : ''}
    <p>${escapeHtml(body).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>
  </div>
`;
  });
  if (content.quiz && content.quiz.questions && content.quiz.questions.length > 0) {
    html += '  <div class="quiz"><h2>Knowledge check</h2>\n';
    content.quiz.questions.forEach((q, i) => {
      html += `    <p><strong>${i + 1}. ${escapeHtml(q.question || '')}</strong></p>\n`;
      if (Array.isArray(q.options)) {
        html += '    <ul>\n';
        q.options.forEach((opt) => { html += `      <li>${escapeHtml(opt)}</li>\n`; });
        html += '    </ul>\n';
      }
    });
    html += '  </div>\n';
    if (includeAnswerKey) {
      html += '  <div class="answer-key"><h3>Answer key</h3><ol>\n';
      content.quiz.questions.forEach((q) => {
        html += `    <li>${escapeHtml(String(q.correct_answer || ''))}</li>\n`;
      });
      html += '  </ol></div>\n';
    }
  }
  html += '</body>\n</html>';
  return html;
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  generateContentWithAI,
  buildPptx,
  buildLectureNotesHtml,
};
