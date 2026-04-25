const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const archiver = require('archiver');
const aiService = require('./aiService');
const aiConfig = require('../config/ai-config');

// ─── ZIP helpers ──────────────────────────────────────────────────────────────

function listZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const entries = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err || new Error('Could not open ZIP'));
      zipfile.readEntry();
      zipfile.on('entry', (entry) => { entries.push(entry.fileName); zipfile.readEntry(); });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

function readZipEntry(zipPath, entryName) {
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return resolve(null);
      let done = false;
      const finish = (v) => { if (done) return; done = true; try { zipfile.close(); } catch (_) {} resolve(v); };
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (sErr, stream) => {
          if (sErr || !stream) return finish(null);
          const chunks = [];
          stream.on('data', (d) => chunks.push(Buffer.from(d)));
          stream.on('end', () => finish(Buffer.concat(chunks)));
          stream.on('error', () => finish(null));
        });
      });
      zipfile.on('end', () => finish(null));
      zipfile.on('error', () => finish(null));
    });
  });
}

// Reads entire ZIP into a Map<entryName, Buffer> so we can repack it.
function readAllZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const map = new Map();
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err || new Error('Could not open ZIP'));
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return; } // skip dirs
        zipfile.openReadStream(entry, (sErr, stream) => {
          if (sErr || !stream) { map.set(entry.fileName, Buffer.alloc(0)); zipfile.readEntry(); return; }
          const chunks = [];
          stream.on('data', (d) => chunks.push(Buffer.from(d)));
          stream.on('end', () => { map.set(entry.fileName, Buffer.concat(chunks)); zipfile.readEntry(); });
          stream.on('error', () => { map.set(entry.fileName, Buffer.alloc(0)); zipfile.readEntry(); });
        });
      });
      zipfile.on('end', () => resolve(map));
      zipfile.on('error', reject);
    });
  });
}

// ─── Slide reading ────────────────────────────────────────────────────────────

async function readAllSlideXmls(zipPath) {
  const entries = await listZipEntries(zipPath);
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e))
    .sort((a, b) => {
      const n = (s) => parseInt((s.match(/\d+/) || ['0'])[0]);
      return n(a) - n(b);
    });

  const slides = [];
  for (const entryName of slideEntries) {
    const buf = await readZipEntry(zipPath, entryName);
    if (!buf) continue;
    const xml = buf.toString('utf8');
    const idx = parseInt((entryName.match(/slide(\d+)\.xml$/i) || ['', String(slides.length + 1)])[1]) - 1;
    slides.push({ index: idx, entryName, xml });
  }
  return slides;
}

// ─── Text extraction ──────────────────────────────────────────────────────────

function extractSlideText(xml) {
  const str = String(xml || '');
  const titleParts = [];
  const bodyParts = [];
  const otherParts = [];

  const shapeRx = /<p:sp\b[\s\S]*?<\/p:sp>/g;
  let m;
  while ((m = shapeRx.exec(str)) !== null) {
    const shape = m[0];
    const phMatch = shape.match(/<p:ph[^/]*?(?:type="([^"]*)")?[^/]*?\/?>/);
    const phType = phMatch ? (phMatch[1] || 'body') : null; // ph with no type = body

    const texts = [];
    const tRx = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    let tr;
    while ((tr = tRx.exec(shape)) !== null) {
      const t = tr[1].trim();
      if (t) texts.push(t);
    }
    const joined = texts.join(' ').trim();
    if (!joined) continue;

    if (phType === 'title' || phType === 'ctrTitle') {
      titleParts.push(joined);
    } else if (phType === 'body' || phType === 'subTitle') {
      bodyParts.push(joined);
    } else {
      otherParts.push(joined);
    }
  }

  return {
    titleText: titleParts.join(' ').trim(),
    bodyTexts: bodyParts,
    allText: [titleParts.join(' '), ...bodyParts, ...otherParts].filter(Boolean).join(' | ').slice(0, 600)
  };
}

// ─── AI: analyse slide types ──────────────────────────────────────────────────

async function analyseSlideTypes(slides) {
  if (!slides.length) return [];

  const cfg = aiConfig.getTaskConfig('contentGeneration');
  const summaries = slides.map((s) => {
    const t = extractSlideText(s.xml);
    return { slideIndex: s.index, detectedText: t.allText };
  });

  const systemMsg = 'You classify PowerPoint slides by educational purpose. Return only a valid JSON array — no markdown, no explanation.';
  const userMsg = `Classify each slide as one of: title | learning_objectives | content | question | activity | summary | quiz | transition | unknown

Rules:
- "?" alone or question-like text → question
- "Objectives" / "Outcomes" text → learning_objectives
- "Summary" / "Conclusion" / "Takeaway" → summary
- Section dividers with short text → transition
- Blank or minimal text → unknown

Slides:
${JSON.stringify(summaries)}

Return JSON: [{"slideIndex":0,"slideType":"...","description":"one sentence describing what this slide should contain"}]`;

  const result = await aiService.createCompletionWithRetry({
    provider: cfg.provider,
    model: cfg.model,
    temperature: 0.15,
    maxTokens: Math.min(cfg.maxTokens, 1500),
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user', content: userMsg }
    ]
  }, 3);

  const raw = String(result?.content || '').trim();
  let parsed = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (_) {
    parsed = slides.map((s) => ({ slideIndex: s.index, slideType: 'unknown', description: '' }));
  }

  return parsed.map((p) => {
    const orig = summaries.find((s) => s.slideIndex === p.slideIndex) || {};
    return {
      slideIndex: typeof p.slideIndex === 'number' ? p.slideIndex : 0,
      slideType: String(p.slideType || 'unknown'),
      description: String(p.description || ''),
      detectedText: orig.detectedText || ''
    };
  });
}

