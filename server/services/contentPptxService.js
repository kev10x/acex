/**
 * PPTX generation and template utilities for MarkMate.
 * Extracted from contentService.js to keep that file focused on AI content generation.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const PptxGenJS = require('pptxgenjs').default || require('pptxgenjs');
const yauzl = require('yauzl');
const aiService = require('./aiService');

const PPTX_TEMPLATE_MAX_BYTES = 30 * 1024 * 1024;
const ANTHROPIC_PPTX_BETAS = [
  'code-execution-2025-08-25',
  'files-api-2025-04-14',
  'skills-2025-10-02',
];
const ANTHROPIC_PPTX_MODEL = process.env.ANTHROPIC_PPTX_MODEL || process.env.CONTENT_PPTX_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_PPTX_MAX_TOKENS = Number(process.env.ANTHROPIC_PPTX_MAX_TOKENS || 32000);
const OPENAI_PPTX_MODEL = process.env.OPENAI_PPTX_MODEL || 'gpt-5.2';
const OPENAI_PPTX_MAX_TOKENS = Number(process.env.OPENAI_PPTX_MAX_TOKENS || 16000);
const PPTX_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf8');

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Section field accessors (shared between buildPptx and buildLectureNotesHtml) ---

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

// --- XML / ZIP template parsing utilities ---

function decodeXmlText(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTextFromSlideXml(xml) {
  return [...String(xml || '').matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
    .map((m) => decodeXmlText(m[1]).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function inferTemplateLayoutHint(texts, xml) {
  const joined = texts.join(' ').toLowerCase();
  const shapeCount = (String(xml || '').match(/<p:sp\b/g) || []).length;
  const picCount = (String(xml || '').match(/<p:pic\b/g) || []).length;
  const numericLabels = texts.filter((t) => /^(0?\d+|[a-d])[\).:-]?$/i.test(t.trim())).length;
  if (/thank|closing|questions|contact/.test(joined)) return 'closing';
  if (/agenda|overview|contents/.test(joined)) return 'agenda/section overview';
  if (/quote|"|"|call out|callout/.test(joined)) return 'quote/callout';
  if (/timeline|phase|step|process|sequence/.test(joined) || numericLabels >= 3) return 'timeline/sequence';
  if (/compare|versus|vs\.?|pros|cons/.test(joined)) return 'comparison/split';
  if (picCount > 0 && shapeCount <= 5) return 'image-led';
  if (shapeCount >= 8) return 'multi-cell grid';
  if (shapeCount >= 5) return 'two-column or card layout';
  if (texts.length <= 2) return 'title or section divider';
  return 'single-heading plus body';
}

async function readZipEntryNames(zipPath) {
  return new Promise((resolve) => {
    if (!zipPath || !fs.existsSync(zipPath)) return resolve([]);
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) return resolve([]);
      const names = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        names.push(entry.fileName);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', () => resolve(names));
    });
  });
}

function readZipEntryText(zipPath, entryName) {
  return new Promise((resolve) => {
    if (!zipPath || !fs.existsSync(zipPath)) return resolve(null);
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) return resolve(null);
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        try { zipfile.close(); } catch (_) {}
        resolve(value);
      };
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return finish(null);
          const chunks = [];
          stream.on('data', (d) => chunks.push(Buffer.from(d)));
          stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', () => finish(null));
        });
      });
      zipfile.on('end', () => finish(null));
      zipfile.on('error', () => finish(null));
    });
  });
}

function extractTemplateImages(zipPath, outputDir) {
  return new Promise((resolve) => {
    if (!zipPath || !fs.existsSync(zipPath)) return resolve([]);
    try { fs.mkdirSync(outputDir, { recursive: true }); } catch (_) {}
    const saved = [];
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) return resolve([]);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (!/^ppt\/media\/.+\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        const basename = path.basename(entry.fileName);
        const outPath = path.join(outputDir, basename);
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { zipfile.readEntry(); return; }
          const chunks = [];
          stream.on('data', (d) => chunks.push(Buffer.from(d)));
          stream.on('end', () => {
            try { fs.writeFileSync(outPath, Buffer.concat(chunks)); saved.push(basename); } catch (_) {}
            zipfile.readEntry();
          });
          stream.on('error', () => zipfile.readEntry());
        });
      });
      zipfile.on('end', () => resolve(saved));
      zipfile.on('error', () => resolve(saved));
    });
  });
}

// --- Theme extraction ---

function extractThemeColor(xml, tag, fallback) {
  const rx = new RegExp(`<a:${tag}>[\\s\\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"`, 'i');
  const match = String(xml || '').match(rx);
  return match?.[1] ? `#${match[1].toUpperCase()}` : fallback;
}

function extractThemeFont(xml, sectionTag) {
  const rx = new RegExp(`<a:${sectionTag}>[\\s\\S]*?<a:latin typeface="([^"]+)"`, 'i');
  const match = String(xml || '').match(rx);
  return match?.[1] ? `'${match[1]}'` : null;
}

async function extractTemplateTheme(templatePath) {
  const xml = await readZipEntryText(templatePath, 'ppt/theme/theme1.xml');
  if (!xml) return null;
  const headingColor = extractThemeColor(xml, 'accent1', '#0F172A');
  const textColor = extractThemeColor(xml, 'dk1', '#0F172A');
  const accentColor = extractThemeColor(xml, 'accent2', '#2563EB');
  const bgColor = extractThemeColor(xml, 'lt1', '#F8FAFC');
  const headFont = extractThemeFont(xml, 'majorFont');
  const bodyFont = extractThemeFont(xml, 'minorFont');
  return { headingColor, textColor, accentColor, bgColor, headFont, bodyFont };
}

function pptxThemeToContentTheme(pptxTheme) {
  if (!pptxTheme) return null;
  const rawFont = (pptxTheme.bodyFont || pptxTheme.headFont || '').replace(/^'|'$/g, '');
  return {
    heading_color: pptxTheme.headingColor || '#0F172A',
    text_color: pptxTheme.textColor || '#0F172A',
    accent_color: pptxTheme.accentColor || '#2563EB',
    bg_color: pptxTheme.bgColor || '#F8FAFC',
    surface_color: '#FFFFFF',
    font_family: rawFont ? `'${rawFont}', sans-serif` : "'Segoe UI', sans-serif",
  };
}

async function summarizePptxTemplateForGeneration(templatePath) {
  validatePptxTemplateFile(templatePath);
  const names = await readZipEntryNames(templatePath);
  const slideNames = names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0));
  const theme = await extractTemplateTheme(templatePath);
  const slides = [];
  for (const slideName of slideNames.slice(0, 18)) {
    const xml = await readZipEntryText(templatePath, slideName);
    const texts = extractTextFromSlideXml(xml).slice(0, 8);
    slides.push({
      n: Number(slideName.match(/slide(\d+)\.xml/i)?.[1] || slides.length + 1),
      hint: inferTemplateLayoutHint(texts, xml),
      text: texts
        .filter((text) => !/click to edit|lorem ipsum/i.test(text))
        .slice(0, 5)
        .join(' | ')
        .slice(0, 240),
    });
  }
  const layoutSummary = slides.map((slide) =>
    `Slide ${slide.n}: ${slide.hint}${slide.text ? `; visible text: ${slide.text}` : ''}`
  ).join('\n');
  return [
    `Uploaded PowerPoint template with ${slideNames.length} slide${slideNames.length === 1 ? '' : 's'}.`,
    theme?.headingColor || theme?.accentColor ? `Theme colors/fonts: heading ${theme.headingColor || 'unknown'}, text ${theme.textColor || 'unknown'}, accent ${theme.accentColor || 'unknown'}, head font ${theme.headFont || 'unknown'}, body font ${theme.bodyFont || 'unknown'}.` : '',
    layoutSummary,
    'Generate content that naturally fits these slide shapes. Favor section count and content structures that align with the reusable layouts; avoid text-heavy paragraphs in slide-facing fields.',
  ].filter(Boolean).join('\n').slice(0, 2200);
}

// --- PPTX design helpers: 16:9, one theme, factory opts (no reused objects) ---
const THEME = { primary: '028090', secondary: '00A896', accent: '02C39A', light: 'F0F9F8', dark: '023E4D' };
const SHADOW = () => ({ type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.15, angle: 135 });
const TXT = (opts) => ({ fontSize: 18, bold: false, align: 'left', valign: 'top', wrap: true, breakLine: true, margin: 0, ...opts });

function isRetryableProviderError(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  return status === 429 || (status >= 500 && status <= 599);
}

function getRetryDelayMs(error, attempt) {
  const retryAfter = error?.response?.headers?.['retry-after'] || error?.headers?.['retry-after'];
  const retryAfterMs = Number.parseInt(retryAfter, 10) * 1000;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  return 500 * Math.pow(2, attempt);
}

function fetchWithTimeout(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Image fetch timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    const req = https.get(url, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error(`Image fetch failed with status ${res.statusCode}: ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      res.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function withProviderRetry(operation, maxAttempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableProviderError(error) || attempt >= maxAttempts - 1) break;
      await sleep(getRetryDelayMs(error, attempt));
    }
  }
  throw lastError;
}

function validatePptxTemplateFile(templatePath) {
  if (!templatePath) return;
  const ext = path.extname(String(templatePath)).toLowerCase();
  if (ext !== '.pptx') {
    throw new Error('PowerPoint template must be a .pptx file.');
  }
  const stat = fs.statSync(templatePath);
  if (!stat.isFile()) {
    throw new Error('PowerPoint template file could not be read.');
  }
  if (stat.size > PPTX_TEMPLATE_MAX_BYTES) {
    throw new Error('PowerPoint template must be 30 MB or smaller.');
  }
}

function isValidPptxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  return buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function isValidPptxZipBuffer(buffer) {
  if (!isValidPptxBuffer(buffer)) return Promise.resolve(false);
  return new Promise((resolve) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) return resolve(false);
      zipfile.on('error', () => resolve(false));
      zipfile.on('end', () => resolve(true));
      zipfile.readEntry();
      zipfile.on('entry', () => {
        try { zipfile.close(); } catch (_) {}
        resolve(true);
      });
    });
  });
}

async function responseToBuffer(response) {
  if (Buffer.isBuffer(response)) return response;
  if (response instanceof ArrayBuffer) return Buffer.from(response);
  if (response?.arrayBuffer) return Buffer.from(await response.arrayBuffer());
  if (response?.buffer) return Buffer.from(await response.buffer());
  if (response?.blob) {
    const blob = await response.blob();
    return Buffer.from(await blob.arrayBuffer());
  }
  if (typeof response === 'string') return Buffer.from(response, 'binary');
  throw new Error('Provider returned a generated file in an unsupported response format.');
}

function collectFileIdsFromValue(value, fileIds) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectFileIdsFromValue(item, fileIds));
    return;
  }
  if (typeof value.file_id === 'string' && value.file_id.trim()) {
    fileIds.push(value.file_id.trim());
  }
  Object.values(value).forEach((nested) => collectFileIdsFromValue(nested, fileIds));
}

function extractGeneratedFileIds(response) {
  const fileIds = [];
  const blocks = Array.isArray(response?.content) ? response.content : [];

  // Prefer tool_result / code_execution blocks (the expected location)
  for (const block of blocks) {
    const blockType = String(block?.type || '');
    if (blockType.includes('tool_result') || blockType.includes('code_execution') || blockType.includes('skill')) {
      collectFileIdsFromValue(block, fileIds);
    }
  }

  // If nothing found, scan ALL blocks — the Skills API may use a different block type
  if (fileIds.length === 0) {
    for (const block of blocks) {
      collectFileIdsFromValue(block, fileIds);
    }
  }

  return [...new Set(fileIds)];
}

function collectOpenAiContainerFiles(value, matches, activeContainerId = null) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectOpenAiContainerFiles(item, matches, activeContainerId));
    return;
  }

  const containerId = typeof value.container_id === 'string' ? value.container_id : activeContainerId;
  if (containerId && typeof value.file_id === 'string' && value.file_id.trim()) {
    matches.push({ containerId, fileId: value.file_id.trim() });
  }
  if (containerId && Array.isArray(value.files)) {
    value.files.forEach((file) => {
      if (typeof file?.file_id === 'string' && file.file_id.trim()) {
        matches.push({ containerId, fileId: file.file_id.trim() });
      }
    });
  }
  Object.values(value).forEach((nested) => collectOpenAiContainerFiles(nested, matches, containerId));
}

function extractOpenAiGeneratedFiles(response) {
  const matches = [];
  collectOpenAiContainerFiles(response?.output || response, matches);
  const seen = new Set();
  return matches.filter(({ containerId, fileId }) => {
    const key = `${containerId}:${fileId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildDeckSourceText(content) {
  const sections = (content.sections || []).map((sec, index) => ({
    number: index + 1,
    heading: getSectionAssertion(sec),
    support: getSectionSupport(sec),
  }));

  return JSON.stringify({
    title: content.title || 'Course Content',
    instructions: content.instructions || '',
    sections,
  }, null, 2);
}

function getOpenAiPptxInstructions() {
  const systemPrompt = PPTX_SYSTEM_PROMPT
    .replace(/You have access to the pptx Skill and the code execution\s+tool\s+.*?use them\./s, 'You have access to OpenAI Code Interpreter with the uploaded PowerPoint template available in the container - use it.')
    .replace('6. Deliver. Move the final .pptx to /mnt/user-data/outputs and present it.', '6. Deliver. Save the final .pptx in the code interpreter container and cite or mention the generated file.');

  return [
    systemPrompt,
    'Use Python libraries available in the container to inspect, modify, validate, and save the presentation. The final generated file must be a .pptx.',
  ].join('\n\n');
}

async function createAnthropicBetaMessage(client, request) {
  if (client?.beta?.messages?.stream) {
    const stream = await client.beta.messages.stream(request);
    return stream.finalMessage();
  }
  if (client?.beta?.messages?.create) {
    return client.beta.messages.create(request);
  }
  throw new Error('Anthropic Messages API is not available.');
}

function buildAnthropicPptxRequest({ content, uploadedFileId, messages, containerId, model, maxTokens, isFirstChunk = true, layoutsText = null }) {
  const container = {
    ...(containerId ? { id: containerId } : {}),
    skills: [{ type: 'anthropic', skill_id: 'pptx', version: 'latest' }],
  };
  const textLines = [
    'Populate the uploaded .pptx template with the source content below.',
  ];
  if (layoutsText) {
    textLines.push(
      '',
      'TEMPLATE LAYOUT INVENTORY (pre-extracted — use this to assign each section to the best-fitting slide layout):',
      layoutsText,
      '',
    );
  }
  if (!isFirstChunk) {
    textLines.push('This is a continuation section — do NOT add a title slide or closing/thank-you slide. Start directly with the first section listed below.');
  }
  textLines.push('Return the completed deck as a generated .pptx file.', '', buildDeckSourceText(content));
  const userContent = [
    { type: 'text', text: textLines.join('\n') },
    { type: 'container_upload', file_id: uploadedFileId },
  ];

  return {
    model,
    max_tokens: maxTokens,
    betas: ANTHROPIC_PPTX_BETAS,
    system: PPTX_SYSTEM_PROMPT,
    container,
    messages: messages || [{ role: 'user', content: userContent }],
    tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
  };
}

function buildOpenAiPptxRequest({ content, uploadedFileId, model, maxTokens }) {
  return {
    model,
    instructions: getOpenAiPptxInstructions(),
    max_output_tokens: maxTokens,
    tools: [{
      type: 'code_interpreter',
      container: {
        type: 'auto',
        file_ids: [uploadedFileId],
        memory_limit: '4g',
      },
    }],
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            'Create a finished PowerPoint deck from the uploaded .pptx template and this source content.',
            'Use the uploaded file as the design source and return the final deck as a generated .pptx file.',
            '',
            buildDeckSourceText(content),
          ].join('\n'),
        },
        {
          type: 'input_file',
          file_id: uploadedFileId,
        },
      ],
    }],
  };
}

async function buildPptxWithAnthropic(content, options = {}) {
  const templatePath = options.templatePath;
  validatePptxTemplateFile(templatePath);

  const client = options.anthropicClient || aiService.anthropic;
  if ((!client?.beta?.messages?.stream && !client?.beta?.messages?.create) || !client?.beta?.files?.upload || !client?.beta?.files?.download) {
    throw new Error('Anthropic API key is required to export a PPTX from an uploaded template.');
  }

  const templateFileName = path.basename(templatePath);
  const uploaded = await withProviderRetry(() => client.beta.files.upload({
    file: fs.createReadStream(templatePath),
    betas: ['files-api-2025-04-14'],
  }));
  const uploadedFileId = uploaded?.id;
  if (!uploadedFileId) {
    throw new Error('Anthropic Files API did not return a template file id.');
  }

  const model = options.model || ANTHROPIC_PPTX_MODEL;
  const maxTokens = options.maxTokens || ANTHROPIC_PPTX_MAX_TOKENS || 16000;
  let messages;
  let containerId;
  let response;

  for (let turn = 0; turn < 12; turn++) {
    if (options.onTurn) {
      try { await options.onTurn(turn + 1); } catch (_) {}
    }
    const request = buildAnthropicPptxRequest({
      content,
      uploadedFileId,
      messages,
      containerId,
      model,
      maxTokens,
      isFirstChunk: options.isFirstChunk !== false,
      layoutsText: options.layoutsText || null,
    });
    response = await withProviderRetry(() => createAnthropicBetaMessage(client, request));
    if (response?.container?.id) containerId = response.container.id;
    if (response?.stop_reason !== 'pause_turn') break;
    messages = [
      ...(messages || request.messages),
      { role: 'assistant', content: response.content || [] },
    ];
  }

  if (response?.stop_reason === 'pause_turn') {
    throw new Error('Anthropic paused PPTX generation too many times before returning a deck.');
  }

  const fileIds = extractGeneratedFileIds(response);
  if (fileIds.length === 0) {
    const blockSummary = (Array.isArray(response?.content) ? response.content : [])
      .map((b) => String(b?.type || 'unknown'))
      .join(', ');
    console.warn(`[buildPptxWithAnthropic] No file IDs in response for ${templateFileName}. stop_reason=${response?.stop_reason}. Block types: [${blockSummary}]`);
    throw new Error(`Anthropic did not return a generated PPTX file for ${templateFileName}.`);
  }

  for (const fileId of fileIds) {
    try {
      const downloaded = await withProviderRetry(() => client.beta.files.download(fileId, {
        betas: ['files-api-2025-04-14'],
      }));
      const buffer = await responseToBuffer(downloaded);
      if (await isValidPptxZipBuffer(buffer)) {
        return buffer;
      }
    } catch (downloadErr) {
      console.warn(`[buildPptxWithAnthropic] Failed to download file ${fileId}:`, downloadErr?.message || downloadErr);
    }
  }

  throw new Error('Anthropic returned files, but none were valid non-empty PPTX ZIP files.');
}

/**
 * Upload a template PPTX to Anthropic and ask Claude to extract its slide layout
 * inventory (layout names, placeholder types, best-fit content type).
 * Returns { layoutsText, uploadedFileId } — the text is injected into subsequent
 * populate requests so each chunk assigns content to the right layouts.
 */
