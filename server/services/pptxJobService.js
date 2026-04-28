/**
 * Batched PPTX job service.
 *
 * Splits a GeneratedContent object into batches of sections, calls AI to reformat
 * each batch into slide-friendly bullets, saves per-batch JSON files, then has Claude
 * assemble the final polished PPTX (with pptxgenjs fallback).
 *
 * Batch JSON format  (uploads/pptx-jobs/{jobId}/batch-{n}.json):
 *   [{ title: string, bullets: string[] }, ...]
 *
 * result_json stores:
 *   { batches: BatchState[], completedBatches: number, totalBatches: number }
 */

const fs = require('fs');
const path = require('path');
const PptxGenJS = require('pptxgenjs').default || require('pptxgenjs');
const aiService = require('./aiService');
const { buildPptxWithAnthropic } = require('./contentService');
const { createGenerationJob, updateGenerationJob, getGenerationJobById } = require('./generationJobService');

const BATCH_SIZE = 4;
const JOBS_DIR = path.join(__dirname, '..', 'uploads', 'pptx-jobs');

try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch (_) {}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jDir(jobId) { return path.join(JOBS_DIR, String(jobId)); }
function batchPath(jobId, i) { return path.join(jDir(jobId), `batch-${i}.json`); }
function finalPath(jobId) { return path.join(jDir(jobId), 'final.pptx'); }
function contentPath(jobId) { return path.join(jDir(jobId), 'content.json'); }

function stripHtml(str) {
  return String(str || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
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
    bullets.push(t.length > maxChars ? t.slice(0, maxChars - 1) + '…' : t);
  }
  if (!bullets.length && plain) {
    bullets.push(plain.length > maxChars ? plain.slice(0, maxChars - 1) + '…' : plain);
  }
  return bullets;
}

function sectionTitle(sec) {
  return String(sec.heading || sec.title || 'Slide').trim().slice(0, 80);
}

// ─── AI batch reformatter ──────────────────────────────────────────────────────

async function reformatBatch(sections) {
  const provider = aiService.openai ? 'openai' : aiService.anthropic ? 'anthropic' : null;
  if (!provider) {
    return sections.map(sec => ({
      title: sectionTitle(sec),
      bullets: sectionToBullets(sec.body || sec.support || '', 5),
    }));
  }

  const sectionList = sections.map((sec, i) => {
    const heading = String(sec.heading || sec.title || '').trim();
    const body = stripHtml(sec.body || '').slice(0, 700);
    return `Section ${i + 1}:\nHeading: ${heading}\nContent: ${body}`;
  }).join('\n\n');

  const userPrompt = `Convert these course content sections into concise PowerPoint slide text. For each section produce:
- "title": a clear slide title (max 8 words)
- "bullets": 3-5 bullet points (max 18 words each, plain text, no markdown symbols)

Return only a JSON array, one object per section, in the same order.

${sectionList}`;

  try {
    const result = await aiService.createCompletionWithRetry({
      provider,
      model: provider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001',
      maxTokens: 2400,
      temperature: 0.25,
      messages: [
        { role: 'system', content: 'You convert educational content into concise slide bullet points. Return only a valid JSON array, no commentary.' },
        { role: 'user', content: userPrompt },
      ],
    }, 2);

    const text = (result?.choices?.[0]?.message?.content) || (result?.content?.[0]?.text) || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in AI response');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('AI response is not an array');

    return parsed.map((item, i) => ({
      title: String(item?.title || sectionTitle(sections[i])).trim().slice(0, 80),
      bullets: Array.isArray(item?.bullets)
        ? item.bullets.map(b => String(b || '').trim()).filter(Boolean).slice(0, 5)
        : sectionToBullets(sections[i]?.body || '', 5),
    }));
  } catch (err) {
    console.warn('[pptxJob] AI reformat failed, using local fallback:', err.message);
    return sections.map(sec => ({
      title: sectionTitle(sec),
      bullets: sectionToBullets(sec.body || sec.support || '', 5),
    }));
  }
}

// ─── Assembly helpers ──────────────────────────────────────────────────────────

// Convert flat slide array to GeneratedContent shape for buildPptxWithAnthropic
function slidesToGeneratedContent(slides, contentMeta = {}) {
  return {
    title: contentMeta.title || 'Presentation',
    instructions: contentMeta.instructions || '',
    sections: slides.map(s => ({
      heading: s.title,
      body: (s.bullets || []).join('\n'),
      support: '',
    })),
  };
}

