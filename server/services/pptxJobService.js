/**
 * Batched PPTX job service.
 *
 * Splits a GeneratedContent object into small batches, asks Claude/OpenAI to
 * convert each batch into slide-friendly specs, persists every completed batch
 * to disk and generation_jobs.result_json, then assembles the saved specs with
 * the local PPTX renderer. This keeps provider calls small and makes progress,
 * retry, and partial downloads meaningful for long lessons.
 */

const fs = require('fs');
const path = require('path');
const aiService = require('./aiService');
const contentService = require('./contentService');
const { createGenerationJob, updateGenerationJob, getGenerationJobById } = require('./generationJobService');

const BATCH_SIZE = Math.max(1, Math.min(10, Number.parseInt(process.env.CONTENT_PPTX_BATCH_SIZE || '5', 10) || 5));
const JOBS_DIR = path.join(__dirname, '..', 'uploads', 'pptx-jobs');

try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (_) {}

// Helpers

function jDir(jobId) { return path.join(JOBS_DIR, String(jobId)); }
function batchPath(jobId, i) { return path.join(jDir(jobId), `batch-${i}.json`); }
function finalPath(jobId) { return path.join(jDir(jobId), 'final.pptx'); }
function contentPath(jobId) { return path.join(jDir(jobId), 'content.json'); }

function stripHtml(str) {
  return String(str || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionToBullets(body, max = 5, maxChars = 140) {
  const plain = stripHtml(body);
  const byLines = plain.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const candidates = byLines.length >= 2 ? byLines : plain.split(/(?<=[.!?])\s+/);
  const bullets = [];
  for (const s of candidates) {
    if (bullets.length >= max) break;
    const t = s.trim();
    if (!t) continue;
    bullets.push(t.length > maxChars ? `${t.slice(0, maxChars - 3)}...` : t);
  }
  if (!bullets.length && plain) {
    bullets.push(plain.length > maxChars ? `${plain.slice(0, maxChars - 3)}...` : plain);
  }
  return bullets;
}

function sectionTitle(sec) {
  return String(sec?.heading || sec?.title || 'Slide').trim().slice(0, 90) || 'Slide';
}

function pickProvider() {
  // Claude first, per the desired pipeline. OpenAI remains a fallback.
  if (aiService.anthropic) return 'anthropic';
  if (aiService.openai) return 'openai';
  return null;
}

function extractCompletionText(result) {
  if (!result) return '';
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && part.text != null) return part.text;
        if (part?.text != null) return part.text;
        return '';
      })
      .join('');
  }
  return result?.choices?.[0]?.message?.content || '';
}

function normalizeSlideSpec(item, section, sourceSectionIndex) {
  const aiBullets = Array.isArray(item?.bullets)
    ? item.bullets.map(b => String(b || '').trim()).filter(Boolean)
    : [];
  const bullets = (aiBullets.length ? aiBullets : sectionToBullets(section?.body || section?.support || '', 5))
    .map((b) => b.length > 180 ? `${b.slice(0, 177)}...` : b)
    .slice(0, 6);

  return {
    sourceSectionIndex,
    title: String(item?.title || sectionTitle(section)).trim().slice(0, 90) || sectionTitle(section),
    support: String(item?.support || section?.support || '').trim().slice(0, 180),
    bullets,
  };
}

function batchFallback(sections, batchStart = 0) {
  return sections.map((section, i) => normalizeSlideSpec(null, section, batchStart + i));
}

// AI batch reformatter

async function reformatBatch(sections, batchStart = 0) {
  const provider = pickProvider();
  if (!provider) return batchFallback(sections, batchStart);

  const sectionList = sections.map((sec, i) => {
    const heading = String(sec.heading || sec.title || '').trim();
    const support = String(sec.support || '').trim();
    const body = stripHtml(sec.body || '').slice(0, 900);
    return `Section ${i + 1}:\nHeading: ${heading}\nSupport: ${support}\nContent: ${body}`;
  }).join('\n\n');

  const userPrompt = `Convert these course content sections into concise PowerPoint slide specs.
For each section produce:
- "title": a clear slide title, max 8 words
- "support": one short assertion or subtitle, max 16 words
- "bullets": 3-5 bullet points, max 18 words each, plain text, no markdown symbols

Return only a JSON array, one object per section, in the same order.

${sectionList}`;

  try {
    const result = await aiService.createCompletionWithRetry({
      provider,
      model: provider === 'openai'
        ? (process.env.CONTENT_PPTX_BATCH_OPENAI_MODEL || 'gpt-4o-mini')
        : (process.env.CONTENT_PPTX_BATCH_ANTHROPIC_MODEL || process.env.CONTENT_PPTX_BATCH_MODEL || 'claude-3-haiku-20240307'),
      maxTokens: 2600,
      temperature: 0.25,
      messages: [
        { role: 'system', content: 'You convert educational content into concise slide specs. Return only a valid JSON array, no commentary.' },
        { role: 'user', content: userPrompt },
      ],
    }, 2);

    const text = extractCompletionText(result);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in AI response');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('AI response is not an array');

    return sections.map((section, i) => normalizeSlideSpec(parsed[i], section, batchStart + i));
  } catch (err) {
    console.warn('[pptxJob] AI batch reformat failed, using local fallback:', err.message);
    return batchFallback(sections, batchStart);
  }
}

