/**
 * Local Model Management Routes
 */

const router = require('express').Router();
const localModelService = require('../services/localModelService');

// List available models
router.get('/models', async (req, res) => {
  try {
    const models = await localModelService.listModels();
    res.json({
      success: true,
      models
    });
  } catch (error) {
    console.error('List models error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get current model info
router.get('/current', async (req, res) => {
  try {
    const info = localModelService.getModelInfo();
    res.json({
      success: true,
      model: info
    });
  } catch (error) {
    console.error('Get current model error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Load a model
router.post('/load', async (req, res) => {
  try {
    const { modelName } = req.body;

    if (!modelName) {
      return res.status(400).json({
        success: false,
        error: 'modelName is required'
      });
    }

    await localModelService.loadModel(modelName);

    res.json({
      success: true,
      message: `Model ${modelName} loaded successfully`,
      model: localModelService.getModelInfo()
    });
  } catch (error) {
    console.error('Load model error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Unload current model
router.post('/unload', async (req, res) => {
  try {
    localModelService.activeModel = null;
    localModelService.modelPath = null;
    localModelService.metadata = null;

    res.json({
      success: true,
      message: 'Model unloaded successfully'
    });
  } catch (error) {
    console.error('Unload model error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;





