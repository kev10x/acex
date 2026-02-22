const express = require('express');
const path = require('path');
const fs = require('fs');
const { query } = require('../database/connection');
const { requireAuth, requireFeature } = require('../middleware/auth');
const feedbackVideoService = require('../services/feedbackVideoService');

const router = express.Router();

// Get all marking results
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        mr.*,
        a.filename,
        a.file_path,
        a.uploaded_at,
        r.name as rubric_name,
        r.total_points as max_points
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.user_id = ?
      ORDER BY mr.marked_at DESC
    `, [req.user.id]);
    
    // Convert rows to plain objects (MySQL RowDataPacket doesn't always spread correctly) and parse JSON/numeric fields
    const parsedResults = result.rows.map(row => {
      const plain = row && typeof row === 'object' ? JSON.parse(JSON.stringify(row)) : {};
      let scores = plain.scores;
      if (typeof scores === 'string') {
        try {
          scores = JSON.parse(scores);
        } catch (_) {
          scores = [];
        }
      }
      if (!Array.isArray(scores)) scores = [];
      let corrections = plain.corrections;
      if (corrections != null && typeof corrections === 'string') {
        try {
          corrections = JSON.parse(corrections);
        } catch (_) {
          corrections = [];
        }
      }
      if (!Array.isArray(corrections)) corrections = [];
      let language_errors = plain.language_errors;
      if (language_errors != null && typeof language_errors === 'string') {
        try {
          language_errors = JSON.parse(language_errors);
        } catch (_) {
          language_errors = [];
        }
      }
      if (!Array.isArray(language_errors)) language_errors = [];
      return {
        ...plain,
        scores,
        corrections,
        language_errors,
        feedback: plain.feedback != null ? String(plain.feedback) : '',
        estimated_cost_usd: plain.estimated_cost_usd != null ? Number(plain.estimated_cost_usd) : null,
        prompt_tokens: plain.prompt_tokens != null ? Number(plain.prompt_tokens) : null,
        completion_tokens: plain.completion_tokens != null ? Number(plain.completion_tokens) : null,
        total_tokens: plain.total_tokens != null ? Number(plain.total_tokens) : null
      };
    });
    
    res.json({
      success: true,
      results: parsedResults
    });
  } catch (error) {
    console.error('Get results error:', error);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// Group results by rubric and date (YYYY-MM-DD)
router.get('/grouped', async (req, res) => {
  try {
    const byRubric = await query(`
      SELECT r.name as rubric_name, COUNT(*) as count
      FROM marking_results mr
      JOIN rubrics r ON mr.rubric_id = r.id
      GROUP BY r.name
      ORDER BY count DESC
    `);

    const byDate = await query(`
      SELECT DATE(mr.marked_at) as date, COUNT(*) as count
      FROM marking_results mr
      GROUP BY DATE(mr.marked_at)
      ORDER BY DATE(mr.marked_at) DESC
    `);

    res.json({
      success: true,
      grouped: {
        byRubric: byRubric.rows,
        byDate: byDate.rows
      }
    });
  } catch (error) {
    console.error('Get grouped results error:', error);
    res.status(500).json({ error: 'Failed to fetch grouped results' });
  }
});

// Re-run AI marking using existing result id
router.post('/rerun/:result_id', async (req, res) => {
  try {
    const { result_id } = req.params;
    const { document_type } = req.body || {};

    const existing = await query(
      `SELECT mr.*, a.file_path, r.* as rubric_json FROM marking_results mr
       JOIN assignments a ON mr.assignment_id = a.id
       JOIN rubrics r ON mr.rubric_id = r.id
       WHERE mr.id = ?`,
      [result_id]
    );
    if (!existing.rows || existing.rows.length === 0) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const row = existing.rows[0];

    // Extract text
    const fs = require('fs');
    const pdfParse = require('pdf-parse');
    const dataBuffer = fs.readFileSync(row.file_path);
    const data = await pdfParse(dataBuffer);
    if (!data.text || data.text.trim().length === 0) {
      return res.status(400).json({ error: 'No text could be extracted from the PDF' });
    }

    // Use generateMarking from mark.js indirectly to avoid circular require
    const { generateMarking: gen } = require('./mark');
    const rubric = row; // row includes rubric fields; routes/mark expects criteria under rubric.criteria

    const marking = await gen(data.text, rubric, document_type || 'treatise');

    const insert = await query(
      'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score) VALUES (?, ?, ?, ?, ?, ?)',
      [row.assignment_id, row.rubric_id, row.student_name || null, JSON.stringify(marking.scores), marking.overall_feedback, marking.total_score]
    );
    const insertedId = insert.lastID || insert.rows?.[0]?.id;

    res.json({ success: true, new_result_id: insertedId });
  } catch (error) {
    console.error('Rerun marking error:', error);
    res.status(500).json({ error: 'Failed to rerun marking' });
  }
});

// Export selected result IDs as CSV
router.post('/export/selected', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    const placeholders = ids.map(() => '?').join(',');
    const result = await query(`
      SELECT mr.id, mr.student_name, a.filename, r.name as rubric_name, mr.total_score, mr.scores, mr.feedback, mr.marked_at
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.id IN (${placeholders})
      ORDER BY mr.marked_at DESC
    `, ids);

    let csvContent = 'ID,Student Name,Filename,Rubric,Total Score,Marked At\n';
    (result.rows || []).forEach(row => {
      csvContent += `"${row.id}","${row.student_name || ''}","${row.filename}","${row.rubric_name}","${row.total_score}","${row.marked_at}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=selected_results.csv');
    res.send(csvContent);
  } catch (error) {
    console.error('Export selected error:', error);
    res.status(500).json({ error: 'Failed to export selected results' });
  }
});