// ─── AI: generate content ─────────────────────────────────────────────────────

async function generateSlideContent(slideAnalysis, { topic, subject = '', level = 'undergraduate' }) {
  if (!slideAnalysis.length) return [];

  const cfg = aiConfig.getTaskConfig('contentGeneration');
  const specs = slideAnalysis.map((s) => ({ slideIndex: s.slideIndex, slideType: s.slideType, description: s.description }));

  const systemMsg = 'You generate educational PowerPoint slide content. Return only a valid JSON array.';
  const userMsg = `Generate content for a ${level} lesson on "${topic}"${subject ? ` (subject: ${subject})` : ''}.

For each slide type, generate:
- title → { title: "Course title", bullets: ["Subtitle or tagline"] }
- learning_objectives → { title: "Learning Objectives", bullets: ["By the end of...", ...4-5 outcomes] }
- content → { title: "Assertion-style heading", bullets: [...4-5 concise evidence points] }
- question → { title: "Discussion Question", bullets: ["The question itself?", "Consider...", "Think about..."] }
- activity → { title: "Activity Title", bullets: ["Step 1: ...", "Step 2: ...", "Step 3: ..."] }
- summary → { title: "Key Takeaways", bullets: [...4-5 important points] }
- quiz → { title: "Check Your Understanding", bullets: ["Q1: ...?", "Q2: ...?", "Q3: ...?"] }
- transition → { title: "Section title", bullets: ["Brief bridging sentence"] }
- unknown → { title: "Topic overview", bullets: [...3 general points] }

Keep bullet text concise (under 15 words each).

Slides:
${JSON.stringify(specs)}

Return JSON: [{"slideIndex":0,"slideType":"...","title":"...","bullets":["...","..."]}]`;

  const result = await aiService.createCompletionWithRetry({
    provider: cfg.provider,
    model: cfg.model,
    temperature: 0.6,
    maxTokens: Math.min(cfg.maxTokens, 4000),
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user', content: userMsg }
    ]
  }, 3);

  const raw = String(result?.content || '').trim();
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(match ? match[0] : raw);
  } catch (_) {
    return slideAnalysis.map((s) => ({
      slideIndex: s.slideIndex,
      slideType: s.slideType,
      title: topic,
      bullets: ['Content generation failed. Please retry.']
    }));
  }
}

// ─── XML injection ────────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPara(text) {
  return `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;
}

// Replace paragraphs inside a txBody, preserving bodyPr / lstStyle preamble.
function replaceTxBodyContent(txBodyXml, lines) {
  // Keep everything up to (but not including) the first <a:p
  const cutPoint = txBodyXml.indexOf('<a:p');
  const preamble = cutPoint >= 0 ? txBodyXml.slice(0, cutPoint) : txBodyXml.replace(/<\/p:txBody>\s*$/, '');
  const newParas = lines.map(buildPara).join('');
  return `${preamble}${newParas}</p:txBody>`;
}

function injectContentIntoSlide(xml, { title, bullets = [] }) {
  // Replace each <p:sp> shape individually
  return xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (shapeXml) => {
    const phMatch = shapeXml.match(/<p:ph[^/]*?(?:type="([^"]*)")?[^/]*?\/?>/);
    const phType = phMatch ? (phMatch[1] || 'body') : null;

    if ((phType === 'title' || phType === 'ctrTitle') && title) {
      return shapeXml.replace(/<p:txBody[\s\S]*?<\/p:txBody>/, (tb) => replaceTxBodyContent(tb, [title]));
    }
    if ((phType === 'body' || phType === 'subTitle') && bullets.length > 0) {
      return shapeXml.replace(/<p:txBody[\s\S]*?<\/p:txBody>/, (tb) => replaceTxBodyContent(tb, bullets));
    }
    return shapeXml;
  });
}

// ─── ZIP rebuild ──────────────────────────────────────────────────────────────

function buildPopulatedPptx(zipPath, modifiedSlides) {
  // modifiedSlides: [{entryName, modifiedXml}]
  return new Promise(async (resolve, reject) => {
    try {
      const allEntries = await readAllZipEntries(zipPath);
      const overrides = new Map(modifiedSlides.map((s) => [s.entryName, Buffer.from(s.modifiedXml, 'utf8')]));

      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('data', (c) => chunks.push(c));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      for (const [name, buf] of allEntries) {
        archive.append(overrides.get(name) || buf, { name });
      }
      archive.finalize();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  readAllSlideXmls,
  extractSlideText,
  analyseSlideTypes,
  generateSlideContent,
  injectContentIntoSlide,
  buildPopulatedPptx
};
