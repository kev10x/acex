const { query } = require('../database/connection');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');

const JOB_STATUS = {
  SCHEDULED: 'scheduled',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  RETRYING: 'retrying',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

function sanitizeStatus(status) {
  const value = String(status || '').toLowerCase();
  return Object.values(JOB_STATUS).includes(value) ? value : JOB_STATUS.SCHEDULED;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (_) {
    return JSON.stringify({ note: 'serialization_failed' });
  }
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

async function createGenerationJob({
  user_id,
  job_type,
  status = JOB_STATUS.SCHEDULED,
  source_route = null,
  payload = null,
  retry_count = 0,
  max_retries = 2,
  scheduled_for = null,
}) {
  const safeStatus = sanitizeStatus(status);
  const safePayload = safeJsonStringify(payload);
  const params = [
    Number(user_id) || null,
    String(job_type || 'unknown').slice(0, 60),
    safeStatus,
    source_route == null ? null : String(source_route).slice(0, 120),
    safePayload,
    Number(retry_count) || 0,
    Number(max_retries) || 2,
  ];

  if (isMySQL()) {
    const withSchedule = scheduled_for
      ? await query(
          `INSERT INTO generation_jobs (
            user_id, job_type, status, source_route, payload_json, retry_count, max_retries, scheduled_for
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [...params, scheduled_for]
        )
      : await query(
          `INSERT INTO generation_jobs (
            user_id, job_type, status, source_route, payload_json, retry_count, max_retries
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params
        );
    return Number(withSchedule.insertId ?? withSchedule.lastID ?? 0) || null;
  }

  const withSchedule = scheduled_for
    ? await query(
        `INSERT INTO generation_jobs (
          user_id, job_type, status, source_route, payload_json, retry_count, max_retries, scheduled_for
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id`,
        [...params, scheduled_for]
      )
    : await query(
        `INSERT INTO generation_jobs (
          user_id, job_type, status, source_route, payload_json, retry_count, max_retries
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
        params
      );
  return Number(rowsOf(withSchedule)[0]?.id || 0) || null;
}

async function updateGenerationJob(jobId, updates = {}) {
  const id = Number(jobId);
  if (!Number.isFinite(id) || id <= 0) return;

  const fields = [];
  const values = [];

  if (updates.status != null) {
    fields.push('status = ?');
    values.push(sanitizeStatus(updates.status));
  }
  if (updates.result !== undefined) {
    fields.push('result_json = ?');
    values.push(safeJsonStringify(updates.result));
  }
  if (updates.error_message !== undefined) {
    fields.push('error_message = ?');
    values.push(updates.error_message == null ? null : String(updates.error_message).slice(0, 2000));
  }
  if (updates.retry_count != null) {
    fields.push('retry_count = ?');
    values.push(Number(updates.retry_count) || 0);
  }
  if (updates.started_at !== undefined) {
    fields.push('started_at = ?');
    values.push(updates.started_at);
  }
  if (updates.completed_at !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completed_at);
  }

  if (fields.length === 0) return;

  if (isMySQL()) {
    await query(
      `UPDATE generation_jobs
       SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [...values, id]
    );
    return;
  }

  const pgFields = fields.map((field, index) => field.replace('?', `$${index + 1}`));
  await query(
    `UPDATE generation_jobs
     SET ${pgFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${values.length + 1}`,
    [...values, id]
  );
}

async function listGenerationJobs({ user_id, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (isMySQL()) {
    const result = user_id
      ? await query(
          `SELECT id, user_id, job_type, status, source_route, payload_json, result_json, error_message,
                  retry_count, max_retries, scheduled_for, started_at, completed_at, created_at, updated_at
           FROM generation_jobs
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          [Number(user_id), safeLimit]
        )
      : await query(
          `SELECT id, user_id, job_type, status, source_route, payload_json, result_json, error_message,
                  retry_count, max_retries, scheduled_for, started_at, completed_at, created_at, updated_at
           FROM generation_jobs
           ORDER BY created_at DESC
           LIMIT ?`,
          [safeLimit]
        );
    return rowsOf(result);
  }

  const result = user_id
    ? await query(
        `SELECT id, user_id, job_type, status, source_route, payload_json, result_json, error_message,
                retry_count, max_retries, scheduled_for, started_at, completed_at, created_at, updated_at
         FROM generation_jobs
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [Number(user_id), safeLimit]
      )
    : await query(
        `SELECT id, user_id, job_type, status, source_route, payload_json, result_json, error_message,
                retry_count, max_retries, scheduled_for, started_at, completed_at, created_at, updated_at
         FROM generation_jobs
         ORDER BY created_at DESC
         LIMIT $1`,
        [safeLimit]
      );
  return rowsOf(result);
}

async function getGenerationJobById(jobId, userId = null) {
  const id = Number(jobId);
  if (!Number.isFinite(id) || id <= 0) return null;

  if (isMySQL()) {
    const result = userId != null
      ? await query(
          `SELECT id, user_id, job_type, status, source_route, payload_json, result_json, error_message,
                  retry_count, max_retries, scheduled_for, started_at, completed_at, created_at, updated_at
           FROM generation_jobs WHERE id = ? AND user_id = ? LIMIT 1`,
          [id, Number(userId)]
        )
      : await query(
          `SELECT id, user_id, job_type, status, source_route, payload_json, result_json, error_message,
                  retry_count, max_retries, scheduled_for, started_at, completed_at, created_at, updated_at
           FROM generation_jobs WHERE id = ? LIMIT 1`,
          [id]
        );
    return rowsOf(result)[0] || null;
  }

  const result = userId != null
    ? await query(
        `SELECT id, user_id, job_type, status, source_route, payload_json, result_json, error_message,
                retry_count, max_retries, scheduled_for, started_at, completed_at, created_at, updated_at
         FROM generation_jobs WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [id, Number(userId)]
      )
    : await query(
        `SELECT id, user_id, job_type, status, source_route, payload_json, result_json, error_message,
                retry_count, max_retries, scheduled_for, started_at, completed_at, created_at, updated_at
         FROM generation_jobs WHERE id = $1 LIMIT 1`,
        [id]
      );
  return rowsOf(result)[0] || null;
}

module.exports = {
  JOB_STATUS,
  createGenerationJob,
  updateGenerationJob,
  listGenerationJobs,
  getGenerationJobById,
};