function loadCompletedSlides(jobId, batches) {
  const slides = [];
  for (const b of batches) {
    if (b.status !== 'completed') continue;
    if (Array.isArray(b.slides) && b.slides.length) {
      slides.push(...b.slides);
      continue;
    }
    const p = batchPath(jobId, b.index);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const items = JSON.parse(raw);
      if (Array.isArray(items)) slides.push(...items);
    } catch (_) {}
  }
  return slides.sort((a, b) => Number(a.sourceSectionIndex || 0) - Number(b.sourceSectionIndex || 0));
}

function slidesToRenderableContent(content, slides, { includeUnprocessed = true } = {}) {
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const bySource = new Map();
  slides.forEach((slide, fallbackIndex) => {
    const idx = Number.isFinite(Number(slide?.sourceSectionIndex))
      ? Number(slide.sourceSectionIndex)
      : fallbackIndex;
    bySource.set(idx, slide);
  });

  return {
    ...content,
    sections: sections
      .map((section, index) => {
        const slide = bySource.get(index);
        if (!slide) return includeUnprocessed ? section : null;
        return {
          ...section,
          heading: slide.title || sectionTitle(section),
          title: slide.title || sectionTitle(section),
          support: slide.support || section.support || '',
          body: Array.isArray(slide.bullets) && slide.bullets.length
            ? slide.bullets.join('\n')
            : (section.body || section.support || ''),
        };
      })
      .filter(Boolean),
    quiz: includeUnprocessed ? content.quiz : null,
  };
}

async function buildPptxFromSavedSlides(content, slides, templatePath = null, options = {}) {
  return contentService.buildPptx(slidesToRenderableContent(content, slides, options), {
    templatePath,
    forceLocal: true,
  });
}

// Job state helpers

async function loadJobRow(jobId, userId = null) {
  const row = await getGenerationJobById(jobId, userId);
  if (!row) return null;
  let payload = {};
  let progress = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch (_) {}
  try { progress = JSON.parse(row.result_json || '{}'); } catch (_) {}
  return { ...row, payload, progress };
}

async function saveProgress(jobId, progress, statusUpdate = {}) {
  await updateGenerationJob(jobId, {
    ...statusUpdate,
    result: progress,
  });
}

function contentToSlides(content) {
  return (Array.isArray(content.sections) ? content.sections : [])
    .map((sec, index) => normalizeSlideSpec(null, sec, index));
}

function summarizeProgress(batches, totalBatches) {
  const completedBatches = batches.filter(b => b.status === 'completed').length;
  const generatedSlides = batches.reduce((sum, b) => (
    sum + (Array.isArray(b.slides) ? b.slides.length : Number(b.slideCount || 0) || 0)
  ), 0);
  return { batches, completedBatches, totalBatches, generatedSlides, batchSize: BATCH_SIZE };
}

// Background processor

async function processJob(jobId) {
  const job = await loadJobRow(jobId);
  if (!job) return;

  let content;
  try {
    content = JSON.parse(fs.readFileSync(contentPath(jobId), 'utf8'));
  } catch (err) {
    await saveProgress(jobId, job.progress, {
      status: 'failed',
      error_message: 'Could not read content file',
      completed_at: new Date(),
    });
    return;
  }

  const useAI = job.payload.useAI !== false;
  const templatePath = job.payload.templatePath || null;

  if (!useAI) {
    try {
      const slides = contentToSlides(content);
      await saveProgress(jobId, {
        batches: [],
        completedBatches: 0,
        totalBatches: 0,
        generatedSlides: slides.length,
        batchSize: BATCH_SIZE,
      }, {
        status: 'processing',
        started_at: new Date(),
      });
      const buf = await buildPptxFromSavedSlides(content, slides, templatePath);
      fs.writeFileSync(finalPath(jobId), buf);
      await saveProgress(jobId, {
        batches: [],
        completedBatches: 0,
        totalBatches: 0,
        generatedSlides: slides.length,
        slides,
        batchSize: BATCH_SIZE,
        finalReady: true,
      }, {
        status: 'completed',
        completed_at: new Date(),
      });
    } catch (err) {
      await saveProgress(jobId, {}, {
        status: 'failed',
        error_message: `Quick build failed: ${String(err.message || err).slice(0, 300)}`,
        completed_at: new Date(),
      });
    }
    return;
  }

  const sections = Array.isArray(content.sections) ? content.sections : [];
  const totalBatches = Math.ceil(sections.length / BATCH_SIZE) || 1;

  let batches = Array.isArray(job.progress.batches) ? job.progress.batches : [];
  if (batches.length !== totalBatches) {
    batches = Array.from({ length: totalBatches }, (_, i) => ({
      index: i,
      sectionStart: i * BATCH_SIZE,
      sectionEnd: Math.min((i + 1) * BATCH_SIZE, sections.length),
      status: 'pending',
      error: null,
      slideCount: 0,
      slides: [],
    }));
  }

  await saveProgress(jobId, summarizeProgress(batches, totalBatches), {
    status: 'processing',
    started_at: new Date(),
  });

  for (let i = 0; i < batches.length; i++) {
    if (batches[i].status === 'completed') continue;

    batches[i].status = 'processing';
    batches[i].error = null;
    await saveProgress(jobId, summarizeProgress(batches, totalBatches));

    const bSections = sections.slice(batches[i].sectionStart, batches[i].sectionEnd);
    try {
      const slides = await reformatBatch(bSections, batches[i].sectionStart);
      fs.writeFileSync(batchPath(jobId, i), JSON.stringify(slides, null, 2));
      batches[i].status = 'completed';
      batches[i].error = null;
      batches[i].slideCount = slides.length;
      batches[i].slides = slides;
      await saveProgress(jobId, summarizeProgress(batches, totalBatches));
    } catch (err) {
      batches[i].status = 'failed';
      batches[i].error = String(err.message || err).slice(0, 300);
      await saveProgress(jobId, summarizeProgress(batches, totalBatches), {
        status: 'failed',
        error_message: `Batch ${i + 1} failed: ${batches[i].error}`,
        completed_at: new Date(),
      });
      return;
    }
  }

  try {
    const allSlides = loadCompletedSlides(jobId, batches);
    const buf = await buildPptxFromSavedSlides(content, allSlides, templatePath);
    fs.writeFileSync(finalPath(jobId), buf);
    await saveProgress(jobId, {
      ...summarizeProgress(batches, totalBatches),
      generatedSlides: allSlides.length,
      finalReady: true,
    }, {
      status: 'completed',
      completed_at: new Date(),
    });
  } catch (err) {
    await saveProgress(jobId, summarizeProgress(batches, totalBatches), {
      status: 'failed',
      error_message: `PPTX assembly failed: ${String(err.message || err).slice(0, 300)}`,
      completed_at: new Date(),
    });
  }
}

