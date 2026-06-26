/**
 * Local Model Service
 * Loads and uses locally trained models for marking
 */

const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');

class LocalModelService {
  constructor() {
    this.modelsDir = path.join(__dirname, '../../models');
    this.activeModel = null;
    this.modelPath = null;
    this.tokenizer = null;
    this.metadata = null;
  }

  /**
   * List available trained models
   */
  async listModels() {
    try {
      await fs.access(this.modelsDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.modelsDir, { withFileTypes: true });
    const models = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const modelPath = path.join(this.modelsDir, entry.name);
        const metadataPath = path.join(modelPath, 'metadata.json');

        try {
          const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
          models.push({
            name: entry.name,
            path: modelPath,
            ...metadata
          });
        } catch {
          // No metadata file, skip
        }
      }
    }

    return models;
  }

  /**
   * Load a trained model
   */
  async loadModel(modelName) {
    const modelPath = path.join(this.modelsDir, modelName);

    try {
      await fs.access(modelPath);
    } catch {
      throw new Error(`Model not found: ${modelName}`);
    }

    // Check if model files exist
    const configPath = path.join(modelPath, 'config.json');
    const pytorchModelPath = path.join(modelPath, 'pytorch_model.bin');

    try {
      await fs.access(configPath);
    } catch {
      throw new Error(`Model config not found for: ${modelName}`);
    }

    this.modelPath = modelPath;
    this.activeModel = modelName;

    // Load metadata
    try {
      const metadataPath = path.join(modelPath, 'metadata.json');
      this.metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    } catch {
      this.metadata = null;
    }

    console.log(`✅ Loaded local model: ${modelName}`);
    return true;
  }

  /**
   * Predict score using Python inference script
   */
  async predictScore(assignmentText, rubric) {
    if (!this.modelPath) {
      throw new Error('No model loaded. Call loadModel() first.');
    }

    // Format input
    const rubricText = this.formatRubric(rubric);
    const inputText = `Rubric:\n${rubricText}\n\nAssignment:\n${assignmentText.substring(0, 4000)}`;

    // Call Python inference script
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, '../../scripts/infer-local-model.py');
      const pythonProcess = spawn('python3', [
        scriptPath,
        '--model', this.modelPath,
        '--text', inputText
      ]);

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Python script failed: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (error) {
          reject(new Error(`Failed to parse result: ${stdout}`));
        }
      });
    });
  }

  /**
   * Format rubric for model input
   */
  formatRubric(rubric) {
    let text = `${rubric.name || 'Rubric'}\n`;
    text += `Total Points: ${rubric.total_points || 0}\n\n`;
    text += 'Criteria:\n';

    if (Array.isArray(rubric.criteria)) {
      rubric.criteria.forEach((criterion, idx) => {
        text += `${idx + 1}. ${criterion.name || 'Criterion'} `;
        text += `(${criterion.max_points || 0} points)\n`;
        if (criterion.description) {
          text += `   ${criterion.description}\n`;
        }
      });
    }

    return text;
  }

  /**
   * Check if a model is loaded
   */
  isModelLoaded() {
    return this.activeModel !== null && this.modelPath !== null;
  }

  /**
   * Get current model info
   */
  getModelInfo() {
    if (!this.isModelLoaded()) {
      return null;
    }

    return {
      name: this.activeModel,
      path: this.modelPath,
      metadata: this.metadata
    };
  }
}

module.exports = new LocalModelService();





