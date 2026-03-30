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

    const userId = req.user?.id;
    if (userId == null || userId === undefined) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await query(
      'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES ($1, $2, $3, $4, $5)',
      [name, JSON.stringify(criteria), total_points, normalizedType, userId]
    );
    
    // Get the last inserted ID (MySQL: insertId/lastID, PostgreSQL: RETURNING or rows[0].id)
    const insertedId = result.insertId ?? result.lastID ?? result.rows?.[0]?.id;
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
    const userId = req.user?.id;
    if (userId == null || userId === undefined) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await query(
      'SELECT * FROM rubrics WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    
    const rows = result.rows || [];
    // Parse criteria JSON for each rubric
    const rubrics = rows.map(rubric => ({
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
    const userId = req.user?.id;
    if (userId == null || userId === undefined) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await query(
      'SELECT * FROM rubrics WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    const rows = result.rows || [];
    if (rows.length === 0) {
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
    const userId = req.user?.id;
    if (userId == null || userId === undefined) {
      return res.status(401).json({ error: 'Authentication required' });
    }
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
      'UPDATE rubrics SET name = ?, criteria = ?, total_points = ?, rubric_type = ? WHERE id = ? AND user_id = ?',
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

    const updatedRows = result.rows || [];
    res.json({
      success: true,
      rubric: updatedRows[0],
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
    const userId = req.user?.id;
    if (userId == null || userId === undefined) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await query(
      'DELETE FROM rubrics WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    const affected = result.changes ?? result.affectedRows ?? (result.rows || []).length;
    if (affected === 0) {
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

