/**
 * Feedback video generation using OpenAI Sora Video API.
 * Uses REST API (videos endpoint) as the Node SDK may not expose it in all versions.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OPENAI_VIDEO_BASE = 'https://api.openai.com/v1/videos';
const POLL_INTERVAL_MS = 15000;
const MAX_POLL_WAIT_MS = 10 * 60 * 1000; // 10 minutes

function getAuthHeader() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !key.trim()) {
    throw new Error('OPENAI_API_KEY is required for feedback video generation.');
  }
  return { Authorization: `Bearer ${key.trim()}` };
}

/**
 * Build a Sora prompt for a short video of an educator explaining the feedback.
 * Prompt must describe shot, subject, action, setting; no real people/copyright.
 */
function buildFeedbackVideoPrompt(feedbackText, rubricName, totalScore, maxPoints) {
  const truncated = (feedbackText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  const scoreLine = maxPoints ? ` The student scored ${totalScore} out of ${maxPoints}.` : '';
  return (
    `Wide shot of a friendly professional educator in a modern office, sitting at a desk, speaking warmly to camera. ` +
    `Soft lighting, neutral background, calm and supportive atmosphere. ` +
    `The educator is explaining assignment feedback to a student.${scoreLine} ` +
    `No real people or copyrighted characters. Suitable for all ages.`
  );
}

/**
 * Create a video generation job with Sora (multipart/form-data).
 * @returns {Promise<{ id: string, status: string }>}
 */
async function createVideoJob(prompt, options = {}) {
  const { model = 'sora-2', seconds = '4', size = '1280x720' } = options;
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('model', model);
  form.append('seconds', String(seconds));
  form.append('size', size);

  const res = await fetch(OPENAI_VIDEO_BASE, {
    method: 'POST',
    headers: getAuthHeader(),
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = `OpenAI Video API error: ${res.status}`;
    try {
      const j = JSON.parse(errText);
      if (j.error?.message) errMsg = j.error.message;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const data = await res.json();
  return { id: data.id, status: data.status || 'queued' };
}

/**
 * Get video job status.
 * @returns {Promise<{ status: string, progress?: number, error?: string }>}
 */
async function getVideoStatus(videoId) {
  const res = await fetch(`${OPENAI_VIDEO_BASE}/${videoId}`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Video API status error: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return {
    status: data.status,
    progress: data.progress,
    error: data.error?.message,
  };
}

/**
 * Download video content (MP4) and return as Buffer.
 * @returns {Promise<Buffer>}
 */
async function getVideoContent(videoId) {
  const res = await fetch(`${OPENAI_VIDEO_BASE}/${videoId}/content`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI Video API content error: ${res.status} ${errText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Poll until video is completed or failed; then download and save to filePath.
 * @returns {Promise<{ status: 'completed' | 'failed', filePath?: string, error?: string }>}
 */
async function pollAndDownloadVideo(videoId, filePath) {
  const start = Date.now();
  while (Date.now() - start < MAX_POLL_WAIT_MS) {
    const { status, error } = await getVideoStatus(videoId);
    if (status === 'completed') {
      const buffer = await getVideoContent(videoId);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, buffer);
      return { status: 'completed', filePath };
    }
    if (status === 'failed') {
      return { status: 'failed', error: error || 'Video generation failed' };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status: 'failed', error: 'Video generation timed out' };
}

module.exports = {
  buildFeedbackVideoPrompt,
  createVideoJob,
  getVideoStatus,
  getVideoContent,
  pollAndDownloadVideo,
  POLL_INTERVAL_MS,
  MAX_POLL_WAIT_MS,
};
