const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const archiver = require('archiver');
const aiService = require('./aiService');
const aiConfig = require('../config/ai-config');
const PptxGenJS = require('pptxgenjs').default || require('pptxgenjs');

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

// ─── Background styles ────────────────────────────────────────────────────────

function solidFillBg(hex) {
  return `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
}

function gradientFillBg(hex1, hex2, angleDeg = 135) {
  const ang = Math.round(angleDeg * 60000);
  return `<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="${hex1}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${hex2}"/></a:gs></a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>`;
}

const PPTX_BACKGROUNDS = {
  'clean-white':  { isDark: false, textColor: '1F2937', bgXml: solidFillBg('FFFFFF') },
  'warm-sand':    { isDark: false, textColor: '78350F', bgXml: solidFillBg('FEF9C3') },
  'soft-blue':    { isDark: false, textColor: '1E3A8A', bgXml: solidFillBg('EFF6FF') },
  'soft-green':   { isDark: false, textColor: '14532D', bgXml: solidFillBg('F0FDF4') },
  'dark-navy':    { isDark: true,  textColor: 'F8FAFC', bgXml: solidFillBg('0F172A') },
  'charcoal':     { isDark: true,  textColor: 'F9FAFB', bgXml: solidFillBg('1F2937') },
  'deep-purple':  { isDark: true,  textColor: 'EDE9FE', bgXml: solidFillBg('1E1B4B') },
  'forest':       { isDark: true,  textColor: 'DCFCE7', bgXml: solidFillBg('052E16') },
  'ocean':        { isDark: true,  textColor: 'E0F2FE', bgXml: gradientFillBg('1E3A8A', '0E7490') },
  'sunset':       { isDark: true,  textColor: 'FEF3C7', bgXml: gradientFillBg('92400E', '831843') },
  'aurora':       { isDark: true,  textColor: 'D1FAE5', bgXml: gradientFillBg('312E81', '065F46') },
  'slate-sky':    { isDark: true,  textColor: 'BAE6FD', bgXml: gradientFillBg('1E293B', '0369A1') },
  'rose':         { isDark: true,  textColor: 'FFE4E6', bgXml: gradientFillBg('881337', '9A3412') },
  'mint':         { isDark: false, textColor: '065F46', bgXml: gradientFillBg('F0FDF4', 'CCFBF1') },
  'lavender':     { isDark: false, textColor: '4C1D95', bgXml: gradientFillBg('F5F3FF', 'EDE9FE') },
};

function injectBackgroundIntoSlide(xml, bgId) {
  const bg = PPTX_BACKGROUNDS[bgId];
  if (!bg) return xml;
  const bgPattern = /<p:bg\b[\s\S]*?<\/p:bg>/;
  if (bgPattern.test(xml)) return xml.replace(bgPattern, bg.bgXml);
  // Insert before <p:spTree if no existing background
  return xml.replace(/(<p:spTree\b)/, bg.bgXml + '\n$1');
}

// ─── XML injection ────────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildPara(text, textColor) {
  const safe = escapeXml(text);
  if (textColor) {
    return `<a:p><a:r><a:rPr lang="en-US" dirty="0" smtClean="0"><a:solidFill><a:srgbClr val="${textColor}"/></a:solidFill></a:rPr><a:t>${safe}</a:t></a:r></a:p>`;
  }
  return `<a:p><a:r><a:t>${safe}</a:t></a:r></a:p>`;
}

// Replace paragraphs inside a txBody, preserving bodyPr / lstStyle preamble.
function replaceTxBodyContent(txBodyXml, lines, textColor) {
  const cutPoint = txBodyXml.indexOf('<a:p');
  const preamble = cutPoint >= 0 ? txBodyXml.slice(0, cutPoint) : txBodyXml.replace(/<\/p:txBody>\s*$/, '');
  const newParas = lines.map((l) => buildPara(l, textColor)).join('');
  return `${preamble}${newParas}</p:txBody>`;
}

function injectContentIntoSlide(xml, { title, bullets = [], textColor = null }) {
  return xml.replace(/<p:sp\b[\s\S]*?<\/p:sp>/g, (shapeXml) => {
    const phMatch = shapeXml.match(/<p:ph[^/]*?(?:type="([^"]*)")?[^/]*?\/?>/);
    const phType = phMatch ? (phMatch[1] || 'body') : null;

    if ((phType === 'title' || phType === 'ctrTitle') && title) {
      return shapeXml.replace(/<p:txBody[\s\S]*?<\/p:txBody>/, (tb) => replaceTxBodyContent(tb, [title], textColor));
    }
    if ((phType === 'body' || phType === 'subTitle') && bullets.length > 0) {
      return shapeXml.replace(/<p:txBody[\s\S]*?<\/p:txBody>/, (tb) => replaceTxBodyContent(tb, bullets, textColor));
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

// ─── Background extraction from PPTX templates ───────────────────────────────

function isHexDark(hex) {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
}

function extractBgXmlFromSlide(xml) {
  const m = String(xml || '').match(/<p:bg\b[\s\S]*?<\/p:bg>/);
  return m ? m[0] : null;
}

function parseBgElement(bgXml) {
  const s = String(bgXml || '');

  if (s.includes('<a:solidFill>')) {
    const m = s.match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/i);
    if (m) return { type: 'color', hex: m[1].toUpperCase() };
  }

  if (s.includes('<a:gradFill>')) {
    const stops = [];
    const gsRx = /<a:gs pos="(\d+)"[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/ig;
    let m;
    while ((m = gsRx.exec(s)) !== null) stops.push({ pos: parseInt(m[1]), hex: m[2].toUpperCase() });
    if (stops.length >= 2) {
      const angM = s.match(/ang="(\d+)"/);
      return { type: 'gradient', stops, angleDeg: angM ? Math.round(parseInt(angM[1]) / 60000) : 135 };
    }
  }

  if (s.includes('<a:blip')) {
    const m = s.match(/r:embed="([^"]+)"/);
    return { type: 'image', rEmbedId: m ? m[1] : null };
  }

  return null;
}

function bgToPreviewCss(parsed) {
  if (!parsed) return '#E5E7EB';
  if (parsed.type === 'color') return `#${parsed.hex}`;
  if (parsed.type === 'gradient') {
    const stops = parsed.stops.map((s) => `#${s.hex} ${(s.pos / 1000).toFixed(0)}%`);
    return `linear-gradient(${parsed.angleDeg}deg, ${stops.join(', ')})`;
  }
  return '#9CA3AF'; // image placeholder — client replaces with actual URL
}