// --- Feedback video (Sora) - must be before /:id ---
const FEEDBACK_VIDEOS_DIR = path.join(__dirname, '..', 'uploads', 'feedback-videos');
// API base for returned URLs (e.g. /tools/api in production when app is at /tools). Set API_PUBLIC_BASE on the server.
const API_BASE = (process.env.API_PUBLIC_BASE || '').replace(/\/$/, '') || '/api';
function feedbackVideoContentUrl(resultId) {
  return `${API_BASE}/results/feedback-video/${resultId}/content`;
}

async function getMarkingResultForUser(resultId, userId) {
  const result = await query(
    `SELECT mr.id, mr.feedback, mr.total_score, mr.user_id, r.name as rubric_name, r.total_points as max_points
     FROM marking_results mr
     JOIN rubrics r ON mr.rubric_id = r.id
     WHERE mr.id = $1 AND mr.user_id = $2`,
    [resultId, userId]
  );
  const rows = result.rows || result;
  return Array.isArray(rows) ? rows[0] : rows;
}

router.post('/feedback-video/:resultId', requireAuth, requireFeature('feedback_video'), async (req, res) => {
  try {
    const resultId = Number(req.params.resultId);
    const markingResult = await getMarkingResultForUser(resultId, req.user.id);
    if (!markingResult) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const existing = await query(
      'SELECT id, openai_video_id, status, file_path FROM feedback_videos WHERE result_id = $1 AND user_id = $2',
      [resultId, req.user.id]
    );
    const existingRows = existing.rows || existing;
    const row = Array.isArray(existingRows) ? existingRows[0] : existingRows;
    if (row && row.status === 'completed' && row.file_path) {
      return res.json({
        status: 'completed',
        video_url: feedbackVideoContentUrl(resultId),
      });
    }
    if (row && (row.status === 'queued' || row.status === 'in_progress')) {
      return res.json({
        status: row.status,
        video_id: row.openai_video_id,
        message: 'Video generation already in progress',
      });
    }
    const prompt = feedbackVideoService.buildFeedbackVideoPrompt(
      markingResult.feedback,
      markingResult.rubric_name,
      markingResult.total_score,
      markingResult.max_points
    );
    const { id: openaiVideoId, status } = await feedbackVideoService.createVideoJob(prompt, {
      model: process.env.SORA_MODEL || 'sora-2',
      seconds: '4',
      size: '1280x720',
    });
    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    if (isMySQL) {
      await query(
        `INSERT INTO feedback_videos (result_id, user_id, openai_video_id, status)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE openai_video_id = VALUES(openai_video_id), status = VALUES(status), updated_at = CURRENT_TIMESTAMP`,
        [resultId, req.user.id, openaiVideoId, status]
      );
    } else {
      await query(
        `INSERT INTO feedback_videos (result_id, user_id, openai_video_id, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (result_id) DO UPDATE SET openai_video_id = $3, status = $4, updated_at = CURRENT_TIMESTAMP`,
        [resultId, req.user.id, openaiVideoId, status]
      );
    }
    res.json({ status, video_id: openaiVideoId, message: 'Video generation started' });
  } catch (err) {
    console.error('Feedback video create error:', err);
    res.status(500).json({
      error: err.message || 'Failed to start video generation',
    });
  }
});

