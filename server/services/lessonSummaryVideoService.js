/**
 * Every section of every published lesson gets its own ~15 second AI summary video
 * (xAI Grok Imagine). It replaces that section's first two visuals (the opening
 * image and the one right after it) and is shown as a hero at the top of the
 * section. Generation is asynchronous and takes minutes, so this is a small
 * background pipeline:
 *
 *   queue  -> create the xAI job, record it in lesson_summary_videos ('pending')
 *   worker -> every POLL_MS check pending jobs; when a video is ready, download it
 *             and splice it into the lesson's content_json ('applied'); on
 *             failure/timeout keep the original images ('failed').
 *
 * The video is stored as an ordinary video_generations row owned by the lesson's
 * author, and referenced from content_json as { kind: 'video', summary: true,
 * video_generation_id } — the existing embed/stream path handles playback.
 */

const { query } = require('../database/connection');
const grokVideoService = require('./grokVideoService');
const { getJobRowById, refreshJobIfProcessing } = require('./videoJobService');
const { assertWithinBudgetOrThrow } = require('./budgetGuardrailService');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

const SUMMARY_SECONDS = 15;
const POLL_MS = 20 * 1000;
const PENDING_TIMEOUT_MS = 40 * 60 * 1000;
const PROJECTED_COST_USD = Number.parseFloat(process.env.VIDEO_GEN_PROJECTED_COST_USD || '0.5') || 0.5;

let timer = null;
let ticking = false;

const clip = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

const stripHtml = (value) => String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

// Friendly doodle imagery keeps the prompt clear of content moderation
// (security topics like "weaponization" or "exploitation" otherwise get rejected).
// The narration line matters: without it the model crams speech into 15 seconds.
function buildSectionPrompt(content, sectionIndex) {
  const title = clip(content?.title, 120) || 'this lesson';
  const section = (Array.isArray(content?.sections) ? content.sections : [])[sectionIndex] || {};
  const heading = clip(section.heading || section.title, 140);
  const idea = clip(section.support, 160);
  const excerpt = clip(stripHtml(section.body || section.raw_body), 240);
  return [
    `A polished 15-second educational explainer video about one part of the lesson "${title}"${heading ? `: ${heading}` : ''}.`,
    idea ? `Key idea: ${idea}.` : '',
    excerpt ? `Context: ${excerpt}` : '',
    'Style: a hand-drawn whiteboard doodle explainer animation. Colourful marker sketches draw themselves stroke by stroke onto a clean white background, with a playful hand-sketched look, and a drawing hand or marker visible as it sketches.',
    'Draw simple doodle illustrations and diagrams: computers, networks, clouds, padlocks, shields, magnifying glasses and friendly cartoon characters, joined by hand-drawn arrows that link the ideas in order.',
    'Keep everything light, friendly and non-threatening: no weapons, no violence, no realistic hacking scenes, and no written words, captions or logos in the drawings.',
    'Audio: a single calm narrator speaking slowly and clearly at a relaxed, unhurried pace with natural pauses between sentences, using no more than about 30 words in total, over soft ambient music. Never rush or add extra words.',
    'Suitable for university students.',
  ].filter(Boolean).join(' ');
}

function parseContent(row) {
  try {
    return typeof row.content_json === 'string' ? JSON.parse(row.content_json) : (row.content_json || {});
  } catch (_) {
    return null;
  }
}

// Put the summary video at the top of a section, replacing its first two visuals.
// If the section already has a summary video (a regeneration), only swap the
// video and leave the remaining visuals alone.
function spliceSummaryVideo(content, videoGenerationId, sectionIndex = 0) {
  const sections = Array.isArray(content?.sections) ? content.sections : [];
  const target = sections[sectionIndex];
  if (!target) return null;
  const video = {
    kind: 'video',
    summary: true,
    title: 'Section summary',
    alt_text: `A ${SUMMARY_SECONDS}-second summary of this section`,
    video_generation_id: Number(videoGenerationId),
  };
  const visuals = Array.isArray(target.visuals) ? target.visuals : [];
  const hadSummary = visuals.some((v) => v && v.kind === 'video' && v.summary);
  const rest = hadSummary
    ? visuals.filter((v) => !(v && v.kind === 'video' && v.summary))
    : visuals.slice(2);
  const nextSections = sections.slice();
  nextSections[sectionIndex] = { ...target, visuals: [video, ...rest] };
  return { ...content, sections: nextSections };
}

