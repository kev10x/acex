const express = require('express');
const { query } = require('../database/connection');
const aiService = require('../services/aiService');
const aiConfig = require('../config/ai-config');

const router = express.Router();

/**
 * Generate a new assessment based on existing assignment data in the database
 * This uses stored assignment text, rubrics, and marking patterns to create new assessments
 */
router.post('/generate', async (req, res) => {
  try {
    const {
      rubric_id, // Required: rubric to base assessment on
      difficulty_level = 'moderate', // 'beginner', 'moderate', 'advanced'
      question_count = 5,
      assessment_type = 'assignment', // 'assignment', 'exam', 'quiz', 'essay'
      use_existing_patterns = true, // Use patterns from existing marked assignments
      topic = null // Optional: specific topic/subject area
    } = req.body;

    if (!rubric_id) {
      return res.status(400).json({ error: 'Rubric ID is required' });
    }

    // Get relevant assignment data from database to inform assessment generation
    let contextData = {
      assignments: [],
      rubrics: [],
      marking_patterns: []
    };

    if (use_existing_patterns) {
      // Get sample assignments with extracted text
      const assignmentsQuery = `
        SELECT 
          a.id,
          a.filename,
          a.extracted_text,
          a.uploaded_at,
          mr.total_score,
          mr.feedback,
          r.name as rubric_name,
          r.criteria as rubric_criteria,
          r.total_points as rubric_total_points
        FROM assignments a
        LEFT JOIN marking_results mr ON a.id = mr.assignment_id AND mr.is_current = 1
        LEFT JOIN rubrics r ON mr.rubric_id = r.id
        WHERE a.extracted_text IS NOT NULL 
          AND a.extracted_text != ''
          AND LENGTH(a.extracted_text) > 100
        ORDER BY a.uploaded_at DESC
        LIMIT 10
      `;
      
      const assignmentsResult = await query(assignmentsQuery);
      const rows = Array.isArray(assignmentsResult) ? assignmentsResult : (assignmentsResult.rows || []);
      
      contextData.assignments = rows.map(row => ({
        filename: row.filename,
        text_preview: row.extracted_text ? row.extracted_text.substring(0, 500) : null,
        total_score: row.total_score,
        rubric_name: row.rubric_name,
        rubric_criteria: typeof row.rubric_criteria === 'string' 
          ? JSON.parse(row.rubric_criteria) 
          : row.rubric_criteria
      }));

      // Get sample rubrics
      const rubricsQuery = `
        SELECT name, criteria, total_points, rubric_type
        FROM rubrics
        ORDER BY created_at DESC
        LIMIT 5
      `;
      
      const rubricsResult = await query(rubricsQuery);
      const rubricRows = Array.isArray(rubricsResult) ? rubricsResult : (rubricsResult.rows || []);
      
      contextData.rubrics = rubricRows.map(row => ({
        name: row.name,
        criteria: typeof row.criteria === 'string' ? JSON.parse(row.criteria) : row.criteria,
        total_points: row.total_points,
        rubric_type: row.rubric_type
      }));

      // Get assignments that were marked with this rubric for context
      const assignmentsWithRubricQuery = `
        SELECT 
          a.id,
          a.filename,
          a.extracted_text,
          a.uploaded_at,
          mr.total_score,
          mr.feedback
        FROM assignments a
        INNER JOIN marking_results mr ON a.id = mr.assignment_id AND mr.is_current = 1
        WHERE mr.rubric_id = ?
          AND a.extracted_text IS NOT NULL 
          AND a.extracted_text != ''
          AND LENGTH(a.extracted_text) > 100
        ORDER BY a.uploaded_at DESC
        LIMIT 5
      `;
      
      const assignmentsWithRubricResult = await query(assignmentsWithRubricQuery, [rubric_id]);
      const assignmentRows = Array.isArray(assignmentsWithRubricResult) 
        ? assignmentsWithRubricResult 
        : (assignmentsWithRubricResult.rows || []);
      
      contextData.assignments = assignmentRows.map(row => ({
        filename: row.filename,
        text_preview: row.extracted_text ? row.extracted_text.substring(0, 500) : null,
        total_score: row.total_score
      }));
    }

    // Get the selected rubric details
    const rubricQuery = `
      SELECT name, criteria, total_points, rubric_type
      FROM rubrics
      WHERE id = ?
    `;
    const rubricResult = await query(rubricQuery, [rubric_id]);
    const rubricRows = Array.isArray(rubricResult) ? rubricResult : (rubricResult.rows || []);
    
    if (rubricRows.length === 0) {
      return res.status(404).json({ error: 'Rubric not found' });
    }

    const selectedRubric = rubricRows[0];
    const rubricCriteria = typeof selectedRubric.criteria === 'string' 
      ? JSON.parse(selectedRubric.criteria) 
      : selectedRubric.criteria;

    // Build context prompt from database data
    let contextPrompt = '';
    if (contextData.assignments.length > 0 && use_existing_patterns) {
      contextPrompt += `\n\nEXISTING ASSIGNMENT EXAMPLES (marked with this rubric):\n`;
      contextData.assignments.slice(0, 3).forEach((assignment, idx) => {
        contextPrompt += `\nExample ${idx + 1}: ${assignment.filename}\n`;
        if (assignment.text_preview) {
          contextPrompt += `Content preview: ${assignment.text_preview}...\n`;
        }
        if (assignment.total_score !== null) {
          contextPrompt += `Score: ${assignment.total_score}/${selectedRubric.total_points}\n`;
        }
      });
    }

    // Build rubric criteria description
    let rubricDescription = `\n\nRUBRIC TO MATCH:\n`;
    rubricDescription += `Name: ${selectedRubric.name}\n`;
    rubricDescription += `Total Points: ${selectedRubric.total_points}\n`;
    rubricDescription += `Type: ${selectedRubric.rubric_type || 'rubric'}\n`;
    rubricDescription += `\nCriteria:\n`;
    
    if (rubricCriteria && Array.isArray(rubricCriteria)) {
      rubricCriteria.forEach((criterion, idx) => {
        rubricDescription += `${idx + 1}. ${criterion.name} (${criterion.max_points} points)\n`;
        if (criterion.description) {
          rubricDescription += `   ${criterion.description.substring(0, 200)}${criterion.description.length > 200 ? '...' : ''}\n`;
        }
        if (criterion.levels && Array.isArray(criterion.levels)) {
          criterion.levels.forEach((level, levelIdx) => {
            rubricDescription += `   Level ${levelIdx + 1}: ${level.description || level.name || ''}\n`;
          });
        }
      });
    }

    // Generate assessment using AI - based on the rubric
    const assessmentPrompt = `You are an expert educator creating ${assessment_type}s for students.

RUBRIC TO BASE ASSESSMENT ON:
${rubricDescription}

${topic ? `TOPIC/SUBJECT AREA: ${topic}\n` : ''}
DIFFICULTY LEVEL: ${difficulty_level}
NUMBER OF QUESTIONS: ${question_count}
ASSESSMENT TYPE: ${assessment_type}
${contextPrompt}

Your task:
1. Create a comprehensive ${assessment_type} that aligns with the rubric criteria above
2. Generate ${question_count} questions that directly assess the rubric criteria
3. Ensure each question maps to one or more rubric criteria
4. The total points for all questions should match the rubric's total points (${selectedRubric.total_points})
5. Questions should be clear, well-structured, and allow students to demonstrate mastery of each criterion
6. If this is an assignment or essay, provide detailed instructions
7. If this is an exam or quiz, include appropriate question types (multiple choice, short answer, essay, problem-solving, etc.)
${use_existing_patterns && contextData.assignments.length > 0 ? '8. Consider the patterns and styles from the existing examples provided above' : ''}

Respond with a JSON object in this exact format:
{
  "title": "Assessment Title (based on rubric: ${selectedRubric.name})",
  "topic": "${topic || 'General'}",
  "difficulty_level": "${difficulty_level}",
  "assessment_type": "${assessment_type}",
  "instructions": "Clear instructions for students on how to complete this assessment, emphasizing how it will be marked according to the rubric",
  "questions": [
    {
      "number": 1,
      "type": "essay|multiple_choice|short_answer|problem",
      "question": "Full question text here",
      "points": 10,
      "hints": ["Optional hint 1", "Optional hint 2"],
      "related_criteria": ["Criterion 1 name", "Criterion 2 name"]
    }
  ],
  "total_points": ${selectedRubric.total_points},
  "estimated_time": "Time estimate (e.g., '60 minutes')",
  "rubric_alignment": "Brief explanation of how the assessment aligns with the rubric criteria"
}

IMPORTANT:
- Total points MUST equal ${selectedRubric.total_points} (the rubric's total points)
- Each question should map to one or more rubric criteria
- Questions should allow students to demonstrate mastery of the rubric criteria
- Ensure appropriate difficulty for ${difficulty_level} level
- Questions should build on each other logically
- The assessment should comprehensively cover all rubric criteria`;

    const config = aiConfig.getConfig('assignment', 'openai');
    const completion = await aiService.createCompletionWithRetry({
      provider: config.provider,
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert educator who creates high-quality, well-structured assessments. Always respond with valid JSON format.'
        },
        {
          role: 'user',
          content: assessmentPrompt
        }
      ],
      temperature: 0.7, // Higher temperature for creative assessment generation
      maxTokens: config.maxTokens.assignment
    });

    let assessmentData;
    try {
      const response = completion.content || completion.choices?.[0]?.message?.content || '';
      let cleanResponse = response.trim();
      
      // Remove markdown code blocks if present
      if (cleanResponse.startsWith('```json')) {
        cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanResponse.startsWith('```')) {
        cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      assessmentData = JSON.parse(cleanResponse);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('AI Response:', completion.content || completion.choices?.[0]?.message?.content);
      throw new Error('Failed to parse AI response as JSON');
    }

    // Validate response structure
    if (!assessmentData.title || !assessmentData.questions || !Array.isArray(assessmentData.questions)) {
      throw new Error('Invalid assessment structure: missing title or questions');
    }

    // Validate total points match rubric
    const calculatedTotal = assessmentData.questions.reduce((sum, q) => sum + (q.points || 0), 0);
    if (Math.abs(calculatedTotal - selectedRubric.total_points) > 1) {
      console.warn(`⚠️  Assessment total points (${calculatedTotal}) doesn't match rubric total (${selectedRubric.total_points})`);
    }

    res.json({
      success: true,
      assessment: assessmentData,
      rubric: {
        id: rubric_id,
        name: selectedRubric.name,
        total_points: selectedRubric.total_points,
        criteria_count: Array.isArray(rubricCriteria) ? rubricCriteria.length : 0
      },
      context_used: {
        assignments_count: contextData.assignments.length
      }
    });

  } catch (error) {
    console.error('Assessment generation error:', error);
    res.status(500).json({
      error: 'Failed to generate assessment',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get statistics about available assignment data for assessment generation
 */
router.get('/stats', async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_assignments,
        COUNT(CASE WHEN extracted_text IS NOT NULL AND extracted_text != '' THEN 1 END) as assignments_with_text,
        COUNT(DISTINCT a.id) as marked_assignments,
        COUNT(DISTINCT r.id) as available_rubrics
      FROM assignments a
      LEFT JOIN marking_results mr ON a.id = mr.assignment_id AND mr.is_current = 1
      LEFT JOIN rubrics r ON mr.rubric_id = r.id
    `;
    
    const result = await query(statsQuery);
    const rows = Array.isArray(result) ? result : (result.rows || []);
    const stats = rows[0] || {};

    res.json({
      success: true,
      stats: {
        total_assignments: parseInt(stats.total_assignments || 0),
        assignments_with_text: parseInt(stats.assignments_with_text || 0),
        marked_assignments: parseInt(stats.marked_assignments || 0),
        available_rubrics: parseInt(stats.available_rubrics || 0)
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

module.exports = router;