router.get('/feedback-video/:resultId/status', requireAuth, requireFeature('feedback_video'), async (req, res) => {
  try {
    const resultId = Number(req.params.resultId);
    const markingResult = await getMarkingResultForUser(resultId, req.user.id);
    if (!markingResult) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const result = await query(
      'SELECT openai_video_id, status, file_path FROM feedback_videos WHERE result_id = $1 AND user_id = $2',
      [resultId, req.user.id]
    );
    const rows = result.rows || result;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.openai_video_id) {
      return res.status(404).json({ error: 'No video job found for this result' });
    }
    if (row.status === 'completed' && row.file_path) {
      return res.json({
        status: 'completed',
        video_url: feedbackVideoContentUrl(resultId),
      });
    }
    const { status, progress, error } = await feedbackVideoService.getVideoStatus(row.openai_video_id);
    if (status === 'completed') {
      const filePath = path.join(FEEDBACK_VIDEOS_DIR, `${resultId}.mp4`);
      try {
        const buffer = await feedbackVideoService.getVideoContent(row.openai_video_id);
        if (!fs.existsSync(FEEDBACK_VIDEOS_DIR)) {
          fs.mkdirSync(FEEDBACK_VIDEOS_DIR, { recursive: true });
        }
        fs.writeFileSync(filePath, buffer);
      } catch (downloadErr) {
        console.error('Feedback video download error:', downloadErr);
        await query(
          'UPDATE feedback_videos SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE result_id = $2 AND user_id = $3',
          ['failed', resultId, req.user.id]
        );
        return res.json({ status: 'failed', error: downloadErr.message || 'Failed to download video' });
      }
      const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
      if (isMySQL) {
        await query(
          'UPDATE feedback_videos SET status = ?, file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE result_id = ? AND user_id = ?',
          ['completed', filePath, resultId, req.user.id]
        );
      } else {
        await query(
          'UPDATE feedback_videos SET status = $1, file_path = $2, updated_at = CURRENT_TIMESTAMP WHERE result_id = $3 AND user_id = $4',
          ['completed', filePath, resultId, req.user.id]
        );
      }
      return res.json({
        status: 'completed',
        video_url: feedbackVideoContentUrl(resultId),
      });
    }
    if (status === 'failed') {
      await query(
        'UPDATE feedback_videos SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE result_id = $2 AND user_id = $3',
        ['failed', resultId, req.user.id]
      );
      return res.json({ status: 'failed', error: error || 'Video generation failed' });
    }
    await query(
      'UPDATE feedback_videos SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE result_id = $2 AND user_id = $3',
      [status, resultId, req.user.id]
    );
    res.json({ status, progress: progress || 0 });
  } catch (err) {
    console.error('Feedback video status error:', err);
    res.status(500).json({ error: err.message || 'Failed to get video status' });
  }
});

router.get('/feedback-video/:resultId/content', requireAuth, requireFeature('feedback_video'), async (req, res) => {
  try {
    const resultId = Number(req.params.resultId);
    const markingResult = await getMarkingResultForUser(resultId, req.user.id);
    if (!markingResult) {
      return res.status(404).json({ error: 'Result not found' });
    }
    const result = await query(
      'SELECT file_path FROM feedback_videos WHERE result_id = $1 AND user_id = $2 AND status = $3',
      [resultId, req.user.id, 'completed']
    );
    const rows = result.rows || result;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ error: 'Video not ready' });
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline; filename="feedback-video.mp4"');
    const stream = fs.createReadStream(row.file_path);
    stream.pipe(res);
  } catch (err) {
    console.error('Feedback video content error:', err);
    res.status(500).json({ error: err.message || 'Failed to stream video' });
  }
});

