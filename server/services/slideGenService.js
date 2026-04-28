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

// Approximate hex values for Office theme scheme colour names
const SCHEME_COLOR_HEX = {
  dk1: '000000', dk2: '1F497D', lt1: 'FFFFFF', lt2: 'EEECE1',
  accent1: '4F81BD', accent2: 'C0504D', accent3: '9BBB59',
  accent4: '8064A2', accent5: '4BACC6', accent6: 'F79646',
  hlink: '0563C1', folHlink: '954F72',
};

function extractBgXmlFromSlide(xml) {
  const m = String(xml || '').match(/<p:bg\b[\s\S]*?<\/p:bg>/);
  return m ? m[0] : null;
}

function resolveColorFromBlock(block) {
  // Explicit hex
  const hexM = block.match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/i);
  if (hexM) return hexM[1].toUpperCase();
  // System color — use lastClr which stores the resolved hex
  const sysM = block.match(/<a:sysClr[^>]*lastClr="([0-9A-Fa-f]{6})"/i);
  if (sysM) return sysM[1].toUpperCase();
  // Scheme color — approximate from known map
  const schemeM = block.match(/<a:schemeClr val="([^"]+)"/);
  if (schemeM) return SCHEME_COLOR_HEX[schemeM[1]] || '6B7280';
  return null;
}