function parsedBgIsDark(parsed) {
  if (!parsed) return false;
  if (parsed.type === 'color') return isHexDark(parsed.hex);
  if (parsed.type === 'gradient') {
    const darkCount = parsed.stops.filter((s) => isHexDark(s.hex)).length;
    return darkCount >= Math.ceil(parsed.stops.length / 2);
  }
  return false;
}

async function extractTemplateBackgrounds(zipPath, mediaDir) {
  try { fs.mkdirSync(mediaDir, { recursive: true }); } catch (_) {}

  const entries = await listZipEntries(zipPath);
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e))
    .sort((a, b) => {
      const n = (s) => parseInt((s.match(/\d+/) || ['0'])[0]);
      return n(a) - n(b);
    });

  const results = [];
  const seenXml = new Set();
  let imgIdx = 0;

  for (const slideEntry of slideEntries) {
    const slideNum = parseInt((slideEntry.match(/slide(\d+)/) || ['', '0'])[1]);
    const slideXml = (await readZipEntry(zipPath, slideEntry))?.toString('utf8') || '';

    // Try slide background first, then its layout
    let bgXml = extractBgXmlFromSlide(slideXml);

    if (!bgXml) {
      const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
      const relsXml = (await readZipEntry(zipPath, relsPath))?.toString('utf8') || '';
      const layoutM = relsXml.match(/Type="[^"]*slideLayout"[^>]*Target="([^"]+)"/);
      if (layoutM) {
        const layoutPath = 'ppt/slideLayouts/' + path.basename(layoutM[1]);
        const layoutXml = (await readZipEntry(zipPath, layoutPath))?.toString('utf8') || '';
        bgXml = extractBgXmlFromSlide(layoutXml);
      }
    }

    // Skip theme references (bgRef) and duplicates
    if (!bgXml || bgXml.includes('<p:bgRef') || seenXml.has(bgXml)) continue;
    seenXml.add(bgXml);

    const parsed = parseBgElement(bgXml);
    if (!parsed) continue;

    let imageFilename = null;

    if (parsed.type === 'image' && parsed.rEmbedId) {
      const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
      const relsXml = (await readZipEntry(zipPath, relsPath))?.toString('utf8') || '';
      const relM = new RegExp(`Id="${parsed.rEmbedId}"[^>]*Target="([^"]+)"`).exec(relsXml);
      if (relM) {
        const zipTarget = relM[1].startsWith('../') ? 'ppt/' + relM[1].slice(3) : relM[1];
        const imgBuf = await readZipEntry(zipPath, zipTarget);
        if (imgBuf) {
          const ext = path.extname(zipTarget).slice(1) || 'png';
          imageFilename = `bg-${imgIdx++}.${ext}`;
          try { fs.writeFileSync(path.join(mediaDir, imageFilename), imgBuf); } catch (_) {}
        }
      }
    }

    results.push({
      id: `tpl-${results.length}`,
      label: `Style ${results.length + 1}`,
      bgXml,
      isDark: parsedBgIsDark(parsed),
      previewCss: bgToPreviewCss(parsed),
      imageFilename,
      parsed,
    });
  }

  return results;
}