// Get a specific marking result
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(`
      SELECT 
        mr.*,
        a.filename,
        a.uploaded_at,
        r.name as rubric_name,
        r.criteria as rubric_criteria
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.id = ?
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Result not found' });
    }

    res.json({
      success: true,
      result: result.rows[0]
    });
  } catch (error) {
    console.error('Get result error:', error);
    res.status(500).json({ error: 'Failed to fetch result' });
  }
});

// Get results by assignment
router.get('/assignment/:assignment_id', async (req, res) => {
  try {
    const { assignment_id } = req.params;
    
    const result = await query(`
      SELECT 
        mr.*,
        a.filename,
        a.uploaded_at,
        r.name as rubric_name,
        r.criteria as rubric_criteria
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.assignment_id = ?
      ORDER BY mr.marked_at DESC
    `, [assignment_id]);

    res.json({
      success: true,
      results: result.rows
    });
  } catch (error) {
    console.error('Get results by assignment error:', error);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// Get results by rubric
router.get('/rubric/:rubric_id', async (req, res) => {
  try {
    const { rubric_id } = req.params;
    
    const result = await query(`
      SELECT 
        mr.*,
        a.filename,
        a.uploaded_at,
        r.name as rubric_name,
        r.criteria as rubric_criteria
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.rubric_id = ?
      ORDER BY mr.marked_at DESC
    `, [rubric_id]);

    res.json({
      success: true,
      results: result.rows
    });
  } catch (error) {
    console.error('Get results by rubric error:', error);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

// Export results to CSV format
router.get('/export/csv', async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        mr.id,
        mr.student_name,
        a.filename,
        r.name as rubric_name,
        mr.total_score,
        mr.scores,
        mr.feedback,
        mr.marked_at
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      ORDER BY mr.marked_at DESC
    `);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No results found to export' });
    }

    // Generate CSV content
    let csvContent = 'ID,Student Name,Filename,Rubric,Total Score,Marked At\n';
    
    result.rows.forEach(row => {
      const scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
      const scoresText = scores.map(s => `${s.criterion_name}: ${s.points_awarded}/${s.max_points}`).join('; ');
      
      csvContent += `"${row.id}","${row.student_name || ''}","${row.filename}","${row.rubric_name}","${row.total_score}","${row.marked_at}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=marking_results.csv');
    res.send(csvContent);
  } catch (error) {
    console.error('Export CSV error:', error);
    res.status(500).json({ error: 'Failed to export results' });
  }
});

// Get statistics
router.get('/stats/overview', async (req, res) => {
  try {
    // Total results count
    const totalResults = await query('SELECT COUNT(*) as count FROM marking_results');
    
    // Average score
    const avgScore = await query('SELECT AVG(total_score) as average FROM marking_results');
    
    // Results by status
    const statusCounts = await query(`
      SELECT 
        a.status,
        COUNT(*) as count
      FROM assignments a
      LEFT JOIN marking_results mr ON a.id = mr.assignment_id
      GROUP BY a.status
    `);
    
    // Recent results (last 7 days)
    const recentResults = await query(`
      SELECT COUNT(*) as count
      FROM marking_results
      WHERE marked_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);

    res.json({
      success: true,
      stats: {
        totalResults: parseInt(totalResults.rows[0].count),
        averageScore: parseFloat(avgScore.rows[0].average || 0),
        statusCounts: statusCounts.rows,
        recentResults: parseInt(recentResults.rows[0].count)
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Delete a marking result
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(
      'DELETE FROM marking_results WHERE id = ?',
      [id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Result not found' });
    }

    res.json({
      success: true,
      message: 'Result deleted successfully'
    });
  } catch (error) {
    console.error('Delete result error:', error);
    res.status(500).json({ error: 'Failed to delete result' });
  }
});

// Delete all marking results
router.delete('/', async (req, res) => {
  try {
    const result = await query('DELETE FROM marking_results');
    
    res.json({
      success: true,
      message: `All marking results deleted successfully (${result.changes || 0} results removed)`
    });
  } catch (error) {
    console.error('Delete all results error:', error);
    res.status(500).json({ error: 'Failed to delete all results' });
  }
});

// Download all results as JSON
router.get('/download/all', requireAuth, requireFeature('download_results'), async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        mr.*,
        a.filename,
        a.uploaded_at,
        r.name as rubric_name,
        r.criteria as rubric_criteria
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.user_id = $1
      ORDER BY mr.marked_at DESC
    `, [req.user.id]);

    const rows = result.rows || result;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No results found to download' });
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `marking_results_${timestamp}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json({
      success: true,
      exported_at: new Date().toISOString(),
      total_results: rows.length,
      results: rows
    });
  } catch (error) {
    console.error('Download all results error:', error);
    res.status(500).json({ error: 'Failed to download results' });
  }
});

