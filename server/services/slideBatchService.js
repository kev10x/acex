/**
 * Slide Batch Service
 *
 * Manages batch generation of slide decks using Anthropic's Message Batches API
 * (50% cheaper than standard API). Supports scheduling for off-peak token costs.
 *
 * Flow:
 *   1. createBatchJob() — stores units + options in generation_jobs, optionally schedules
 *   2. If not scheduled: immediately submits to Anthropic Batches API
 *   3. getBatchStatus() — polls Anthropic for completion; processes results when done
 *   4. buildAndDownloadZip() — builds individual PPTXs and returns a ZIP buffer
 */

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const archiver = require('archiver');
const aiService = require('./aiService');
const { DETAIL_SPECS, buildFreshSlidePptx, generateSlideImages } = require('./slideGenService');
const aiConfig = require('../config/ai-config');
const { createGenerationJob, updateGenerationJob, getGenerationJobById } = require('./generationJobService');

const BATCH_DIR = path.join(__dirname, '..', 'uploads', 'slide-batches');
try { fs.mkdirSync(BATCH_DIR, { recursive: true }); } catch (_) {}

function jobDir(jobId) { return path.join(BATCH_DIR, String(jobId)); }
function contentPath(jobId) { return path.join(jobDir(jobId), 'content.json'); }

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildUnitPrompt({ title, slideCount, includeQuiz, subject, level, detailLevel, backgrounds }) {
  const spec = DETAIL_SPECS[detailLevel] || DETAIL_SPECS.standard;
  const totalSlides = includeQuiz ? slideCount + 1 : slideCount;

  let backgroundInfo = '';
  if (Array.isArray(backgrounds) && backgrounds.length > 0) {
    backgroundInfo = `\n\nAvailable template backgrounds:\n${backgrounds.map((b, i) => `${i + 1}. id="${b.id}" label="${b.label}" (${b.isDark ? 'dark' : 'light'})`).join('\n')}\nAssign backgroundId to each slide (or null).`;
  }

  const hasBg = Array.isArray(backgrounds) && backgrounds.length > 0;
  const quizNote = includeQuiz
    ? `Slide ${totalSlides - 1} MUST be slideType "quiz" with a "Checkpoint Quiz" title and 3–4 MCQ-style questions as bullets (e.g. "Q1: Which of the following…?").`
    : '';

  return `Generate a ${level} lesson slide deck for the unit: "${title}"${subject ? ` (subject: ${subject})` : ''}.
Create exactly ${totalSlides} slides with a logical educational flow.
${quizNote}

Slide types: title | learning_objectives | content | question | activity | summary | quiz | transition

For each slide:
- slideIndex (0-based, 0 to ${totalSlides - 1})
- slideType
- title (assertive heading)
- bullets (${spec.bulletCount} — ${spec.style} — max ${spec.wordLimit} words each)${hasBg ? '\n- backgroundId (from list, or null)' : ''}

Return ONLY valid JSON array:
[{"slideIndex":0,"slideType":"title","title":"...","bullets":["..."]}]${backgroundInfo}`;
}

// ─── Job creation ─────────────────────────────────────────────────────────────

async function createBatchJob({ userId, units, subject, level, detailLevel, scheduledFor, sessionId, backgrounds, templateBgs, templateImages, generateImages }) {
  const isScheduled = !!scheduledFor;

  const jobId = await createGenerationJob({
    user_id: userId,
    job_type: 'slide_batch',
    status: isScheduled ? 'scheduled' : 'queued',
    source_route: '/slide-gen/batch',
    payload: { units, subject, level, detailLevel, sessionId, backgrounds, templateBgs, templateImages, generateImages: !!generateImages },
    scheduled_for: scheduledFor || null,
    max_retries: 0,
  });

  fs.mkdirSync(jobDir(jobId), { recursive: true });

  if (!isScheduled) {
    // Fire-and-forget: submit immediately to Anthropic
    submitAnthropicBatch(jobId, { units, subject, level, detailLevel, backgrounds }).catch((err) => {
      console.error('[slideBatch] Submit error for job', jobId, err?.message);
      updateGenerationJob(jobId, { status: 'failed', error_message: String(err?.message || err) }).catch(() => {});
    });
  }

  return jobId;
}

// ─── Anthropic Batch submission ───────────────────────────────────────────────

async function submitAnthropicBatch(jobId, { units, subject, level, detailLevel, backgrounds }) {
  if (!aiService.anthropic) throw new Error('Anthropic client not configured');

  const cfg = aiConfig.getTaskConfig('contentGeneration', 'anthropic');
  const batchModel = cfg.model;

  const requests = units.map((unit, i) => ({
    custom_id: `unit-${i}`,
    params: {
      model: batchModel,
      max_tokens: 2500,
      system: 'You generate educational PowerPoint slide content. Return ONLY a valid JSON array, no markdown.',
      messages: [
        {
          role: 'user',
          content: buildUnitPrompt({ ...unit, subject, level, detailLevel, backgrounds }),
        },
      ],
    },
  }));

  const batch = await aiService.anthropic.messages.batches.create({ requests });

  await updateGenerationJob(jobId, {
    status: 'processing',
    result: {
      anthropicBatchId: batch.id,
      units: units.map((u) => ({ title: u.title, slideCount: u.slideCount, includeQuiz: u.includeQuiz })),
    },
  });

  return batch.id;
}

// ─── Status polling ───────────────────────────────────────────────────────────

