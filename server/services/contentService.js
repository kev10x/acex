/**
 * Content generation and export: AI-generated course content, PPTX, lecture notes.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const aiService = require('./aiService');
const aiConfig = require('../config/ai-config');
const { buildEducationLevelPromptBlock, buildAcademicWritingGuidance } = require('./educationLevelService');
const { inferVisualKind, buildVisualPromptFromContext } = require('../../shared/visualPrompts.mjs');

const OPENAI_IMAGE_MODEL = 'gpt-image-1';
const OPENAI_IMAGE_SIZE = '1024x1024';
const XAI_IMAGE_MODEL = 'grok-2-image';
const IMAGE_CONCURRENCY = 3;
const XAI_TTS_ENDPOINT = 'https://api.x.ai/v1/tts';
const XAI_TTS_DEFAULT_VOICE = 'eve';
const XAI_TTS_MAX_CHARS = 15000;
const TTS_TRANSLATION_MODEL = process.env.TTS_TRANSLATION_MODEL || 'gpt-4o-mini';
const RESILIENT_CHUNK_SIZE = Math.max(2, Number.parseInt(process.env.CONTENT_RESILIENT_CHUNK_SIZE || '8', 10) || 8);
const RESILIENT_CHUNK_THRESHOLD = Math.max(8, Number.parseInt(process.env.CONTENT_RESILIENT_CHUNK_THRESHOLD || '18', 10) || 18);
const RESILIENT_CHUNK_MAX_RETRIES = Math.max(1, Number.parseInt(process.env.CONTENT_RESILIENT_CHUNK_MAX_RETRIES || '3', 10) || 3);
const RESILIENT_INTER_BATCH_DELAY_MS = Math.max(0, Number.parseInt(process.env.CONTENT_RESILIENT_INTER_BATCH_DELAY_MS || '700', 10) || 700);
const RESILIENT_IMAGE_RETRIES = Math.max(1, Number.parseInt(process.env.CONTENT_IMAGE_RETRIES || '3', 10) || 3);
const RESILIENT_IMAGE_RETRY_DELAY_MS = Math.max(150, Number.parseInt(process.env.CONTENT_IMAGE_RETRY_DELAY_MS || '450', 10) || 450);
const CONTENT_TEXT_BEAUTIFY_MODEL = process.env.CONTENT_TEXT_BEAUTIFY_MODEL || 'gpt-4o-mini';
const CONTENT_TEXT_BEAUTIFY_MAX_TOKENS = Math.max(400, Number.parseInt(process.env.CONTENT_TEXT_BEAUTIFY_MAX_TOKENS || '1400', 10) || 1400);
const CONTENT_TEXT_BEAUTIFY_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.CONTENT_TEXT_BEAUTIFY_CONCURRENCY || '2', 10) || 2));

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpeechLanguage(language) {
  const normalized = String(language || 'en').trim().toLowerCase();
  return normalized || 'en';
}

async function localizeTextForSpeech(text, { language = 'en' } = {}) {
  const normalizedText = String(text || '').trim();
  const normalizedLanguage = normalizeSpeechLanguage(language);
  if (!normalizedText) return '';
  if (['en', 'en-us', 'en-gb'].includes(normalizedLanguage)) {
    return normalizedText;
  }

  const provider = aiService.openai ? 'openai' : aiService.anthropic ? 'anthropic' : null;
  if (!provider) {
    return normalizedText;
  }

  try {
    const result = await aiService.createCompletionWithRetry({
      provider,
      model: TTS_TRANSLATION_MODEL,
      temperature: 0.2,
      maxTokens: 1200,
      messages: [
        {
          role: 'system',
          content: 'Translate educational text for audio narration. Preserve numbering, option labels like A), B), and structural cues. Return only the translated text with no commentary.'
        },
        {
          role: 'user',
          content: `Translate the following educational assessment or lesson text into ${normalizedLanguage} for text-to-speech narration.\n\n${normalizedText}`
        }
      ]
    }, 2);
    return String(result?.content || '').trim() || normalizedText;
  } catch (error) {
    console.warn(`Speech text translation failed for language ${normalizedLanguage}:`, error?.message || error);
    return normalizedText;
  }
}

function buildVisualImagePrompt(prompt, {
  visualKind = 'image',
  title = '',
  sectionHeading = '',
  sectionBody = '',
  contentTitle = '',
} = {}) {
  const context = [
    contentTitle ? `Course: ${String(contentTitle).slice(0, 140)}.` : '',
    sectionHeading ? `Section: ${String(sectionHeading).slice(0, 180)}.` : '',
    title ? `Caption context: ${String(title).slice(0, 180)}.` : '',
    sectionBody ? `Lesson excerpt: ${String(sectionBody).replace(/\s+/g, ' ').slice(0, 500)}.` : '',
    String(prompt || '').trim(),
  ].filter(Boolean).join(' ');

  const styleInstruction = visualKind === 'illustration'
    ? 'Create a clean educational visual with a plain solid background and clean edges (no alpha cutout artifacts). Use a diagram, chart, graph, or infographic when that best explains the concept, comparison, trend, category breakdown, process, or relationship. Avoid decorative scenes when a chart would teach more clearly. Do not render words, letters, numbers, legends, or labels inside the image.'
    : visualKind === 'mascot'
      ? 'Create a playful educational mascot as a cartoonified human-like character (not an animal, not an object), sticker/cutout style, centered, with a plain solid background and clean edges (no alpha cutout artifacts), no watermark, no logo, and no text overlays.'
      : 'Create a clean educational supporting image suitable for lesson content, with a plain solid background and clean edges (no alpha cutout artifacts). Do not render words, letters, numbers, labels, or text overlays inside the image.';

  return `${styleInstruction} ${context} Professional, accurate, suitable for all ages, visually clear, no watermark, no logo, no text overlays. Avoid checkerboard or jagged transparency artifacts. Prefer symbolic/shape-based communication over written annotations.`
    .trim()
    .slice(0, 1800);
}

function buildVisualRegenerationPrompt(visual, {
  contentTitle = '',
  sectionHeading = '',
  sectionBody = '',
} = {}) {
  const currentVisual = visual && typeof visual === 'object' ? visual : {};
  const inferredKind = inferVisualKind(currentVisual);
  const parts = [
    String(currentVisual.prompt || '').trim(),
    currentVisual.title ? `Visual title: ${String(currentVisual.title).trim()}.` : '',
    currentVisual.alt_text ? `Accessibility description: ${String(currentVisual.alt_text).trim()}.` : '',
    inferredKind === 'image' && currentVisual.image_url
      ? 'Reimagine the current image as a fresher, more polished educational visual while keeping the same teaching intent.'
      : '',
    inferredKind === 'illustration'
      ? 'Reimagine this as the clearest educational visual for the idea. Use a chart, graph, diagram, or infographic whenever that would teach the concept better while preserving the same relationships and intent.'
      : '',
  ].filter(Boolean).join(' ');

  return buildVisualImagePrompt(parts, {
    visualKind: inferredKind,
    title: currentVisual.title || '',
    sectionHeading,
    sectionBody,
    contentTitle,
  });
}

async function generateImageForVisual(prompt, options = {}) {
  const provider = options.provider === 'openai'
    ? 'openai'
    : options.provider === 'xai'
      ? 'xai'
      : aiService.xai
        ? 'xai'
        : 'openai';
  const client = provider === 'xai' ? aiService.xai : aiService.openai;
  if (!client) return null;
  try {
    const safePrompt = buildVisualImagePrompt(prompt, options);
    const response = provider === 'xai'
      ? await client.images.generate({
          model: XAI_IMAGE_MODEL,
          prompt: safePrompt,
          n: 1,
          response_format: 'b64_json',
          extra_body: { resolution: '1k' },
        })
      : await client.images.generate({
          model: OPENAI_IMAGE_MODEL,
          prompt: safePrompt,
          n: 1,
          size: OPENAI_IMAGE_SIZE,
          response_format: 'b64_json',
        });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) return null;
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.warn(`Image generation failed via ${provider} (non-fatal):`, err?.message || err);
    return null;
  }
}

async function regenerateVisualWithGrok({ visual, contentTitle = '', sectionHeading = '', sectionBody = '' } = {}) {
  if (!aiService.xai || !process.env.XAI_API_KEY) {
    throw new Error('XAI_API_KEY is required for Grok image regeneration.');
  }
  const currentVisual = visual && typeof visual === 'object' ? visual : {};
  const kind = inferVisualKind(currentVisual);
  const regenerationPrompt = buildVisualRegenerationPrompt(currentVisual, {
    contentTitle,
    sectionHeading,
    sectionBody,
  });
  const imageUrl = await generateImageForVisual(regenerationPrompt, {
    provider: 'xai',
    visualKind: kind,
    title: currentVisual.title || '',
    sectionHeading,
    sectionBody,
    contentTitle,
  });
  if (!imageUrl) {
    throw new Error('Grok image regeneration did not return an image.');
  }
  return {
    ...currentVisual,
    kind,
    image_url: imageUrl,
  };
}

async function generateImageForVisualWithRetry(prompt, options = {}, retryOptions = {}) {
  const attempts = Math.max(1, Number.parseInt(String(retryOptions.maxAttempts || RESILIENT_IMAGE_RETRIES), 10) || RESILIENT_IMAGE_RETRIES);
  const baseDelayMs = Math.max(100, Number.parseInt(String(retryOptions.delayMs || RESILIENT_IMAGE_RETRY_DELAY_MS), 10) || RESILIENT_IMAGE_RETRY_DELAY_MS);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const url = await generateImageForVisual(prompt, options);
    if (url) return url;
    if (attempt < attempts) {
      await sleep(baseDelayMs * attempt);
    }
  }
  return null;
}

function buildMascotPromptFromContext(mascot = {}, section = {}) {
  const parts = [
    section?.heading || section?.title ? `Section: ${String(section.heading || section.title).trim()}.` : '',
    mascot?.title ? `Mascot title: ${String(mascot.title).trim()}.` : '',
    mascot?.alt_text ? `Description: ${String(mascot.alt_text).trim()}.` : '',
    section?.support ? `Key point: ${String(section.support).trim()}.` : '',
    section?.body ? `Lesson context: ${String(section.body).replace(/\s+/g, ' ').slice(0, 260)}.` : '',
    'Create a mascot-style cartoonified human-like character that fits this lesson and can sit near the key point card.',
    'The mascot must clearly look like a stylized human character, not an animal, icon, or abstract object.',
  ].filter(Boolean);
  return parts.join(' ').trim().slice(0, 360);
}

function createFallbackMascot(sectionTitle, ordinal = 1) {
  const label = ordinal > 1 ? `Mascot ${ordinal}` : 'Mascot';
  return {
    title: `${label}: ${sectionTitle}`.slice(0, 120),
    alt_text: `Cartoonified human-like mascot character for: ${sectionTitle}`.slice(0, 240),
    prompt: `Create a playful educational cartoonified human-like mascot character for: ${sectionTitle}`.slice(0, 320),
    image_url: '',
  };
}

function normalizeSectionMascot(section, mascot, { includeMascot = false } = {}) {
  const hasMascotInput = mascot && typeof mascot === 'object';
  if (!includeMascot && !hasMascotInput) return null;
  const sectionTitle = String(section?.heading || section?.title || 'Section').trim() || 'Section';
  const fallback = createFallbackMascot(sectionTitle, 1);
  const src = hasMascotInput ? mascot : {};
  const normalizedBase = {
    title: String(src.title || fallback.title).slice(0, 160),
    alt_text: String(src.alt_text || fallback.alt_text).slice(0, 260),
    image_url: typeof src.image_url === 'string' ? src.image_url : '',
  };
  const rebuiltPrompt = buildMascotPromptFromContext(normalizedBase, section);
  return {
    ...normalizedBase,
    prompt: String(src.prompt || rebuiltPrompt).slice(0, 360),
  };
}

async function regenerateMascotWithGrok({ mascot, contentTitle = '', sectionHeading = '', sectionBody = '' } = {}) {
  if (!aiService.xai || !process.env.XAI_API_KEY) {
    throw new Error('XAI_API_KEY is required for Grok mascot regeneration.');
  }
  const currentMascot = mascot && typeof mascot === 'object' ? mascot : {};
  const sectionContext = { heading: sectionHeading, body: sectionBody };
  const prompt = buildMascotPromptFromContext(currentMascot, sectionContext);
  const imageUrl = await generateImageForVisual(prompt, {
    provider: 'xai',
    visualKind: 'mascot',
    title: currentMascot.title || '',
    sectionHeading,
    sectionBody,
    contentTitle,
  });
  if (!imageUrl) {
    throw new Error('Grok mascot regeneration did not return an image.');
  }
  return {
    ...currentMascot,
    image_url: imageUrl,
  };
}

function buildSectionNarrationText(content, sectionIndex) {
  const sections = Array.isArray(content?.sections) ? content.sections : [];
  const section = sections[sectionIndex];
  if (!section) return '';
  const parts = [
    content?.title ? `Lesson title: ${content.title}.` : '',
    section.heading || section.title ? `Section title: ${section.heading || section.title}.` : '',
    section.support ? `Key takeaway: ${section.support}.` : '',
    section.body || '',
  ].filter(Boolean);
  return parts.join('\n\n').trim();
}

async function synthesizeSectionSpeech(text, { voiceId = XAI_TTS_DEFAULT_VOICE, language = 'en' } = {}) {
  if (!process.env.XAI_API_KEY) {
    throw new Error('XAI_API_KEY is required for Grok text-to-speech.');
  }
  const normalizedLanguage = normalizeSpeechLanguage(language);
  const localizedText = await localizeTextForSpeech(text, { language: normalizedLanguage });
  const normalizedText = String(localizedText || '').trim().slice(0, XAI_TTS_MAX_CHARS);
  if (!normalizedText) {
    throw new Error('No section text available for text-to-speech.');
  }

  const response = await fetch(XAI_TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: normalizedText,
      voice_id: String(voiceId || XAI_TTS_DEFAULT_VOICE).trim() || XAI_TTS_DEFAULT_VOICE,
      language: normalizedLanguage,
      output_format: {
        codec: 'mp3',
        sample_rate: 24000,
        bit_rate: 128000,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Grok TTS failed (${response.status}): ${detail || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * After content generation, fill in image_url for every `image` visual using the configured image provider.
 * Runs in parallel per section, non-fatal (skips on error).
 */