function parseBgElement(bgXml) {
  const s = String(bgXml || '');

  if (s.includes('<a:solidFill>')) {
    const fillBlock = s.match(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/);
    if (fillBlock) {
      const hex = resolveColorFromBlock(fillBlock[1]);
      if (hex) return { type: 'color', hex };
    }
  }

  if (s.includes('<a:gradFill>')) {
    const stops = [];
    const gsBlockRx = /<a:gs pos="(\d+)">([\s\S]*?)<\/a:gs>/g;
    let gsM;
    while ((gsM = gsBlockRx.exec(s)) !== null) {
      const hex = resolveColorFromBlock(gsM[2]);
      if (hex) stops.push({ pos: parseInt(gsM[1]), hex });
    }
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
  return '#9CA3AF'; // image — client replaces with actual URL
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

const TEMPLATE_IMAGE_EXT_RX = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

function normalizeZipTarget(entryName, relTarget) {
  const rawTarget = String(relTarget || '').replace(/\\/g, '/');
  if (!rawTarget) return null;
  if (/^[a-z]+:\/\//i.test(rawTarget)) return null; // external URL targets

  if (rawTarget.startsWith('/')) return rawTarget.replace(/^\/+/, '');

  const fromDir = entryName.includes('/') ? entryName.slice(0, entryName.lastIndexOf('/')) : '';
  const base = fromDir ? fromDir.split('/') : [];
  for (const part of rawTarget.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (base.length) base.pop();
      continue;
    }
    base.push(part);
  }
  return base.join('/');
}

async function extractTemplateBackgrounds(zipPath, mediaDir) {
  try { fs.mkdirSync(mediaDir, { recursive: true }); } catch (_) {}

  const entries = await listZipEntries(zipPath);
  const results = [];
  const seenXml = new Set();
  let imgIdx = 0;

  const byNum = (a, b) => {
    const n = (s) => parseInt((s.match(/(\d+)\.xml$/) || ['', '0'])[1]);
    return n(a) - n(b);
  };

  // Process masters → layouts → slides so per-slide overrides appear last (dedup keeps first seen)
  const masterEntries = entries.filter((e) => (/^ppt\/slideMasters\/slideMaster\d+\.xml$/i).test(e)).sort(byNum);
  const layoutEntries = entries.filter((e) => (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/i).test(e)).sort(byNum);
  const slideEntries  = entries.filter((e) => (/^ppt\/slides\/slide\d+\.xml$/i).test(e)).sort(byNum);

  const sources = [...masterEntries, ...layoutEntries, ...slideEntries];

  for (const entryName of sources) {
    const xml = (await readZipEntry(zipPath, entryName))?.toString('utf8') || '';
    const bgXml = extractBgXmlFromSlide(xml);

    // Skip theme-ref backgrounds (cannot be rendered without full theme resolution)
    if (!bgXml || bgXml.includes('<p:bgRef') || seenXml.has(bgXml)) continue;
    seenXml.add(bgXml);

    const parsed = parseBgElement(bgXml);
    if (!parsed) continue;

    let imageFilename = null;
    let sourceZipEntry = null;

    if (parsed.type === 'image' && parsed.rEmbedId) {
      // Build rels path: same directory + _rels/ + basename + .rels
      const dirPart = entryName.slice(0, entryName.lastIndexOf('/') + 1);
      const basePart = entryName.slice(entryName.lastIndexOf('/') + 1);
      const relsPath = `${dirPart}_rels/${basePart}.rels`;
      const relsXml = (await readZipEntry(zipPath, relsPath))?.toString('utf8') || '';
      const relM = new RegExp(`Id="${parsed.rEmbedId}"[^>]*Target="([^"]+)"`).exec(relsXml);
      if (relM) {
        const zipTarget = normalizeZipTarget(entryName, relM[1]);
        const imgBuf = zipTarget ? await readZipEntry(zipPath, zipTarget) : null;
        if (imgBuf) {
          const ext = path.extname(zipTarget).slice(1) || 'png';
          imageFilename = `bg-${imgIdx++}.${ext}`;
          sourceZipEntry = zipTarget;
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
      sourceZipEntry,
      parsed,
    });
  }

  return results;
}

function extensionToMime(ext) {
  const clean = String(ext || '').toLowerCase().replace(/^\./, '');
  if (clean === 'jpg' || clean === 'jpeg') return 'image/jpeg';
  if (clean === 'png') return 'image/png';
  if (clean === 'gif') return 'image/gif';
  if (clean === 'webp') return 'image/webp';
  if (clean === 'bmp') return 'image/bmp';
  if (clean === 'svg') return 'image/svg+xml';
  return 'image/png';
}

const VISION_MAX_BYTES = 2 * 1024 * 1024; // skip images > 2 MB — keeps base64 payload small

async function describeImageWithVision(buffer, mimeType) {
  if (!buffer || !buffer.length) return null;
  if (buffer.length > VISION_MAX_BYTES) return null; // avoid huge base64 strings in memory
  if (!aiService?.openai) return null;

  const cfg = aiConfig.getTaskConfig('visionOCR', 'openai');
  const b64 = buffer.toString('base64');

  const result = await aiService.createCompletionWithRetry({
    provider: 'openai',
    model: cfg.model,
    temperature: 0.1,
    maxTokens: Math.min(cfg.maxTokens, 300),
    messages: [
      {
        role: 'system',
        content: 'You classify template images extracted from PowerPoint. Return only strict JSON.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Return JSON object: {"shortLabel":"...","description":"...","likelyBackground":true|false}. Keep shortLabel <= 6 words and description <= 20 words.'
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${b64}` }
          }
        ]
      }
    ]
  }, 2);

  const raw = String(result?.content || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  return {
    shortLabel: String(parsed.shortLabel || '').trim(),
    description: String(parsed.description || '').trim(),
    likelyBackground: !!parsed.likelyBackground,
  };
}

const MAX_TEMPLATE_IMAGES = 20;  // hard cap on images extracted per template
const IMAGE_FILE_MAX_BYTES = 8 * 1024 * 1024; // skip writing images > 8 MB (background fill unlikely)

async function extractTemplateImages(zipPath, mediaDir, { backgroundZipEntries = new Set(), useVision = true, maxVisionAssets = 4 } = {}) {
  try { fs.mkdirSync(mediaDir, { recursive: true }); } catch (_) {}

  const entries = await listZipEntries(zipPath);
  const imageEntries = entries
    .filter((e) => /^ppt\/media\/.+/i.test(e) && TEMPLATE_IMAGE_EXT_RX.test(e))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, MAX_TEMPLATE_IMAGES);

  const results = [];
  for (const entryName of imageEntries) {
    const imgBuf = await readZipEntry(zipPath, entryName);
    if (!imgBuf || !imgBuf.length) continue;
    if (imgBuf.length > IMAGE_FILE_MAX_BYTES) continue; // skip giant files

    const ext = path.extname(entryName).toLowerCase() || '.png';
    const filename = `asset-${results.length}${ext}`;
    try { fs.writeFileSync(path.join(mediaDir, filename), imgBuf); } catch (_) {}

    const mimeType = extensionToMime(ext);
    const sizeBytes = imgBuf.length;
    const asset = {
      id: `img-${results.length}`,
      label: path.basename(entryName),
      filename,
      sourceZipEntry: entryName,
      mimeType,
      sizeBytes,
      usedAsBackground: backgroundZipEntries.has(entryName),
      vision: null,
    };

    if (useVision && results.length < maxVisionAssets) {
      try {
        // Pass buffer directly — describeImageWithVision skips if > VISION_MAX_BYTES
        asset.vision = await describeImageWithVision(imgBuf, mimeType);
      } catch (_) {
        // Non-fatal
      }
    }
    // imgBuf goes out of scope here — GC can reclaim it before next iteration

    results.push(asset);
  }

  return results;
}

async function extractTemplateAssets(zipPath, mediaDir, options = {}) {
  const backgrounds = await extractTemplateBackgrounds(zipPath, mediaDir);
  const backgroundZipEntries = new Set(
    backgrounds.map((b) => b.sourceZipEntry).filter(Boolean)
  );
  const images = await extractTemplateImages(zipPath, mediaDir, {
    backgroundZipEntries,
    useVision: options.useVision !== false,
    maxVisionAssets: Number.isFinite(options.maxVisionAssets) ? options.maxVisionAssets : 8,
  });
  return { backgrounds, images };
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

function normaliseAssetText(value) {
  return String(value || '').trim().toLowerCase();
}

function assetHasAnyToken(asset, tokens) {
  const joined = [
    asset?.label,
    asset?.sourceZipEntry,
    asset?.vision?.shortLabel,
    asset?.vision?.description,
  ].map((v) => normaliseAssetText(v)).join(' ');
  return tokens.some((t) => joined.includes(t));
}

function chooseTemplateAssetsForSlides(templateImages, sessionMediaDir) {
  if (!Array.isArray(templateImages) || !sessionMediaDir) {
    return { logo: null, heroPool: [] };
  }

  const existing = templateImages.filter((img) => {
    if (!img?.filename) return false;
    const fullPath = path.join(sessionMediaDir, img.filename);
    return fs.existsSync(fullPath);
  });
  if (!existing.length) return { logo: null, heroPool: [] };

  const visualCandidates = existing.filter((img) => !(img.usedAsBackground || img?.vision?.likelyBackground));
  const pool = visualCandidates.length ? visualCandidates : existing;

  const logoTokens = ['logo', 'brand', 'wordmark', 'emblem', 'icon'];
  const logo = pool.find((img) => assetHasAnyToken(img, logoTokens)) || null;
  const heroPool = pool
    .filter((img) => !logo || img.filename !== logo.filename)
    .slice(0, 10);

  return { logo, heroPool };
}

function chooseHeroAssetForSlide(heroPool, slideType, index) {
  if (!heroPool.length) return null;
  const type = String(slideType || '').toLowerCase();
  if (type === 'title' || type === 'transition') return heroPool[index % heroPool.length];
  if (type === 'learning_objectives' || type === 'summary') return heroPool[(index + 1) % heroPool.length];
  return null;
}

// Build fresh slide deck (blank pptxgenjs + injected backgrounds)

async function buildFreshSlidePptx(content, slideBackgrounds, templateBgs, templateImagesOrSessionDir, maybeSessionMediaDir) {
  // Backward-compatible signature:
  // buildFreshSlidePptx(content, slideBackgrounds, templateBgs, sessionMediaDir)
  // buildFreshSlidePptx(content, slideBackgrounds, templateBgs, templateImages, sessionMediaDir)
  const templateImages = Array.isArray(templateImagesOrSessionDir) ? templateImagesOrSessionDir : [];
  const sessionMediaDir = Array.isArray(templateImagesOrSessionDir) ? maybeSessionMediaDir : templateImagesOrSessionDir;

  // Build a unified background lookup: id -> { bgXml, isDark, imageFilename, parsed }
  const bgMap = new Map();
  for (const tb of (templateBgs || [])) bgMap.set(tb.id, tb);
  for (const [id, pb] of Object.entries(PPTX_BACKGROUNDS)) {
    bgMap.set(id, { bgXml: pb.bgXml, isDark: pb.isDark, imageFilename: null, parsed: { type: pb.isDark ? 'dark' : 'light' } });
  }

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 16:9

  const bgInjections = []; // slides needing post-process bg injection
  const { logo, heroPool } = chooseTemplateAssetsForSlides(templateImages, sessionMediaDir);
  const logoPath = logo?.filename && sessionMediaDir ? path.join(sessionMediaDir, logo.filename) : null;
  const hasLogo = !!(logoPath && fs.existsSync(logoPath));

  for (let i = 0; i < content.length; i++) {
    const sc = content[i];
    const bgId = slideBackgrounds?.[sc.slideIndex];
    const bg = bgId ? bgMap.get(bgId) : null;
    const isDark = bg?.isDark ?? false;
    const titleColor = isDark ? 'F8FAFC' : '1F2937';
    const bodyColor = isDark ? 'CBD5E1' : '374151';
    const hero = chooseHeroAssetForSlide(heroPool, sc.slideType, i);
    const heroPath = hero?.filename && sessionMediaDir ? path.join(sessionMediaDir, hero.filename) : null;
    const hasHero = !!(heroPath && fs.existsSync(heroPath));
    const textW = hasHero ? 8.7 : 9.2;

    const slide = pptx.addSlide();

    slide.addText(String(sc.title || ''), {
      x: 0.4, y: 0.4, w: textW, h: 1.1,
      fontSize: 28, bold: true, color: titleColor, fontFace: 'Calibri', valign: 'middle',
    });

    const bullets = (sc.bullets || []).filter(Boolean).slice(0, 6);
    if (bullets.length) {
      slide.addText(
        bullets.map((b) => ({ text: String(b), options: { bullet: true } })),
        { x: 0.4, y: 1.7, w: textW, h: 3.5, fontSize: 18, color: bodyColor, fontFace: 'Calibri', valign: 'top' }
      );
    }

    if (hasHero) {
      const type = String(sc.slideType || '').toLowerCase();
      const isTitleLike = type === 'title' || type === 'transition';
      const hx = 9.5;
      const hy = isTitleLike ? 1.1 : 1.5;
      const hw = 3.3;
      const hh = isTitleLike ? 5.6 : 4.8;
      slide.addImage({
        path: heroPath,
        x: hx, y: hy, w: hw, h: hh,
        sizing: { type: 'contain', w: hw, h: hh }
      });
    }

    if (hasLogo) {
      slide.addImage({
        path: logoPath,
        x: 11.0, y: 0.15, w: 2.0, h: 0.6,
        sizing: { type: 'contain', w: 2.0, h: 0.6 }
      });
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
  extractTemplateAssets,
  buildFreshSlidePptx,
  injectContentIntoSlide,
  injectBackgroundIntoSlide,
  buildPopulatedPptx,
  PPTX_BACKGROUNDS,
};