async function getBatchStatus(jobId, userId) {
  const row = await getGenerationJobById(jobId, userId);
  if (!row) return null;

  let payload = {};
  let progress = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch (_) {}
  try { progress = JSON.parse(row.result_json || '{}'); } catch (_) {}

  const status = row.status;

  // If scheduled and time has arrived, trigger submission now
  if (status === 'scheduled' && row.scheduled_for) {
    const scheduledAt = new Date(row.scheduled_for);
    if (scheduledAt <= new Date()) {
      try {
        const { units, subject, level, detailLevel, backgrounds } = payload;
        await submitAnthropicBatch(jobId, { units, subject, level, detailLevel, backgrounds });
        const refreshed = await getGenerationJobById(jobId, userId);
        let refreshedProgress = {};
        try { refreshedProgress = JSON.parse(refreshed.result_json || '{}'); } catch (_) {}
        return formatStatus(refreshed, refreshedProgress, payload);
      } catch (err) {
        await updateGenerationJob(jobId, { status: 'failed', error_message: String(err?.message || err) });
      }
    }
  }

  // If processing, check Anthropic batch status
  if ((status === 'processing' || status === 'queued') && progress.anthropicBatchId && !progress.contentReady) {
    try {
      const batch = await aiService.anthropic.messages.batches.retrieve(progress.anthropicBatchId);

      if (batch.processing_status === 'ended') {
        await processBatchResults(jobId, batch.id, payload);
        const refreshed = await getGenerationJobById(jobId, userId);
        let refreshedProgress = {};
        try { refreshedProgress = JSON.parse(refreshed.result_json || '{}'); } catch (_) {}
        return formatStatus(refreshed, refreshedProgress, payload);
      }

      return formatStatus(row, {
        ...progress,
        anthropicStatus: batch.processing_status,
        requestCounts: batch.request_counts,
      }, payload);
    } catch (err) {
      console.error('[slideBatch] Status check error:', err?.message);
    }
  }

  return formatStatus(row, progress, payload);
}

function formatStatus(row, progress, payload) {
  return {
    id: row.id,
    status: row.status,
    scheduledFor: row.scheduled_for || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progress,
    unitCount: Array.isArray(payload?.units) ? payload.units.length : (progress.unitCount || 0),
    errorMessage: row.error_message || null,
  };
}

// ─── Process Anthropic batch results ─────────────────────────────────────────

async function processBatchResults(jobId, anthropicBatchId, payload) {
  const { units } = payload;
  const contentByUnit = {};

  for await (const result of await aiService.anthropic.messages.batches.results(anthropicBatchId)) {
    const i = parseInt(String(result.custom_id).replace('unit-', ''), 10);
    const unit = units[i];

    if (result.result.type === 'succeeded') {
      const text = result.result.message.content[0]?.text || '';
      try {
        const match = text.match(/\[[\s\S]*\]/);
        contentByUnit[i] = JSON.parse(match ? match[0] : text);
      } catch (_) {
        contentByUnit[i] = fallbackSlides(unit, i);
      }
    } else {
      contentByUnit[i] = fallbackSlides(unit, i);
    }
  }

  fs.mkdirSync(jobDir(jobId), { recursive: true });
  fs.writeFileSync(contentPath(jobId), JSON.stringify({ units, contentByUnit }));

  await updateGenerationJob(jobId, {
    status: 'completed',
    result: { anthropicBatchId, contentReady: true, unitCount: units.length },
    completed_at: new Date(),
  });
}

function fallbackSlides(unit, unitIndex) {
  const count = (unit?.slideCount || 5) + (unit?.includeQuiz ? 1 : 0);
  return Array.from({ length: count }, (_, i) => ({
    slideIndex: i,
    slideType: i === 0 ? 'title' : i === count - 1 ? 'summary' : 'content',
    title: unit?.title || `Unit ${unitIndex + 1}`,
    bullets: ['Content generation failed — please retry this unit.'],
  }));
}

// ─── Build ZIP ────────────────────────────────────────────────────────────────

async function buildBatchZip(jobId, { templateBgs = [], templateImages = [], sessionMediaDir = '', generateImages = false, subject = '', level = '' } = {}) {
  const file = contentPath(jobId);
  if (!fs.existsSync(file)) throw new Error('Batch content not ready — poll status first');

  const { units, contentByUnit } = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Build each PPTX sequentially
  const pptxEntries = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const slides = contentByUnit[i] || fallbackSlides(unit, i);

    // Generate Grok images into a per-unit subdirectory to avoid filename collisions
    let slideImages = {};
    if (generateImages && sessionMediaDir) {
      const unitImgDir = require('path').join(sessionMediaDir, `unit_${i}_imgs`);
      slideImages = await generateSlideImages(slides, unitImgDir, {
        topic: unit.title,
        subject,
        level,
      }).catch(() => ({}));
    }

    const buf = await buildFreshSlidePptx(
      slides,
      {}, // no per-slide bg overrides for batch (AI assigned backgroundId on slides)
      templateBgs,
      templateImages,
      sessionMediaDir || undefined,
      slideImages
    );
    const safeName = String(unit.title || `unit_${i + 1}`)
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || `unit_${i + 1}`;
    pptxEntries.push({ name: `${safeName}.pptx`, buffer: buf });
  }

  // Stream all into a ZIP buffer
  return new Promise((resolve, reject) => {
    const pass = new PassThrough();
    const chunks = [];
    pass.on('data', (d) => chunks.push(d));
    pass.on('end', () => resolve(Buffer.concat(chunks)));
    pass.on('error', reject);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(pass);
    archive.on('error', reject);

    for (const { name, buffer } of pptxEntries) {
      archive.append(buffer, { name });
    }
    archive.finalize();
  });
}

module.exports = { createBatchJob, getBatchStatus, buildBatchZip };
