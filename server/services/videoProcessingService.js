const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStaticPath = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const OpenAI = require('openai');
const { query } = require('../database/connection');
const { generateMarking } = require('./markingService');
const { estimateCost } = require('../config/ai-config');

const POLL_INTERVAL_MS = 15000;
const MAX_MEDIA_DURATION_SECONDS = Math.max(60, Number(process.env.MAX_MEDIA_DURATION_SECONDS || 3600));
const MEDIA_DIR = path.resolve(process.env.MEDIA_PROCESSING_DIR || path.join(__dirname, '../uploads/media-processing'));
const DEFAULT_MAX_RETRIES = Math.max(0, Number(process.env.MEDIA_PROCESSING_MAX_RETRIES || 3));
const RETRY_BASE_SECONDS = Math.max(10, Number(process.env.MEDIA_PROCESSING_RETRY_BASE_SECONDS || 30));
const RETRY_MAX_SECONDS = Math.max(RETRY_BASE_SECONDS, Number(process.env.MEDIA_PROCESSING_RETRY_MAX_SECONDS || 600));

// Frame extraction tuning (Decision #1: scene-change detection with a fixed-interval fallback)
const SCENE_CHANGE_THRESHOLD = Number(process.env.MEDIA_SCENE_CHANGE_THRESHOLD || 0.3);
const MAX_FRAMES = Math.max(1, Number(process.env.MEDIA_MAX_FRAMES || 80));
const MIN_SCENE_FRAMES = 3;
const FALLBACK_INTERVAL_SECONDS = 20;

// Audio transcription chunking (OpenAI's per-request limit is ~25MB)
const AUDIO_CHUNK_SECONDS = 600;
const AUDIO_CHUNK_OVERLAP_SECONDS = 5;
const AUDIO_CHUNK_MAX_BYTES = 24 * 1024 * 1024;

const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const firstRow = (result) => rowsOf(result)[0];

// Resolve ffmpeg/ffprobe binaries: env override wins, else the bundled static binary (Decision #6),
// mirroring the GRAPHICSMAGICK_PATH/GHOSTSCRIPT_PATH escape-hatch precedent in pdfOCR.js.
const resolvedFfmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath;
const resolvedFfprobePath = process.env.FFPROBE_PATH || ffprobeStatic.path;
if (resolvedFfmpegPath) ffmpeg.setFfmpegPath(resolvedFfmpegPath);
if (resolvedFfprobePath) ffmpeg.setFfprobePath(resolvedFfprobePath);

let pollingTimer = null;
let cycleInProgress = false;

class NonRetryableMediaError extends Error {}

function ensureOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const durationSeconds = Number(metadata?.format?.duration || 0);
      const hasVideoStream = Array.isArray(metadata?.streams) && metadata.streams.some((s) => s.codec_type === 'video');
      const hasAudioStream = Array.isArray(metadata?.streams) && metadata.streams.some((s) => s.codec_type === 'audio');
      resolve({ durationSeconds, hasVideoStream, hasAudioStream });
    });
  });
}