async function enrichContentWithImages(content, options = {}) {
  const sections = content?.sections;
  if (!Array.isArray(sections)) return content;
  const {
    onProgress = null,
    imageRetries = RESILIENT_IMAGE_RETRIES,
    imageRetryDelayMs = RESILIENT_IMAGE_RETRY_DELAY_MS,
    interBatchDelayMs = 120,
  } = options || {};

  // Collect all visuals that need generation, cap concurrent image calls.
  const tasks = [];
  sections.forEach((section, si) => {
    (section.visuals || []).forEach((visual, vi) => {
      if (!(visual.image_url && !visual.image_url.startsWith('data:image/svg'))) {
        const kind = inferVisualKind(visual);
        tasks.push({
          si,
          vi,
          prompt: visual.prompt,
          title: visual.title,
          sectionHeading: section.heading || section.title || '',
          sectionBody: section.body || '',
          contentTitle: content?.title || '',
          kind,
        });
      }
    });
  });

  let totalWork = tasks.length;
  let completedWork = 0;
  const reportProgress = (stage, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      stage,
      completed: completedWork,
      total: totalWork,
      ...extra,
    });
  };

  const results = new Map();
  reportProgress('visual_images', { message: `Generating ${tasks.length} visual image(s).` });
  for (let i = 0; i < tasks.length; i += IMAGE_CONCURRENCY) {
    const batch = tasks.slice(i, i + IMAGE_CONCURRENCY);
    await Promise.all(
      batch.map(async (task) => {
        const url = await generateImageForVisualWithRetry(task.prompt, {
          title: task.title,
          sectionHeading: task.sectionHeading,
          sectionBody: task.sectionBody,
          contentTitle: task.contentTitle,
          visualKind: task.kind === 'illustration' ? 'illustration' : 'image',
        }, {
          maxAttempts: imageRetries,
          delayMs: imageRetryDelayMs,
        });
        if (url) results.set(`${task.si}:${task.vi}`, url);
        completedWork += 1;
      })
    );
    reportProgress('visual_images');
    if (i + IMAGE_CONCURRENCY < tasks.length) {
      await sleep(interBatchDelayMs);
    }
  }

  const mascotResults = new Map();
  const mascotTasks = [];
  sections.forEach((section, si) => {
    const mascot = section?.mascot;
    if (!mascot || typeof mascot !== 'object') return;
    const hasImage = typeof mascot.image_url === 'string' && mascot.image_url.trim();
    if (hasImage && !String(mascot.image_url).startsWith('data:image/svg')) return;
    mascotTasks.push({
      si,
      prompt: mascot.prompt,
      title: mascot.title,
      sectionHeading: section.heading || section.title || '',
      sectionBody: section.body || '',
      contentTitle: content?.title || '',
    });
  });
  totalWork = tasks.length + mascotTasks.length;
  reportProgress('mascots', { message: `Generating ${mascotTasks.length} mascot image(s).` });
  for (let i = 0; i < mascotTasks.length; i += IMAGE_CONCURRENCY) {
    const batch = mascotTasks.slice(i, i + IMAGE_CONCURRENCY);
    await Promise.all(
      batch.map(async (task) => {
        const url = await generateImageForVisualWithRetry(task.prompt, {
          title: task.title,
          sectionHeading: task.sectionHeading,
          sectionBody: task.sectionBody,
          contentTitle: task.contentTitle,
          visualKind: 'mascot',
        }, {
          maxAttempts: imageRetries,
          delayMs: imageRetryDelayMs,
        });
        if (url) mascotResults.set(`${task.si}`, url);
        completedWork += 1;
      })
    );
    reportProgress('mascots');
    if (i + IMAGE_CONCURRENCY < mascotTasks.length) {
      await sleep(interBatchDelayMs);
    }
  }

  const enrichedSections = sections.map((section, si) => {
    const visuals = (section.visuals || []).map((visual, vi) => {
      const url = results.get(`${si}:${vi}`);
      return url ? { ...visual, image_url: url } : visual;
    });
    const mascot = section?.mascot && typeof section.mascot === 'object'
      ? (() => {
          const mascotUrl = mascotResults.get(`${si}`);
          return mascotUrl ? { ...section.mascot, image_url: mascotUrl } : section.mascot;
        })()
      : section?.mascot;
    return { ...section, visuals, mascot };
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
  const { topics, level = '', numSections = 5, rubricContext = '', title: suggestedTitle = '', templateId = 'classroom', templateContext = '', includeDiagrams = true, includeImages = true, includeMascot = false, uploadedTheme = null } = opts;
  const config = aiConfig.getTaskConfig('contentGeneration', 'openai');
  const compactTopics = String(topics || '').trim().slice(0, 1200);
  const compactRubricContext = String(rubricContext || '').trim().slice(0, 1200);
  const compactTemplateContext = String(templateContext || getBuiltInTemplateGenerationContext(templateId) || '').trim().slice(0, 1800);
  const visualsInstruction = (includeDiagrams || includeImages || includeMascot)
    ? `- visuals: array of visual descriptors (only include the types listed below):${includeDiagrams ? `
  - kind = "illustration" - an explanatory visual relevant to the section, such as a diagram, chart, graph, flowchart, architecture diagram, concept map, or infographic. This must be prompt-driven image generation (not Mermaid). Prefer charts/graphs when the section involves quantities, comparisons, proportions, categories, rankings, or trends. Do not place words, labels, legends, numbers, or long text directly inside the generated image. Ask for a plain solid background and clean edges.` : ''}${includeImages ? `
  - kind = "image" - a descriptive scene/photo-style visual. Ask for a plain solid background and clean edges.` : ''}
  Each visual must include: title (short caption used as "Figure N: caption"), alt_text, prompt.
${includeMascot ? `- mascot: object descriptor for a playful cartoonified human-like companion image for this section, with fields: title, alt_text, prompt.` : ''}`
    : `- visuals: omit entirely - do not include a visuals field in any section.`;
  const visualsExample = (includeDiagrams || includeImages || includeMascot)
    ? `"visuals": [${includeDiagrams ? `
        {
          "kind": "illustration",
          "title": "Diagram or chart caption (used as figure label)",
          "alt_text": "Accessible description of the diagram or chart",
          "prompt": "Prompt for a clean educational chart/diagram image with plain solid background and concrete visual structure"
        }` : ''}${includeDiagrams && includeImages ? ',' : ''}${includeImages ? `
        {
          "kind": "image",
          "title": "Photo/scene caption",
          "alt_text": "Accessible description of image",
          "prompt": "Prompt text for image generation with plain solid background"
        }` : ''}
      ],${includeMascot ? `
      "mascot": {
        "title": "Mascot caption",
        "alt_text": "Cartoonified human-like mascot character that fits the section concept",
        "prompt": "Prompt for a mascot style cartoonified human-like educational character image for this section with plain solid background"
      }` : ''}
    `
    : '"visuals": []';
  const visualsRule = includeDiagrams && includeImages
    ? 'Include exactly one illustration and one image descriptor in visuals for every section. For the illustration, choose the most educationally effective form: diagram, chart, graph, flowchart, concept map, or infographic. Avoid simplistic diagrams; each one must encode concrete domain information.'
    : includeDiagrams
      ? 'Include exactly one illustration descriptor in visuals for every section, choosing a diagram, chart, graph, flowchart, concept map, or infographic as best suits the material. Avoid simplistic diagrams; each one must encode concrete domain information.'
      : includeImages
        ? 'Include exactly one image descriptor in visuals for every section.'
        : 'Do not include a visuals field.';
  const mascotRule = includeMascot
    ? 'Include exactly one mascot object for every section. Mascot must be described as a cartoonified human-like character.'
    : 'Do not include a mascot field.';
  const levelPromptBlock = level ? buildEducationLevelPromptBlock(level) : '';
  const writingGuidance = buildAcademicWritingGuidance(level || 'level_4');
  const buildPrompt = ({ compact = false } = {}) => `You are an expert educator creating course/lecture content for students. Use the assertion-evidence model of slide design (Carnegie Mellon): each slide has ONE clear message in a complete sentence, with minimal supporting text-no long bullet lists or text-heavy slides.

TOPICS TO COVER (create clear sections that teach these):
${compactTopics}
${levelPromptBlock ? `${levelPromptBlock}\n` : ''}
${writingGuidance}
${compactRubricContext ? `CONTEXT FROM RUBRIC/MEMO:\n${compactRubricContext}\n` : ''}
${compactTemplateContext ? `TEMPLATE / DECK SHAPE TO FIT:\n${compactTemplateContext}\nUse this to choose the shape of the content. If the template suggests grids, comparisons, timelines, dividers, quotes, or a limited number of content slides, make the section headings/support lines fit those layouts. Do not mention the template to learners.\n` : ''}

Generate a structured course with exactly ${numSections} sections. For each section provide:
- heading: ONE complete sentence that states the main idea (like a newspaper headline). This will be the slide title. Example: "Triple therapy reduced gastric ulcer recurrence by 60% over traditional ranitidine treatments."
- support: ONE short line or key takeaway for the slide only (optional). Keep it minimal so slides are not text-heavy.
- body: Full explanation for lecture notes and detailed reading (3-6 substantive paragraphs) in clear academic writing. MUST contain meaningful text (minimum 90 words) and never be empty. Use \\n for paragraph breaks. Where it improves clarity, include structured lists using Markdown-style bullets ("- item") and numbered lists ("1. item"), especially for processes, criteria, comparisons, or key takeaways.
${visualsInstruction}

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
      ${visualsExample}
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

Rules: heading must be a complete sentence (message, not just a topic). support is brief. body has the full teaching content in academically appropriate language and structure. ${visualsRule} ${mascotRule} When visuals or mascot prompts are present, they must request a plain solid background and clean edges (no transparency artifacts). Quiz questions must have options and correct_answer. Do not use em dashes in any text fields. Ensure all ${numSections} sections are fully written and not truncated.${compact ? ' Keep the JSON lean and avoid extra prose outside the required fields.' : ''}`;
  const prompt = buildPrompt();

  const messages = [
    { role: 'system', content: 'You are an expert educator and academic writer. Produce rigorous, clear instructional content and respond only with valid JSON, no markdown.' },
    { role: 'user', content: prompt },
  ];
  const fallbackModel = process.env.CONTENT_GENERATION_FALLBACK_MODEL || 'gpt-5-mini';
  const nonReasoningFallbackModel = process.env.CONTENT_GENERATION_NON_REASONING_MODEL || 'gpt-4o-mini';
  const boostedMaxTokens = Math.max(config.maxTokens || 0, 12000);
  const attemptConfigs = [
    {
      model: config.model,
      maxTokens: config.maxTokens,
      messages,
      label: 'primary',
    },
    {
      model: fallbackModel,
      maxTokens: boostedMaxTokens,
      messages,
      label: 'fallback',
    },
    {
      model: fallbackModel,
      maxTokens: boostedMaxTokens,
      messages: [
        { role: 'system', content: 'You are an expert educator. Return only compact, valid JSON matching the requested schema.' },
        { role: 'user', content: buildPrompt({ compact: true }) },
      ],
      label: 'compact-fallback',
    },
    {
      model: nonReasoningFallbackModel,
      maxTokens: boostedMaxTokens,
      messages: [
        { role: 'system', content: 'You are an expert educator. Return strict JSON only. Do not include any explanatory text outside the JSON object.' },
        { role: 'user', content: buildPrompt({ compact: true }) },
      ],
      label: 'non-reasoning-fallback',
    },
  ].filter((attempt, index, all) =>
    Boolean(attempt.model) &&
    all.findIndex((candidate) =>
      candidate.model === attempt.model &&
      candidate.maxTokens === attempt.maxTokens &&
      JSON.stringify(candidate.messages) === JSON.stringify(attempt.messages)
    ) === index
  );
  let completion = null;
  let raw = '';
  let lastReason = '';

  for (const attempt of attemptConfigs) {
    const { model, maxTokens, messages: attemptMessages, label } = attempt;
    try {
      completion = await aiService.createCompletionWithRetry({
        provider: config.provider,
        model,
        messages: attemptMessages,
        temperature: config.temperature,
        maxTokens,
        response_format: { type: 'json_object' },
      });
    } catch (apiError) {
      lastReason = apiError?.message || `API call failed for model ${model} (${label})`;
      console.warn(`Content generation API error with model ${model} (${label}):`, apiError?.message || apiError);
      continue;
    }
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
      const finishReason = completion.choices?.[0]?.finish_reason;
      const reason = usage.reasoning_tokens || usage.completion_tokens_details?.reasoning_tokens
        ? 'The model used output budget on reasoning and returned no visible content.'
        : 'The API returned no or empty content.';
      lastReason = reason;
      console.warn(`Content generation empty response with model ${model} (${label}).`, { finishReason, usage });
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
      if (data.sections.length < numSections) {
        lastReason = `Incomplete content: expected ${numSections} sections, received ${data.sections.length}`;
        continue;
      }
      return normalizeGeneratedContent(data, templateId, { includeDiagrams, includeImages, includeMascot, uploadedTheme });
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
            if (data && data.title && data.sections && Array.isArray(data.sections) && data.sections.length >= numSections) {
              console.warn(`Content JSON repaired using strategy for model ${model}`);
              return normalizeGeneratedContent(data, templateId, { includeDiagrams, includeImages, includeMascot, uploadedTheme });
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

async function generateContentWithAIResilient(opts = {}) {
  const {
    topics,
    level = '',
    numSections = 5,
    rubricContext = '',
    title: suggestedTitle = '',
    templateId = 'classroom',
    templateContext = '',
    includeDiagrams = true,
    includeImages = true,
    includeMascot = false,
    uploadedTheme = null,
    forceChunking = false,
    chunkSize = RESILIENT_CHUNK_SIZE,
    chunkThreshold = RESILIENT_CHUNK_THRESHOLD,
    maxChunkRetries = RESILIENT_CHUNK_MAX_RETRIES,
    interBatchDelayMs = RESILIENT_INTER_BATCH_DELAY_MS,
    onProgress = null,
    onChunkComplete = null,
  } = opts;

  const totalSections = Math.max(1, Number.parseInt(String(numSections || 5), 10) || 5);
  const resolvedChunkSize = Math.max(2, Number.parseInt(String(chunkSize || RESILIENT_CHUNK_SIZE), 10) || RESILIENT_CHUNK_SIZE);
  const resolvedChunkThreshold = Math.max(2, Number.parseInt(String(chunkThreshold || RESILIENT_CHUNK_THRESHOLD), 10) || RESILIENT_CHUNK_THRESHOLD);
  const shouldChunk = forceChunking || totalSections > resolvedChunkThreshold;

  if (!shouldChunk) {
    return generateContentWithAI({
      topics,
      level,
      numSections: totalSections,
      rubricContext,
      title: suggestedTitle,
      templateId,
      templateContext,
      includeDiagrams,
      includeImages,
      includeMascot,
      uploadedTheme,
    });
  }

  const totalChunks = Math.ceil(totalSections / resolvedChunkSize);
  const mergedSections = [];
  const chunkResults = [];
  let mergedTitle = String(suggestedTitle || '').trim();
  let mergedInstructions = '';
  let bestQuiz = null;

  if (typeof onProgress === 'function') {
    onProgress({
      stage: 'planning',
      total_chunks: totalChunks,
      completed_chunks: 0,
      generated_sections: 0,
      total_sections: totalSections,
      message: `Preparing chunked generation for ${totalSections} sections.`,
    });
  }

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    const startSection = chunkIndex * resolvedChunkSize + 1;
    const targetCount = Math.min(resolvedChunkSize, totalSections - mergedSections.length);
    const endSection = startSection + targetCount - 1;
    // Structured continuity: heading + one-sentence key idea, last 10 sections only.
    const previousHeadings = mergedSections
      .slice(-10)
      .map((section, relIdx) => {
        const absIdx = mergedSections.length - Math.min(10, mergedSections.length) + relIdx;
        const heading = String(section?.heading || section?.title || '').trim();
        const keyIdea = String(section?.support || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        return `${absIdx + 1}. ${heading}${keyIdea ? ` — ${keyIdea}` : ''}`;
      })
      .filter(Boolean);

    if (typeof onProgress === 'function') {
      onProgress({
        stage: 'text_generation',
        total_chunks: totalChunks,
        completed_chunks: chunkIndex,
        current_chunk: chunkIndex + 1,
        chunk_range: `${startSection}-${endSection}`,
        generated_sections: mergedSections.length,
        total_sections: totalSections,
        message: `Generating sections ${startSection}-${endSection} of ${totalSections}.`,
      });
    }

    let chunkContent = null;
    let lastChunkError = null;
    for (let attempt = 1; attempt <= maxChunkRetries; attempt += 1) {
      try {
        const chunkTopics = [
          String(topics || '').trim(),
          '',
          `Generation job context: part ${chunkIndex + 1} of ${totalChunks} for a ${totalSections}-section course.`,
          `Generate exactly ${targetCount} sections for this part (sections ${startSection} to ${endSection}).`,
          previousHeadings.length
            ? `Already generated sections (avoid repeating these):\n${previousHeadings.join('\n')}`
            : '',
          'Keep conceptual continuity with prior sections, but do not restate previous headings verbatim.',
        ].filter(Boolean).join('\n');

        chunkContent = await generateContentWithAI({
          topics: chunkTopics,
          level,
          numSections: targetCount,
          rubricContext,
          title: mergedTitle || suggestedTitle || '',
          templateId,
          templateContext,
          includeDiagrams,
          includeImages: false,
          includeMascot: false,
          uploadedTheme,
        });

        const chunkSections = Array.isArray(chunkContent?.sections) ? chunkContent.sections.slice(0, targetCount) : [];
        if (chunkSections.length < targetCount) {
          throw new Error(`Chunk returned ${chunkSections.length}/${targetCount} sections`);
        }
        chunkContent = { ...chunkContent, sections: chunkSections };
        lastChunkError = null;
        break;
      } catch (error) {
        lastChunkError = error;
        if (attempt < maxChunkRetries) {
          const retryDelay = interBatchDelayMs + attempt * 300;
          await sleep(retryDelay);
        }
      }
    }

    if (!chunkContent) {
      throw new Error(
        `Chunk generation failed for sections ${startSection}-${endSection}: ${lastChunkError?.message || 'Unknown error'}`
      );
    }

    if (!mergedTitle) {
      mergedTitle = String(chunkContent.title || suggestedTitle || 'Course Content').trim();
    }
    if (!mergedInstructions) {
      mergedInstructions = String(chunkContent.instructions || '').trim();
    }
    const chunkQuiz = chunkContent?.quiz;
    const chunkQuizLen = Array.isArray(chunkQuiz?.questions) ? chunkQuiz.questions.length : 0;
    const bestQuizLen = Array.isArray(bestQuiz?.questions) ? bestQuiz.questions.length : 0;
    if (chunkQuizLen > bestQuizLen) {
      bestQuiz = chunkQuiz;
    }

    mergedSections.push(...chunkContent.sections);
    chunkResults.push(chunkContent);

    if (typeof onChunkComplete === 'function') {
      try {
        onChunkComplete({
          chunkIndex,
          completedChunks: chunkIndex + 1,
          totalChunks,
          partial_sections: mergedSections.map((s) => ({
            heading: s?.heading || s?.title || '',
            support: s?.support || '',
          })),
        });
      } catch (_) {}
    }

    if (typeof onProgress === 'function') {
      onProgress({
        stage: 'text_generation',
        total_chunks: totalChunks,
        completed_chunks: chunkIndex + 1,
        current_chunk: chunkIndex + 1,
        chunk_range: `${startSection}-${endSection}`,
        generated_sections: mergedSections.length,
        total_sections: totalSections,
        message: `Completed sections ${startSection}-${endSection}.`,
      });
    }

    if (chunkIndex < totalChunks - 1) {
      await sleep(interBatchDelayMs);
    }
  }

  const merged = {
    title: mergedTitle || String(chunkResults?.[0]?.title || suggestedTitle || 'Course Content').trim(),
    instructions: mergedInstructions || String(chunkResults?.[0]?.instructions || '').trim(),
    sections: mergedSections.slice(0, totalSections),
    quiz: bestQuiz || {},
  };

  return normalizeGeneratedContent(merged, templateId, {
    includeDiagrams,
    includeImages,
    includeMascot,
    uploadedTheme,
  });
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
  const label = kind === 'illustration' ? 'Illustration' : 'Image';
  const title = `${label}: ${sectionTitle}`.slice(0, 120);
  const altText = kind === 'illustration'
    ? `Diagram style illustration for: ${sectionTitle}`
    : `Visual scene for: ${sectionTitle}`;
  const prompt = kind === 'illustration'
    ? `Create a clean educational diagram illustrating: ${sectionTitle}`
    : `Create an educational scene image representing: ${sectionTitle}`;

  // Illustration placeholder: node-and-arrow diagram skeleton
  // Image placeholder: landscape/photo skeleton
  const svg = kind === 'illustration'
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#ffffff" rx="0"/>
  <!-- central node -->
  <circle cx="640" cy="360" r="72" fill="none" stroke="#d1d5db" stroke-width="3"/>
  <rect x="602" y="344" width="76" height="14" rx="7" fill="#e5e7eb"/>
  <rect x="614" y="366" width="52" height="10" rx="5" fill="#e5e7eb"/>
  <!-- satellite nodes -->
  <rect x="180" y="200" width="160" height="80" rx="14" fill="none" stroke="#d1d5db" stroke-width="2.5"/>
  <rect x="196" y="228" width="96" height="12" rx="6" fill="#e5e7eb"/>
  <rect x="196" y="248" width="72" height="10" rx="5" fill="#f3f4f6"/>
  <rect x="940" y="200" width="160" height="80" rx="14" fill="none" stroke="#d1d5db" stroke-width="2.5"/>
  <rect x="956" y="228" width="96" height="12" rx="6" fill="#e5e7eb"/>
  <rect x="956" y="248" width="72" height="10" rx="5" fill="#f3f4f6"/>
  <rect x="180" y="440" width="160" height="80" rx="14" fill="none" stroke="#d1d5db" stroke-width="2.5"/>
  <rect x="196" y="468" width="96" height="12" rx="6" fill="#e5e7eb"/>
  <rect x="196" y="488" width="60" height="10" rx="5" fill="#f3f4f6"/>
  <rect x="940" y="440" width="160" height="80" rx="14" fill="none" stroke="#d1d5db" stroke-width="2.5"/>
  <rect x="956" y="468" width="96" height="12" rx="6" fill="#e5e7eb"/>
  <rect x="956" y="488" width="60" height="10" rx="5" fill="#f3f4f6"/>
  <!-- connectors -->
  <line x1="340" y1="240" x2="570" y2="330" stroke="#d1d5db" stroke-width="2" stroke-dasharray="8 5" marker-end="url(#arr)"/>
  <line x1="940" y1="240" x2="710" y2="330" stroke="#d1d5db" stroke-width="2" stroke-dasharray="8 5" marker-end="url(#arr)"/>
  <line x1="340" y1="480" x2="570" y2="400" stroke="#d1d5db" stroke-width="2" stroke-dasharray="8 5" marker-end="url(#arr)"/>
  <line x1="940" y1="480" x2="710" y2="400" stroke="#d1d5db" stroke-width="2" stroke-dasharray="8 5" marker-end="url(#arr)"/>
  <defs>
    <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" fill="#d1d5db"/>
    </marker>
  </defs>
</svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#ffffff" rx="0"/>
  <!-- image area skeleton -->
  <rect x="64" y="64" width="740" height="460" rx="16" fill="#f3f4f6" stroke="#e5e7eb" stroke-width="2"/>
  <!-- mountain/landscape icon inside image area -->
  <polygon points="200,440 434,200 668,440" fill="#e5e7eb"/>
  <polygon points="434,440 584,300 734,440" fill="#d1d5db"/>
  <circle cx="580" cy="160" r="52" fill="#e5e7eb"/>
  <!-- side text skeleton -->
  <rect x="848" y="64" width="368" height="22" rx="11" fill="#e5e7eb"/>
  <rect x="848" y="104" width="320" height="14" rx="7" fill="#f3f4f6"/>
  <rect x="848" y="128" width="340" height="14" rx="7" fill="#f3f4f6"/>
  <rect x="848" y="152" width="280" height="14" rx="7" fill="#f3f4f6"/>
  <rect x="848" y="200" width="360" height="14" rx="7" fill="#f3f4f6"/>
  <rect x="848" y="224" width="300" height="14" rx="7" fill="#f3f4f6"/>
  <rect x="848" y="248" width="340" height="14" rx="7" fill="#f3f4f6"/>
  <rect x="848" y="296" width="120" height="36" rx="8" fill="#e5e7eb"/>
  <!-- caption bar -->
  <rect x="64" y="548" width="740" height="36" rx="0 0 16 16" fill="#f9fafb" stroke="#e5e7eb" stroke-width="1"/>
  <rect x="84" y="560" width="200" height="12" rx="6" fill="#e5e7eb"/>
</svg>`;

  return {
    kind,
    title,
    alt_text: altText,
    prompt,
    image_url: toDataUriSvg(svg),
  };
}

function shouldRefreshLegacyPrompt(visual, section, fallbackPrompt = '') {
  const currentPrompt = String(visual?.prompt || '').trim();
  if (!currentPrompt) return true;

  const normalizedCurrent = currentPrompt.toLowerCase();
  const normalizedFallback = String(fallbackPrompt || '').trim().toLowerCase();
  if (normalizedFallback && normalizedCurrent === normalizedFallback) return true;

  return /^(create a clean educational diagram illustrating:|create an educational scene image representing:)/i.test(currentPrompt);
}

function normalizeSectionVisuals(section, visuals, { includeDiagrams = true, includeImages = true } = {}) {
  const sectionTitle = String(section?.heading || section?.title || 'Section').trim() || 'Section';
  const incoming = Array.isArray(visuals) ? visuals : [];
  const normalized = incoming
    .filter((v) => {
      if (!v || typeof v !== 'object') return false;
      const kind = inferVisualKind(v);
      if (kind === 'illustration' && !includeDiagrams) return false;
      if (kind === 'image' && !includeImages) return false;
      return true;
    })
    .map((v, index) => {
      const kind = inferVisualKind(v);
      const fallback = createFallbackVisual(sectionTitle, kind, index + 1);
      const normalizedBase = {
        kind,
        title: String(v.title || fallback.title).slice(0, 160),
        alt_text: String(v.alt_text || fallback.alt_text).slice(0, 260),
        image_url: typeof v.image_url === 'string' && v.image_url.trim()
          ? v.image_url
          : fallback.image_url,
      };
      const rebuiltPrompt = buildVisualPromptFromContext(normalizedBase, section);
      return {
        ...normalizedBase,
        prompt: String(
          shouldRefreshLegacyPrompt(v, section, fallback.prompt)
            ? rebuiltPrompt
            : String(v.prompt || rebuiltPrompt)
        ).slice(0, 360),
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

function ensureSectionBodyText(section = {}, index = 0) {
  const rawBody = String(section?.body || '').trim();
  const minChars = 220;
  if (rawBody.length >= minChars) return rawBody;

  const heading = String(section?.heading || section?.title || `Section ${index + 1}`).trim();
  const support = String(section?.support || '').trim();
  const starter = rawBody || support;

  const fallbackParts = [
    starter,
    `This section expands on "${heading}" with clear explanation, examples, and practical interpretation.`,
    support ? `Key takeaway: ${support}.` : '',
    'Focus on why the concept matters, how it works in context, and where it is applied in real scenarios.',
  ].filter(Boolean);

  return fallbackParts.join('\n\n').trim();
}

function normalizeDashText(value) {
  return String(value || '').replace(/[\u2013\u2014]/g, '-');
}

function countWords(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

async function beautifySectionBodyWithAI(section = {}, { level = '' } = {}) {
  const originalBody = String(section?.body || '').trim();
  if (!originalBody) return originalBody;

  const provider = aiService.openai ? 'openai' : aiService.anthropic ? 'anthropic' : null;
  if (!provider) return originalBody;

  const heading = String(section?.heading || section?.title || '').trim();
  const support = String(section?.support || '').trim();
  const levelHint = String(level || '').trim();

  const messages = [
    {
      role: 'system',
      content: 'You are an expert academic editor for lesson notes. Rewrite for clarity and flow only. Preserve facts, quantities, formulas, and meaning exactly. Do not add new claims. Do not remove key details. Keep it plain text with paragraph breaks and optional bullet/numbered lists. Never use em dashes.'
    },
    {
      role: 'user',
      content: [
        heading ? `Section heading: ${heading}` : '',
        support ? `Key point: ${support}` : '',
        levelHint ? `Education level: ${levelHint}` : '',
        '',
        'Rewrite the section text for readability and academic polish. Keep all facts intact.',
        '',
        'Original text:',
        originalBody,
      ].filter(Boolean).join('\n')
    }
  ];

  try {
    const completion = await aiService.createCompletionWithRetry({
      provider,
      model: CONTENT_TEXT_BEAUTIFY_MODEL,
      temperature: 0.25,
      maxTokens: CONTENT_TEXT_BEAUTIFY_MAX_TOKENS,
      messages,
    }, 2);

    const rewritten = normalizeDashText(String(completion?.content || '').trim());
    if (!rewritten) return originalBody;

    const originalWords = countWords(originalBody);
    const rewrittenWords = countWords(rewritten);
    const minAllowedWords = Math.max(40, Math.floor(originalWords * 0.55));
    if (rewrittenWords < minAllowedWords) {
      return originalBody;
    }
    return rewritten;
  } catch (error) {
    console.warn('Section text beautification failed (non-fatal):', error?.message || error);
    return originalBody;
  }
}

async function beautifyContentTextWithAI(content = {}, options = {}) {
  const sections = Array.isArray(content?.sections) ? content.sections : [];
  if (!sections.length) return content;

  const level = String(options?.level || '').trim();
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
  const concurrency = Math.max(1, Math.min(4, Number.parseInt(String(options?.concurrency || CONTENT_TEXT_BEAUTIFY_CONCURRENCY), 10) || CONTENT_TEXT_BEAUTIFY_CONCURRENCY));
  let completed = 0;
  const total = sections.length;
  const updatedSections = [...sections];

  const report = (message = '') => {
    if (!onProgress) return;
    onProgress({
      stage: 'text_beautify',
      completed,
      total,
      message: message || `Beautified text for ${completed}/${total} section(s).`,
    });
  };

  report('Beautifying section text for readability.');

  for (let i = 0; i < total; i += concurrency) {
    const batch = updatedSections.slice(i, i + concurrency);
    const rewrittenBatch = await Promise.all(
      batch.map((section) => beautifySectionBodyWithAI(section, { level }))
    );

    rewrittenBatch.forEach((rewritten, idx) => {
      const sectionIndex = i + idx;
      const current = updatedSections[sectionIndex] || {};
      const currentBody = String(current?.body || '').trim();
      const nextBody = String(rewritten || '').trim() || currentBody;
      updatedSections[sectionIndex] = {
        ...current,
        raw_body: String(current?.raw_body || currentBody),
        body: nextBody,
      };
      completed += 1;
    });

    report();
  }

  return {
    ...content,
    sections: updatedSections,
  };
}

function normalizeQuizText(quiz = {}) {
  const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
  return {
    ...quiz,
    questions: questions.map((q) => ({
      ...q,
      question: normalizeDashText(q?.question || ''),
      correct_answer: normalizeDashText(q?.correct_answer || ''),
      options: Array.isArray(q?.options) ? q.options.map((opt) => normalizeDashText(opt)) : q?.options,
    })),
  };
}

function getTemplateById(templateId) {
  const key = String(templateId || 'classroom').trim().toLowerCase();
  return CONTENT_TEMPLATES[key] || CONTENT_TEMPLATES.classroom;
}

function getBuiltInTemplateGenerationContext(templateId) {
  const templateToken = String(templateId || 'classroom').trim();
  if (/^uploaded:\d+$/i.test(templateToken)) return '';
  const template = getTemplateById(templateToken);
  if (!template) return '';
  const theme = template.theme || {};
  return [
    `Built-in template: ${template.name || template.id}.`,
    theme.heading_color || theme.accent_color ? `Visual emphasis colors: heading ${theme.heading_color || 'default'}, accent ${theme.accent_color || 'default'}.` : '',
    'Prefer concise assertion-evidence slide headings, short support lines, and content that can fit a standard title slide plus one focused content slide per section.',
  ].filter(Boolean).join('\n');
}

function applyTemplateToContent(content, templateId = 'classroom', uploadedTheme = null) {
  const templateToken = String(templateId || 'classroom').trim();
  if (/^uploaded:\d+$/i.test(templateToken)) {
    const fallback = CONTENT_TEMPLATES.classroom;
    return {
      ...content,
      template_id: templateToken,
      template_name: 'Uploaded template',
      theme: uploadedTheme ? { ...uploadedTheme } : { ...(content?.theme || fallback.theme || {}) },
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

function normalizeGeneratedContent(content, templateId = 'classroom', { includeDiagrams = true, includeImages = true, includeMascot = false, uploadedTheme = null } = {}) {
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const normalizedSections = sections.map((section, index) => {
    const heading = normalizeDashText(String(section.heading || section.title || `Section ${index + 1}`).trim());
    const support = normalizeDashText(String(section?.support || '').trim());
    const normalizedSection = {
      ...section,
      heading,
      support,
      body: normalizeDashText(ensureSectionBodyText(section, index)),
      raw_body: normalizeDashText(String(section?.raw_body || section?.body || '').trim()),
    };
    return {
      ...normalizedSection,
      visuals: normalizeSectionVisuals(normalizedSection, section.visuals, { includeDiagrams, includeImages }),
      mascot: normalizeSectionMascot(normalizedSection, section.mascot, { includeMascot }),
    };
  });

  const withSections = {
    ...content,
    title: normalizeDashText(content?.title || ''),
    instructions: normalizeDashText(content?.instructions || ''),
    sections: normalizedSections,
    quiz: normalizeQuizText(content?.quiz || {}),
  };
  const selectedTemplateId = content?.template_id || templateId || 'classroom';
  return applyTemplateToContent(withSections, selectedTemplateId, uploadedTheme);
}

// Lazy re-exports for PPTX functions — avoids circular dependency while keeping
// existing callers working via contentService.buildPptx(...) dot-notation access.
const _pptx = () => require('./contentPptxService');

module.exports = {
  generateContentWithAI,
  generateContentWithAIResilient,
  beautifyContentTextWithAI,
  enrichContentWithImages,
  regenerateVisualWithGrok,
  regenerateMascotWithGrok,
  buildSectionNarrationText,
  localizeTextForSpeech,
  synthesizeSectionSpeech,
  buildVisualPromptFromContext,
  normalizeGeneratedContent,
  applyTemplateToContent,
  getTemplateById,
  CONTENT_TEMPLATES,
  get summarizePptxTemplateForGeneration() { return _pptx().summarizePptxTemplateForGeneration; },
  get buildPptx() { return _pptx().buildPptx; },
  get buildPptxWithAnthropic() { return _pptx().buildPptxWithAnthropic; },
  get buildPptxWithOpenAI() { return _pptx().buildPptxWithOpenAI; },
  get extractTemplateLayouts() { return _pptx().extractTemplateLayouts; },
  get mergePptxWithAnthropic() { return _pptx().mergePptxWithAnthropic; },
  get applyTemplateStyleWithClaude() { return _pptx().applyTemplateStyleWithClaude; },
  get buildLectureNotesHtml() { return _pptx().buildLectureNotesHtml; },
  get extractTemplateTheme() { return _pptx().extractTemplateTheme; },
  get extractTemplateImages() { return _pptx().extractTemplateImages; },
  get extractGeneratedFileIds() { return _pptx().extractGeneratedFileIds; },
  get extractOpenAiGeneratedFiles() { return _pptx().extractOpenAiGeneratedFiles; },
  get isValidPptxBuffer() { return _pptx().isValidPptxBuffer; },
  get isValidPptxZipBuffer() { return _pptx().isValidPptxZipBuffer; },
  get pptxThemeToContentTheme() { return _pptx().pptxThemeToContentTheme; },
};
