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

// --- Design system: expert presentation designer (PptxGenJS) ---
// 16:9 = 10" x 5.625". All hex 6-char, no "#". Factory functions only (no reused option objects).

const THEMES = {
  TealTrust: { primary: '028090', secondary: '00A896', accent: '02C39A', light: 'F0F9F8', dark: '023E4D' },
  SageCalm: { primary: '84B59F', secondary: '69A297', accent: '50808E', light: 'F5F7F6', dark: '2C4A3E' },
  MidnightExecutive: { primary: '1E2761', secondary: 'CADCFC', accent: 'FFFFFF', light: 'E8ECF7', dark: '0F1535' },
  ForestMoss: { primary: '2C5F2D', secondary: '97BC62', accent: 'F5F5F5', light: 'F0F5EE', dark: '1A381C' },
  OceanGradient: { primary: '065A82', secondary: '1C7293', accent: '21295C', light: 'E8F4F8', dark: '033042' },
};

function pickTheme(index) {
  const keys = Object.keys(THEMES);
  return THEMES[keys[index % keys.length]];
}

function makeShadow() {
  return { type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.15, angle: 135 };
}
function makeTitleOpts(theme, overrides = {}) {
  return { fontSize: 40, bold: true, color: theme.accent, align: 'left', valign: 'middle', wrap: true, breakLine: true, margin: 0, ...overrides };
}
function makeBodyOpts(theme, overrides = {}) {
  return { fontSize: 15, color: theme.dark || '1E293B', align: 'left', valign: 'top', wrap: true, breakLine: true, margin: 0, ...overrides };
}
function makeCaptionOpts(theme, overrides = {}) {
  return { fontSize: 11, color: theme.secondary, align: 'left', valign: 'top', wrap: true, margin: 0, ...overrides };
}

/**
 * Build a PowerPoint buffer using agency-grade design: 16:9, theme palette, visual on every slide, varied layouts.
 * Design brief: https://www.cmu.edu/student-success/other-resources/handouts/comm-supp-pdfs/designing-powerpoint-slides.pdf
 * @param {object} content - { title, instructions, sections: [{ heading?, title?, support?, body }] }
 * @returns {Promise<Buffer>}
 */
