/**
 * Video generation via xAI's Grok Imagine API.
 * Async job pattern: create a job (get a request_id), poll for status, then
 * download the finished video from the URL the status response returns.
 * Mirrors feedbackVideoService.js's Sora integration, adapted to Grok Imagine's
 * contract (see https://docs.x.ai/docs/guides/video-generations).
 */

const XAI_VIDEO_BASE = 'https://api.x.ai/v1/videos';
const DEFAULT_MODEL = 'grok-imagine-video-1.5';
const ALLOWED_ASPECT_RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
const ALLOWED_RESOLUTIONS = new Set(['480p', '720p', '1080p']);

function getAuthHeaders() {
  const key = process.env.XAI_API_KEY;
  if (!key || !key.trim()) {
    throw new Error('XAI_API_KEY is required for video generation.');
  }
  return {
    Authorization: `Bearer ${key.trim()}`,
    'Content-Type': 'application/json',
  };
}

function normalizeDuration(duration) {
  const parsed = Number.parseInt(duration, 10);
  if (!Number.isFinite(parsed)) return 10;
  return Math.max(1, Math.min(15, parsed));
}

function normalizeAspectRatio(aspectRatio) {
  const value = String(aspectRatio || '').trim();
  return ALLOWED_ASPECT_RATIOS.has(value) ? value : '16:9';
}

function normalizeResolution(resolution) {
  const value = String(resolution || '').trim();
  return ALLOWED_RESOLUTIONS.has(value) ? value : '720p';
}

/**
 * Create a video generation job.
 * @returns {Promise<{ requestId: string }>}
 */
async function createVideoJob(prompt, options = {}) {
  const trimmedPrompt = String(prompt || '').trim();
  if (!trimmedPrompt) {
    throw new Error('A prompt is required to generate a video.');
  }

  const body = {
    model: options.model || DEFAULT_MODEL,
    prompt: trimmedPrompt,
    duration: normalizeDuration(options.duration),
    aspect_ratio: normalizeAspectRatio(options.aspectRatio),
    resolution: normalizeResolution(options.resolution),
    generate_audio: options.generateAudio !== false,
  };

  const res = await fetch(`${XAI_VIDEO_BASE}/generations`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let errMsg = `xAI Video API error: ${res.status}`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) errMsg = parsed.error.message;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const data = await res.json();
  if (!data?.request_id) {
    throw new Error('xAI Video API did not return a request_id.');
  }
  return { requestId: data.request_id };
}

/**
 * Check job status.
 * @returns {Promise<{ status: 'processing'|'completed'|'failed', videoUrl?: string, error?: string }>}
 */
async function getVideoStatus(requestId) {
  const res = await fetch(`${XAI_VIDEO_BASE}/${requestId}`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // A 4xx response means xAI has definitively rejected/terminated this job
    // (e.g. content moderation) rather than a transient/network failure.
    // Treat it as a terminal 'failed' status instead of throwing, so callers
    // stop re-polling it.
    if (res.status >= 400 && res.status < 500) {
      let parsed;
      try {
        parsed = JSON.parse(errText);
      } catch {
        parsed = null;
      }
      const message = parsed?.error || parsed?.code || errText || `xAI Video API error ${res.status}`;
      return { status: 'failed', error: message };
    }
    throw new Error(`xAI Video API status error: ${res.status} ${errText}`);
  }
  const data = await res.json();
  const rawStatus = String(data?.status || '').toLowerCase();

  if (rawStatus === 'done') {
    return { status: 'completed', videoUrl: data?.video?.url };
  }
  if (rawStatus === 'failed' || rawStatus === 'expired') {
    return { status: 'failed', error: data?.error?.message || `Video generation ${rawStatus}` };
  }
  return { status: 'processing' };
}

/**
 * Download the finished video's content as a Buffer.
 */
async function downloadVideo(videoUrl) {
  const res = await fetch(videoUrl);
  if (!res.ok) {
    throw new Error(`Failed to download generated video: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  createVideoJob,
  getVideoStatus,
  downloadVideo,
  DEFAULT_MODEL,
  ALLOWED_ASPECT_RATIOS,
  ALLOWED_RESOLUTIONS,
};
