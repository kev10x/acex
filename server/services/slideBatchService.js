/**
 * Slide Batch Service
 *
 * Generates multiple slide decks in a single job using OpenAI, processing each
 * unit sequentially in the background. Supports optional scheduling.
 *
 * Flow:
 *   1. createBatchJob()  — stores units + options in generation_jobs, optionally schedules
 *   2. If not scheduled: immediately fires processUnitsWithOpenAI() in the background
 *   3. getBatchStatus()  — returns current DB status; triggers processing when a scheduled time arrives
 *   4. buildBatchZip()   — builds individual PPTXs from stored content.json and returns a ZIP buffer
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
    status: isScheduled ? 'scheduled' : 'processing',
    source_route: '/slide-gen/batch',
    payload: { units, subject, level, detailLevel, sessionId, backgrounds, templateBgs, templateImages, generateImages: !!generateImages },
    scheduled_for: scheduledFor || null,
    max_retries: 0,
  });

  fs.mkdirSync(jobDir(jobId), { recursive: true });

  if (!isScheduled) {
    processUnits(jobId, { units, subject, level, detailLevel, backgrounds }).catch((err) => {
      console.error('[slideBatch] Processing error for job', jobId, err?.message);
      updateGenerationJob(jobId, { status: 'failed', error_message: String(err?.message || err) }).catch(() => {});
    });
  }

  return jobId;
}

// ─── Unit processing ──────────────────────────────────────────────────────────

async function processUnits(jobId, { units, subject, level, detailLevel, backgrounds }) {
  const cfg = aiConfig.getTaskConfig('contentGeneration', 'anthropic');
  console.log(`[slideBatch] job ${jobId} starting — ${units.length} units, model: ${cfg.model}`);

  const contentByUnit = {};
  let consecutiveErrors = 0;

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    try {
      console.log(`[slideBatch] job ${jobId} unit ${i + 1}/${units.length}: "${unit.title}"`);
      const result = await aiService.createCompletionWithRetry({
        provider: 'anthropic',
        model: cfg.model,
        temperature: 0.6,
        maxTokens: Math.min(cfg.maxTokens, 2500),
        messages: [
          { role: 'system', content: 'You generate educational PowerPoint slide content. Return ONLY a valid JSON array, no markdown.' },
          { role: 'user', content: buildUnitPrompt({ ...unit, subject, level, detailLevel, backgrounds }) },
        ],
      }, 3);

      const raw = String(result?.content || '').trim();
      const match = raw.match(/\[[\s\S]*\]/);
      contentByUnit[i] = JSON.parse(match ? match[0] : raw);
      consecutiveErrors = 0;
      console.log(`[slideBatch] job ${jobId} unit ${i + 1} OK — ${contentByUnit[i].length} slides`);
    } catch (err) {
      console.error(`[slideBatch] job ${jobId} unit ${i + 1} failed:`, err?.message || err);
      contentByUnit[i] = fallbackSlides(unit, i);
      consecutiveErrors++;

      // If first unit fails, the problem is likely systemic (bad API key, wrong model) — abort early
      if (consecutiveErrors >= 2 || i === 0) {
        const errMsg = `Unit generation failed: ${String(err?.message || err).slice(0, 300)}`;
        await updateGenerationJob(jobId, {
          status: 'failed',
          error_message: errMsg,
          completed_at: new Date(),
        }).catch(() => {});
        console.error(`[slideBatch] job ${jobId} aborting after consecutive errors`);
        return;
      }
    }

    await updateGenerationJob(jobId, {
      result: { completedUnits: i + 1, totalUnits: units.length, contentReady: false },
    }).catch(() => {});
  }

  fs.writeFileSync(contentPath(jobId), JSON.stringify({ units, contentByUnit }));

  await updateGenerationJob(jobId, {
    status: 'completed',
    result: { completedUnits: units.length, totalUnits: units.length, contentReady: true },
    completed_at: new Date(),
  });
  console.log(`[slideBatch] job ${jobId} completed`);
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function getBatchStatus(jobId, userId) {
  const row = await getGenerationJobById(jobId, userId);
  if (!row) return null;

  let payload = {};
  let progress = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch (_) {}
  try { progress = JSON.parse(row.result_json || '{}'); } catch (_) {}

  // If scheduled and time has arrived, kick off processing now
  if (row.status === 'scheduled' && row.scheduled_for) {
    const scheduledAt = new Date(row.scheduled_for);
    if (scheduledAt <= new Date()) {
      const { units, subject, level, detailLevel, backgrounds } = payload;
      await updateGenerationJob(jobId, { status: 'processing' });
      processUnits(jobId, { units, subject, level, detailLevel, backgrounds }).catch((err) => {
        console.error('[slideBatch] Scheduled processing error for job', jobId, err?.message);
        updateGenerationJob(jobId, { status: 'failed', error_message: String(err?.message || err) }).catch(() => {});
      });
      const refreshed = await getGenerationJobById(jobId, userId);
      return formatStatus(refreshed, progress, payload);
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
    unitCount: Array.isArray(payload?.units) ? payload.units.length : (progress.totalUnits || 0),
    errorMessage: row.error_message || null,
  };
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

  const pptxEntries = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const slides = contentByUnit[i] || fallbackSlides(unit, i);

    let slideImages = {};
    if (generateImages && sessionMediaDir) {
      const unitImgDir = path.join(sessionMediaDir, `unit_${i}_imgs`);
      slideImages = await generateSlideImages(slides, unitImgDir, {
        topic: unit.title,
        subject,
        level,
      }).catch(() => ({}));
    }

    const buf = await buildFreshSlidePptx(
      slides,
      {},
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
