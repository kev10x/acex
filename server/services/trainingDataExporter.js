/**
 * Training Data Exporter
 * Exports marking data for model training
 */

const { query } = require('../database/connection');
const { extractTextFromPDF } = require('./pdfOCR');
const fs = require('fs').promises;
const path = require('path');

class TrainingDataExporter {
  constructor() {
    this.exportDir = path.join(__dirname, '../../training_data');
  }

  /**
   * Ensure export directory exists
   */
  async ensureExportDir() {
    try {
      await fs.mkdir(this.exportDir, { recursive: true });
    } catch (error) {
      console.error('Error creating export directory:', error);
      throw error;
    }
  }

  /**
   * Export all training data from the database
   * @param {Object} options - Export options
   * @param {boolean} options.includeText - Include full assignment text (default: true)
   * @param {boolean} options.onlyCurrentVersions - Only export current versions (default: true)
   * @param {number} options.minScoreCount - Minimum number of scores per assignment (default: 1)
   * @param {string[]} options.strictnessLevels - Filter by strictness levels (default: all)
   * @param {string[]} options.providers - Filter by AI providers (default: all)
   */
  async exportTrainingData(options = {}) {
    const {
      includeText = true,
      onlyCurrentVersions = true,
      minScoreCount = 1,
      strictnessLevels = null,
      providers = null
    } = options;

    await this.ensureExportDir();

    console.log('📊 Starting training data export...');

    // Build query to get marking results with related data
    let sql = `
      SELECT 
        mr.id as result_id,
        mr.assignment_id,
        mr.rubric_id,
        mr.student_name,
        mr.scores,
        mr.feedback,
        mr.total_score,
        mr.strictness_level,
        mr.provider,
        mr.corrections,
        mr.marked_at,
        mr.version,
        mr.is_current,
        a.filename,
        a.file_path,
        a.uploaded_at,
        r.name as rubric_name,
        r.total_points as rubric_total_points,
        r.criteria as rubric_criteria,
        r.rubric_type
      FROM marking_results mr
      INNER JOIN assignments a ON mr.assignment_id = a.id
      INNER JOIN rubrics r ON mr.rubric_id = r.id
      WHERE 1=1
    `;

    const params = [];

    if (onlyCurrentVersions) {
      sql += ' AND mr.is_current = 1';
    }

    if (strictnessLevels && strictnessLevels.length > 0) {
      const placeholders = strictnessLevels.map(() => '?').join(',');
      sql += ` AND mr.strictness_level IN (${placeholders})`;
      params.push(...strictnessLevels);
    }

    if (providers && providers.length > 0) {
      const placeholders = providers.map(() => '?').join(',');
      sql += ` AND mr.provider IN (${placeholders})`;
      params.push(...providers);
    }

    sql += ' ORDER BY mr.marked_at DESC';

    const results = await query(sql, params);
    const rows = Array.isArray(results) ? results : (results.rows || []);

    console.log(`📦 Found ${rows.length} marking results`);

    const trainingData = [];
    let processed = 0;
    let skipped = 0;

    for (const row of rows) {
      try {
        // Parse JSON fields
        const scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores;
        const rubricCriteria = typeof row.rubric_criteria === 'string' 
          ? JSON.parse(row.rubric_criteria) 
          : row.rubric_criteria;
        const corrections = row.corrections 
          ? (typeof row.corrections === 'string' ? JSON.parse(row.corrections) : row.corrections)
          : null;

        // Filter by minimum score count
        if (!scores || !Array.isArray(scores) || scores.length < minScoreCount) {
          skipped++;
          continue;
        }

        // Extract assignment text if requested
        let assignmentText = null;
        if (includeText && row.file_path) {
          try {
            assignmentText = await extractTextFromPDF(row.file_path);
            if (!assignmentText || assignmentText.trim().length === 0) {
              console.warn(`⚠️  No text extracted from ${row.filename}`);
              assignmentText = null;
            }
          } catch (error) {
            console.warn(`⚠️  Error extracting text from ${row.filename}:`, error.message);
            assignmentText = null;
          }
        }

        // Build training example
        const example = {
          id: row.result_id,
          assignment_id: row.assignment_id,
          rubric_id: row.rubric_id,
          student_name: row.student_name || null,
          filename: row.filename,
          uploaded_at: row.uploaded_at,
          marked_at: row.marked_at,
          version: row.version,
          is_current: row.is_current,
          
          // Input features
          assignment_text: assignmentText,
          rubric: {
            name: row.rubric_name,
            total_points: row.rubric_total_points,
            criteria: rubricCriteria,
            rubric_type: row.rubric_type
          },
          strictness_level: row.strictness_level,
          provider: row.provider,
          
          // Output targets (what we want the model to learn)
          scores: scores,
          total_score: row.total_score,
          feedback: row.feedback,
          corrections: corrections
        };

        trainingData.push(example);
        processed++;

        if (processed % 10 === 0) {
          console.log(`  Processed ${processed}/${rows.length}...`);
        }
      } catch (error) {
        console.error(`❌ Error processing result ${row.result_id}:`, error.message);
        skipped++;
      }
    }

    console.log(`✅ Export complete: ${processed} examples, ${skipped} skipped`);

    return {
      total_found: rows.length,
      processed,
      skipped,
      data: trainingData
    };
  }

