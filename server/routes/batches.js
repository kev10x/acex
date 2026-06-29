const express = require('express');
const { query } = require('../database/connection');
const { requireAuth } = require('../middleware/auth');
const { generateMarking } = require('./mark');
const { runOpenAIBatchPollingCycle } = require('../services/openaiBatchMarkingService');
const { isCodeDocument } = require('../services/documentExtractService');

const router = express.Router();
const scheduledTimers = new Map();

// How many assignments to mark in parallel within a single job.
const BATCH_CONCURRENCY = Math.max(1, Number(process.env.BATCH_CONCURRENCY || 3));

const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const firstRow = (result) => rowsOf(result)[0];
const isManagementUser = (user) => ['management', 'admin'].includes(String(user?.role || '').toLowerCase());
const stripAssignmentExtension = (filename) => String(filename || '').replace(/\.[^.]+$/i, '');

const scheduleJobProcessor = (jobId, when) => {
  if (scheduledTimers.has(jobId)) {
    clearTimeout(scheduledTimers.get(jobId));
    scheduledTimers.delete(jobId);
  }
  const delay = Math.max(0, new Date(when).getTime() - Date.now());
  const timer = setTimeout(() => {
    runMarkingJob(jobId).catch((err) => {
      console.error(`Marking job ${jobId} failed:`, err);
    });
  }, delay);
  scheduledTimers.set(jobId, timer);
};

