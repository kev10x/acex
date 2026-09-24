/**
 * Every published lesson gets a ~15 second AI summary video (xAI Grok Imagine).
 * It replaces the first two visuals of the lesson's first section (the opening
 * image and the one right after it) and is shown as a hero at the top of the
 * lesson. Generation is asynchronous and takes minutes, so this is a small
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

// Abstract, non-violent imagery keeps the prompt clear of content moderation
// (security topics like "weaponization" or "exploitation" otherwise get rejected).
function buildSummaryPrompt(content) {
  const title = clip(content?.title, 140) || 'this lesson';
  const ideas = (Array.isArray(content?.sections) ? content.sections : [])
    .slice(0, 4)
    .map((s) => clip(s?.support || s?.heading || s?.title, 110))
    .filter(Boolean);
  return [
    `A polished 15-second educational explainer video that summarises the lesson "${title}".`,
    ideas.length ? `Visualise these key ideas in sequence: ${ideas.join('; ')}.` : '',
    'Style: clean modern motion graphics with smooth camera moves and calm, confident narration-free music.',
    'Use abstract, non-violent visuals such as glowing network nodes, data streams, padlocks, shields, dashboards and diagrams.',
    'No people, no weapons, no realistic violence or hacking scenes, and no on-screen text, captions or logos.',
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

// Replace the first two visuals of the first section with the summary video.
function spliceSummaryVideo(content, videoGenerationId) {
  const sections = Array.isArray(content?.sections) ? content.sections : [];
  if (sections.length === 0) return null;
  const video = {
    kind: 'video',
    summary: true,
    title: 'Lesson summary',
    alt_text: `A ${SUMMARY_SECONDS}-second summary of this lesson`,
    video_generation_id: Number(videoGenerationId),
  };
  const first = sections[0];
  const rest = (Array.isArray(first.visuals) ? first.visuals : [])
    .filter((v) => !(v && v.kind === 'video' && v.summary))
    .slice(2);
  return {
    ...content,
    sections: [{ ...first, visuals: [video, ...rest] }, ...sections.slice(1)],
  };
}

async function getSummaryRow(contentId) {
  const q = isMySQL()
    ? await query('SELECT * FROM lesson_summary_videos WHERE published_content_id = ?', [contentId])
    : await query('SELECT * FROM lesson_summary_videos WHERE published_content_id = $1', [contentId]);
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

/**
 * Start a summary video for one published lesson (no-op if it already has one
 * that is pending or applied). `retryFailed` lets a failed one be tried again.
 * @returns {Promise<{ queued: boolean, reason?: string }>}
 */
async function queueSummaryVideo(contentId, { retryFailed = false } = {}) {
  const contentQ = isMySQL()
    ? await query('SELECT id, user_id, content_json FROM published_content WHERE id = ?', [contentId])
    : await query('SELECT id, user_id, content_json FROM published_content WHERE id = $1', [contentId]);
  const row = rowList(contentQ)[0];
  if (!row) return { queued: false, reason: 'not_found' };

  const existing = await getSummaryRow(contentId);
  if (existing && !(retryFailed && existing.status === 'failed')) {
    return { queued: false, reason: `already_${existing.status}` };
  }

  const content = parseContent(row);
  if (!content || !Array.isArray(content.sections) || content.sections.length === 0) {
    return { queued: false, reason: 'no_sections' };
  }

  try {
    await assertWithinBudgetOrThrow({ userId: row.user_id, projectedCostUsd: PROJECTED_COST_USD, generationType: 'lesson summary video' });
  } catch (budgetError) {
    return { queued: false, reason: budgetError?.code === 'BUDGET_GUARDRAIL_EXCEEDED' ? 'budget' : 'budget_check_failed' };
  }

  const prompt = buildSummaryPrompt(content);
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
    await query("INSERT INTO lesson_summary_videos (published_content_id, video_generation_id, status) VALUES (?, ?, 'pending')", [contentId, videoId]);
  } else {
    await query("INSERT INTO lesson_summary_videos (published_content_id, video_generation_id, status) VALUES ($1, $2, 'pending')", [contentId, videoId]);
  }
  return { queued: true };
}

async function applyToLesson(summaryRow) {
  const contentQ = isMySQL()
    ? await query('SELECT id, content_json FROM published_content WHERE id = ?', [summaryRow.published_content_id])
    : await query('SELECT id, content_json FROM published_content WHERE id = $1', [summaryRow.published_content_id]);
  const row = rowList(contentQ)[0];
  if (!row) return setStatus(summaryRow.id, 'failed', 'Lesson no longer exists');
  const content = parseContent(row);
  const next = content && spliceSummaryVideo(content, summaryRow.video_generation_id);
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

module.exports = { queueSummaryVideo, startWorker, buildSummaryPrompt, spliceSummaryVideo, tick };
