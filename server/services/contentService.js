/**
 * Content generation and export: AI-generated course content, PPTX, lecture notes.
 */

const crypto = require('crypto');
const fs = require('fs');
const aiService = require('./aiService');
const aiConfig = require('../config/ai-config');
const PptxGenJS = require('pptxgenjs').default || require('pptxgenjs');
const yauzl = require('yauzl');

const IMAGE_MODEL = 'gpt-image-1';
const IMAGE_SIZE = '1024x1024';
const IMAGE_CONCURRENCY = 3;

async function generateImageForVisual(prompt) {
  const client = aiService.openai;
  if (!client) return null;
  try {
    const safePrompt = `Educational illustration for a course slide. ${String(prompt || '').slice(0, 900)}. Clean, professional, suitable for all ages. No text overlays.`;
    const response = await client.images.generate({
      model: IMAGE_MODEL,
      prompt: safePrompt,
      n: 1,
      size: IMAGE_SIZE,
      response_format: 'b64_json',
    });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.warn('Image generation failed (non-fatal):', err?.message || err);
    return null;
  }
}

/**
 * After content generation, fill in image_url for every `image` visual using DALL-E.
 * Runs in parallel per section, non-fatal (skips on error).
 */
async function enrichContentWithImages(content) {
  const sections = content?.sections;
  if (!Array.isArray(sections)) return content;

  // Collect all image visuals that need generation, cap concurrent DALL-E calls.
  const tasks = [];
  sections.forEach((section, si) => {
    (section.visuals || []).forEach((visual, vi) => {
      if (visual.kind === 'image' && !(visual.image_url && !visual.image_url.startsWith('data:image/svg'))) {
        tasks.push({ si, vi, prompt: visual.prompt });
      }
    });
  });

  const results = new Map();
  for (let i = 0; i < tasks.length; i += IMAGE_CONCURRENCY) {
    const batch = tasks.slice(i, i + IMAGE_CONCURRENCY);
    await Promise.all(
      batch.map(async (task) => {
        const url = await generateImageForVisual(task.prompt);
        if (url) results.set(`${task.si}:${task.vi}`, url);
      })
    );
  }

  const enrichedSections = sections.map((section, si) => {
    const visuals = (section.visuals || []).map((visual, vi) => {
      const url = results.get(`${si}:${vi}`);
      return url ? { ...visual, image_url: url } : visual;
    });
    return { ...section, visuals };
  });

  return { ...content, sections: enrichedSections };
}
const CONTENT_TEMPLATES = {
  classroom: {
    id: 'classroom',
    name: 'Classroom Fresh',
    theme: {
      font_family: "'Trebuchet MS', 'Segoe UI', sans-serif",
      bg_color: '#F8FAFC',
      surface_color: '#FFFFFF',
      heading_color: '#0F766E',
      text_color: '#0F172A',
      accent_color: '#14B8A6',
    },
  },
  corporate: {
    id: 'corporate',
    name: 'Corporate Crisp',
    theme: {
      font_family: "'Calibri', 'Segoe UI', sans-serif",
      bg_color: '#F3F4F6',
      surface_color: '#FFFFFF',
      heading_color: '#1D4ED8',
      text_color: '#111827',
      accent_color: '#2563EB',
    },
  },
  playful: {
    id: 'playful',
    name: 'Playful Bright',
    theme: {
      font_family: "'Verdana', 'Segoe UI', sans-serif",
      bg_color: '#FFF7ED',
      surface_color: '#FFFFFF',
      heading_color: '#C2410C',
      text_color: '#431407',
      accent_color: '#FB923C',
    },
  },
};

/**
 * Attempt to repair common JSON syntax errors from AI responses.
 * @param {string} jsonStr - The potentially malformed JSON string
 * @returns {string} - Repaired JSON string or original if unrepairable
 */
