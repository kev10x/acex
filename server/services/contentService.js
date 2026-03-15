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
  const prompt = `You are an expert educator creating course/lecture content for students.

TOPICS TO COVER (create clear sections that teach these):
${topics}
${level ? `TARGET LEVEL: ${level}\n` : ''}
${rubricContext ? `CONTEXT FROM RUBRIC/MEMO:\n${rubricContext}\n` : ''}

Generate a structured course with exactly ${numSections} sections. Each section should have a clear title and body text (2–4 short paragraphs) that teach the topic. Include one optional short knowledge-check quiz at the end (3–5 multiple choice questions with correct_answer and options).

Respond with a JSON object only (no markdown), in this exact format:
{
  "title": "${suggestedTitle || 'Course Title'}",
  "instructions": "Brief instructions for the learner (1–2 sentences).",
  "sections": [
    {
      "title": "Section title",
      "body": "Section content in plain text. Use \\n for paragraph breaks. Teach the concept clearly."
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

Ensure sections are educational and well-ordered. Quiz questions must have options and correct_answer.`;

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

/**
 * Build a PowerPoint buffer from content (sections = slides).
 * @param {object} content - { title, instructions, sections: [{ title, body }] }
 * @returns {Promise<Buffer>}
 */
async function buildPptx(content) {
  const pptx = new PptxGenJS();
  const title = content.title || 'Course Content';
  pptx.title = title;
  pptx.author = 'MarkMate';
  pptx.subject = title;

  const slide1 = pptx.addSlide();
  slide1.addText(title, { x: 0.5, y: 1, w: 9, h: 1.2, fontSize: 28, bold: true });
  if (content.instructions) {
    slide1.addText(content.instructions, { x: 0.5, y: 2.2, w: 9, h: 1.5, fontSize: 14 });
  }

  const sections = content.sections || [];
  for (const sec of sections) {
    const slide = pptx.addSlide();
    slide.addText(sec.title || 'Section', { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 22, bold: true });
    const body = (sec.body || '').replace(/\n/g, '\n');
    slide.addText(body, { x: 0.5, y: 1.2, w: 9, h: 5.5, fontSize: 12, valign: 'top' });
  }

  if (content.quiz && content.quiz.questions && content.quiz.questions.length > 0) {
    const quizSlide = pptx.addSlide();
    quizSlide.addText('Knowledge check', { x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 22, bold: true });
    const lines = content.quiz.questions.map((q, i) => `${i + 1}. ${(q.question || '').slice(0, 80)}...`);
    quizSlide.addText(lines.join('\n'), { x: 0.5, y: 1, w: 9, h: 5, fontSize: 12 });
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
    .section h2 { color: #444; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
    .quiz { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid #ddd; }
    .answer-key { margin-top: 2rem; background: #e8f5e9; padding: 1rem; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${content.instructions ? `<div class="instructions">${escapeHtml(content.instructions).replace(/\n/g, '<br/>')}</div>` : ''}
`;
  sections.forEach((sec) => {
    html += `  <div class="section">
    <h2>${escapeHtml(sec.title || 'Section')}</h2>
    <p>${escapeHtml(sec.body || '').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>
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
