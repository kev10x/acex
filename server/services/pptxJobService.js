/**
 * PPTX job service.
 *
 * When a template is uploaded: sends the content + template to Claude's PPTX
 * skill in a single call — content is distilled for slides and the template
 * design is preserved in one step.
 *
 * When no template is present (or AI is disabled): renders locally with
 * PptxGenJS using theme colours extracted from the template file.
 */

const fs = require('fs');
const path = require('path');
const aiService = require('./aiService');
const contentService = require('./contentService');
const { createGenerationJob, updateGenerationJob, getGenerationJobById } = require('./generationJobService');

const JOBS_DIR = path.join(__dirname, '..', 'uploads', 'pptx-jobs');
const MAX_TURNS = 12;

try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (_) {}

function jDir(jobId) { return path.join(JOBS_DIR, String(jobId)); }
function finalPath(jobId) { return path.join(jDir(jobId), 'final.pptx'); }
function contentPath(jobId) { return path.join(jDir(jobId), 'content.json'); }

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
  await updateGenerationJob(jobId, { ...statusUpdate, result: progress });
}

function canUseAnthropicPptx() {
  const c = aiService.anthropic;
  return !!(c?.beta?.messages?.stream && c?.beta?.files?.upload && c?.beta?.files?.download);
}

async function processJob(jobId) {
  const job = await loadJobRow(jobId);
  if (!job) return;

  let content;
  try {
    content = JSON.parse(fs.readFileSync(contentPath(jobId), 'utf8'));
  } catch {
    await saveProgress(jobId, {}, {
      status: 'failed',
      error_message: 'Could not read content file',
      completed_at: new Date(),
    });
    return;
  }

  const templatePath = job.payload.templatePath || null;
  const useAI = job.payload.useAI !== false;

  await saveProgress(jobId, { step: 'building', turn: 0, totalTurns: MAX_TURNS }, {
    status: 'processing',
    started_at: new Date(),
  });

  try {
    let buf;

    if (templatePath && useAI && canUseAnthropicPptx()) {
      buf = await contentService.buildPptxWithAnthropic(content, {
        templatePath,
        onTurn: async (turn) => {
          await saveProgress(jobId, { step: 'building', turn, totalTurns: MAX_TURNS });
        },
      });
    } else {
      buf = await contentService.buildPptx(content, { templatePath, forceLocal: true });
    }

    fs.writeFileSync(finalPath(jobId), buf);
    await saveProgress(jobId, { step: 'done', finalReady: true }, {
      status: 'completed',
      completed_at: new Date(),
    });
  } catch (err) {
    await saveProgress(jobId, { step: 'failed' }, {
      status: 'failed',
      error_message: `PPTX build failed: ${String(err.message || err).slice(0, 300)}`,
      completed_at: new Date(),
    });
  }
}

async function createJob(userId, content, options = {}) {
  const templatePath = options.templatePath || null;
  const useAI = options.useAI !== false;

  const jobId = await createGenerationJob({
    user_id: userId,
    job_type: 'pptx_batch',
    status: 'processing',
    source_route: '/pptx-jobs',
    payload: { title: content.title, templatePath, useAI },
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

  await saveProgress(jobId, { step: 'building', turn: 0, totalTurns: MAX_TURNS }, {
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

  let content = {};
  try { content = JSON.parse(fs.readFileSync(contentPath(jobId), 'utf8')); } catch (_) {}

  return contentService.buildPptx(content, { forceLocal: true });
}

async function cleanupJob(jobId) {
  const dir = jDir(jobId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { createJob, getJobState, retryJob, getFinalBuffer, getPartialBuffer, cleanupJob };
