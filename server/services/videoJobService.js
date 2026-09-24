/**
 * Shared video-job helpers: look up a job, and if it is still processing check
 * xAI and (when done) download and store the file. Used both by the video tool's
 * lazy client polling and by the lesson summary-video background worker.
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { query } = require('../database/connection');
const grokVideoService = require('./grokVideoService');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

const VIDEO_GEN_DIR = path.join(__dirname, '..', 'uploads', 'video-gen');
try {
  fs.mkdirSync(VIDEO_GEN_DIR, { recursive: true });
} catch (_) {}

async function getJobRowById(jobId) {
  const q = isMySQL()
    ? await query('SELECT * FROM video_generations WHERE id = ?', [jobId])
    : await query('SELECT * FROM video_generations WHERE id = $1', [jobId]);
  return rowList(q)[0] || null;
}

/**
 * If a job is still processing, check xAI now and, if done, download and
 * persist the video. Called lazily from GET /jobs/:id and GET /jobs — the
 * client polls those endpoints, so no background timer is needed (same
 * lazy-poll pattern the existing Sora content-video flow in content.js uses).
 */
async function refreshJobIfProcessing(row) {
  if (row.status !== 'processing' || !row.xai_request_id) return row;

  let statusResult;
  try {
    statusResult = await grokVideoService.getVideoStatus(row.xai_request_id);
  } catch (error) {
    console.warn(`Video gen status check failed for job ${row.id}:`, error.message);
    return row;
  }

  if (statusResult.status === 'processing') {
    return row;
  }

  if (statusResult.status === 'failed') {
    const errorMessage = String(statusResult.error || 'Video generation failed').slice(0, 2000);
    if (isMySQL()) {
      await query('UPDATE video_generations SET status = ?, error_message = ? WHERE id = ?', ['failed', errorMessage, row.id]);
    } else {
      await query('UPDATE video_generations SET status = $1, error_message = $2 WHERE id = $3', ['failed', errorMessage, row.id]);
    }
    return { ...row, status: 'failed', error_message: errorMessage };
  }

  // completed
  try {
    const buffer = await grokVideoService.downloadVideo(statusResult.videoUrl);
    const filePath = path.join(VIDEO_GEN_DIR, `${row.id}.mp4`);
    await fsPromises.writeFile(filePath, buffer);
    if (isMySQL()) {
      await query('UPDATE video_generations SET status = ?, file_path = ? WHERE id = ?', ['completed', filePath, row.id]);
    } else {
      await query('UPDATE video_generations SET status = $1, file_path = $2 WHERE id = $3', ['completed', filePath, row.id]);
    }
    return { ...row, status: 'completed', file_path: filePath };
  } catch (error) {
    const errorMessage = `Failed to download generated video: ${error.message}`.slice(0, 2000);
    if (isMySQL()) {
      await query('UPDATE video_generations SET status = ?, error_message = ? WHERE id = ?', ['failed', errorMessage, row.id]);
    } else {
      await query('UPDATE video_generations SET status = $1, error_message = $2 WHERE id = $3', ['failed', errorMessage, row.id]);
    }
    return { ...row, status: 'failed', error_message: errorMessage };
  }
}

module.exports = { VIDEO_GEN_DIR, getJobRowById, refreshJobIfProcessing };