// Minimal blank PPTX (single blank slide) so Claude has a valid template to start from
async function generateBlankTemplate(jobId) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.addSlide(); // one blank slide — Claude will replace it
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  const tplPath = path.join(jDir(jobId), 'blank-template.pptx');
  fs.writeFileSync(tplPath, buf);
  return tplPath;
}

// pptxgenjs local render (fallback / partial downloads)
async function buildPptxLocal(slides, contentMeta = {}) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.title = contentMeta.title || 'Presentation';
  pptx.author = 'MarkMate';

  const headingColor = '1E293B';
  const textColor = '374151';
  const accentColor = '6D28D9';
  const m = 0.5;
  const contentW = 10 - 2 * m;
  const h = 5.625;
  const TITLE_H = 0.9;
  const BODY_Y = m + TITLE_H + 0.12;
  const BODY_H = h - BODY_Y - m;

  const s0 = pptx.addSlide();
  s0.addText(contentMeta.title || 'Presentation', {
    x: m, y: 1.5, w: contentW, h: 1.6,
    fontSize: 36, bold: true, align: 'center', valign: 'middle', wrap: true, color: headingColor,
  });

  for (const slide of slides) {
    const s = pptx.addSlide();
    s.addText(slide.title, {
      x: m, y: m, w: contentW, h: TITLE_H,
      fontSize: 22, bold: true, valign: 'middle', wrap: true, color: headingColor,
    });
    s.addText((slide.bullets || []).join('\n'), {
      x: m, y: BODY_Y, w: contentW, h: BODY_H,
      fontSize: 15, valign: 'top', wrap: true, color: textColor,
      bullet: { type: 'bullet', indent: 10 },
    });
  }

  if (slides.length > 2) {
    const summary = pptx.addSlide();
    summary.addText('Summary', {
      x: m, y: m, w: contentW, h: TITLE_H,
      fontSize: 22, bold: true, valign: 'middle', wrap: true, color: headingColor,
    });
    summary.addText(slides.map(s => s.title).join('\n'), {
      x: m, y: BODY_Y, w: contentW, h: BODY_H,
      fontSize: 14, valign: 'top', wrap: true, color: accentColor,
      bullet: { type: 'bullet', indent: 10 },
    });
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

// Final assembly: Claude builds using the user's template (or a blank canvas), pptxgenjs fallback
async function buildFinalPptx(slides, contentMeta, jobId, templatePath = null) {
  const hasAnthropic = !!(aiService.anthropic?.beta?.messages?.stream || aiService.anthropic?.beta?.messages?.create);

  if (hasAnthropic) {
    let generatedBlank = null;
    let effectiveTemplatePath = templatePath;
    try {
      if (!effectiveTemplatePath || !fs.existsSync(effectiveTemplatePath)) {
        // No user template — generate a minimal blank so Claude still controls the design
        effectiveTemplatePath = await generateBlankTemplate(jobId);
        generatedBlank = effectiveTemplatePath;
      }
      const content = slidesToGeneratedContent(slides, contentMeta);
      const buf = await buildPptxWithAnthropic(content, { templatePath: effectiveTemplatePath });
      return buf;
    } catch (err) {
      console.warn('[pptxJob] Claude deck build failed, falling back to pptxgenjs:', err.message);
    } finally {
      if (generatedBlank) try { fs.unlinkSync(generatedBlank); } catch (_) {}
    }
  }

  return buildPptxLocal(slides, contentMeta);
}

// Collect all slides from completed batch files
function loadCompletedSlides(jobId, batches) {
  const slides = [];
  for (const b of batches) {
    if (b.status !== 'completed') continue;
    const p = batchPath(jobId, b.index);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const items = JSON.parse(raw);
      slides.push(...items);
    } catch (_) {}
  }
  return slides;
}

// ─── Job state helpers ─────────────────────────────────────────────────────────

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

// Convert raw content sections directly to slides without AI (for quick mode)
function contentToSlides(content) {
  return (Array.isArray(content.sections) ? content.sections : []).map(sec => ({
    title: sectionTitle(sec),
    bullets: sectionToBullets(sec.body || sec.support || '', 5),
  }));
}