async function buildPptx(content) {
  const pptx = new PptxGenJS();
  const title = content.title || 'Course Content';
  pptx.title = title;
  pptx.author = 'MarkMate';
  pptx.subject = title;

  // 16:9 layout (10" x 5.625") — built-in in PptxGenJS
  pptx.layout = 'LAYOUT_16x9';

  const theme = pickTheme(0); // TealTrust
  const margin = 0.5;
  const gap = 0.4;
  const slideW = 10;
  const slideH = 5.625;

  // ---- Title slide: dark background, centred title, visual element ----
  const slide1 = pptx.addSlide();
  slide1.background = { color: theme.primary };
  slide1.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: slideW, h: 1.2, fill: { color: theme.dark }, line: { type: 'none' } });
  slide1.addText(title, { x: margin, y: 1.4, w: slideW - 2 * margin, h: 1.6, ...makeTitleOpts(theme, { color: theme.accent, align: 'center', fontSize: 36 }) });
  if (content.instructions) {
    slide1.addText(content.instructions, { x: margin, y: 3.2, w: slideW - 2 * margin, h: 1.2, ...makeCaptionOpts(theme, { color: theme.secondary, align: 'center', fontSize: 14 }) });
  }
  slide1.addShape(pptx.ShapeType.rect, { x: margin, y: 4.6, w: slideW - 2 * margin, h: 0.15, fill: { color: theme.accent }, line: { type: 'none' } });

  const sections = content.sections || [];
  const layouts = ['twoColumn', 'accentBar', 'card', 'twoColumnReverse', 'iconCircle'];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const assertion = getSectionAssertion(sec);
    const support = getSectionSupport(sec);
    const slide = pptx.addSlide();
    const layout = layouts[i % layouts.length];

    // Light background for content slides
    slide.background = { color: theme.light || 'FFFFFF' };

    if (layout === 'twoColumn') {
      slide.addShape(pptx.ShapeType.rect, { x: slideW - 2.8, y: margin, w: 2.3, h: slideH - 2 * margin, fill: { color: theme.secondary }, line: { type: 'none' }, shadow: makeShadow() });
      slide.addText(assertion, { x: margin, y: margin, w: slideW - 3.5 - gap, h: 1.4, ...makeTitleOpts(theme, { fontSize: 22 }) });
      if (support) slide.addText(support, { x: margin, y: margin + 1.4 + gap, w: slideW - 3.5 - gap, h: 1.5, ...makeBodyOpts(theme, { fontSize: 14 }) });
    } else if (layout === 'accentBar') {
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.08, h: slideH, fill: { color: theme.primary }, line: { type: 'none' } });
      slide.addText(assertion, { x: margin + 0.1, y: margin, w: slideW - margin - 0.2, h: 1.5, ...makeTitleOpts(theme, { fontSize: 24 }) });
      if (support) slide.addText(support, { x: margin + 0.1, y: margin + 1.5 + gap, w: slideW - margin - 0.2, h: 1.8, ...makeBodyOpts(theme) });
      slide.addShape(pptx.ShapeType.ellipse, { x: slideW - 2.2, y: 1.8, w: 1.8, h: 1.8, fill: { color: theme.secondary }, line: { type: 'none' }, shadow: makeShadow() });
    } else if (layout === 'card') {
      slide.addShape(pptx.ShapeType.rect, { x: margin, y: margin, w: slideW - 2 * margin, h: slideH - 2 * margin, fill: { color: 'FFFFFF' }, line: { type: 'none' }, shadow: makeShadow() });
      slide.addShape(pptx.ShapeType.rect, { x: margin, y: margin, w: slideW - 2 * margin, h: 0.35, fill: { color: theme.primary }, line: { type: 'none' } });
      slide.addText(assertion, { x: margin + 0.2, y: margin + 0.45, w: slideW - 2 * margin - 0.4, h: 1.3, ...makeTitleOpts(theme, { fontSize: 20 }) });
      if (support) slide.addText(support, { x: margin + 0.2, y: margin + 1.85, w: slideW - 2 * margin - 0.4, h: 2.2, ...makeBodyOpts(theme) });
    } else if (layout === 'twoColumnReverse') {
      slide.addShape(pptx.ShapeType.rect, { x: margin, y: margin, w: 2.3, h: slideH - 2 * margin, fill: { color: theme.primary }, line: { type: 'none' }, shadow: makeShadow() });
      slide.addText(assertion, { x: margin + 2.3 + gap, y: margin, w: slideW - margin - 2.3 - gap - margin, h: 1.4, ...makeTitleOpts(theme, { fontSize: 22, color: theme.dark }) });
      if (support) slide.addText(support, { x: margin + 2.3 + gap, y: margin + 1.4 + gap, w: slideW - margin - 2.3 - gap - margin, h: 1.5, ...makeBodyOpts(theme) });
    } else {
      // iconCircle
      slide.addShape(pptx.ShapeType.ellipse, { x: margin, y: margin, w: 1.2, h: 1.2, fill: { color: theme.accent }, line: { type: 'none' }, shadow: makeShadow() });
      slide.addText(assertion, { x: margin + 1.2 + gap, y: margin, w: slideW - margin - 1.2 - gap - margin, h: 1.5, ...makeTitleOpts(theme, { fontSize: 22 }) });
      if (support) slide.addText(support, { x: margin, y: margin + 1.6 + gap, w: slideW - 2 * margin, h: 1.8, ...makeBodyOpts(theme) });
      slide.addShape(pptx.ShapeType.rect, { x: slideW - 2.5, y: 2.2, w: 2, h: 1.5, fill: { color: theme.secondary }, line: { type: 'none' }, shadow: makeShadow() });
    }
  }

  if (content.quiz && content.quiz.questions && content.quiz.questions.length > 0) {
    const quizSlide = pptx.addSlide();
    quizSlide.background = { color: theme.primary };
    quizSlide.addShape(pptx.ShapeType.rect, { x: margin, y: margin, w: slideW - 2 * margin, h: slideH - 2 * margin, fill: { color: theme.light || 'FFFFFF' }, line: { type: 'none' }, shadow: makeShadow() });
    quizSlide.addText('Knowledge check', { x: margin + 0.2, y: margin + 0.2, w: slideW - 2 * margin - 0.4, h: 0.6, ...makeTitleOpts(theme, { color: theme.primary, fontSize: 28 }) });
    const quizLines = content.quiz.questions.map((q, idx) => `${idx + 1}. ${(q.question || '').slice(0, 65)}${(q.question || '').length > 65 ? '…' : ''}`).join('\n');
    quizSlide.addText(quizLines, { x: margin + 0.4, y: margin + 1, w: slideW - 2 * margin - 0.8, h: 3.8, ...makeBodyOpts(theme), breakLine: true });
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