const runMarkingJob = async (jobId) => {
  const job = firstRow(await query('SELECT * FROM marking_jobs WHERE id = ?', [jobId]));
  if (!job || (job.status !== 'scheduled' && job.status !== 'running')) return;

  await query(
    'UPDATE marking_jobs SET status = ?, started_at = COALESCE(started_at, NOW()), completed_at = NULL WHERE id = ?',
    ['running', jobId]
  );

  const assignments = rowsOf(await query(
    `SELECT a.id, a.filename, a.extracted_text
     FROM assignments a
     WHERE a.batch_id = ? AND a.user_id = ? AND a.status = ?
     ORDER BY a.uploaded_at ASC`,
    [job.batch_id, job.user_id, 'uploaded']
  ));
  const rubric = firstRow(await query(
    'SELECT id, criteria, total_points FROM rubrics WHERE id = ? AND user_id = ?',
    [job.rubric_id, job.user_id]
  ));

  if (!rubric) {
    await query(
      'UPDATE marking_jobs SET status = ?, completed_at = NOW(), last_error = ? WHERE id = ?',
      ['failed', 'Rubric not found for this user', jobId]
    );
    return;
  }

  // Reset counters to reflect what is actually about to be processed.
  await query(
    'UPDATE marking_jobs SET total_count = ?, processed_count = 0, success_count = 0, failed_count = 0, last_error = NULL WHERE id = ?',
    [assignments.length, jobId]
  );

  // Process one assignment; use atomic DB increments to avoid counter races.
  const processOne = async (assignment) => {
    try {
      await query(
        'UPDATE assignments SET status = ?, processing_job_id = ? WHERE id = ? AND user_id = ?',
        ['processing', jobId, assignment.id, job.user_id]
      );
      await query(
        'UPDATE assessment_submissions SET status = ?, failure_reason = NULL, completed_at = NULL WHERE assignment_id = ?',
        ['processing', assignment.id]
      );
      const text = (assignment.extracted_text || '').trim();
      if (!text) throw new Error(`No extracted text for ${assignment.filename}`);

      const documentType = isCodeDocument(assignment.filename) ? 'code' : null;
      const result = await generateMarking(text, rubric, documentType, null, job.provider, job.strictness_level || 'strict', assignment.id, null, job.feedback_type || 'standard', job.feedback_verbosity || 'standard', null);
      const insertResult = await query(
        `INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          assignment.id,
          job.rubric_id,
          stripAssignmentExtension(assignment.filename),
          JSON.stringify(result.scores || []),
          result.feedback || '',
          Number(result.total_score || 0),
          job.user_id
        ]
      );
      const resultId = insertResult.insertId ?? insertResult.lastID ?? insertResult.rows?.[0]?.id ?? null;
      await query(
        'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE id = ? AND user_id = ?',
        ['completed', assignment.id, job.user_id]
      );
      await query(
        'UPDATE assessment_submissions SET status = ?, result_id = ?, failure_reason = NULL, completed_at = NOW() WHERE assignment_id = ?',
        ['completed', resultId, assignment.id]
      );
      await query(
        'UPDATE marking_jobs SET processed_count = processed_count + 1, success_count = success_count + 1 WHERE id = ?',
        [jobId]
      );
    } catch (err) {
      await query(
        'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE id = ? AND user_id = ?',
        ['error', assignment.id, job.user_id]
      );
      await query(
        'UPDATE assessment_submissions SET status = ?, failure_reason = ?, completed_at = NOW() WHERE assignment_id = ?',
        ['failed', err?.message || 'Unknown error', assignment.id]
      );
      await query(
        'UPDATE marking_jobs SET processed_count = processed_count + 1, failed_count = failed_count + 1, last_error = ? WHERE id = ?',
        [err?.message || 'Unknown error', jobId]
      );
    }
  };

  // Run BATCH_CONCURRENCY assignments at a time.
  for (let i = 0; i < assignments.length; i += BATCH_CONCURRENCY) {
    const chunk = assignments.slice(i, i + BATCH_CONCURRENCY);
    await Promise.all(chunk.map(processOne));
  }

  // Read final counts from DB (written atomically above) to determine outcome.
  const finalJob = firstRow(await query(
    'SELECT success_count, failed_count FROM marking_jobs WHERE id = ?',
    [jobId]
  ));
  const s = Number(finalJob?.success_count || 0);
  const f = Number(finalJob?.failed_count || 0);
  const finalStatus = f > 0 && s === 0 ? 'failed' : f > 0 ? 'completed_with_errors' : 'completed';
  await query(
    'UPDATE marking_jobs SET status = ?, completed_at = NOW() WHERE id = ?',
    [finalStatus, jobId]
  );
  if (scheduledTimers.has(jobId)) {
    clearTimeout(scheduledTimers.get(jobId));
    scheduledTimers.delete(jobId);
  }
};

// Re-register timers for standard-mode jobs that were scheduled before a
// server restart. Called once at startup after the DB is ready.
const recoverScheduledJobs = async () => {
  try {
    const pending = rowsOf(await query(
      `SELECT id, scheduled_for FROM marking_jobs
       WHERE status = 'scheduled' AND processing_mode = 'standard'`
    ));
    if (pending.length > 0) {
      console.log(`[batch] Recovering ${pending.length} scheduled standard job(s) after restart`);
      for (const job of pending) {
        scheduleJobProcessor(job.id, job.scheduled_for || new Date());
      }
    }
  } catch (err) {
    console.error('[batch] Failed to recover scheduled jobs:', err.message);
  }
};

// Get all batches
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT b.*, 
             COUNT(a.id) as assignment_count
      FROM batches b
      LEFT JOIN assignments a ON a.batch_id = b.id AND a.user_id = ?
      WHERE b.user_id = ?
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `, [req.user.id, req.user.id]);
    
    const batches = Array.isArray(result) ? result : (result.rows || []);
    
    res.json({
      success: true,
      batches: batches.map(batch => ({
        id: batch.id,
        name: batch.name,
        description: batch.description,
        created_at: batch.created_at,
        assignment_count: batch.assignment_count || 0
      }))
    });
  } catch (error) {
    console.error('Get batches error:', error);
    res.status(500).json({ error: 'Failed to fetch batches' });
  }
});