function extractAudioTrack(sourcePath, outAudioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('libmp3lame')
      .output(outAudioPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function extractAudioChunk(sourcePath, outPath, startSeconds, durationSeconds) {
  return new Promise((resolve, reject) => {
    ffmpeg(sourcePath)
      .setStartTime(startSeconds)
      .duration(durationSeconds)
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Splits audio into overlapping chunks so a transcription request never exceeds OpenAI's
// per-file size limit; the small overlap avoids losing words that fall on a chunk boundary.
async function buildAudioChunks(audioPath, workDir, totalDurationSeconds) {
  const stat = fs.statSync(audioPath);
  if (stat.size <= AUDIO_CHUNK_MAX_BYTES && totalDurationSeconds <= AUDIO_CHUNK_SECONDS) {
    return [{ filePath: audioPath, startOffsetSeconds: 0 }];
  }

  const chunks = [];
  let index = 0;
  let cursor = 0;
  while (cursor < totalDurationSeconds) {
    const chunkStart = index === 0 ? 0 : Math.max(0, cursor - AUDIO_CHUNK_OVERLAP_SECONDS);
    const chunkDuration = Math.min(AUDIO_CHUNK_SECONDS + AUDIO_CHUNK_OVERLAP_SECONDS, totalDurationSeconds - chunkStart);
    const chunkPath = path.join(workDir, `audio-chunk-${index}.mp3`);
    await extractAudioChunk(audioPath, chunkPath, chunkStart, chunkDuration);
    chunks.push({ filePath: chunkPath, startOffsetSeconds: chunkStart });
    index += 1;
    cursor += AUDIO_CHUNK_SECONDS;
  }
  return chunks;
}

// Transcribes the full audio track (chunked if necessary) and returns both a plain concatenated
// transcript (for assignments.extracted_text, reusing the marking pipeline unchanged) and
// timestamped segments (Decision #3, stored separately for future use).
async function transcribeAudio(audioPath, workDir, totalDurationSeconds) {
  const client = ensureOpenAIClient();
  if (!client) {
    throw new Error('OPENAI_API_KEY is not configured; audio transcription requires OpenAI');
  }

  const chunks = await buildAudioChunks(audioPath, workDir, totalDurationSeconds);
  const textParts = [];
  const segments = [];

  for (const chunk of chunks) {
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(chunk.filePath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    });

    if (transcription.text) {
      textParts.push(String(transcription.text).trim());
    }
    if (Array.isArray(transcription.segments)) {
      for (const segment of transcription.segments) {
        segments.push({
          start: Number(segment.start || 0) + chunk.startOffsetSeconds,
          end: Number(segment.end || 0) + chunk.startOffsetSeconds,
          text: String(segment.text || '').trim()
        });
      }
    }

    if (chunk.filePath !== audioPath) {
      try { fs.unlinkSync(chunk.filePath); } catch (_) { /* ignore temp cleanup errors */ }
    }
  }

  return {
    plainText: textParts.join('\n\n'),
    segments
  };
}

function parseSceneFrameTimestamps(stderrLog) {
  const timestamps = [];
  const regex = /pts_time:([0-9.]+)/g;
  let match;
  while ((match = regex.exec(stderrLog)) !== null) {
    timestamps.push(Number(match[1]));
  }
  return timestamps;
}

function runFrameExtraction(sourcePath, outputPattern, vfFilter) {
  return new Promise((resolve, reject) => {
    let stderrLog = '';
    ffmpeg(sourcePath)
      .outputOptions(['-vf', vfFilter, '-vsync', 'vfr', '-q:v', '2'])
      .output(outputPattern)
      .on('stderr', (line) => { stderrLog += `${line}\n`; })
      .on('end', () => resolve(stderrLog))
      .on('error', reject)
      .run();
  });
}

function listFramesSorted(framesDir) {
  return fs.readdirSync(framesDir)
    .filter((name) => /^frame-\d+\.jpg$/.test(name))
    .sort()
    .map((name) => path.join(framesDir, name));
}

// Cap the frame set to MAX_FRAMES by taking an evenly-spaced subset, preserving chronological order.
function capFrames(framePaths, maxFrames) {
  if (framePaths.length <= maxFrames) return framePaths;
  const step = framePaths.length / maxFrames;
  const capped = [];
  for (let i = 0; i < maxFrames; i += 1) {
    capped.push(framePaths[Math.floor(i * step)]);
  }
  return capped;
}

// Extracts representative frames via scene-change detection (maps frames to real slide
// transitions), falling back to fixed-interval sampling when scene detection finds too few
// or too many transitions (Decision #1).
async function extractFrames(videoPath, workDir, durationSeconds) {
  const framesDir = path.join(workDir, 'frames');
  ensureDir(framesDir);

  await runFrameExtraction(
    videoPath,
    path.join(framesDir, 'frame-%03d.jpg'),
    `select='gt(scene,${SCENE_CHANGE_THRESHOLD})',showinfo`
  );
  let framePaths = listFramesSorted(framesDir);

  if (framePaths.length < MIN_SCENE_FRAMES || framePaths.length > MAX_FRAMES) {
    for (const filePath of framePaths) {
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    }
    const intervalSeconds = Math.max(FALLBACK_INTERVAL_SECONDS, Math.ceil(durationSeconds / MAX_FRAMES));
    await runFrameExtraction(
      videoPath,
      path.join(framesDir, 'frame-%03d.jpg'),
      `fps=1/${intervalSeconds}`
    );
    framePaths = listFramesSorted(framesDir);
  }

  return capFrames(framePaths, MAX_FRAMES);
}

async function updateJobStage(jobId, stage, extra = {}) {
  const setClauses = ['stage = ?', 'updated_at = NOW()'];
  const values = [stage];
  for (const [key, value] of Object.entries(extra)) {
    setClauses.push(`${key} = ?`);
    values.push(value);
  }
  values.push(jobId);
  await query(`UPDATE media_processing_jobs SET ${setClauses.join(', ')} WHERE id = ?`, values);
}

function computeRetryDelaySeconds(retryCount) {
  const exponent = Math.max(0, Number(retryCount || 0));
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** exponent));
}

async function handleJobFailure(job, error) {
  const isTerminal = error instanceof NonRetryableMediaError;
  const message = error?.message || 'Unknown media processing error';
  const nextRetryCount = Number(job.retry_count || 0) + 1;
  const maxRetries = Number(job.max_retries ?? DEFAULT_MAX_RETRIES);

  if (isTerminal || nextRetryCount > maxRetries) {
    await query(
      'UPDATE media_processing_jobs SET status = ?, stage = ?, error_message = ?, completed_at = NOW(), retry_count = ?, updated_at = NOW() WHERE id = ?',
      ['failed', 'failed', message, nextRetryCount, job.id]
    );
    await query('UPDATE assignments SET status = ? WHERE id = ?', ['error', job.assignment_id]);
    return;
  }

  const delaySeconds = computeRetryDelaySeconds(nextRetryCount - 1);
  const nextRetryAt = new Date(Date.now() + (delaySeconds * 1000));
  await query(
    'UPDATE media_processing_jobs SET status = ?, error_message = ?, retry_count = ?, next_retry_at = ?, updated_at = NOW() WHERE id = ?',
    ['queued', message, nextRetryCount, nextRetryAt, job.id]
  );
}

// After a video/audio assignment finishes processing, if it belongs to a published-assessment
// student submission, mark it immediately via the synchronous multimodal generateMarking() call —
// openaiBatchMarkingService.js's OpenAI Batch API path has no image support, so assessment
// video/audio answers must bypass it entirely (Section H of the implementation plan).
async function maybeAutoMarkAssessmentSubmission(assignment) {
  const submission = firstRow(await query(
    'SELECT id, published_assessment_id, student_name FROM assessment_submissions WHERE assignment_id = ?',
    [assignment.id]
  ));
  if (!submission) {
    return;
  }

  const publishedAssessment = firstRow(await query(
    'SELECT id, rubric_id, user_id FROM published_assessments WHERE id = ?',
    [submission.published_assessment_id]
  ));
  if (!publishedAssessment) {
    return;
  }

  const rubric = firstRow(await query(
    'SELECT id, name, criteria, total_points, rubric_type FROM rubrics WHERE id = ?',
    [publishedAssessment.rubric_id]
  ));
  if (!rubric) {
    await query(
      'UPDATE assessment_submissions SET status = ?, failure_reason = ?, completed_at = NOW() WHERE id = ?',
      ['failed', 'Rubric not found for this assessment', submission.id]
    );
    return;
  }
  if (typeof rubric.criteria === 'string') {
    try { rubric.criteria = JSON.parse(rubric.criteria); } catch (_) { rubric.criteria = []; }
  }

  await query('UPDATE assignments SET status = ? WHERE id = ?', ['processing', assignment.id]);
  await query('UPDATE assessment_submissions SET status = ? WHERE id = ?', ['processing', submission.id]);

  try {
    const assignmentImages = assignment.media_type === 'video'
      ? loadPersistedFrameImagesAsBase64(assignment.media_frame_paths)
      : null;

    const markingResult = await generateMarking(
      assignment.extracted_text,
      rubric,
      'assignment',
      null,
      null,
      'strict',
      assignment.id,
      assignmentImages,
      'standard',
      'standard',
      null,
      'video'
    );

    const versionRow = firstRow(await query(
      'SELECT COALESCE(MAX(version), 0) AS max_version FROM marking_results WHERE assignment_id = ?',
      [assignment.id]
    ));
    const newVersion = Number(versionRow?.max_version || 0) + 1;
    await query('UPDATE marking_results SET is_current = 0 WHERE assignment_id = ?', [assignment.id]);

    const usage = markingResult.usage || null;
    const estimatedCostUsd = usage
      ? estimateCost(usage.prompt_tokens, usage.completion_tokens, 'openai')
      : null;

    const insertResult = await query(
      `INSERT INTO marking_results (
        assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current,
        strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence,
        prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assignment.id,
        rubric.id,
        submission.student_name,
        JSON.stringify(markingResult.scores || []),
        markingResult.overall_feedback || '',
        Number(markingResult.total_score || 0),
        newVersion,
        1,
        'strict',
        'video-presentation',
        markingResult.corrections?.length ? JSON.stringify(markingResult.corrections) : null,
        markingResult.language_errors?.length ? JSON.stringify(markingResult.language_errors) : null,
        markingResult.handwriting_recognition_confidence ?? null,
        usage?.prompt_tokens ?? null,
        usage?.completion_tokens ?? null,
        usage?.total_tokens ?? null,
        estimatedCostUsd,
        publishedAssessment.user_id
      ]
    );
    const resultId = insertResult.insertId ?? insertResult.lastID ?? insertResult.rows?.[0]?.id ?? null;

    await query('UPDATE assignments SET status = ? WHERE id = ?', ['completed', assignment.id]);
    await query(
      'UPDATE assessment_submissions SET status = ?, failure_reason = NULL, result_id = ?, completed_at = NOW() WHERE id = ?',
      ['completed', resultId, submission.id]
    );
  } catch (error) {
    await query('UPDATE assignments SET status = ? WHERE id = ?', ['error', assignment.id]);
    await query(
      'UPDATE assessment_submissions SET status = ?, failure_reason = ?, completed_at = NOW() WHERE id = ?',
      ['failed', error.message, submission.id]
    );
  }
}

// Reads persisted frame JPEGs off disk and base64-encodes them — cheap, since extraction already
// happened once during the pipeline and is not repeated on every mark/remark.
function loadPersistedFrameImagesAsBase64(mediaFramePathsJson) {
  let framePaths = [];
  try {
    framePaths = JSON.parse(mediaFramePathsJson || '[]');
  } catch (_) {
    framePaths = [];
  }
  if (!Array.isArray(framePaths) || framePaths.length === 0) {
    return null;
  }
  return framePaths
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => fs.readFileSync(filePath).toString('base64'));
}

async function processVideoJob(job) {
  const assignment = firstRow(await query('SELECT * FROM assignments WHERE id = ?', [job.assignment_id]));
  if (!assignment) {
    await query('UPDATE media_processing_jobs SET status = ?, error_message = ?, completed_at = NOW() WHERE id = ?', ['failed', 'Assignment no longer exists', job.id]);
    return;
  }

  const workDir = path.join(MEDIA_DIR, String(assignment.id));
  ensureDir(workDir);

  try {
    await updateJobStage(job.id, 'probing');
    const probe = await probeMedia(assignment.file_path);
    if (!probe.durationSeconds || probe.durationSeconds <= 0) {
      throw new NonRetryableMediaError('Could not determine media duration — file may be corrupt or in an unsupported format');
    }
    if (probe.durationSeconds > MAX_MEDIA_DURATION_SECONDS) {
      throw new NonRetryableMediaError(`Media duration (${Math.round(probe.durationSeconds)}s) exceeds the maximum allowed (${MAX_MEDIA_DURATION_SECONDS}s)`);
    }
    if (!probe.hasAudioStream) {
      throw new NonRetryableMediaError('No audio track found — a narrated presentation requires spoken audio to mark');
    }
    await query('UPDATE assignments SET media_duration_seconds = ? WHERE id = ?', [Math.round(probe.durationSeconds), assignment.id]);

    let audioPath = assignment.file_path;
    if (job.media_type === 'video') {
      await updateJobStage(job.id, 'extracting_audio');
      audioPath = path.join(workDir, 'audio.mp3');
      await extractAudioTrack(assignment.file_path, audioPath);
    }

    await updateJobStage(job.id, 'transcribing');
    const { plainText, segments } = await transcribeAudio(audioPath, workDir, probe.durationSeconds);
    if (!plainText || plainText.trim().length < 10) {
      throw new NonRetryableMediaError('Transcription produced little or no text — the audio may be silent or unintelligible');
    }
    await query(
      'UPDATE assignments SET extracted_text = ?, media_transcript_segments = ? WHERE id = ?',
      [plainText, JSON.stringify(segments), assignment.id]
    );

    if (job.media_type === 'video') {
      await updateJobStage(job.id, 'extracting_frames');
      const framePaths = await extractFrames(assignment.file_path, workDir, probe.durationSeconds);
      await query('UPDATE assignments SET media_frame_paths = ? WHERE id = ?', [JSON.stringify(framePaths), assignment.id]);
      try { fs.unlinkSync(audioPath); } catch (_) { /* ignore */ }
    }

    await updateJobStage(job.id, 'ready', { status: 'ready', completed_at: new Date() });
    await query('UPDATE assignments SET status = ? WHERE id = ?', ['uploaded', assignment.id]);

    const refreshedAssignment = firstRow(await query('SELECT * FROM assignments WHERE id = ?', [assignment.id]));
    await maybeAutoMarkAssessmentSubmission(refreshedAssignment);
  } catch (error) {
    console.error(`Video processing job ${job.id} (assignment ${job.assignment_id}) failed:`, error);
    await handleJobFailure(job, error);
  }
}

async function processPendingVideoJobs() {
  const dueJobs = rowsOf(await query(
    `SELECT * FROM media_processing_jobs
     WHERE status = ?
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
     ORDER BY created_at ASC`,
    ['queued']
  ));

  for (const job of dueJobs) {
    await query(
      'UPDATE media_processing_jobs SET status = ?, started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = ?',
      ['processing', job.id]
    );
    await processVideoJob(job);
  }
}

async function runVideoProcessingCycle() {
  if (cycleInProgress) {
    return;
  }
  cycleInProgress = true;
  try {
    await processPendingVideoJobs();
  } catch (error) {
    console.error('Video processing cycle failed:', error);
  } finally {
    cycleInProgress = false;
  }
}

function startVideoProcessingPolling() {
  if (pollingTimer) {
    return;
  }
  pollingTimer = setInterval(() => {
    runVideoProcessingCycle().catch((error) => {
      console.error('Video processing polling tick failed:', error);
    });
  }, POLL_INTERVAL_MS);

  runVideoProcessingCycle().catch((error) => {
    console.error('Initial video processing polling run failed:', error);
  });
}

module.exports = {
  startVideoProcessingPolling,
  runVideoProcessingCycle,
  loadPersistedFrameImagesAsBase64,
  MAX_MEDIA_DURATION_SECONDS
};
