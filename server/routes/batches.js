const express = require('express');
const { query } = require('../database/connection');

const router = express.Router();

// Get all batches
router.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT b.*, 
             COUNT(a.id) as assignment_count
      FROM batches b
      LEFT JOIN assignments a ON a.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    
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
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get batch details
    const batchResult = await query(
      'SELECT * FROM batches WHERE id = ?',
      [id]
    );
    
    const batch = Array.isArray(batchResult) 
      ? batchResult[0] 
      : (batchResult.rows?.[0] || batchResult[0]);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Get assignments in this batch
    const assignmentsResult = await query(
      'SELECT * FROM assignments WHERE batch_id = ? ORDER BY uploaded_at DESC',
      [id]
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
router.post('/', async (req, res) => {
  try {
    const { name, description } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Batch name is required' });
    }
    
    const result = await query(
      'INSERT INTO batches (name, description) VALUES (?, ?)',
      [name.trim(), description?.trim() || null]
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
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Batch name is required' });
    }
    
    await query(
      'UPDATE batches SET name = ?, description = ? WHERE id = ?',
      [name.trim(), description?.trim() || null, id]
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
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if batch exists
    const batchResult = await query(
      'SELECT * FROM batches WHERE id = ?',
      [id]
    );
    
    const batch = Array.isArray(batchResult)
      ? batchResult[0]
      : (batchResult.rows?.[0] || batchResult[0]);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Delete the batch (assignments will have batch_id set to NULL due to ON DELETE SET NULL)
    await query('DELETE FROM batches WHERE id = ?', [id]);
    
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
router.post('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { assignment_ids } = req.body;
    
    if (!Array.isArray(assignment_ids) || assignment_ids.length === 0) {
      return res.status(400).json({ error: 'assignment_ids array is required' });
    }
    
    // Check if batch exists
    const batchResult = await query(
      'SELECT * FROM batches WHERE id = ?',
      [id]
    );
    
    const batch = Array.isArray(batchResult)
      ? batchResult[0]
      : (batchResult.rows?.[0] || batchResult[0]);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    // Update assignments to belong to this batch
    const placeholders = assignment_ids.map(() => '?').join(',');
    await query(
      `UPDATE assignments SET batch_id = ? WHERE id IN (${placeholders})`,
      [id, ...assignment_ids]
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
router.post('/:id/unassign', async (req, res) => {
  try {
    const { id } = req.params;
    const { assignment_ids } = req.body;
    
    if (!Array.isArray(assignment_ids) || assignment_ids.length === 0) {
      return res.status(400).json({ error: 'assignment_ids array is required' });
    }
    
    // Set batch_id to NULL for these assignments
    const placeholders = assignment_ids.map(() => '?').join(',');
    await query(
      `UPDATE assignments SET batch_id = NULL WHERE id IN (${placeholders}) AND batch_id = ?`,
      [...assignment_ids, id]
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

module.exports = router;








