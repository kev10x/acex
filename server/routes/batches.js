const express = require('express');
const { query } = require('../database/connection');
const { requireAuth } = require('../middleware/auth');
const { generateMarking } = require('./mark');
const { runOpenAIBatchPollingCycle } = require('../services/openaiBatchMarkingService');

const router = express.Router();
const scheduledTimers = new Map();

const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const firstRow = (result) => rowsOf(result)[0];

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

  await query(
    'UPDATE marking_jobs SET total_count = ?, processed_count = 0, success_count = 0, failed_count = 0, last_error = NULL WHERE id = ?',
    [assignments.length, jobId]
  );

  let processed = 0;
  let success = 0;
  let failed = 0;

  for (const assignment of assignments) {
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

      const result = await generateMarking(text, rubric);
      const insertResult = await query(
        `INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          assignment.id,
          job.rubric_id,
          assignment.filename.replace(/\.pdf$/i, ''),
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
      success += 1;
    } catch (err) {
      failed += 1;
      await query(
        'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE id = ? AND user_id = ?',
        ['error', assignment.id, job.user_id]
      );
      await query(
        'UPDATE assessment_submissions SET status = ?, failure_reason = ?, completed_at = NOW() WHERE assignment_id = ?',
        ['failed', err?.message || 'Unknown error', assignment.id]
      );
      await query('UPDATE marking_jobs SET last_error = ? WHERE id = ?', [err?.message || 'Unknown error', jobId]);
    } finally {
      processed += 1;
      await query(
        'UPDATE marking_jobs SET processed_count = ?, success_count = ?, failed_count = ? WHERE id = ?',
        [processed, success, failed, jobId]
      );
    }
  }

  const finalStatus = failed > 0 && success === 0 ? 'failed' : failed > 0 ? 'completed_with_errors' : 'completed';
  await query(
    'UPDATE marking_jobs SET status = ?, completed_at = NOW() WHERE id = ?',
    [finalStatus, jobId]
  );
  if (scheduledTimers.has(jobId)) {
    clearTimeout(scheduledTimers.get(jobId));
    scheduledTimers.delete(jobId);
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
      'SELECT * FROM assignments WHERE batch_id = ? AND user_id = ? ORDER BY uploaded_at DESC',
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
    const { rubric_id, scheduled_for, provider = 'openai', processing_mode } = req.body;

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
      `INSERT INTO marking_jobs (batch_id, rubric_id, user_id, provider, processing_mode, status, scheduled_for, total_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, rubric_id, req.user.id, requestedProvider, finalProcessingMode, 'scheduled', scheduleTime.toISOString().slice(0, 19).replace('T', ' '), assignmentCount]
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

module.exports = router;








