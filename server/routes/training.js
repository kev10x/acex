/**
 * Training Data Management Routes
 */

const router = require('express').Router();
const trainingExporter = require('../services/trainingDataExporter');
const fs = require('fs').promises;
const path = require('path');
const { requireAuth, requireRoles } = require('../middleware/auth');

const TRAINING_ROUTE_GUARD = [requireAuth, requireRoles(['lecturer', 'management'])];

function getUserExportDir(userId) {
  return trainingExporter.getExportDir(userId);
}

async function resolveUserFilePath(userId, filename) {
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename');
  }
  return path.join(getUserExportDir(userId), filename);
}

// Get training data statistics
router.get('/stats', ...TRAINING_ROUTE_GUARD, async (req, res) => {
  try {
    const stats = await trainingExporter.getStatistics(req.user.id);
    res.json({
      success: true,
      statistics: stats
    });
  } catch (error) {
    console.error('Get training stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Export training data to JSON
router.post('/export/json', ...TRAINING_ROUTE_GUARD, async (req, res) => {
  try {
    const {
      includeText = true,
      onlyCurrentVersions = true,
      minScoreCount = 1,
      strictnessLevels = null,
      providers = null,
      filename = null
    } = req.body;

    const result = await trainingExporter.exportToJSON({
      userId: req.user.id,
      includeText,
      onlyCurrentVersions,
      minScoreCount,
      strictnessLevels: strictnessLevels ? (Array.isArray(strictnessLevels) ? strictnessLevels : [strictnessLevels]) : null,
      providers: providers ? (Array.isArray(providers) ? providers : [providers]) : null
    }, filename);

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Export training data error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Export training data for OpenAI fine-tuning (JSONL format)
router.post('/export/openai', ...TRAINING_ROUTE_GUARD, async (req, res) => {
  try {
    const {
      onlyCurrentVersions = true,
      minScoreCount = 1,
      strictnessLevels = null,
      providers = null
    } = req.body;

    const result = await trainingExporter.exportToJSONL('openai', {
      userId: req.user.id,
      onlyCurrentVersions,
      minScoreCount,
      strictnessLevels: strictnessLevels ? (Array.isArray(strictnessLevels) ? strictnessLevels : [strictnessLevels]) : null,
      providers: providers ? (Array.isArray(providers) ? providers : [providers]) : null
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Export OpenAI fine-tuning data error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Export training data for Anthropic fine-tuning (JSONL format)
router.post('/export/anthropic', ...TRAINING_ROUTE_GUARD, async (req, res) => {
  try {
    const {
      onlyCurrentVersions = true,
      minScoreCount = 1,
      strictnessLevels = null,
      providers = null
    } = req.body;

    const result = await trainingExporter.exportToJSONL('anthropic', {
      userId: req.user.id,
      onlyCurrentVersions,
      minScoreCount,
      strictnessLevels: strictnessLevels ? (Array.isArray(strictnessLevels) ? strictnessLevels : [strictnessLevels]) : null,
      providers: providers ? (Array.isArray(providers) ? providers : [providers]) : null
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Export Anthropic fine-tuning data error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// List exported training files
router.get('/files', ...TRAINING_ROUTE_GUARD, async (req, res) => {
  try {
    const exportDir = getUserExportDir(req.user.id);
    
    try {
      await fs.access(exportDir);
    } catch {
      return res.json({
        success: true,
        files: []
      });
    }

    const files = await fs.readdir(exportDir);
    const fileStats = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(exportDir, file);
        const stats = await fs.stat(filePath);
        return {
          filename: file,
          size: stats.size,
          size_mb: (stats.size / 1024 / 1024).toFixed(2),
          created: stats.birthtime,
          modified: stats.mtime,
          format: file.endsWith('.jsonl') ? 'jsonl' : file.endsWith('.json') ? 'json' : 'unknown'
        };
      })
    );

    // Sort by modified date (newest first)
    fileStats.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({
      success: true,
      files: fileStats
    });
  } catch (error) {
    console.error('List training files error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Download a training file
router.get('/download/:filename', ...TRAINING_ROUTE_GUARD, async (req, res) => {
  try {
    const { filename } = req.params;
    let filePath;
    try {
      filePath = await resolveUserFilePath(req.user.id, filename);
    } catch (_error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid filename'
      });
    }

    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    res.download(filePath, filename);
  } catch (error) {
    console.error('Download training file error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete a training file
router.delete('/files/:filename', ...TRAINING_ROUTE_GUARD, async (req, res) => {
  try {
    const { filename } = req.params;
    let filePath;
    try {
      filePath = await resolveUserFilePath(req.user.id, filename);
    } catch (_error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid filename'
      });
    }

    try {
      await fs.unlink(filePath);
      res.json({
        success: true,
        message: 'File deleted successfully'
      });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({
          success: false,
          error: 'File not found'
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Delete training file error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;