// Get a single batch with assignments
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get batch details
    const batchResult = await query(
      'SELECT * FROM batches WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    
    const batch = Array.isArray(batchResult) 
      ? batchResult[0] 
      : (batchResult.rows?.[0] || batchResult[0]);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Get assignments in this batch
    const assignmentsResult = await query(
      `SELECT id, filename, file_size, uploaded_at, status, batch_id, processing_job_id
       FROM assignments
       WHERE batch_id = ? AND user_id = ?
       ORDER BY uploaded_at DESC`,
      [id, req.user.id]
    );
    
    const assignments = Array.isArray(assignmentsResult)
      ? assignmentsResult
      : (assignmentsResult.rows || []);
    
    res.json({
      success: true,
      batch: {
        ...batch,
        assignments
      }
    });
  } catch (error) {
    console.error('Get batch error:', error);
    res.status(500).json({ error: 'Failed to fetch batch' });
  }
});

// Create a new batch
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Batch name is required' });
    }
    
    const result = await query(
      'INSERT INTO batches (name, description, user_id) VALUES (?, ?, ?)',
      [name.trim(), description?.trim() || null, req.user.id]
    );
    
    const insertedId = result.lastID || result.insertId || result.rows?.[0]?.id;
    
    res.json({
      success: true,
      batch: {
        id: insertedId,
        name: name.trim(),
        description: description?.trim() || null,
        created_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Create batch error:', error);
    res.status(500).json({ error: 'Failed to create batch' });
  }
});

// Update a batch
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Batch name is required' });
    }
    
    await query(
      'UPDATE batches SET name = ?, description = ? WHERE id = ? AND user_id = ?',
      [name.trim(), description?.trim() || null, id, req.user.id]
    );
    
    res.json({
      success: true,
      message: 'Batch updated successfully'
    });
  } catch (error) {
    console.error('Update batch error:', error);
    res.status(500).json({ error: 'Failed to update batch' });
  }
});

// Delete a batch (assignments will have batch_id set to NULL)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if batch exists
    const batchResult = await query(
      'SELECT * FROM batches WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    
    const batch = Array.isArray(batchResult)
      ? batchResult[0]
      : (batchResult.rows?.[0] || batchResult[0]);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Delete the batch (assignments will have batch_id set to NULL due to ON DELETE SET NULL)
    await query('DELETE FROM batches WHERE id = ? AND user_id = ?', [id, req.user.id]);
    
    res.json({
      success: true,
      message: 'Batch deleted successfully'
    });
  } catch (error) {
    console.error('Delete batch error:', error);
    res.status(500).json({ error: 'Failed to delete batch' });
  }
});

// Assign assignments to a batch
router.post('/:id/assign', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { assignment_ids } = req.body;
    
    if (!Array.isArray(assignment_ids) || assignment_ids.length === 0) {
      return res.status(400).json({ error: 'assignment_ids array is required' });
    }
    
    // Check if batch exists
    const batchResult = await query(
      'SELECT * FROM batches WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    
    const batch = Array.isArray(batchResult)
      ? batchResult[0]
      : (batchResult.rows?.[0] || batchResult[0]);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Update assignments to belong to this batch (only user's assignments)
    const placeholders = assignment_ids.map(() => '?').join(',');
    await query(
      `UPDATE assignments SET batch_id = ? WHERE id IN (${placeholders}) AND user_id = ?`,
      [id, ...assignment_ids, req.user.id]
    );
    
    res.json({
      success: true,
      message: `Assigned ${assignment_ids.length} assignment(s) to batch`
    });
  } catch (error) {
    console.error('Assign to batch error:', error);
    res.status(500).json({ error: 'Failed to assign assignments to batch' });
  }
});

