/**
 * Training Data Management Routes
 */

const router = require('express').Router();
const trainingExporter = require('../services/trainingDataExporter');
const fs = require('fs').promises;
const path = require('path');

// Get training data statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await trainingExporter.getStatistics();
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
router.post('/export/json', async (req, res) => {
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
router.post('/export/openai', async (req, res) => {
  try {
    const {
      onlyCurrentVersions = true,
      minScoreCount = 1,
      strictnessLevels = null,
      providers = null
    } = req.body;

    const result = await trainingExporter.exportToJSONL('openai', {
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
router.post('/export/anthropic', async (req, res) => {
  try {
    const {
      onlyCurrentVersions = true,
      minScoreCount = 1,
      strictnessLevels = null,
      providers = null
    } = req.body;

    const result = await trainingExporter.exportToJSONL('anthropic', {
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
router.get('/files', async (req, res) => {
  try {
    const exportDir = path.join(__dirname, '../../training_data');
    
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
router.get('/download/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const exportDir = path.join(__dirname, '../../training_data');
    const filePath = path.join(exportDir, filename);

    // Security: prevent directory traversal
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
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
router.delete('/files/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const exportDir = path.join(__dirname, '../../training_data');
    const filePath = path.join(exportDir, filename);

    // Security: prevent directory traversal
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
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