  /**
   * Export training data to JSON file
   */
  async exportToJSON(options = {}, filename = null) {
    const exportData = await this.exportTrainingData(options);
    
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      filename = `training_data_${timestamp}.json`;
    }

    const filePath = path.join(this.exportDir, filename);
    await fs.writeFile(filePath, JSON.stringify(exportData, null, 2), 'utf8');

    console.log(`💾 Training data saved to: ${filePath}`);
    console.log(`   File size: ${(await fs.stat(filePath)).size / 1024 / 1024} MB`);

    return {
      file_path: filePath,
      ...exportData
    };
  }

  /**
   * Export training data in format suitable for OpenAI fine-tuning
   * Format: array of {messages: [{role: "system", content: ...}, {role: "user", content: ...}, {role: "assistant", content: ...}]}
   */
  async exportForOpenAIFineTuning(options = {}) {
    const exportData = await this.exportTrainingData({
      includeText: true,
      ...options
    });

    const fineTuningData = [];

    for (const example of exportData.data) {
      if (!example.assignment_text) {
        continue; // Skip examples without text
      }

      // Build system message with rubric
      const rubricText = this.formatRubricForPrompt(example.rubric);
      const systemMessage = `You are an expert academic evaluator. Evaluate assignments based on the provided rubric.

${rubricText}

Strictness Level: ${example.strictness_level || 'strict'}

Provide detailed scores for each criterion and comprehensive feedback.`;

      // Build user message with assignment
      const userMessage = `Assignment Text:\n\n${example.assignment_text.substring(0, 8000)}`; // Limit to avoid token limits

      // Build assistant message with scores and feedback
      const scoresText = example.scores.map(score => 
        `- ${score.criterion_name}: ${score.points_awarded}/${score.max_points} points\n  ${score.feedback || 'No feedback'}`
      ).join('\n');

      const assistantMessage = `Scores:\n${scoresText}\n\nTotal Score: ${example.total_score}/${example.rubric.total_points}\n\nFeedback:\n${example.feedback}`;

      fineTuningData.push({
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
          { role: "assistant", content: assistantMessage }
        ]
      });
    }

    return fineTuningData;
  }

  /**
   * Export training data in format suitable for Anthropic fine-tuning
   */
  async exportForAnthropicFineTuning(options = {}) {
    const exportData = await this.exportTrainingData({
      includeText: true,
      ...options
    });

    const fineTuningData = [];

    for (const example of exportData.data) {
      if (!example.assignment_text) {
        continue;
      }

      const rubricText = this.formatRubricForPrompt(example.rubric);
      const prompt = `You are an expert academic evaluator. Evaluate assignments based on the provided rubric.

${rubricText}

Strictness Level: ${example.strictness_level || 'strict'}

Assignment Text:
${example.assignment_text.substring(0, 8000)}`;

      const scoresText = example.scores.map(score => 
        `- ${score.criterion_name}: ${score.points_awarded}/${score.max_points} points\n  ${score.feedback || 'No feedback'}`
      ).join('\n');

      const completion = `Scores:\n${scoresText}\n\nTotal Score: ${example.total_score}/${example.rubric.total_points}\n\nFeedback:\n${example.feedback}`;

      fineTuningData.push({
        prompt,
        completion
      });
    }

    return fineTuningData;
  }

  /**
   * Format rubric for prompt
   */
  formatRubricForPrompt(rubric) {
    let text = `Rubric: ${rubric.name}\nTotal Points: ${rubric.total_points}\n\nCriteria:\n`;

    if (Array.isArray(rubric.criteria)) {
      rubric.criteria.forEach((criterion, idx) => {
        text += `\n${idx + 1}. ${criterion.name} (${criterion.max_points} points)\n`;
        text += `   Description: ${criterion.description || 'N/A'}\n`;
        
        if (criterion.levels && Array.isArray(criterion.levels)) {
          text += `   Performance Levels:\n`;
          criterion.levels.forEach((level, levelIdx) => {
            text += `     - Level ${levelIdx + 1} (${level.points || 0} points): ${level.description || 'N/A'}\n`;
          });
        }
      });
    }

    return text;
  }

  /**
   * Export to JSONL format (one JSON object per line) for fine-tuning
   */
  async exportToJSONL(format = 'openai', options = {}) {
    let fineTuningData;
    
    if (format === 'openai') {
      fineTuningData = await this.exportForOpenAIFineTuning(options);
    } else if (format === 'anthropic') {
      fineTuningData = await this.exportForAnthropicFineTuning(options);
    } else {
      throw new Error(`Unknown format: ${format}. Use 'openai' or 'anthropic'`);
    }

    if (fineTuningData.length === 0) {
      throw new Error('No training data to export');
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `training_data_${format}_${timestamp}.jsonl`;
    const filePath = path.join(this.exportDir, filename);

    // Write JSONL (one JSON object per line)
    const lines = fineTuningData.map(item => JSON.stringify(item)).join('\n');
    await fs.writeFile(filePath, lines, 'utf8');

    console.log(`💾 Fine-tuning data saved to: ${filePath}`);
    console.log(`   Format: ${format}`);
    console.log(`   Examples: ${fineTuningData.length}`);
    console.log(`   File size: ${(await fs.stat(filePath)).size / 1024 / 1024} MB`);

    return {
      file_path: filePath,
      format,
      examples: fineTuningData.length
    };
  }

  /**
   * Get training data statistics
   */
  async getStatistics() {
    const stats = await query(`
      SELECT 
        COUNT(*) as total_results,
        COUNT(DISTINCT assignment_id) as unique_assignments,
        COUNT(DISTINCT rubric_id) as unique_rubrics,
        COUNT(DISTINCT strictness_level) as unique_strictness_levels,
        COUNT(DISTINCT provider) as unique_providers,
        AVG(total_score) as avg_score,
        MIN(total_score) as min_score,
        MAX(total_score) as max_score
      FROM marking_results
      WHERE is_current = 1
    `);

    const row = Array.isArray(stats) ? stats[0] : (stats.rows?.[0] || stats[0]);

    return {
      total_results: row.total_results || 0,
      unique_assignments: row.unique_assignments || 0,
      unique_rubrics: row.unique_rubrics || 0,
      unique_strictness_levels: row.unique_strictness_levels || 0,
      unique_providers: row.unique_providers || 0,
      avg_score: row.avg_score || 0,
      min_score: row.min_score || 0,
      max_score: row.max_score || 0
    };
  }
}

module.exports = new TrainingDataExporter();





