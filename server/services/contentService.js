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
${level ? `TARGET LEVEL/CATEGORY: ${level}.${level === 'ECD' || level === 'Foundation Phase' ? ' Use age-appropriate language, simple sentences, and concrete examples suitable for early childhood or foundation phase learners.' : ''}\n` : ''}
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

  let raw = completion.content || completion.choices?.[0]?.message?.content || '';
  if (Array.isArray(raw)) {
    raw = raw.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('');
  } else if (raw != null && typeof raw !== 'string') {
    raw = String(raw);
  }
  let jsonStr = (raw || '').trim();
  if (jsonStr.startsWith('```json')) jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  else if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');

  if (!jsonStr || jsonStr.length < 10) {
    const usage = completion.usage || {};
    const reason = usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens
      ? 'The model may have used all output tokens for reasoning and returned no text. Try a non-reasoning model (e.g. gpt-4o) or increase max_tokens.'
      : 'The API returned no or empty content.';
    throw new Error(`Content generation failed: ${reason}`);
  }

  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (parseErr) {
    const snippet = jsonStr.length > 200 ? `${jsonStr.slice(0, 100)}...${jsonStr.slice(-100)}` : jsonStr;
    console.error('Content JSON parse error. Snippet:', snippet);
    throw new Error(
      'Content generation returned invalid JSON. The response may be truncated (try fewer sections or a higher max_tokens) or the model may be a reasoning model that did not output JSON.'
    );
  }

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

// --- PPTX design: 16:9, one theme, factory opts (no reused objects). Every slide has a visual. ---
const THEME = { primary: '028090', secondary: '00A896', accent: '02C39A', light: 'F0F9F8', dark: '023E4D' };
const SHADOW = () => ({ type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.15, angle: 135 });
const TXT = (opts) => ({ fontSize: 18, bold: false, align: 'left', valign: 'top', wrap: true, breakLine: true, margin: 0, ...opts });

/**
 * Build a PowerPoint buffer: 16:9, assertion per slide, one visual per slide, two alternating layouts.
 */
async function buildPptx(content) {
  const pptx = new PptxGenJS();
  const title = content.title || 'Course Content';
  pptx.title = title;
  pptx.author = 'MarkMate';
  pptx.subject = title;
  pptx.layout = 'LAYOUT_16x9';

  const m = 0.5;
  const w = 10;
  const h = 5.625;
  const contentW = w - 2 * m;

  // Title slide
  const s0 = pptx.addSlide();
  s0.background = { color: THEME.primary };
  s0.addText(title, { x: m, y: 1.6, w: contentW, h: 1.4, ...TXT({ fontSize: 36, bold: true, color: THEME.accent, align: 'center', valign: 'middle' }) });
  if (content.instructions) {
    s0.addText(content.instructions, { x: m, y: 3.1, w: contentW, h: 1, ...TXT({ fontSize: 14, color: THEME.secondary, align: 'center' }) });
  }
  s0.addShape(pptx.ShapeType.rect, { x: m, y: 4.5, w: contentW, h: 0.12, fill: { color: THEME.accent }, line: { type: 'none' } });

  // Content slides: alternate layout so no two consecutive are the same
  const sections = content.sections || [];
  for (let i = 0; i < sections.length; i++) {
    const assertion = getSectionAssertion(sections[i]);
    const support = getSectionSupport(sections[i]);
    const slide = pptx.addSlide();
    slide.background = { color: THEME.light };

    if (i % 2 === 0) {
      // Layout A: left accent bar + text, right visual block
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.08, h, fill: { color: THEME.primary }, line: { type: 'none' } });
      slide.addText(assertion, { x: m + 0.1, y: m, w: contentW - 2.2, h: 1.4, ...TXT({ fontSize: 22, bold: true, color: THEME.dark }) });
      if (support) slide.addText(support, { x: m + 0.1, y: m + 1.5, w: contentW - 2.2, h: 2, ...TXT({ fontSize: 14, color: THEME.dark }) });
      slide.addShape(pptx.ShapeType.rect, { x: w - 2.4, y: m, w: 1.9, h: h - 2 * m, fill: { color: THEME.secondary }, line: { type: 'none' }, shadow: SHADOW() });
    } else {
      // Layout B: card with top accent strip
      slide.addShape(pptx.ShapeType.rect, { x: m, y: m, w: contentW, h: h - 2 * m, fill: { color: 'FFFFFF' }, line: { type: 'none' }, shadow: SHADOW() });
      slide.addShape(pptx.ShapeType.rect, { x: m, y: m, w: contentW, h: 0.3, fill: { color: THEME.primary }, line: { type: 'none' } });
      slide.addText(assertion, { x: m + 0.2, y: m + 0.45, w: contentW - 0.4, h: 1.3, ...TXT({ fontSize: 22, bold: true, color: THEME.dark }) });
      if (support) slide.addText(support, { x: m + 0.2, y: m + 1.85, w: contentW - 0.4, h: 2.2, ...TXT({ fontSize: 14, color: THEME.dark }) });
    }
  }

  // Quiz slide
  if (content.quiz && content.quiz.questions && content.quiz.questions.length > 0) {
    const qSlide = pptx.addSlide();
    qSlide.background = { color: THEME.light };
    qSlide.addShape(pptx.ShapeType.rect, { x: m, y: m, w: contentW, h: h - 2 * m, fill: { color: 'FFFFFF' }, line: { type: 'none' }, shadow: SHADOW() });
    qSlide.addText('Knowledge check', { x: m + 0.2, y: m + 0.2, w: contentW - 0.4, h: 0.55, ...TXT({ fontSize: 26, bold: true, color: THEME.primary }) });
    const quizLines = content.quiz.questions.map((q, idx) => `${idx + 1}. ${(q.question || '').slice(0, 65)}${(q.question || '').length > 65 ? '…' : ''}`).join('\n');
    qSlide.addText(quizLines, { x: m + 0.4, y: m + 0.9, w: contentW - 0.8, h: 3.5, ...TXT({ fontSize: 14, color: THEME.dark }) });
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