// Public API

async function createJob(userId, content, options = {}) {
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const totalBatches = Math.ceil(sections.length / BATCH_SIZE) || 1;
  const templatePath = options.templatePath || null;
  const useAI = options.useAI !== false;

  const jobId = await createGenerationJob({
    user_id: userId,
    job_type: 'pptx_batch',
    status: 'processing',
    source_route: '/pptx-jobs',
    payload: { totalBatches, totalSections: sections.length, title: content.title, templatePath, useAI, batchSize: BATCH_SIZE },
    max_retries: 3,
  });

  const dir = jDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(contentPath(jobId), JSON.stringify(content));

  processJob(jobId).catch(err => console.error('[pptxJob] Unhandled error in job', jobId, err));

  return jobId;
}

async function getJobState(jobId, userId = null) {
  const job = await loadJobRow(jobId, userId);
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    error_message: job.error_message,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

async function retryJob(jobId, userId = null) {
  const job = await loadJobRow(jobId, userId);
  if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
  if (job.status === 'processing') throw Object.assign(new Error('Job is still running'), { status: 400 });

  const batches = Array.isArray(job.progress.batches) ? job.progress.batches : [];
  for (const b of batches) {
    if (b.status === 'failed') {
      b.status = 'pending';
      b.error = null;
      b.slideCount = 0;
      b.slides = [];
    }
  }
  const totalBatches = job.progress.totalBatches || batches.length;

  await saveProgress(jobId, summarizeProgress(batches, totalBatches), {
    status: 'processing',
    error_message: null,
    completed_at: null,
  });

  processJob(jobId).catch(err => console.error('[pptxJob] Retry error in job', jobId, err));
}

async function getFinalBuffer(jobId, userId = null) {
  const job = await loadJobRow(jobId, userId);
  if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });
  if (job.status !== 'completed') throw Object.assign(new Error('Job not completed'), { status: 400 });
  const fp = finalPath(jobId);
  if (!fs.existsSync(fp)) throw Object.assign(new Error('PPTX file missing'), { status: 404 });
  return fs.readFileSync(fp);
}

async function getPartialBuffer(jobId, userId = null) {
  const job = await loadJobRow(jobId, userId);
  if (!job) throw Object.assign(new Error('Job not found'), { status: 404 });

  const batches = Array.isArray(job.progress.batches) ? job.progress.batches : [];
  const completedBatches = batches.filter(b => b.status === 'completed');
  if (!completedBatches.length) throw Object.assign(new Error('No completed batches to download'), { status: 400 });

  let content = {};
  try { content = JSON.parse(fs.readFileSync(contentPath(jobId), 'utf8')); } catch (_) {}

  const slides = loadCompletedSlides(jobId, batches);
  return buildPptxFromSavedSlides(content, slides, job.payload?.templatePath || null, {
    includeUnprocessed: false,
  });
}

async function cleanupJob(jobId) {
  const dir = jDir(jobId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = {
  JOBS_DIR,
  BATCH_SIZE,
  createJob,
  getJobState,
  retryJob,
  getFinalBuffer,
  getPartialBuffer,
  cleanupJob,
};