// Get annotated PDF for a marking result
router.get('/annotated-pdf/:resultId', async (req, res) => {
  try {
    const { resultId } = req.params;

    // Get marking result with assignment file path
    const result = await query(`
      SELECT 
        mr.*,
        a.filename,
        a.file_path
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      WHERE mr.id = ?
    `, [resultId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Marking result not found' });
    }

    const markingResult = result.rows[0];
    const originalPath = markingResult.file_path;
    
    // Check if annotated PDF exists
    const annotatedPath = originalPath.replace(/\.pdf$/i, '.annotated.pdf');
    
    if (!fs.existsSync(annotatedPath)) {
      return res.status(404).json({ 
        error: 'Annotated PDF not found',
        message: 'The annotated PDF file does not exist. This may occur if annotation was not selected or failed during marking.'
      });
    }

    // Send the annotated PDF file
    res.setHeader('Content-Type', 'application/pdf');
    const filename = markingResult.filename.replace(/\.pdf$/i, '') + '_annotated.pdf';
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    const fileStream = fs.createReadStream(annotatedPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('Error streaming annotated PDF:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream annotated PDF' });
      }
    });
  } catch (error) {
    console.error('Get annotated PDF error:', error);
    res.status(500).json({ 
      error: 'Failed to get annotated PDF',
      details: error.message
    });
  }
});

// Download all results as detailed CSV
router.get('/download/csv', requireAuth, requireFeature('download_results'), async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        mr.id,
        mr.student_name,
        a.filename,
        r.name as rubric_name,
        mr.total_score,
        mr.scores,
        mr.feedback,
        mr.marked_at,
        r.total_points as max_points
      FROM marking_results mr
      JOIN assignments a ON mr.assignment_id = a.id
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.user_id = $1
      ORDER BY mr.marked_at DESC
    `, [req.user.id]);

    const rows = result.rows || result;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No results found to export' });
    }

    // Generate detailed CSV content
    let csvContent = 'ID,Student Name,Filename,Rubric,Total Score,Max Points,Percentage,Marked At,Feedback\n';
    
    rows.forEach(row => {
      const percentage = row.max_points > 0 ? ((row.total_score / row.max_points) * 100).toFixed(2) : '0.00';
      const feedback = (row.feedback || '').replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, ' ');
      
      csvContent += `"${row.id}","${row.student_name || ''}","${row.filename}","${row.rubric_name}","${row.total_score}","${row.max_points}","${percentage}%","${row.marked_at}","${feedback}"\n`;
    });

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `marking_results_detailed_${timestamp}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  } catch (error) {
    console.error('Download CSV error:', error);
    res.status(500).json({ error: 'Failed to download CSV' });
  }
});

// Analytics endpoints
router.get('/analytics/overview', async (req, res) => {
  try {
    // Get total results count
    const totalResult = await query('SELECT COUNT(*) as count FROM marking_results WHERE is_current = 1');
    const total = totalResult.rows?.[0]?.count || totalResult?.[0]?.count || 0;

    // Get average score
    const avgResult = await query(`
      SELECT AVG(total_score) as avg_score, 
             MIN(total_score) as min_score, 
             MAX(total_score) as max_score
      FROM marking_results 
      WHERE is_current = 1
    `);
    const stats = avgResult.rows?.[0] || avgResult?.[0] || {};

    // Get score distribution
    const distributionResult = await query(`
      SELECT 
        CASE 
          WHEN total_score >= 90 THEN 'A (90-100)'
          WHEN total_score >= 80 THEN 'B (80-89)'
          WHEN total_score >= 70 THEN 'C (70-79)'
          WHEN total_score >= 60 THEN 'D (60-69)'
          ELSE 'F (<60)'
        END as grade_band,
        COUNT(*) as count
      FROM marking_results
      WHERE is_current = 1
      GROUP BY grade_band
      ORDER BY MIN(total_score) DESC
    `);
    const scoreDistribution = distributionResult.rows || distributionResult || [];

    // Get trends over time (last 30 days)
    // Use database-agnostic date calculation
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateStr = thirtyDaysAgo.toISOString().split('T')[0];
    
    const trendsResult = await query(`
      SELECT 
        DATE(marked_at) as date,
        COUNT(*) as count,
        AVG(total_score) as avg_score
      FROM marking_results
      WHERE is_current = 1 AND marked_at >= ?
      GROUP BY DATE(marked_at)
      ORDER BY date DESC
    `, [dateStr]);

    // Get rubric usage stats
    const rubricStatsResult = await query(`
      SELECT 
        r.name as rubric_name,
        COUNT(*) as usage_count,
        AVG(mr.total_score) as avg_score,
        r.total_points as max_points
      FROM marking_results mr
      JOIN rubrics r ON mr.rubric_id = r.id
      WHERE mr.is_current = 1
      GROUP BY r.id, r.name, r.total_points
      ORDER BY usage_count DESC
    `);

    const trends = trendsResult.rows || trendsResult || [];
    const rubricStats = rubricStatsResult.rows || rubricStatsResult || [];

    res.json({
      success: true,
      overview: {
        total_markings: total,
        average_score: parseFloat(stats.avg_score || 0).toFixed(2),
        min_score: parseFloat(stats.min_score || 0).toFixed(2),
        max_score: parseFloat(stats.max_score || 0).toFixed(2),
        score_distribution: scoreDistribution,
        trends: trends,
        rubric_stats: rubricStats
      }
    });
  } catch (error) {
    console.error('Analytics overview error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics overview' });
  }
});

