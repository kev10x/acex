const { query } = require('../database/connection');

const RETRY_BASE_DELAY_SECONDS = Math.max(10, Number(process.env.GENERATION_JOB_RETRY_BASE_SECONDS || 30));
const MAX_RETRY_CLAIM_PER_CYCLE = Math.max(1, Number(process.env.GENERATION_JOB_RETRY_CLAIM_LIMIT || 20));
const POLL_INTERVAL_MS = Math.max(5000, Number(process.env.GENERATION_JOB_POLL_INTERVAL_MS || 15000));

let workerTimer = null;
let cycleInProgress = false;

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));

function computeRetryDelaySeconds(retryCount) {
  const exponent = Math.max(0, Number(retryCount || 0));
  return RETRY_BASE_DELAY_SECONDS * Math.pow(2, exponent);
}

async function claimRetryCandidates() {
  if (isMySQL()) {
    const result = await query(
      `SELECT id, retry_count
       FROM generation_jobs
       WHERE status = 'failed'
         AND retry_count < max_retries
         AND TIMESTAMPDIFF(SECOND, updated_at, NOW()) >= POW(2, retry_count) * ?
       ORDER BY updated_at ASC
       LIMIT ?`,
      [RETRY_BASE_DELAY_SECONDS, MAX_RETRY_CLAIM_PER_CYCLE]
    );
    return rowsOf(result);
  }
  const result = await query(
    `SELECT id, retry_count
     FROM generation_jobs
     WHERE status = 'failed'
       AND retry_count < max_retries
       AND EXTRACT(EPOCH FROM (NOW() - updated_at)) >= POWER(2, retry_count) * $1
     ORDER BY updated_at ASC
     LIMIT $2`,
    [RETRY_BASE_DELAY_SECONDS, MAX_RETRY_CLAIM_PER_CYCLE]
  );
  return rowsOf(result);
}

async function scheduleRetry(job) {
  const id = Number(job.id);
  if (!Number.isFinite(id) || id <= 0) return;
  const nextRetryCount = Number(job.retry_count || 0) + 1;
  const delaySeconds = computeRetryDelaySeconds(nextRetryCount);

  if (isMySQL()) {
    await query(
      `UPDATE generation_jobs
       SET status = ?, retry_count = ?, error_message = ?, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['scheduled', nextRetryCount, `Auto-retry scheduled by worker after ${delaySeconds}s delay`, id]
    );
    return;
  }
  await query(
    `UPDATE generation_jobs
     SET status = $1, retry_count = $2, error_message = $3, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $4`,
    ['scheduled', nextRetryCount, `Auto-retry scheduled by worker after ${delaySeconds}s delay`, id]
  );
}

async function claimDeadLetterCandidates() {
  if (isMySQL()) {
    const result = await query(
      `SELECT g.id, g.user_id, g.job_type, g.status, g.retry_count, g.max_retries, g.error_message, g.payload_json, g.result_json
       FROM generation_jobs g
       LEFT JOIN generation_job_dead_letters dl ON dl.job_id = g.id
       WHERE dl.job_id IS NULL
         AND g.status = 'failed'
         AND g.retry_count >= g.max_retries
       ORDER BY g.updated_at ASC
       LIMIT ?`,
      [MAX_RETRY_CLAIM_PER_CYCLE]
    );
    return rowsOf(result);
  }
  const result = await query(
    `SELECT g.id, g.user_id, g.job_type, g.status, g.retry_count, g.max_retries, g.error_message, g.payload_json, g.result_json
     FROM generation_jobs g
     LEFT JOIN generation_job_dead_letters dl ON dl.job_id = g.id
     WHERE dl.job_id IS NULL
       AND g.status = 'failed'
       AND g.retry_count >= g.max_retries
     ORDER BY g.updated_at ASC
     LIMIT $1`,
    [MAX_RETRY_CLAIM_PER_CYCLE]
  );
  return rowsOf(result);
}

async function createDeadLetterRecord(job) {
  const params = [
    Number(job.id) || null,
    Number(job.user_id) || null,
    String(job.job_type || 'unknown').slice(0, 60),
    String(job.status || 'failed').slice(0, 20),
    Number(job.retry_count || 0),
    Number(job.max_retries || 0),
    job.error_message ? String(job.error_message).slice(0, 2000) : null,
    job.payload_json || null,
    job.result_json || null,
    'max_retries_exhausted',
  ];

  if (isMySQL()) {
    await query(
      `INSERT INTO generation_job_dead_letters (
        job_id, user_id, job_type, status, retry_count, max_retries, error_message, payload_json, result_json, dead_letter_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        retry_count = VALUES(retry_count),
        max_retries = VALUES(max_retries),
        error_message = VALUES(error_message),
        result_json = VALUES(result_json),
        dead_letter_reason = VALUES(dead_letter_reason)`,
      params
    );
    return;
  }

  await query(
    `INSERT INTO generation_job_dead_letters (
      job_id, user_id, job_type, status, retry_count, max_retries, error_message, payload_json, result_json, dead_letter_reason
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (job_id) DO UPDATE
      SET status = EXCLUDED.status,
          retry_count = EXCLUDED.retry_count,
          max_retries = EXCLUDED.max_retries,
          error_message = EXCLUDED.error_message,
          result_json = EXCLUDED.result_json,
          dead_letter_reason = EXCLUDED.dead_letter_reason`,
    params
  );
}

async function runGenerationJobWorkerCycle() {
  if (cycleInProgress) return;
  cycleInProgress = true;
  try {
    const retryCandidates = await claimRetryCandidates();
    for (const job of retryCandidates) {
      await scheduleRetry(job);
    }

    const deadLetterCandidates = await claimDeadLetterCandidates();
    for (const job of deadLetterCandidates) {
      await createDeadLetterRecord(job);
    }
  } catch (error) {
    console.error('Generation job worker cycle failed:', error);
  } finally {
    cycleInProgress = false;
  }
}

function startGenerationJobWorkerPolling() {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    runGenerationJobWorkerCycle().catch((error) => {
      console.error('Generation job worker tick failed:', error);
    });
  }, POLL_INTERVAL_MS);

  runGenerationJobWorkerCycle().catch((error) => {
    console.error('Initial generation job worker cycle failed:', error);
  });
}

module.exports = {
  startGenerationJobWorkerPolling,
  runGenerationJobWorkerCycle,
  computeRetryDelaySeconds,
};