function repairJson(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return jsonStr;

  let repaired = jsonStr.trim();

  // Remove trailing commas before closing braces/brackets
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // Fix missing commas between properties (common AI truncation issue)
  // Look for patterns like "value"}"property": or "value"]"property":
  repaired = repaired.replace(/("[^"]*")\s*([}\]])\s*"([^"]*)":/g, '$1$2,"$3":');

  // Fix incomplete objects - if ends with a property without closing, try to close it
  if (repaired.endsWith(':')) {
    repaired = repaired.slice(0, -1) + ': null}';
  }

  // Fix unclosed strings - if odd number of quotes at end, close the string
  const quoteCount = (repaired.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) {
    repaired += '"';
  }

  // Handle incomplete array elements - if ends with [" or , " without closing
  if (repaired.match(/\[[\s\S]*"[^"]*$/) && !repaired.endsWith(']')) {
    // Find the last incomplete array and complete it
    const lastArrayMatch = repaired.match(/(":\s*\[[\s\S]*"[^"]*)$/);
    if (lastArrayMatch) {
      const arrayPart = lastArrayMatch[1];
      const completeArray = arrayPart + '"]';
      repaired = repaired.replace(lastArrayMatch[1], completeArray);
    }
  }

  // Handle incomplete object properties - if ends with ,"key": without value
  if (repaired.match(/"[^"]*":\s*$/)) {
    repaired = repaired.replace(/"([^"]*)":\s*$/, '"$1": null}');
  }

  // Try to complete incomplete JSON structures
  const openBraces = (repaired.match(/{/g) || []).length;
  const closeBraces = (repaired.match(/}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;

  // Add missing closing braces
  for (let i = 0; i < openBraces - closeBraces; i++) {
    repaired += '}';
  }

  // Add missing closing brackets
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    repaired += ']';
  }

  // If it still doesn't start with {, wrap it
  if (!repaired.trim().startsWith('{')) {
    repaired = '{' + repaired + '}';
  }

  return repaired;
}

/**
 * Generate course content (sections + optional quiz) using AI.
 * @param {object} opts - { topics, level, numSections, rubricContext?, title? }
 * @returns {Promise<{ title, instructions, sections: [{ title, body }], quiz?: { questions } }>}
 */
async function generateContentWithAI(opts) {
  const { topics, level = '', numSections = 5, rubricContext = '', title: suggestedTitle = '', templateId = 'classroom', includeDiagrams = true, includeImages = true } = opts;
  const config = aiConfig.getTaskConfig('contentGeneration', 'openai');
  const compactTopics = String(topics || '').trim().slice(0, 1200);
  const compactRubricContext = String(rubricContext || '').trim().slice(0, 1200);
  const prompt = `You are an expert educator creating course/lecture content for students. Use the assertion-evidence model of slide design (Carnegie Mellon): each slide has ONE clear message in a complete sentence, with minimal supporting text-no long bullet lists or text-heavy slides.

TOPICS TO COVER (create clear sections that teach these):
${compactTopics}
${level ? `TARGET LEVEL/CATEGORY: ${level}.${level === 'ECD' || level === 'Foundation Phase' ? ' Use age-appropriate language, simple sentences, and concrete examples suitable for early childhood or foundation phase learners.' : ''}\n` : ''}
${compactRubricContext ? `CONTEXT FROM RUBRIC/MEMO:\n${compactRubricContext}\n` : ''}

Generate a structured course with exactly ${numSections} sections. For each section provide:
- heading: ONE complete sentence that states the main idea (like a newspaper headline). This will be the slide title. Example: "Triple therapy reduced gastric ulcer recurrence by 60% over traditional ranitidine treatments."
- support: ONE short line or key takeaway for the slide only (optional). Keep it minimal so slides are not text-heavy.
- body: Full explanation for lecture notes and detailed reading (2-4 short paragraphs). Use \\n for paragraph breaks.
${(includeDiagrams || includeImages) ? `- visuals: array of visual descriptors (only include the types listed below):${includeDiagrams ? `
  - kind = "illustration" — a diagram, flowchart, or architecture diagram relevant to the section. MUST include mermaid_code: a valid Mermaid.js diagram string (graph TD, flowchart LR, sequenceDiagram, classDiagram, etc.). Keep it concise (max 20 nodes). Use real topic-specific content, not generic placeholders.` : ''}${includeImages ? `
  - kind = "image" — a descriptive scene/photo-style visual. No mermaid_code needed.` : ''}
  Each visual must include: title (short caption used as "Figure N: caption"), alt_text, prompt.${includeDiagrams ? '\n  mermaid_code (illustration only): valid Mermaid.js syntax.' : ''}` : `- visuals: omit entirely — do not include a visuals field in any section.`}

Include one optional short knowledge-check quiz at the end (3-5 multiple choice questions with correct_answer and options).

Respond with a JSON object only (no markdown), in this exact format:
{
  "title": "${suggestedTitle || 'Course Title'}",
  "instructions": "Brief instructions for the learner (1-2 sentences).",
  "sections": [
    {
      "heading": "One complete sentence stating this slide's main idea.",
      "support": "One short supporting line or key takeaway.",
      "body": "Full explanation for notes and reading. Use \\n for paragraph breaks.",
      ${(includeDiagrams || includeImages) ? `"visuals": [${includeDiagrams ? `
        {
          "kind": "illustration",
          "title": "Diagram caption (used as figure label)",
          "alt_text": "Accessible description of the diagram",
          "prompt": "Prompt text for illustration generation",
          "mermaid_code": "graph TD\\n  A[Concept A] --> B[Concept B]\\n  B --> C[Outcome]"
        }` : ''}${includeDiagrams && includeImages ? ',' : ''}${includeImages ? `
        {
          "kind": "image",
          "title": "Photo/scene caption",
          "alt_text": "Accessible description of image",
          "prompt": "Prompt text for image generation"
        }` : ''}
      ]` : '"visuals": []'}
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

Rules: heading must be a complete sentence (message, not just a topic). support is brief. body has the full teaching content. Include exactly one illustration and one image descriptor in visuals for every section. Quiz questions must have options and correct_answer.`;

  const messages = [
    { role: 'system', content: 'You are an expert educator. Respond only with valid JSON, no markdown.' },
    { role: 'user', content: prompt },
  ];
  const fallbackModel = process.env.CONTENT_GENERATION_FALLBACK_MODEL || 'gpt-4o-mini';
  const modelsToTry = [config.model, fallbackModel].filter((m, i, arr) => !!m && arr.indexOf(m) === i);
  let completion = null;
  let raw = '';
  let lastReason = '';

  for (const model of modelsToTry) {
    completion = await aiService.createCompletionWithRetry({
      provider: config.provider,
      model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    raw = completion.content || completion.choices?.[0]?.message?.content || '';
  if (Array.isArray(raw)) {
    raw = raw.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('');
  } else if (raw != null && typeof raw !== 'string') {
    raw = String(raw);
  }
    let jsonStr = (raw || '').trim();
    if (jsonStr.startsWith('```json')) jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    else if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');

    // Additional cleaning for common AI response issues
    jsonStr = jsonStr.replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // Remove control characters
    jsonStr = jsonStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); // Normalize line endings
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1'); // Remove trailing commas

    // More aggressive cleaning for truncated responses
    // If the string ends with incomplete array/object syntax, try to complete it
    if (jsonStr.match(/\[[\s\S]*$/)) {
      // Count brackets to see if we need to close arrays
      const openCount = (jsonStr.match(/\[/g) || []).length;
      const closeCount = (jsonStr.match(/\]/g) || []).length;
      if (openCount > closeCount) {
        // Add missing closing brackets
        for (let i = 0; i < openCount - closeCount; i++) {
          jsonStr += ']';
        }
      }
    }

    if (jsonStr.match(/\{[\s\S]*$/)) {
      // Count braces to see if we need to close objects
      const openCount = (jsonStr.match(/\{/g) || []).length;
      const closeCount = (jsonStr.match(/\}/g) || []).length;
      if (openCount > closeCount) {
        // Add missing closing braces
        for (let i = 0; i < openCount - closeCount; i++) {
          jsonStr += '}';
        }
      }
    }

    if (!jsonStr || jsonStr.length < 10) {
      const usage = completion.usage || {};
      const reason = usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens
        ? 'The model used output budget on reasoning and returned no visible content.'
        : 'The API returned no or empty content.';
      lastReason = reason;
      console.warn(`Content generation empty response with model ${model}.`, { usage });
      continue;
    }

    try {
      let data = JSON.parse(jsonStr);

      // If parsing failed, try to repair the JSON
      if (!data) {
        const repairedJson = repairJson(jsonStr);
        if (repairedJson !== jsonStr) {
          try {
            data = JSON.parse(repairedJson);
            console.warn(`Content JSON repaired for model ${model}`);
          } catch (repairErr) {
            // Repair failed, continue with original error
          }
        }
      }

      if (!data.title || !data.sections || !Array.isArray(data.sections)) {
        lastReason = 'Invalid content structure: need title and sections array';
        continue;
      }
      return normalizeGeneratedContent(data, templateId, { includeDiagrams, includeImages });
    } catch (parseErr) {
      // Try multiple repair strategies
      let data = null;
      const repairStrategies = [
        // Strategy 1: Standard repair
        () => repairJson(jsonStr),
        // Strategy 2: More aggressive bracket/brace completion
        (str) => {
          let repaired = str;
          const openBraces = (repaired.match(/{/g) || []).length;
          const closeBraces = (repaired.match(/}/g) || []).length;
          const openBrackets = (repaired.match(/\[/g) || []).length;
          const closeBrackets = (repaired.match(/\]/g) || []).length;
          for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
          for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
          return repaired;
        },
        // Strategy 3: Extract partial JSON if possible
        (str) => {
          // Try to find the last complete property and truncate there
          const lines = str.split('\n');
          let lastValidLine = -1;
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.endsWith('}') || line.endsWith(']') || line.endsWith(',') || line.match(/"[^"]*":\s*"[^"]*"$/)) {
              lastValidLine = i;
              break;
            }
          }
          if (lastValidLine >= 0) {
            return lines.slice(0, lastValidLine + 1).join('\n') + '}';
          }
          return str;
        }
      ];

      for (const strategy of repairStrategies) {
        try {
          const repairedJson = strategy(jsonStr);
          if (repairedJson !== jsonStr) {
            data = JSON.parse(repairedJson);
            if (data && data.title && data.sections && Array.isArray(data.sections)) {
              console.warn(`Content JSON repaired using strategy for model ${model}`);
              return normalizeGeneratedContent(data, templateId, { includeDiagrams, includeImages });
            }
          }
        } catch (strategyErr) {
          // Continue to next strategy
        }
      }

      // All repair strategies failed
      const snippet = jsonStr.length > 200 ? `${jsonStr.slice(0, 100)}...${jsonStr.slice(-100)}` : jsonStr;
      console.error(`Content JSON parse error with model ${model}. Snippet:`, snippet);
      lastReason = 'Content generation returned invalid JSON';
    }
  }
  throw new Error(`Content generation failed: ${lastReason || 'no valid content from any configured model'}`);
}

function stableColorFromText(seed) {
  const hex = crypto.createHash('md5').update(String(seed || 'content')).digest('hex');
  return {
    primary: hex.slice(0, 6),
    secondary: hex.slice(6, 12),
    accent: hex.slice(12, 18),
  };
}

function escapeSvgText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function toDataUriSvg(svg) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function createFallbackVisual(sectionTitle, kind, ordinal = 1) {
  const palette = stableColorFromText(`${sectionTitle}-${kind}-${ordinal}`);
  const label = kind === 'illustration' ? 'Illustration' : 'Image';
  const title = `${label}: ${sectionTitle}`.slice(0, 120);
  const altText = kind === 'illustration'
    ? `Diagram style illustration for: ${sectionTitle}`
    : `Visual scene for: ${sectionTitle}`;
  const prompt = kind === 'illustration'
    ? `Create a clean educational diagram illustrating: ${sectionTitle}`
    : `Create an educational scene image representing: ${sectionTitle}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#${palette.primary}"/>
      <stop offset="100%" stop-color="#${palette.secondary}"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="720" fill="url(#g)"/>
  <rect x="64" y="64" width="1152" height="592" rx="24" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.45)"/>
  <text x="100" y="190" font-family="Segoe UI, Arial, sans-serif" font-size="44" fill="#FFFFFF" font-weight="700">${escapeSvgText(label)}</text>
  <text x="100" y="260" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="#FFFFFF">${escapeSvgText(sectionTitle).slice(0, 72)}</text>
  <circle cx="1080" cy="180" r="74" fill="#${palette.accent}" opacity="0.65"/>
  <rect x="100" y="330" width="680" height="26" rx="13" fill="rgba(255,255,255,0.65)"/>
  <rect x="100" y="375" width="900" height="18" rx="9" fill="rgba(255,255,255,0.48)"/>
  <rect x="100" y="410" width="760" height="18" rx="9" fill="rgba(255,255,255,0.48)"/>
</svg>`;

  return {
    kind,
    title,
    alt_text: altText,
    prompt,
    image_url: toDataUriSvg(svg),
  };
}

function normalizeSectionVisuals(sectionTitle, visuals, { includeDiagrams = true, includeImages = true } = {}) {
  const incoming = Array.isArray(visuals) ? visuals : [];
  const normalized = incoming
    .filter((v) => {
      if (!v || typeof v !== 'object') return false;
      const kind = String(v.kind || '').toLowerCase() === 'illustration' ? 'illustration' : 'image';
      if (kind === 'illustration' && !includeDiagrams) return false;
      if (kind === 'image' && !includeImages) return false;
      return true;
    })
    .map((v, index) => {
      const kind = String(v.kind || '').toLowerCase() === 'illustration' ? 'illustration' : 'image';
      const fallback = createFallbackVisual(sectionTitle, kind, index + 1);
      return {
        kind,
        title: String(v.title || fallback.title).slice(0, 160),
        alt_text: String(v.alt_text || fallback.alt_text).slice(0, 260),
        prompt: String(v.prompt || fallback.prompt).slice(0, 360),
        mermaid_code: kind === 'illustration' && typeof v.mermaid_code === 'string' && v.mermaid_code.trim()
          ? v.mermaid_code.trim()
          : undefined,
        image_url: typeof v.image_url === 'string' && v.image_url.trim()
          ? v.image_url
          : fallback.image_url,
      };
    });

  // Only add fallbacks for types that are enabled and not already present
  if (includeDiagrams && !normalized.some((v) => v.kind === 'illustration')) {
    normalized.unshift(createFallbackVisual(sectionTitle, 'illustration', 1));
  }
  if (includeImages && !normalized.some((v) => v.kind === 'image')) {
    normalized.push(createFallbackVisual(sectionTitle, 'image', 2));
  }
  return normalized.slice(0, 4);
}

function getTemplateById(templateId) {
  const key = String(templateId || 'classroom').trim().toLowerCase();
  return CONTENT_TEMPLATES[key] || CONTENT_TEMPLATES.classroom;
}

function applyTemplateToContent(content, templateId = 'classroom') {
  const templateToken = String(templateId || 'classroom').trim();
  if (/^uploaded:\d+$/i.test(templateToken)) {
    const fallback = CONTENT_TEMPLATES.classroom;
    return {
      ...content,
      template_id: templateToken,
      template_name: 'Uploaded template',
      theme: { ...(content?.theme || fallback.theme || {}) },
    };
  }
  const template = getTemplateById(templateId);
  return {
    ...content,
    template_id: template.id,
    template_name: template.name,
    theme: { ...template.theme },
  };
}

function normalizeGeneratedContent(content, templateId = 'classroom', { includeDiagrams = true, includeImages = true } = {}) {
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const normalizedSections = sections.map((section, index) => {
    const heading = String(section.heading || section.title || `Section ${index + 1}`).trim();
    return {
      ...section,
      heading,
      visuals: normalizeSectionVisuals(heading, section.visuals, { includeDiagrams, includeImages }),
    };
  });

  const withSections = {
    ...content,
    sections: normalizedSections,
  };
  const selectedTemplateId = content?.template_id || templateId || 'classroom';
  return applyTemplateToContent(withSections, selectedTemplateId);
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

function readZipEntryText(zipPath, entryName) {
  return new Promise((resolve, reject) => {
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
  const headFont = extractThemeFont(xml, 'majorFont');
  const bodyFont = extractThemeFont(xml, 'minorFont');
  return {
    headingColor,
    textColor,
    accentColor,
    headFont,
    bodyFont,
  };
}

// --- PPTX design: 16:9, one theme, factory opts (no reused objects). Every slide has a visual. ---
const THEME = { primary: '028090', secondary: '00A896', accent: '02C39A', light: 'F0F9F8', dark: '023E4D' };
const SHADOW = () => ({ type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.15, angle: 135 });
const TXT = (opts) => ({ fontSize: 18, bold: false, align: 'left', valign: 'top', wrap: true, breakLine: true, margin: 0, ...opts });

/**
 * Build a PowerPoint buffer: 16:9, one section per slide.
 * Deliberately unstyled (no background colours, no decorative shapes) so the
 * presenter can apply their own PowerPoint theme.  Each slide has a title text
 * box, bullet-point body text, and — when an image is available — the image in
 * a right-hand column.
 */
async function buildPptx(content, options = {}) {
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
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const heading = getSectionAssertion(sec);
    const body = getSectionBody(sec) || getSectionSupport(sec);

    const imageVisual = (sec.visuals || []).find(v => v.image_url && String(v.image_url).trim());
    const mermaidVisual = (sec.visuals || []).find(v => v.mermaid_code && String(v.mermaid_code).trim());

    const slide = pptx.addSlide();

    // Title
    slide.addText(heading, {
      x: m, y: m, w: contentW, h: TITLE_H,
      fontSize: 24, bold: true, valign: 'middle', wrap: true, color: headingColor
    });

    // Body paragraphs as bullets (up to 6, capped at 220 chars each)
    const paras = body.split(/\n+/).map(p => p.trim()).filter(Boolean).slice(0, 6);
    const bulletText = paras.map(p => p.length > 220 ? p.slice(0, 217) + '\u2026' : p).join('\n');

    if (imageVisual) {
      // Two-column: bullets left (~55 %), image right (~42 %)
      const textW = contentW * 0.55;
      const imgX = m + textW + 0.2;
      const imgW = contentW - textW - 0.2;

      slide.addText(bulletText, {
        x: m, y: BODY_Y, w: textW, h: BODY_H,
        fontSize: 14, valign: 'top', wrap: true, color: textColor,
        bullet: { type: 'bullet', indent: 10 }
      });

      const imgUrl = imageVisual.image_url;
      const imgSpec = imgUrl.startsWith('data:') ? { data: imgUrl } : { url: imgUrl };
      slide.addImage({
        ...imgSpec,
        x: imgX, y: BODY_Y, w: imgW, h: BODY_H - 0.3,
        sizing: { type: 'contain', w: imgW, h: BODY_H - 0.3 }
      });
      if (imageVisual.title) {
        slide.addText(imageVisual.title, {
          x: imgX, y: BODY_Y + BODY_H - 0.3, w: imgW, h: 0.28,
          fontSize: 9, align: 'center', italic: true, wrap: true, color: accentColor
        });
      }
    } else {
      slide.addText(bulletText, {
        x: m, y: BODY_Y, w: contentW, h: BODY_H - (mermaidVisual ? 0.4 : 0),
        fontSize: 14, valign: 'top', wrap: true, color: textColor,
        bullet: { type: 'bullet', indent: 10 }
      });
      if (mermaidVisual) {
        slide.addText(`[Diagram: ${mermaidVisual.title || 'see interactive version'}]`, {
          x: m, y: h - m - 0.35, w: contentW, h: 0.32,
          fontSize: 10, italic: true, valign: 'middle', wrap: true, color: accentColor
        });
      }
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
  generateContentWithAI,
  enrichContentWithImages,
  normalizeGeneratedContent,
  applyTemplateToContent,
  getTemplateById,
  CONTENT_TEMPLATES,
  buildPptx,
  buildLectureNotesHtml,
};