// ─── Fresh slide generation (blank deck via pptxgenjs) ────────────────────────

async function generateFreshSlideContent({ topic, subject = '', level = 'undergraduate', slideCount = 8 }) {
  const cfg = aiConfig.getTaskConfig('contentGeneration');

  const prompt = `Design and generate content for a ${level} lesson on "${topic}"${subject ? ` (${subject})` : ''}.
Create exactly ${slideCount} slides with a logical educational flow.
Choose slide types from: title | learning_objectives | content | question | activity | summary | quiz | transition

For each slide generate:
- slideIndex (0-based, 0 to ${slideCount - 1})
- slideType
- title (clear, assertive heading)
- bullets (3-5 concise points under 15 words each)

Return ONLY valid JSON:
[{"slideIndex":0,"slideType":"title","title":"...","bullets":["..."]}]`;

  const result = await aiService.createCompletionWithRetry({
    provider: cfg.provider,
    model: cfg.model,
    temperature: 0.6,
    maxTokens: Math.min(cfg.maxTokens, 4000),
    messages: [
      { role: 'system', content: 'You generate educational presentation slide content. Return only a valid JSON array.' },
      { role: 'user', content: prompt }
    ]
  }, 3);

  const raw = String(result?.content || '').trim();
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    return JSON.parse(match ? match[0] : raw);
  } catch (_) {
    return Array.from({ length: slideCount }, (_, i) => ({
      slideIndex: i,
      slideType: i === 0 ? 'title' : i === slideCount - 1 ? 'summary' : 'content',
      title: i === 0 ? topic : `Slide ${i + 1}`,
      bullets: ['Content generation failed — please retry.']
    }));
  }
}

// ─── Read ZIP entries from a Buffer (for post-processing pptxgenjs output) ───

function readAllZipEntriesFromBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const map = new Map();
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err || new Error('Cannot read ZIP buffer'));
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return; }
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

// ─── Inject non-solid backgrounds into a pptxgenjs output buffer ─────────────