// Get criterion-level analytics
router.get('/analytics/criteria/:rubric_id', async (req, res) => {
  try {
    const { rubric_id } = req.params;

    const result = await query(`
      SELECT 
        mr.scores,
        mr.total_score
      FROM marking_results mr
      WHERE mr.rubric_id = ? AND mr.is_current = 1
    `, [rubric_id]);

    if (!result.rows || result.rows.length === 0) {
      return res.json({
        success: true,
        criteria_analytics: []
      });
    }

    // Parse scores and aggregate by criterion
    const criterionStats = {};
    
    result.rows.forEach(row => {
      const scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
      if (Array.isArray(scores)) {
        scores.forEach(score => {
          if (!criterionStats[score.criterion_name]) {
            criterionStats[score.criterion_name] = {
              criterion_name: score.criterion_name,
              max_points: score.max_points,
              total_marks: 0,
              count: 0,
              avg_score: 0,
              min_score: score.max_points,
              max_score: 0
            };
          }
          
          const points = score.points_awarded || 0;
          criterionStats[score.criterion_name].total_marks += points;
          criterionStats[score.criterion_name].count += 1;
          criterionStats[score.criterion_name].min_score = Math.min(criterionStats[score.criterion_name].min_score, points);
          criterionStats[score.criterion_name].max_score = Math.max(criterionStats[score.criterion_name].max_score, points);
        });
      }
    });

    // Calculate averages
    const criteriaAnalytics = Object.values(criterionStats).map(stat => ({
      ...stat,
      avg_score: (stat.total_marks / stat.count).toFixed(2),
      avg_percentage: ((stat.total_marks / stat.count) / stat.max_points * 100).toFixed(2) + '%'
    }));

    res.json({
      success: true,
      criteria_analytics: criteriaAnalytics
    });
  } catch (error) {
    console.error('Criteria analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch criteria analytics' });
  }
});

// Get common issues/feedback patterns
router.get('/analytics/common-issues', async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        mr.scores,
        mr.feedback
      FROM marking_results mr
      WHERE mr.is_current = 1
      LIMIT 100
    `);

    // Extract common keywords from feedback
    const issueKeywords = ['missing', 'incomplete', 'unclear', 'weak', 'lacks', 'needs improvement', 'incorrect', 'error'];
    const issueCounts = {};

    result.rows.forEach(row => {
      const scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
      const feedback = (row.feedback || '').toLowerCase();
      
      if (Array.isArray(scores)) {
        scores.forEach(score => {
          const criterionFeedback = (score.feedback || '').toLowerCase();
          issueKeywords.forEach(keyword => {
            if (criterionFeedback.includes(keyword) || feedback.includes(keyword)) {
              issueCounts[keyword] = (issueCounts[keyword] || 0) + 1;
            }
          });
        });
      }
    });

    const commonIssues = Object.entries(issueCounts)
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      success: true,
      common_issues: commonIssues
    });
  } catch (error) {
    console.error('Common issues analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch common issues' });
  }
});

module.exports = router;

