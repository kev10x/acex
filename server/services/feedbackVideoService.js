/**
 * Feedback video generation using OpenAI Sora Video API.
 * Uses REST API (videos endpoint) as the Node SDK may not expose it in all versions.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
  const scoreLine = maxPoints ? ` The student scored ${totalScore} out of ${maxPoints}.` : '';
  return (
    `Wide shot of a friendly professional educator in a modern office, sitting at a desk, speaking warmly to camera. ` +
    `Soft lighting, neutral background, calm and supportive atmosphere. ` +
    `The educator is explaining assignment feedback to a student.${scoreLine} ` +
    `No real people or copyrighted characters. Suitable for all ages.`
  );
}

/**
 * Build multiple prompt variants for stitching (e.g. intro, main, outro).
 * Each clip is 4 seconds; same visual style so stitching looks coherent.
 * @returns {string[]} Array of prompts, one per clip.
 */
function buildFeedbackVideoPromptSegments(feedbackText, rubricName, totalScore, maxPoints, numSegments = 3) {
  const scoreLine = maxPoints ? ` The student scored ${totalScore} out of ${maxPoints}.` : '';
  const base = 'Wide shot of a friendly professional educator in a modern office, sitting at a desk, speaking warmly to camera. Soft lighting, neutral background, calm and supportive atmosphere. No real people or copyrighted characters. Suitable for all ages.';
  const segments = [];
  if (numSegments >= 3) {
    segments.push(`${base} The educator welcomes the student and introduces the assignment feedback.${scoreLine}`);
    segments.push(`${base} The educator is explaining the main feedback points in a supportive way.`);
    segments.push(`${base} The educator gives a brief closing summary and encouragement.`);
  } else if (numSegments === 2) {
    segments.push(`${base} The educator introduces the feedback.${scoreLine}`);
    segments.push(`${base} The educator explains the feedback and gives a closing summary.`);
  } else {
    segments.push(buildFeedbackVideoPrompt(feedbackText, rubricName, totalScore, maxPoints));
  }
  return segments.slice(0, numSegments);
}

/**
 * Create a video generation job with Sora (multipart/form-data).
 * @returns {Promise<{ id: string, status: string }>}
 */
async function createVideoJob(prompt, options = {}) {
  const defaultSeconds = process.env.SORA_VIDEO_SECONDS || '8';
  const { model = 'sora-2', seconds = defaultSeconds, size = '1280x720' } = options;
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

/**
 * Stitch multiple MP4 files into one using ffmpeg concat demuxer.
 * Requires ffmpeg on the system PATH.
 * @param {string[]} inputPaths - Full paths to MP4 files in order.
 * @param {string} outputPath - Full path for the output MP4.
 * @returns {Promise<void>}
 */
function stitchVideos(inputPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listDir = path.dirname(outputPath);
    const listPath = path.join(listDir, `concat-list-${Date.now()}.txt`);
    const listContent = inputPaths.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      try { fs.unlinkSync(listPath); } catch (_) {}
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-500)}`));
    });
    proc.on('error', (err) => {
      try { fs.unlinkSync(listPath); } catch (_) {}
      reject(new Error(`ffmpeg not found or failed to start: ${err.message}. Install ffmpeg on the server.`));
    });
  });
}

module.exports = {
  buildFeedbackVideoPrompt,
  buildFeedbackVideoPromptSegments,
  createVideoJob,
  getVideoStatus,
  getVideoContent,
  pollAndDownloadVideo,
  stitchVideos,
  POLL_INTERVAL_MS,
  MAX_POLL_WAIT_MS,
};