async function injectBgsIntoBuffer(pptxBuffer, bgInjections, sessionMediaDir) {
  return new Promise(async (resolve, reject) => {
    try {
      const allEntries = await readAllZipEntriesFromBuffer(pptxBuffer);
      const overrides = new Map();
      const newMedia = new Map();

      for (const { slideNum, bgXml, imageFilename } of bgInjections) {
        const slideKey = `ppt/slides/slide${slideNum}.xml`;
        const relsKey = `ppt/slides/_rels/slide${slideNum}.xml.rels`;

        let slideXml = allEntries.get(slideKey)?.toString('utf8') || '';
        let relsXml = allEntries.get(relsKey)?.toString('utf8') || '';
        if (!slideXml) continue;

        let finalBgXml = bgXml;

        if (imageFilename && sessionMediaDir) {
          const imgPath = path.join(sessionMediaDir, imageFilename);
          if (fs.existsSync(imgPath)) {
            const imgBuf = fs.readFileSync(imgPath);
            const ext = path.extname(imageFilename).slice(1) || 'png';
            const mediaName = `bg-slide${slideNum}.${ext}`;
            newMedia.set(`ppt/media/${mediaName}`, imgBuf);

            const RID = 'rId50';
            finalBgXml = bgXml.replace(/r:embed="[^"]*"/, `r:embed="${RID}"`);
            const newRel = `<Relationship Id="${RID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>`;
            relsXml = relsXml.replace('</Relationships>', newRel + '</Relationships>');
            overrides.set(relsKey, Buffer.from(relsXml, 'utf8'));
          }
        }

        const bgPattern = /<p:bg\b[\s\S]*?<\/p:bg>/;
        slideXml = bgPattern.test(slideXml)
          ? slideXml.replace(bgPattern, finalBgXml)
          : slideXml.replace(/(<p:spTree\b)/, finalBgXml + '\n$1');
        overrides.set(slideKey, Buffer.from(slideXml, 'utf8'));
      }

      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('data', (c) => chunks.push(c));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      for (const [name, buf] of allEntries) archive.append(overrides.get(name) || buf, { name });
      for (const [name, buf] of newMedia) archive.append(buf, { name });

      archive.finalize();
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Build fresh slide deck (blank pptxgenjs + injected backgrounds) ──────────

async function buildFreshSlidePptx(content, slideBackgrounds, templateBgs, sessionMediaDir) {
  // Build a unified background lookup: id → { bgXml, isDark, imageFilename, parsed }
  const bgMap = new Map();
  for (const tb of (templateBgs || [])) bgMap.set(tb.id, tb);
  for (const [id, pb] of Object.entries(PPTX_BACKGROUNDS)) {
    bgMap.set(id, { bgXml: pb.bgXml, isDark: pb.isDark, imageFilename: null, parsed: { type: pb.isDark ? 'dark' : 'light' } });
  }

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 16:9

  const bgInjections = []; // slides needing post-process bg injection

  for (let i = 0; i < content.length; i++) {
    const sc = content[i];
    const bgId = slideBackgrounds?.[sc.slideIndex];
    const bg = bgId ? bgMap.get(bgId) : null;
    const isDark = bg?.isDark ?? false;
    const titleColor = isDark ? 'F8FAFC' : '1F2937';
    const bodyColor = isDark ? 'CBD5E1' : '374151';

    const slide = pptx.addSlide();

    slide.addText(String(sc.title || ''), {
      x: 0.4, y: 0.4, w: 9.2, h: 1.1,
      fontSize: 28, bold: true, color: titleColor, fontFace: 'Calibri', valign: 'middle',
    });

    const bullets = (sc.bullets || []).filter(Boolean).slice(0, 6);
    if (bullets.length) {
      slide.addText(
        bullets.map((b) => ({ text: String(b), options: { bullet: true } })),
        { x: 0.4, y: 1.7, w: 9.2, h: 3.5, fontSize: 18, color: bodyColor, fontFace: 'Calibri', valign: 'top' }
      );
    }

    // Solid colour backgrounds can be applied by pptxgenjs directly
    if (bg?.parsed?.type === 'color') {
      slide.background = { color: bg.parsed.hex };
    } else if (bg?.bgXml) {
      // Gradients and image fills need post-processing
      bgInjections.push({ slideNum: i + 1, bgXml: bg.bgXml, imageFilename: bg.imageFilename || null });
    }
  }

  const pptxBuffer = await pptx.write({ outputType: 'nodebuffer' });
  if (!bgInjections.length) return pptxBuffer;
  return injectBgsIntoBuffer(pptxBuffer, bgInjections, sessionMediaDir);
}

module.exports = {
  readAllSlideXmls,
  extractSlideText,
  analyseSlideTypes,
  generateSlideContent,
  generateFreshSlideContent,
  extractTemplateBackgrounds,
  buildFreshSlidePptx,
  injectContentIntoSlide,
  injectBackgroundIntoSlide,
  buildPopulatedPptx,
  PPTX_BACKGROUNDS,
};
