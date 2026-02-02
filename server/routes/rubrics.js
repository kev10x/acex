const express = require('express');
const { query } = require('../database/connection');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Create a new rubric
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, criteria, total_points, rubric_type = 'rubric' } = req.body;

    if (!name || !criteria || !total_points) {
      return res.status(400).json({ 
        error: 'Missing required fields: name, criteria, total_points' 
      });
    }

    // Validate criteria structure
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return res.status(400).json({ 
        error: 'Criteria must be a non-empty array' 
      });
    }

    // Validate each criterion
    for (const criterion of criteria) {
      if (!criterion.name || !criterion.max_points || !criterion.description) {
        return res.status(400).json({ 
          error: 'Each criterion must have name, max_points, and description' 
        });
      }
    }

    // Calculate total points from criteria
    const calculatedTotal = criteria.reduce((sum, criterion) => sum + criterion.max_points, 0);
    
    if (calculatedTotal !== total_points) {
      return res.status(400).json({ 
        error: `Total points (${total_points}) does not match sum of criterion points (${calculatedTotal})` 
      });
    }

    const normalizedType = ['rubric', 'answer_key'].includes(rubric_type) ? rubric_type : 'rubric';

    const result = await query(
      'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES (?, ?, ?, ?, ?)',
      [name, JSON.stringify(criteria), total_points, normalizedType, req.user.id]
    );
    
    // Get the last inserted ID
    const insertedId = result.lastID || result.rows?.[0]?.id;
    const rubricWithId = {
      id: insertedId,
      name,
      criteria: JSON.parse(JSON.stringify(criteria)),
      total_points: total_points,
      rubric_type: normalizedType,
      created_at: new Date().toISOString()
    };

    res.status(201).json({
      success: true,
      rubric: rubricWithId,
      message: 'Rubric created successfully'
    });
  } catch (error) {
    console.error('Create rubric error:', error);
    res.status(500).json({ error: 'Failed to create rubric' });
  }
});

// Get all rubrics
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM rubrics WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    
    // Parse criteria JSON for each rubric
    const rubrics = result.rows.map(rubric => ({
      ...rubric,
      rubric_type: rubric.rubric_type || 'rubric',
      criteria: typeof rubric.criteria === 'string' ? JSON.parse(rubric.criteria) : rubric.criteria
    }));
    
    res.json({
      success: true,
      rubrics: rubrics
    });
  } catch (error) {
    console.error('Get rubrics error:', error);
    res.status(500).json({ error: 'Failed to fetch rubrics' });
  }
});

// Get a specific rubric
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rubric not found' });
    }

    const rubric = { ...result.rows[0], rubric_type: result.rows[0].rubric_type || 'rubric' };
    
    // Parse criteria if it's a JSON string
    if (typeof rubric.criteria === 'string') {
      rubric.criteria = JSON.parse(rubric.criteria);
    }

    res.json({
      success: true,
      rubric: rubric
    });
  } catch (error) {
    console.error('Get rubric error:', error);
    res.status(500).json({ error: 'Failed to fetch rubric' });
  }
});

// Update a rubric
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, criteria, total_points, rubric_type = 'rubric' } = req.body;

    if (!name || !criteria || !total_points) {
      return res.status(400).json({ 
        error: 'Missing required fields: name, criteria, total_points' 
      });
    }

    // Validate criteria structure
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return res.status(400).json({ 
        error: 'Criteria must be a non-empty array' 
      });
    }

    // Calculate total points from criteria
    const calculatedTotal = criteria.reduce((sum, criterion) => sum + criterion.max_points, 0);
    
    if (calculatedTotal !== total_points) {
      return res.status(400).json({ 
        error: `Total points (${total_points}) does not match sum of criterion points (${calculatedTotal})` 
      });
    }

    const normalizedType = ['rubric', 'answer_key'].includes(rubric_type) ? rubric_type : 'rubric';

    const result = await query(
      'UPDATE rubrics SET name = ?, criteria = ?, total_points = ?, rubric_type = ?, created_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [name, JSON.stringify(criteria), total_points, normalizedType, id, req.user.id]
    );
    
    // Get the updated record
    if (result.changes > 0) {
      const updatedResult = await query(
        'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
        [id, req.user.id]
      );
      
      if (updatedResult.rows.length > 0) {
        result.rows = updatedResult.rows;
      }
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rubric not found' });
    }

    res.json({
      success: true,
      rubric: result.rows[0],
      message: 'Rubric updated successfully'
    });
  } catch (error) {
    console.error('Update rubric error:', error);
    res.status(500).json({ error: 'Failed to update rubric' });
  }
});

// Delete a rubric
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(
      'DELETE FROM rubrics WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rubric not found' });
    }

    res.json({
      success: true,
      message: 'Rubric deleted successfully'
    });
  } catch (error) {
    console.error('Delete rubric error:', error);
    res.status(500).json({ error: 'Failed to delete rubric' });
  }
});

module.exports = router;