async function getSummaryRow(contentId, sectionIndex) {
  const q = isMySQL()
    ? await query('SELECT * FROM lesson_summary_videos WHERE published_content_id = ? AND section_index = ?', [contentId, sectionIndex])
    : await query('SELECT * FROM lesson_summary_videos WHERE published_content_id = $1 AND section_index = $2', [contentId, sectionIndex]);
  return rowList(q)[0] || null;
}

async function setStatus(id, status, errorMessage = null, applied = false) {
  const msg = errorMessage ? String(errorMessage).slice(0, 2000) : null;
  if (isMySQL()) {
    await query(
      `UPDATE lesson_summary_videos SET status = ?, error_message = ?, applied_at = ${applied ? 'CURRENT_TIMESTAMP' : 'applied_at'} WHERE id = ?`,
      [status, msg, id]
    );
  } else {
    await query(
      `UPDATE lesson_summary_videos SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP, applied_at = ${applied ? 'CURRENT_TIMESTAMP' : 'applied_at'} WHERE id = $3`,
      [status, msg, id]
    );
  }
}

async function startSectionVideo(row, content, sectionIndex, { retryFailed, force }) {
  const existing = await getSummaryRow(row.id, sectionIndex);
  if (existing) {
    const redo = force || (retryFailed && existing.status === 'failed');
    if (!redo) return { queued: false, reason: `already_${existing.status}` };
    if (existing.status === 'pending' && !force) return { queued: false, reason: 'already_pending' };
  }

  try {
    await assertWithinBudgetOrThrow({ userId: row.user_id, projectedCostUsd: PROJECTED_COST_USD, generationType: 'lesson summary video' });
  } catch (budgetError) {
    return { queued: false, reason: budgetError?.code === 'BUDGET_GUARDRAIL_EXCEEDED' ? 'budget' : 'budget_check_failed' };
  }

  const prompt = buildSectionPrompt(content, sectionIndex);
  const { requestId } = await grokVideoService.createVideoJob(prompt, {
    duration: SUMMARY_SECONDS,
    aspectRatio: '16:9',
    resolution: '720p',
    generateAudio: true,
  });

  let videoId;
  if (isMySQL()) {
    const ins = await query(
      `INSERT INTO video_generations (user_id, prompt, model, duration_seconds, aspect_ratio, resolution, generate_audio, xai_request_id, status)
       VALUES (?, ?, ?, ?, '16:9', '720p', 1, ?, 'processing')`,
      [row.user_id, prompt, grokVideoService.DEFAULT_MODEL, SUMMARY_SECONDS, requestId]
    );
    videoId = ins.insertId;
  } else {
    const ins = await query(
      `INSERT INTO video_generations (user_id, prompt, model, duration_seconds, aspect_ratio, resolution, generate_audio, xai_request_id, status)
       VALUES ($1, $2, $3, $4, '16:9', '720p', true, $5, 'processing') RETURNING id`,
      [row.user_id, prompt, grokVideoService.DEFAULT_MODEL, SUMMARY_SECONDS, requestId]
    );
    videoId = rowList(ins)[0]?.id;
  }

  if (existing) {
    if (isMySQL()) {
      await query("UPDATE lesson_summary_videos SET video_generation_id = ?, status = 'pending', error_message = NULL WHERE id = ?", [videoId, existing.id]);
    } else {
      await query("UPDATE lesson_summary_videos SET video_generation_id = $1, status = 'pending', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [videoId, existing.id]);
    }
  } else if (isMySQL()) {
    await query("INSERT INTO lesson_summary_videos (published_content_id, section_index, video_generation_id, status) VALUES (?, ?, ?, 'pending')", [row.id, sectionIndex, videoId]);
  } else {
    await query("INSERT INTO lesson_summary_videos (published_content_id, section_index, video_generation_id, status) VALUES ($1, $2, $3, 'pending')", [row.id, sectionIndex, videoId]);
  }
  return { queued: true };
}

/**
 * Start a summary video for every section of one published lesson. Sections that
 * already have one (pending or applied) are skipped unless `force` is set;
 * `retryFailed` redoes only the failed ones.
 * @returns {Promise<{ queued: number, skipped: number }>}
 */
async function queueSummaryVideo(contentId, { retryFailed = false, force = false } = {}) {
  const contentQ = isMySQL()
    ? await query('SELECT id, user_id, content_json FROM published_content WHERE id = ?', [contentId])
    : await query('SELECT id, user_id, content_json FROM published_content WHERE id = $1', [contentId]);
  const row = rowList(contentQ)[0];
  if (!row) return { queued: 0, skipped: 0 };
  const content = parseContent(row);
  const count = Array.isArray(content?.sections) ? content.sections.length : 0;
  const result = { queued: 0, skipped: 0 };
  for (let k = 0; k < count; k += 1) {
    try {
      const r = await startSectionVideo(row, content, k, { retryFailed, force });
      if (r.queued) result.queued += 1; else result.skipped += 1;
    } catch (err) {
      console.warn(`Could not start summary video for lesson ${contentId} section ${k + 1}:`, err.message);
      result.skipped += 1;
    }
  }
  return result;
}

async function applyToLesson(summaryRow) {
  const contentQ = isMySQL()
    ? await query('SELECT id, content_json FROM published_content WHERE id = ?', [summaryRow.published_content_id])
    : await query('SELECT id, content_json FROM published_content WHERE id = $1', [summaryRow.published_content_id]);
  const row = rowList(contentQ)[0];
  if (!row) return setStatus(summaryRow.id, 'failed', 'Lesson no longer exists');
  const content = parseContent(row);
  const next = content && spliceSummaryVideo(content, summaryRow.video_generation_id, Number(summaryRow.section_index || 0));
  if (!next) return setStatus(summaryRow.id, 'failed', 'Lesson has no sections to attach the video to');
  const json = JSON.stringify(next);
  if (isMySQL()) await query('UPDATE published_content SET content_json = ? WHERE id = ?', [json, row.id]);
  else await query('UPDATE published_content SET content_json = $1 WHERE id = $2', [json, row.id]);
  await setStatus(summaryRow.id, 'applied', null, true);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const pendingQ = isMySQL()
      ? await query("SELECT * FROM lesson_summary_videos WHERE status = 'pending' ORDER BY id ASC LIMIT 10")
      : await query("SELECT * FROM lesson_summary_videos WHERE status = 'pending' ORDER BY id ASC LIMIT 10");
    for (const summary of rowList(pendingQ)) {
      try {
        const job = summary.video_generation_id ? await getJobRowById(summary.video_generation_id) : null;
        if (!job) {
          await setStatus(summary.id, 'failed', 'Video job missing');
          continue;
        }
        const refreshed = await refreshJobIfProcessing(job);
        if (refreshed.status === 'completed') {
          await applyToLesson(summary);
        } else if (refreshed.status === 'failed') {
          await setStatus(summary.id, 'failed', refreshed.error_message || 'Video generation failed');
        } else if (Date.now() - new Date(summary.created_at).getTime() > PENDING_TIMEOUT_MS) {
          await setStatus(summary.id, 'failed', 'Timed out waiting for the video');
        }
      } catch (err) {
        console.warn(`Lesson summary video ${summary.id} check failed:`, err.message);
      }
    }
  } catch (err) {
    console.warn('Lesson summary video worker error:', err.message);
  } finally {
    ticking = false;
  }
}

function startWorker() {
  if (timer || process.env.LESSON_SUMMARY_VIDEOS_ENABLED === 'false') return;
  timer = setInterval(tick, POLL_MS);
  if (timer.unref) timer.unref();
}

module.exports = { queueSummaryVideo, startWorker, buildSectionPrompt, spliceSummaryVideo, tick };