async function extractTemplateLayouts(templatePath, options = {}) {
  validatePptxTemplateFile(templatePath);
  const client = options.anthropicClient || aiService.anthropic;
  if ((!client?.beta?.messages?.stream && !client?.beta?.messages?.create) || !client?.beta?.files?.upload) {
    throw new Error('Anthropic API not available for template extraction.');
  }

  const uploaded = await withProviderRetry(() => client.beta.files.upload({
    file: fs.createReadStream(templatePath),
    betas: ['files-api-2025-04-14'],
  }));
  const uploadedFileId = uploaded?.id;
  if (!uploadedFileId) throw new Error('Anthropic Files API did not return a file id for template extraction.');

  const model = options.model || ANTHROPIC_PPTX_MODEL;
  const maxTokens = options.maxTokens || ANTHROPIC_PPTX_MAX_TOKENS;
  const userContent = [
    {
      type: 'text',
      text: [
        'Open the uploaded PowerPoint template with python-pptx.',
        'For each slide layout in the file output a numbered list with:',
        '  • layout index and name',
        '  • placeholder count and types (title / body / picture / other)',
        '  • one short phrase describing the content type this layout suits best',
        '    (e.g. "title slide", "two-column comparison", "4-cell grid", "image + caption")',
        'Output ONLY this list — no code, no narrative. Finish with a blank line.',
      ].join('\n'),
    },
    { type: 'container_upload', file_id: uploadedFileId },
  ];

  const container = { skills: [{ type: 'anthropic', skill_id: 'pptx', version: 'latest' }] };
  let messages;
  let containerId;
  let response;

  for (let turn = 0; turn < 6; turn++) {
    if (options.onTurn) { try { await options.onTurn(turn + 1); } catch (_) {} }
    const request = {
      model,
      max_tokens: maxTokens,
      betas: ANTHROPIC_PPTX_BETAS,
      system: 'You are a PowerPoint template analyst. When asked to inspect a template, use python-pptx to open it and output only the requested layout information — no extra commentary.',
      container: containerId ? { id: containerId, ...container } : container,
      messages: messages || [{ role: 'user', content: userContent }],
      tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
    };
    response = await withProviderRetry(() => createAnthropicBetaMessage(client, request));
    if (response?.container?.id) containerId = response.container.id;
    if (response?.stop_reason !== 'pause_turn') break;
    messages = [
      ...(messages || [{ role: 'user', content: userContent }]),
      { role: 'assistant', content: response.content || [] },
    ];
  }

  const layoutsText = (response?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return { layoutsText, uploadedFileId };
}

/**
 * Merge an ordered array of PPTX buffers (chunk outputs) into a single PPTX.
 * Each buffer is uploaded to the Anthropic Files API; Claude appends the slides
 * in order and returns one combined file.
 */
async function mergePptxWithAnthropic(chunkBuffers, options = {}) {
  if (!chunkBuffers || chunkBuffers.length === 0) throw new Error('No chunk buffers to merge.');
  if (chunkBuffers.length === 1) return chunkBuffers[0];

  const client = options.anthropicClient || aiService.anthropic;
  if ((!client?.beta?.messages?.stream && !client?.beta?.messages?.create) || !client?.beta?.files?.upload || !client?.beta?.files?.download) {
    throw new Error('Anthropic API not available for PPTX merge.');
  }

  const os = require('os');
  const tempPaths = [];
  const uploadedFileIds = [];
  try {
    for (let i = 0; i < chunkBuffers.length; i++) {
      const tempPath = path.join(os.tmpdir(), `_pptx_merge_${Date.now()}_${i}.pptx`);
      fs.writeFileSync(tempPath, chunkBuffers[i]);
      tempPaths.push(tempPath);
      const uploaded = await withProviderRetry(() => client.beta.files.upload({
        file: fs.createReadStream(tempPath),
        betas: ['files-api-2025-04-14'],
      }));
      if (!uploaded?.id) throw new Error(`Anthropic Files API did not return a file ID for chunk ${i + 1}.`);
      uploadedFileIds.push(uploaded.id);
    }
  } finally {
    for (const p of tempPaths) { try { fs.unlinkSync(p); } catch (_) {} }
  }

  const model = options.model || ANTHROPIC_PPTX_MODEL;
  const maxTokens = options.maxTokens || ANTHROPIC_PPTX_MAX_TOKENS;
  const userContent = [
    {
      type: 'text',
      text: [
        `You have ${chunkBuffers.length} PowerPoint files that are sequential sections of a single presentation.`,
        'Combine them into one .pptx file in order: all slides from file 1, then file 2, and so on.',
        'Preserve all slide content, layout, and styling from each file exactly as-is.',
        'Return the merged presentation as a single .pptx file.',
      ].join('\n'),
    },
    ...uploadedFileIds.map((fileId) => ({ type: 'container_upload', file_id: fileId })),
  ];

  const container = {
    skills: [{ type: 'anthropic', skill_id: 'pptx', version: 'latest' }],
  };

  let messages;
  let containerId;
  let response;

  for (let turn = 0; turn < 12; turn++) {
    const request = {
      model,
      max_tokens: maxTokens,
      betas: ANTHROPIC_PPTX_BETAS,
      system: PPTX_SYSTEM_PROMPT,
      container: containerId ? { id: containerId, ...container } : container,
      messages: messages || [{ role: 'user', content: userContent }],
      tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
    };
    response = await withProviderRetry(() => createAnthropicBetaMessage(client, request));
    if (response?.container?.id) containerId = response.container.id;
    if (response?.stop_reason !== 'pause_turn') break;
    messages = [
      ...(messages || [{ role: 'user', content: userContent }]),
      { role: 'assistant', content: response.content || [] },
    ];
  }

  if (response?.stop_reason === 'pause_turn') {
    throw new Error('Anthropic paused PPTX merge too many times before returning a file.');
  }

  const fileIds = extractGeneratedFileIds(response);
  for (const fileId of fileIds) {
    try {
      const downloaded = await withProviderRetry(() => client.beta.files.download(fileId, {
        betas: ['files-api-2025-04-14'],
      }));
      const buffer = await responseToBuffer(downloaded);
      if (await isValidPptxZipBuffer(buffer)) return buffer;
    } catch (downloadErr) {
      console.warn('[mergePptxWithAnthropic] Failed to download file', fileId, downloadErr?.message);
    }
  }

  throw new Error('Anthropic did not return a valid merged PPTX file.');
}

/**
 * Apply a user's PPTX template design onto an already-rendered content PPTX buffer.
 * Claude receives both files and transfers only the visual styling — fonts, colours,
 * backgrounds, decorative shapes — while preserving all slide content exactly.
 */
async function applyTemplateStyleWithClaude(contentBuffer, templatePath, options = {}) {
  validatePptxTemplateFile(templatePath);
  const client = options.anthropicClient || aiService.anthropic;
  if ((!client?.beta?.messages?.stream && !client?.beta?.messages?.create) || !client?.beta?.files?.upload) {
    throw new Error('Anthropic API not available for template style transfer.');
  }

  // Write content buffer to a temp file so we can stream it to the Files API
  const tempPath = path.join(path.dirname(templatePath), `_pptx_content_${Date.now()}.pptx`);
  fs.writeFileSync(tempPath, contentBuffer);

  let contentFileId, templateFileId;
  try {
    const [cu, tu] = await Promise.all([
      withProviderRetry(() => client.beta.files.upload({
        file: fs.createReadStream(tempPath),
        betas: ['files-api-2025-04-14'],
      })),
      withProviderRetry(() => client.beta.files.upload({
        file: fs.createReadStream(templatePath),
        betas: ['files-api-2025-04-14'],
      })),
    ]);
    contentFileId = cu?.id;
    templateFileId = tu?.id;
    if (!contentFileId || !templateFileId) throw new Error('Anthropic Files API did not return file IDs.');
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }

  const model = options.model || ANTHROPIC_PPTX_MODEL;
  const maxTokens = options.maxTokens || ANTHROPIC_PPTX_MAX_TOKENS;
  const userText = [
    'You have two PowerPoint files:',
    '1. content.pptx — a presentation where every slide has its final content (titles and bullet points). Do not change any text.',
    '2. template.pptx — the design template to apply (slide backgrounds, colour scheme, fonts, decorative shapes, layout positioning).',
    '',
    'Task: Transfer the visual design from template.pptx onto every slide in content.pptx.',
    'Rules: preserve all text content exactly; only change visual styling.',
    'Return the restyled presentation as a .pptx file.',
  ].join('\n');

  let messages;
  let containerId;
  let response;

  for (let turn = 0; turn < 12; turn++) {
    const container = {
      ...(containerId ? { id: containerId } : {}),
      skills: [{ type: 'anthropic', skill_id: 'pptx', version: 'latest' }],
    };
    const userContent = [
      { type: 'text', text: userText },
      { type: 'container_upload', file_id: contentFileId },
      { type: 'container_upload', file_id: templateFileId },
    ];
    const request = {
      model,
      max_tokens: maxTokens,
      betas: ANTHROPIC_PPTX_BETAS,
      system: 'You apply PowerPoint design templates to presentations. Transfer visual styling only — never alter text content.',
      container,
      messages: messages || [{ role: 'user', content: userContent }],
      tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
    };
    response = await withProviderRetry(() => createAnthropicBetaMessage(client, request));
    if (response?.container?.id) containerId = response.container.id;
    if (response?.stop_reason !== 'pause_turn') break;
    messages = [
      ...(messages || [{ role: 'user', content: userContent }]),
      { role: 'assistant', content: response.content || [] },
    ];
  }

  const fileIds = extractGeneratedFileIds(response);
  for (const fileId of fileIds) {
    try {
      const downloaded = await withProviderRetry(() => client.beta.files.download(fileId, {
        betas: ['files-api-2025-04-14'],
      }));
      const buf = await responseToBuffer(downloaded);
      if (await isValidPptxZipBuffer(buf)) return buf;
    } catch (downloadErr) {
      console.warn('[applyTemplateStyle] Failed to download file', fileId, downloadErr?.message);
    }
  }

  throw new Error('Claude did not return a valid styled PPTX after style transfer.');
}

async function buildPptxWithOpenAI(content, options = {}) {
  const templatePath = options.templatePath;
  validatePptxTemplateFile(templatePath);

  const client = options.openAIClient || options.openaiClient || aiService.openai;
  if (!client?.responses?.create || !client?.files?.create || !client?.containers?.files?.content?.retrieve) {
    throw new Error('OpenAI API key is required to export a PPTX from an uploaded template with OpenAI.');
  }

  const uploaded = await withProviderRetry(() => client.files.create({
    file: fs.createReadStream(templatePath),
    purpose: 'assistants',
  }));
  const uploadedFileId = uploaded?.id;
  if (!uploadedFileId) {
    throw new Error('OpenAI Files API did not return a template file id.');
  }

  const response = await withProviderRetry(() => client.responses.create(buildOpenAiPptxRequest({
    content,
    uploadedFileId,
    model: options.model || OPENAI_PPTX_MODEL,
    maxTokens: options.maxTokens || OPENAI_PPTX_MAX_TOKENS || 16000,
  })));

  if (response?.status === 'failed') {
    throw new Error(response?.error?.message || 'OpenAI failed to generate the PPTX.');
  }
  if (response?.status === 'incomplete') {
    throw new Error(response?.incomplete_details?.reason || 'OpenAI returned an incomplete PPTX generation response.');
  }

  const generatedFiles = extractOpenAiGeneratedFiles(response);
  if (generatedFiles.length === 0) {
    throw new Error('OpenAI did not return a generated PPTX container file.');
  }

  for (const { containerId, fileId } of generatedFiles) {
    const downloaded = await withProviderRetry(() => client.containers.files.content.retrieve(containerId, fileId));
    const buffer = await responseToBuffer(downloaded);
    if (await isValidPptxZipBuffer(buffer)) {
      return buffer;
    }
  }

  throw new Error('OpenAI returned files, but none were valid non-empty PPTX ZIP files.');
}

/**
 * Build a PowerPoint buffer: 16:9, one section per slide.
 * Deliberately unstyled (no background colours, no decorative shapes) so the
 * presenter can apply their own PowerPoint theme.  Each slide has a title text
 * box, bullet-point body text, and — when an image is available — the image in
 * a right-hand column.
 */
async function buildPptx(content, options = {}) {
  if (options?.templatePath && !options?.forceLocal) {
    if (options.provider === 'openai') {
      return buildPptxWithOpenAI(content, options);
    }
    // Anthropic path — auto-fallback to OpenAI on any failure
    try {
      return await buildPptxWithAnthropic(content, options);
    } catch (anthropicErr) {
      const hasOpenAI = !!(aiService.openai?.responses?.create);
      if (hasOpenAI) {
        console.warn('[buildPptx] Anthropic PPTX failed — falling back to OpenAI:', anthropicErr.message);
        return buildPptxWithOpenAI(content, options);
      }
      throw anthropicErr;
    }
  }

  const pptx = new PptxGenJS();
  const title = content.title || 'Course Content';
  const templateTheme = options?.templatePath ? await extractTemplateTheme(options.templatePath) : null;
  const headingColor = (templateTheme?.headingColor || '').replace('#', '') || '1E293B';
  const textColor = (templateTheme?.textColor || '').replace('#', '') || '111827';
  const accentColor = (templateTheme?.accentColor || '').replace('#', '') || '2563EB';
  if (templateTheme?.headFont || templateTheme?.bodyFont) {
    pptx.theme = {
      headFontFace: templateTheme?.headFont ? templateTheme.headFont.replace(/^'|'$/g, '') : 'Aptos Display',
      bodyFontFace: templateTheme?.bodyFont ? templateTheme.bodyFont.replace(/^'|'$/g, '') : 'Aptos',
      lang: 'en-US',
    };
  }
  pptx.title = title;
  pptx.author = 'MarkMate';
  pptx.subject = title;
  pptx.layout = 'LAYOUT_16x9';

  const m = 0.5;        // margin (inches)
  const w = 10;         // slide width
  const h = 5.625;      // slide height
  const contentW = w - 2 * m;
  const TITLE_H = 0.9;
  const BODY_Y = m + TITLE_H + 0.1;
  const BODY_H = h - BODY_Y - m;

  // --- Title slide ---
  const s0 = pptx.addSlide();
  s0.addText(title, {
    x: m, y: 1.6, w: contentW, h: 1.5,
    fontSize: 36, bold: true, align: 'center', valign: 'middle', wrap: true, color: headingColor
  });
  if (content.instructions) {
    s0.addText(content.instructions, {
      x: m, y: 3.3, w: contentW, h: 0.9,
      fontSize: 14, align: 'center', wrap: true, color: textColor
    });
  }

  // --- Content slides ---
  const sections = content.sections || [];

  // Pre-fetch any external image URLs so PptxGenJS never calls https.get() without a timeout.
  // PptxGenJS's built-in https.get has no timeout — expired or unreachable URLs hang forever.
  const externalImageUrls = new Set();
  for (const sec of sections) {
    for (const v of (Array.isArray(sec.visuals) ? sec.visuals : [])) {
      const u = String(v.image_url || '').trim();
      if (u && !u.startsWith('data:')) externalImageUrls.add(u);
    }
  }
  const prefetchedImages = new Map();
  await Promise.all([...externalImageUrls].map(async (url) => {
    try {
      const buf = await fetchWithTimeout(url, 10000);
      prefetchedImages.set(url, `data:image/png;base64,${buf.toString('base64')}`);
    } catch (_) {
      // Skip image — prevents PptxGenJS from hanging on expired/unreachable URLs
    }
  }));

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const heading = getSectionAssertion(sec);
    const body = getSectionBody(sec) || getSectionSupport(sec);
    const support = getSectionSupport(sec);
    const visuals = Array.isArray(sec.visuals) ? sec.visuals : [];
    const imageVisual = visuals.find(v => v.image_url && String(v.image_url).trim());

    const slide = pptx.addSlide();
    const layoutVariant = i % 3; // rotate layouts for less uniform output

    // Title
    slide.addText(heading, {
      x: m, y: m, w: contentW, h: TITLE_H,
      fontSize: 24, bold: true, valign: 'middle', wrap: true, color: headingColor
    });
    if (support) {
      slide.addText(support, {
        x: m, y: m + TITLE_H - 0.1, w: contentW, h: 0.35,
        fontSize: 12, italic: true, valign: 'top', wrap: true, color: accentColor
      });
    }

    // Body paragraphs as bullets (up to 6, capped at 220 chars each)
    const paras = body.split(/\n+/).map(p => p.trim()).filter(Boolean).slice(0, 6);
    const bulletText = paras.map(p => p.length > 220 ? p.slice(0, 217) + '…' : p).join('\n');

    if (imageVisual) {
      const imgUrl = imageVisual.image_url;
      const resolvedData = imgUrl.startsWith('data:') ? imgUrl : prefetchedImages.get(imgUrl) ?? null;
      // Skip images that couldn't be resolved to a data URI (avoids PptxGenJS fetch hang)
      if (!resolvedData) {
        slide.addText(bulletText, {
          x: m, y: BODY_Y, w: contentW, h: BODY_H,
          fontSize: 14, valign: 'top', wrap: true, color: textColor,
          bullet: { type: 'bullet', indent: 10 }
        });
        continue;
      }
      const imgSpec = { data: resolvedData };

      if (layoutVariant === 0) {
        // Split: text left, image right
        const textW = contentW * 0.55;
        const imgX = m + textW + 0.2;
        const imgW = contentW - textW - 0.2;
        slide.addText(bulletText, {
          x: m, y: BODY_Y, w: textW, h: BODY_H,
          fontSize: 14, valign: 'top', wrap: true, color: textColor,
          bullet: { type: 'bullet', indent: 10 }
        });
        slide.addImage({
          ...imgSpec,
          x: imgX, y: BODY_Y, w: imgW, h: BODY_H - 0.3,
          sizing: { type: 'contain', w: imgW, h: BODY_H - 0.3 }
        });
      } else if (layoutVariant === 1) {
        // Hero image top, text band below
        const imgH = BODY_H * 0.56;
        slide.addImage({
          ...imgSpec,
          x: m, y: BODY_Y, w: contentW, h: imgH,
          sizing: { type: 'cover', w: contentW, h: imgH }
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: m, y: BODY_Y + imgH + 0.1, w: contentW, h: BODY_H - imgH - 0.1,
          fill: { color: 'F8FAFC', transparency: 8 },
          line: { color: accentColor, transparency: 65, pt: 1 }
        });
        slide.addText(bulletText, {
          x: m + 0.15, y: BODY_Y + imgH + 0.2, w: contentW - 0.3, h: BODY_H - imgH - 0.3,
          fontSize: 13, valign: 'top', wrap: true, color: textColor,
          bullet: { type: 'bullet', indent: 10 }
        });
      } else {
        // Split: image left, text right
        const imgW = contentW * 0.45;
        const textX = m + imgW + 0.2;
        const textW = contentW - imgW - 0.2;
        slide.addImage({
          ...imgSpec,
          x: m, y: BODY_Y, w: imgW, h: BODY_H - 0.3,
          sizing: { type: 'contain', w: imgW, h: BODY_H - 0.3 }
        });
        slide.addText(bulletText, {
          x: textX, y: BODY_Y, w: textW, h: BODY_H,
          fontSize: 14, valign: 'top', wrap: true, color: textColor,
          bullet: { type: 'bullet', indent: 10 }
        });
      }

      if (imageVisual.title) {
        slide.addText(imageVisual.title, {
          x: m, y: h - m - 0.28, w: contentW, h: 0.28,
          fontSize: 9, align: 'center', italic: true, wrap: true, color: accentColor
        });
      }
    } else {
      slide.addText(bulletText, {
        x: m, y: BODY_Y, w: contentW, h: BODY_H,
        fontSize: 14, valign: 'top', wrap: true, color: textColor,
        bullet: { type: 'bullet', indent: 10 }
      });
    }
  }

  // --- Quiz slide ---
  if (content.quiz && content.quiz.questions && content.quiz.questions.length > 0) {
    const qSlide = pptx.addSlide();
    qSlide.addText('Knowledge Check', {
      x: m, y: m, w: contentW, h: TITLE_H,
      fontSize: 24, bold: true, valign: 'middle', wrap: true, color: headingColor
    });
    const quizText = content.quiz.questions
      .map((q, idx) => `${idx + 1}. ${q.question || ''}`)
      .join('\n');
    qSlide.addText(quizText, {
      x: m, y: BODY_Y, w: contentW, h: BODY_H,
      fontSize: 14, valign: 'top', wrap: true, color: textColor
    });
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
  buildPptx,
  buildPptxWithAnthropic,
  buildPptxWithOpenAI,
  extractTemplateLayouts,
  mergePptxWithAnthropic,
  applyTemplateStyleWithClaude,
  buildLectureNotesHtml,
  extractTemplateTheme,
  extractTemplateImages,
  extractGeneratedFileIds,
  extractOpenAiGeneratedFiles,
  isValidPptxBuffer,
  isValidPptxZipBuffer,
  pptxThemeToContentTheme,
  summarizePptxTemplateForGeneration,
};