// ─── Background processor ─────────────────────────────────────────────────────

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

  const useAI = job.payload.useAI !== false; // default true
  const templatePath = job.payload.templatePath || null;
  const contentMeta = { title: content.title, instructions: content.instructions };

  // ── Quick mode: no AI, build locally and finish immediately ──────────────────
  if (!useAI) {
    try {
      await saveProgress(jobId, { batches: [], completedBatches: 0, totalBatches: 0 }, {
        status: 'processing',
        started_at: new Date(),
      });
      const slides = contentToSlides(content);
      const buf = await buildPptxLocal(slides, contentMeta);
      fs.writeFileSync(finalPath(jobId), buf);
      await saveProgress(jobId, { batches: [], completedBatches: 0, totalBatches: 0, finalReady: true }, {
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

  // ── AI mode: batch reformat → Claude assembly ─────────────────────────────────
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const totalBatches = Math.ceil(sections.length / BATCH_SIZE) || 1;

  // Initialise batch state if not yet set
  let batches = Array.isArray(job.progress.batches) ? job.progress.batches : [];
  if (batches.length !== totalBatches) {
    batches = Array.from({ length: totalBatches }, (_, i) => ({
      index: i,
      sectionStart: i * BATCH_SIZE,
      sectionEnd: Math.min((i + 1) * BATCH_SIZE, sections.length),
      status: 'pending',
      error: null,
    }));
  }

  await saveProgress(jobId, { batches, completedBatches: batches.filter(b => b.status === 'completed').length, totalBatches }, {
    status: 'processing',
    started_at: new Date(),
  });

  for (let i = 0; i < batches.length; i++) {
    if (batches[i].status === 'completed') continue; // already done (resume case)

    batches[i].status = 'processing';
    await saveProgress(jobId, { batches, completedBatches: batches.filter(b => b.status === 'completed').length, totalBatches });

    const bSections = sections.slice(batches[i].sectionStart, batches[i].sectionEnd);
    try {
      const slides = await reformatBatch(bSections);
      fs.writeFileSync(batchPath(jobId, i), JSON.stringify(slides, null, 2));
      batches[i].status = 'completed';
      batches[i].error = null;
      const completedBatches = batches.filter(b => b.status === 'completed').length;
      await saveProgress(jobId, { batches, completedBatches, totalBatches });
    } catch (err) {
      batches[i].status = 'failed';
      batches[i].error = String(err.message || err).slice(0, 300);
      await saveProgress(jobId, { batches, completedBatches: batches.filter(b => b.status === 'completed').length, totalBatches }, {
        status: 'failed',
        error_message: `Batch ${i} failed: ${batches[i].error}`,
        completed_at: new Date(),
      });
      return; // stop — client can retry
    }
  }

  // All batches done — Claude assembles the final PPTX (pptxgenjs fallback)
  try {
    const allSlides = loadCompletedSlides(jobId, batches);
    const buf = await buildFinalPptx(allSlides, contentMeta, jobId, templatePath);
    fs.writeFileSync(finalPath(jobId), buf);
    await saveProgress(jobId, { batches, completedBatches: batches.length, totalBatches, finalReady: true }, {
      status: 'completed',
      completed_at: new Date(),
    });
  } catch (err) {
    await saveProgress(jobId, { batches, completedBatches: batches.filter(b => b.status === 'completed').length, totalBatches }, {
      status: 'failed',
      error_message: `PPTX assembly failed: ${String(err.message || err).slice(0, 300)}`,
      completed_at: new Date(),
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function createJob(userId, content, options = {}) {
  const sections = Array.isArray(content.sections) ? content.sections : [];
  const totalBatches = Math.ceil(sections.length / BATCH_SIZE) || 1;
  const templatePath = options.templatePath || null;
  const useAI = options.useAI !== false; // default true

  const jobId = await createGenerationJob({
    user_id: userId,
    job_type: 'pptx_batch',
    status: 'processing',
    source_route: '/pptx-jobs',
    payload: { totalBatches, totalSections: sections.length, title: content.title, templatePath, useAI },
    max_retries: 3,
  });

  const dir = jDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(contentPath(jobId), JSON.stringify(content));

  // Fire and forget
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

  // Reset any failed batches to pending so processing restarts from there
  const batches = Array.isArray(job.progress.batches) ? job.progress.batches : [];
  for (const b of batches) {
    if (b.status === 'failed') b.status = 'pending';
  }
  const totalBatches = job.progress.totalBatches || batches.length;

  await saveProgress(jobId, { ...job.progress, batches, completedBatches: batches.filter(b => b.status === 'completed').length, totalBatches }, {
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
  return buildPptxLocal(slides, { title: content.title, instructions: content.instructions });
}

async function cleanupJob(jobId) {
  const dir = jDir(jobId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

module.exports = { JOBS_DIR, createJob, getJobState, retryJob, getFinalBuffer, getPartialBuffer, cleanupJob };