// Remove assignments from a batch
router.post('/:id/unassign', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { assignment_ids } = req.body;
    
    if (!Array.isArray(assignment_ids) || assignment_ids.length === 0) {
      return res.status(400).json({ error: 'assignment_ids array is required' });
    }
    
    // Set batch_id to NULL for these assignments (only user's assignments)
    const placeholders = assignment_ids.map(() => '?').join(',');
    await query(
      `UPDATE assignments SET batch_id = NULL WHERE id IN (${placeholders}) AND batch_id = ? AND user_id = ?`,
      [...assignment_ids, id, req.user.id]
    );
    
    res.json({
      success: true,
      message: `Removed ${assignment_ids.length} assignment(s) from batch`
    });
  } catch (error) {
    console.error('Unassign from batch error:', error);
    res.status(500).json({ error: 'Failed to remove assignments from batch' });
  }
});

// Schedule batch marking job
router.post('/:id/schedule-marking', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { rubric_id, scheduled_for, provider = 'openai', processing_mode, strictness_level = 'strict', feedback_type = 'standard', feedback_verbosity = 'standard' } = req.body;

    if (!rubric_id) return res.status(400).json({ error: 'rubric_id is required' });

    const batch = firstRow(await query('SELECT id FROM batches WHERE id = ? AND user_id = ?', [id, req.user.id]));
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    const rubric = firstRow(await query('SELECT id FROM rubrics WHERE id = ? AND user_id = ?', [rubric_id, req.user.id]));
    if (!rubric) return res.status(404).json({ error: 'Rubric not found' });

    const assignmentCountRow = firstRow(await query(
      'SELECT COUNT(*) AS count FROM assignments WHERE batch_id = ? AND user_id = ?',
      [id, req.user.id]
    ));
    const assignmentCount = Number(assignmentCountRow?.count || 0);
    if (assignmentCount === 0) return res.status(400).json({ error: 'This folder has no scripts to mark' });

    const scheduleTime = scheduled_for ? new Date(scheduled_for) : new Date();
    if (Number.isNaN(scheduleTime.getTime())) {
      return res.status(400).json({ error: 'Invalid scheduled_for datetime' });
    }

    const requestedProvider = String(provider || 'openai').toLowerCase();
    const supportsOpenAIBatch = requestedProvider === 'openai' && !!process.env.OPENAI_API_KEY;
    const finalProcessingMode = processing_mode
      ? String(processing_mode)
      : supportsOpenAIBatch
      ? 'openai_batch'
      : 'standard';

    if (finalProcessingMode === 'openai_batch' && requestedProvider !== 'openai') {
      return res.status(400).json({ error: 'OpenAI batch processing requires provider "openai"' });
    }
    if (finalProcessingMode === 'openai_batch' && !process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: 'OpenAI batch processing is unavailable because OPENAI_API_KEY is not configured' });
    }

    const insert = await query(
      `INSERT INTO marking_jobs (batch_id, rubric_id, user_id, provider, processing_mode, status, scheduled_for, total_count, strictness_level, feedback_type, feedback_verbosity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, rubric_id, req.user.id, requestedProvider, finalProcessingMode, 'scheduled', scheduleTime.toISOString().slice(0, 19).replace('T', ' '), assignmentCount, strictness_level, feedback_type, feedback_verbosity]
    );
    const jobId = insert.lastID || insert.insertId || insert.rows?.[0]?.id;

    if (finalProcessingMode === 'standard') {
      scheduleJobProcessor(jobId, scheduleTime);
    } else {
      runOpenAIBatchPollingCycle().catch((error) => {
        console.error(`OpenAI batch job ${jobId} kick-off failed:`, error);
      });
    }

    res.json({
      success: true,
      job: {
        id: jobId,
        batch_id: Number(id),
        rubric_id: Number(rubric_id),
        status: 'scheduled',
        provider: requestedProvider,
        processing_mode: finalProcessingMode,
        scheduled_for: scheduleTime.toISOString(),
        total_count: assignmentCount
      }
    });
  } catch (error) {
    console.error('Schedule marking error:', error);
    res.status(500).json({ error: 'Failed to schedule marking job' });
  }
});

// Retry a failed or partially-failed job by re-queuing only the failed assignments.
router.post('/jobs/:jobId/retry', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = firstRow(await query(
      'SELECT * FROM marking_jobs WHERE id = ? AND user_id = ?',
      [jobId, req.user.id]
    ));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'failed' && job.status !== 'completed_with_errors') {
      return res.status(400).json({ error: `Only failed or completed_with_errors jobs can be retried (current status: ${job.status})` });
    }

    // Reset assignments that errored back to 'uploaded' so runMarkingJob picks them up.
    await query(
      'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE batch_id = ? AND user_id = ? AND status = ?',
      ['uploaded', job.batch_id, job.user_id, 'error']
    );
    await query(
      `UPDATE assessment_submissions SET status = 'pending', failure_reason = NULL, completed_at = NULL
       WHERE assignment_id IN (
         SELECT id FROM assignments WHERE batch_id = ? AND user_id = ? AND status = 'uploaded'
       )`,
      [job.batch_id, job.user_id]
    );

    // Put job back into scheduled state and increment retry_count.
    await query(
      `UPDATE marking_jobs
       SET status = 'scheduled', started_at = NULL, completed_at = NULL,
           processed_count = 0, success_count = 0, failed_count = 0, last_error = NULL,
           retry_count = COALESCE(retry_count, 0) + 1
       WHERE id = ?`,
      [jobId]
    );

    scheduleJobProcessor(jobId, new Date());
    res.json({ success: true, message: 'Job retry started' });
  } catch (error) {
    console.error('Retry job error:', error);
    res.status(500).json({ error: 'Failed to retry job' });
  }
});

// Immediately trigger a scheduled standard-mode job without waiting for its timer.
router.post('/jobs/:jobId/run-now', requireAuth, async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = firstRow(await query(
      'SELECT * FROM marking_jobs WHERE id = ? AND user_id = ?',
      [jobId, req.user.id]
    ));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'scheduled') {
      return res.status(400).json({ error: `Job is already ${job.status} — only scheduled jobs can be started now` });
    }
    if (job.processing_mode !== 'standard') {
      return res.status(400).json({ error: 'Run-now is only supported for standard-mode jobs' });
    }
    scheduleJobProcessor(jobId, new Date());
    res.json({ success: true, message: 'Job started' });
  } catch (error) {
    console.error('Run-now error:', error);
    res.status(500).json({ error: 'Failed to start job' });
  }
});

// List all jobs for current user
router.get('/jobs/all', requireAuth, async (req, res) => {
  try {
    const jobs = rowsOf(await query(
      `SELECT j.*, b.name AS batch_name, r.name AS rubric_name
       FROM marking_jobs j
       JOIN batches b ON b.id = j.batch_id
       JOIN rubrics r ON r.id = j.rubric_id
       WHERE j.user_id = ?
       ORDER BY j.created_at DESC
       LIMIT 100`,
      [req.user.id]
    ));
    res.json({ success: true, jobs });
  } catch (error) {
    console.error('Get jobs error:', error);
    res.status(500).json({ error: 'Failed to fetch marking jobs' });
  }
});

// Batch job health summary for observability
router.get('/jobs/health', requireAuth, async (req, res) => {
  try {
    const canViewAll = isManagementUser(req.user);
    const ownershipClause = canViewAll ? '' : 'AND j.user_id = ?';
    const ownershipParams = canViewAll ? [] : [req.user.id];
    const stuckMinutes = Math.max(5, Number(process.env.BATCH_STUCK_MINUTES || 20));
    const stuckCutoff = new Date(Date.now() - (stuckMinutes * 60 * 1000));

    const summaryRows = rowsOf(await query(
      `SELECT
         COUNT(*) AS total_jobs,
         SUM(CASE WHEN j.status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled_jobs,
         SUM(CASE WHEN j.status = 'submitted' THEN 1 ELSE 0 END) AS submitted_jobs,
         SUM(CASE WHEN j.status = 'running' THEN 1 ELSE 0 END) AS running_jobs,
         SUM(CASE WHEN j.status = 'finalizing' THEN 1 ELSE 0 END) AS finalizing_jobs,
         SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
         SUM(CASE WHEN j.status = 'completed_with_errors' THEN 1 ELSE 0 END) AS completed_with_errors_jobs,
         SUM(CASE WHEN j.status = 'failed' THEN 1 ELSE 0 END) AS failed_jobs,
         SUM(CASE WHEN j.retry_count > 0 THEN 1 ELSE 0 END) AS retried_jobs
       FROM marking_jobs j
       WHERE 1 = 1 ${ownershipClause}`,
      ownershipParams
    ));

    const stuckJobs = rowsOf(await query(
      `SELECT
         j.id, j.status, j.retry_count, j.max_retries, j.last_error, j.created_at,
         j.started_at, j.completed_at, j.last_status_at, j.next_retry_at,
         j.batch_id, b.name AS batch_name, j.user_id, u.email AS owner_email
       FROM marking_jobs j
       JOIN batches b ON b.id = j.batch_id
       JOIN users u ON u.id = j.user_id
       WHERE j.status IN ('submitted', 'running', 'finalizing')
         AND COALESCE(j.last_status_at, j.started_at, j.created_at) < ?
         ${ownershipClause}
       ORDER BY COALESCE(j.last_status_at, j.started_at, j.created_at) ASC
       LIMIT 25`,
      [stuckCutoff, ...ownershipParams]
    ));

    const retryingJobs = rowsOf(await query(
      `SELECT
         j.id, j.status, j.retry_count, j.max_retries, j.last_error, j.next_retry_at,
         j.batch_id, b.name AS batch_name, j.user_id, u.email AS owner_email
       FROM marking_jobs j
       JOIN batches b ON b.id = j.batch_id
       JOIN users u ON u.id = j.user_id
       WHERE j.status = 'scheduled' AND j.retry_count > 0
         ${ownershipClause}
       ORDER BY j.next_retry_at ASC, j.created_at ASC
       LIMIT 25`,
      ownershipParams
    ));

    const recentFailures = rowsOf(await query(
      `SELECT
         j.id, j.status, j.retry_count, j.max_retries, j.last_error, j.completed_at,
         j.batch_id, b.name AS batch_name, j.user_id, u.email AS owner_email
       FROM marking_jobs j
       JOIN batches b ON b.id = j.batch_id
       JOIN users u ON u.id = j.user_id
       WHERE j.status = 'failed'
         ${ownershipClause}
       ORDER BY j.completed_at DESC, j.created_at DESC
       LIMIT 25`,
      ownershipParams
    ));

    const summary = summaryRows[0] || {};
    const status = stuckJobs.length > 0 || Number(summary.failed_jobs || 0) > 0
      ? 'degraded'
      : 'healthy';

    res.json({
      success: true,
      status,
      scope: canViewAll ? 'all' : 'own',
      stuck_threshold_minutes: stuckMinutes,
      summary: {
        total_jobs: Number(summary.total_jobs || 0),
        scheduled_jobs: Number(summary.scheduled_jobs || 0),
        submitted_jobs: Number(summary.submitted_jobs || 0),
        running_jobs: Number(summary.running_jobs || 0),
        finalizing_jobs: Number(summary.finalizing_jobs || 0),
        completed_jobs: Number(summary.completed_jobs || 0),
        completed_with_errors_jobs: Number(summary.completed_with_errors_jobs || 0),
        failed_jobs: Number(summary.failed_jobs || 0),
        retried_jobs: Number(summary.retried_jobs || 0)
      },
      stuck_jobs: stuckJobs,
      retrying_jobs: retryingJobs,
      recent_failures: recentFailures
    });
  } catch (error) {
    console.error('Get batch jobs health error:', error);
    res.status(500).json({ error: 'Failed to fetch batch jobs health' });
  }
});

router.recoverScheduledJobs = recoverScheduledJobs;
module.exports = router;





