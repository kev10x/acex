const express = require('express');
const crypto = require('crypto');
const { query } = require('../database/connection');
const aiService = require('../services/aiService');
const aiConfig = require('../config/ai-config');
const { requireAuth, requireFeature } = require('../middleware/auth');

const router = express.Router();

function generateCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

/**
 * Generate a new assessment based on existing assignment data in the database
 * This uses stored assignment text, rubrics, and marking patterns to create new assessments
 */
router.post('/generate', requireAuth, requireFeature('generate_assessments'), async (req, res) => {
  try {
    const {
      rubric_id,
      custom_topics = null, // When set, topics come from this list; rubric_id is optional
      level = null, // e.g. Grade 10, Undergraduate
      difficulty_level = 'moderate',
      question_count = 5,
      assessment_type = 'assignment',
      use_existing_patterns = true,
      topic = null,
      question_types = ['mix']
    } = req.body;

    const useCustomTopics = custom_topics && String(custom_topics).trim().length > 0;
    if (!useCustomTopics && !rubric_id) {
      return res.status(400).json({ error: 'Rubric ID or custom topic list is required' });
    }

    let contextData = { assignments: [], rubrics: [], marking_patterns: [] };
    let selectedRubric = null;
    let rubricCriteria = null;
    let topicsFromRubric = '';

    if (!useCustomTopics) {
      // Get rubric and context when using a selected rubric
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

      selectedRubric = rubricRows[0];
      rubricCriteria = typeof selectedRubric.criteria === 'string'
        ? JSON.parse(selectedRubric.criteria)
        : selectedRubric.criteria;
      topicsFromRubric = (rubricCriteria && Array.isArray(rubricCriteria))
        ? rubricCriteria.map((c) => `${c.name}${c.description ? ': ' + String(c.description).slice(0, 120) : ''}`).join('; ')
        : selectedRubric.name;
    }

    if (useCustomTopics) {
      topicsFromRubric = String(custom_topics).trim();
      const defaultTotal = 100;
      selectedRubric = {
        name: 'Custom topics assessment',
        total_points: defaultTotal,
        rubric_type: 'rubric',
        criteria: []
      };
    }

    // Normalize question_types: array of allowed types or "mix"
    const requestedTypes = Array.isArray(question_types)
      ? question_types.map((t) => String(t).toLowerCase().trim())
      : [String(question_types || 'mix').toLowerCase()];
    const useMix = requestedTypes.includes('mix') || requestedTypes.length === 0;
    const allowedTypes = useMix
      ? ['mcq', 'essay', 'short_answer', 'mix_and_match', 'problem']
      : requestedTypes.filter((t) => ['mcq', 'essay', 'short_answer', 'mix_and_match', 'problem'].includes(t));

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

    let rubricDescription;
    if (useCustomTopics) {
      rubricDescription = `\n\nCUSTOM TOPIC LIST (create questions covering these topics):\n${topicsFromRubric}\n`;
      if (level && String(level).trim()) {
        rubricDescription += `\nTARGET LEVEL: ${String(level).trim()}\n`;
      }
      rubricDescription += `\nTotal points: use a round number (e.g. 100) that fits the number and difficulty of questions. suggested_rubric_criteria must sum to the same.\n`;
    } else {
      rubricDescription = `\n\nRUBRIC TO MATCH:\n`;
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
            criterion.levels.forEach((lev, levelIdx) => {
              rubricDescription += `   Level ${levelIdx + 1}: ${lev.description || lev.name || ''}\n`;
            });
          }
        });
      }
    }

    // Generate assessment using AI - based on the rubric and requested question types
    const questionTypeInstruction = useMix
      ? `Use a MIX of question types: include some multiple_choice (MCQ), short_answer, essay, and optionally mix_and_match or problem. Vary the types across the ${question_count} questions.`
      : `Use ONLY these question types (distribute across the ${question_count} questions): ${allowedTypes.join(', ')}. Include at least one of each requested type where possible.`;

    const assessmentPrompt = `You are an expert educator creating ${assessment_type}s for students.

SOURCE RUBRIC/MEMO (topics and criteria to assess):
${rubricDescription}

TOPICS TO COVER (create questions with variations around these):
${topic ? topic + '; ' : ''}${topicsFromRubric}
${level && String(level).trim() ? `\nTARGET LEVEL: ${String(level).trim()}\n` : ''}

DIFFICULTY LEVEL: ${difficulty_level}
NUMBER OF QUESTIONS: ${question_count}
ASSESSMENT TYPE: ${assessment_type}
QUESTION TYPES: ${questionTypeInstruction}
${contextPrompt}

Your task:
1. Create a comprehensive ${assessment_type} that aligns with the rubric criteria and topics above.
2. Generate exactly ${question_count} questions. Create VARIATIONS so similar topics are tested in different ways (e.g. different wording, different angles).
3. Each question must map to one or more rubric criteria. Total points for all questions MUST equal ${selectedRubric.total_points}.
4. For multiple_choice (MCQ): include "options" (array of strings, e.g. ["A) ...", "B) ..."]) and "correct_answer" (letter, e.g. "A", or 1-based index).
5. For mix_and_match: include "left_column" (array of strings), "right_column" (array of strings), and "correct_pairings" (array of {left_index, right_index} 1-based, or array of strings "left item - right item").
6. For short_answer and essay: question text is enough. For problem: include question and optionally "hints".
7. Include "suggested_rubric_criteria" so this assessment can be marked: array of {name, max_points, description} matching the distribution of points across questions.
${use_existing_patterns && contextData.assignments.length > 0 ? '8. Consider the patterns and styles from the existing examples provided above.' : ''}

Respond with a JSON object in this exact format (no markdown, only JSON):
{
  "title": "Assessment Title (based on: ${selectedRubric.name})",
  "topic": "${topic || 'From memo/rubric'}",
  "difficulty_level": "${difficulty_level}",
  "assessment_type": "${assessment_type}",
  "instructions": "Clear instructions for students. Mention how to answer each question type (e.g. for MCQ choose one option; for mix and match draw lines).",
  "questions": [
    {
      "number": 1,
      "type": "multiple_choice|short_answer|essay|mix_and_match|problem",
      "question": "Full question text",
      "points": 10,
      "options": ["Only for multiple_choice: option A", "option B", "option C", "option D"],
      "correct_answer": "A",
      "left_column": ["Only for mix_and_match: left item 1", "left item 2"],
      "right_column": ["Only for mix_and_match: right item A", "right item B"],
      "correct_pairings": [{"left_index": 1, "right_index": 2}, {"left_index": 2, "right_index": 1}],
      "hints": ["Optional"],
      "related_criteria": ["Criterion name"]
    }
  ],
  "total_points": ${selectedRubric.total_points},
  "estimated_time": "e.g. 45 minutes",
  "rubric_alignment": "Brief explanation of how the assessment aligns with the rubric",
  "suggested_rubric_criteria": [
    {"name": "Question 1", "max_points": 10, "description": "Marking guidance for this question"}
  ]
}

IMPORTANT:
- Total points MUST equal ${selectedRubric.total_points}. suggested_rubric_criteria max_points must sum to the same.
- Use the requested question types. For MCQ always include "options" and "correct_answer". For mix_and_match include "left_column", "right_column", "correct_pairings".
- Create variety: different questions on the same topic should use different phrasings and angles.`;

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

    // Build and store a new rubric for marking this assessment
    let savedRubricId = null;
    let savedRubricName = null;
    const suggested = assessmentData.suggested_rubric_criteria;
    const criteriaForNewRubric = Array.isArray(suggested) && suggested.length > 0
      ? suggested.map((c) => ({
          name: c.name || `Question ${c.max_points}`,
          max_points: Number(c.max_points) || 0,
          description: c.description || 'See question in assessment.'
        })).filter((c) => c.max_points > 0)
      : assessmentData.questions.map((q, i) => ({
          name: `Question ${q.number}`,
          max_points: q.points || 0,
          description: (q.question || '').slice(0, 200) + (q.question && q.question.length > 200 ? '...' : '')
        }));
    const newRubricTotal = criteriaForNewRubric.reduce((s, c) => s + c.max_points, 0);
    if (criteriaForNewRubric.length > 0 && newRubricTotal > 0) {
      const newRubricName = `Rubric: ${assessmentData.title || 'Generated Assessment'}`.slice(0, 255);
      const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
      if (isMySQL) {
        const insertResult = await query(
          'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES (?, ?, ?, ?, ?)',
          [newRubricName, JSON.stringify(criteriaForNewRubric), newRubricTotal, 'rubric', req.user.id]
        );
        savedRubricId = insertResult.insertId ?? insertResult.lastID;
      } else {
        const insertResult = await query(
          'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [newRubricName, JSON.stringify(criteriaForNewRubric), newRubricTotal, 'rubric', req.user.id]
        );
        const row = insertResult.rows?.[0] || insertResult?.[0];
        savedRubricId = row?.id ?? insertResult.insertId ?? insertResult.lastID;
      }
      savedRubricName = newRubricName;
    }

    res.json({
      success: true,
      assessment: assessmentData,
      rubric: {
        id: useCustomTopics ? savedRubricId : rubric_id,
        name: selectedRubric.name,
        total_points: assessmentData.total_points ?? selectedRubric.total_points,
        criteria_count: Array.isArray(assessmentData.suggested_rubric_criteria) ? assessmentData.suggested_rubric_criteria.length : (Array.isArray(rubricCriteria) ? rubricCriteria.length : 0)
      },
      saved_rubric_id: savedRubricId,
      saved_rubric_name: savedRubricName,
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

/**
 * Publish an assessment so students can take it via a shareable link.
 * Requires auth. Returns code and link.
 */
router.post('/publish', requireAuth, requireFeature('generate_assessments'), async (req, res) => {
  try {
    const { assessment, rubric_id } = req.body;
    if (!assessment || !rubric_id) {
      return res.status(400).json({ error: 'assessment and rubric_id are required' });
    }
    if (!assessment.title || !assessment.questions || !Array.isArray(assessment.questions)) {
      return res.status(400).json({ error: 'Invalid assessment: needs title and questions array' });
    }
    let code;
    for (let i = 0; i < 5; i++) {
      code = generateCode();
      const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
      try {
        if (isMySQL) {
          await query(
            'INSERT INTO published_assessments (code, assessment_json, rubric_id, user_id) VALUES (?, ?, ?, ?)',
            [code, JSON.stringify(assessment), rubric_id, req.user.id]
          );
        } else {
          await query(
            'INSERT INTO published_assessments (code, assessment_json, rubric_id, user_id) VALUES ($1, $2, $3, $4)',
            [code, JSON.stringify(assessment), rubric_id, req.user.id]
          );
        }
        break;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY' || e.message?.includes('unique') || e.code === '23505') {
          continue;
        }
        throw e;
      }
    }
    if (!code) {
      return res.status(500).json({ error: 'Could not generate unique code' });
    }
    const base = process.env.CLIENT_URL || '';
    const takePath = base ? `${base.replace(/\/$/, '')}/take-assessment` : '/take-assessment';
    res.json({
      success: true,
      code,
      link: `${takePath}?code=${code}`,
      message: 'Assessment published. Share the link with students.',
    });
  } catch (error) {
    console.error('Publish assessment error:', error);
    res.status(500).json({ error: 'Failed to publish assessment' });
  }
});

/**
 * Get assessment by code (public) for students to take. Returns assessment without answer key.
 */
router.get('/take/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    const result = isMySQL
      ? await query('SELECT assessment_json, rubric_id FROM published_assessments WHERE code = ?', [code])
      : await query('SELECT assessment_json, rubric_id FROM published_assessments WHERE code = $1', [code]);
    const rows = result.rows || result;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) {
      return res.status(404).json({ error: 'Assessment not found or link expired' });
    }
    const assessment = typeof row.assessment_json === 'string' ? JSON.parse(row.assessment_json) : row.assessment_json;
    const stripAnswerKey = (q) => {
      const { correct_answer, correct_pairings, options, ...rest } = q;
      return rest;
    };
    const safeAssessment = {
      ...assessment,
      questions: (assessment.questions || []).map(stripAnswerKey),
    };
    res.json({ success: true, assessment: safeAssessment });
  } catch (error) {
    console.error('Take assessment get error:', error);
    res.status(500).json({ error: 'Failed to load assessment' });
  }
});

/**
 * Submit student answers and run marking. Public. Returns marking result.
 */
router.post('/submit', async (req, res) => {
  try {
    const { code, student_name, answers } = req.body;
    if (!code || !student_name || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'code, student_name, and answers array are required' });
    }
    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    const pubResult = isMySQL
      ? await query('SELECT id, assessment_json, rubric_id, user_id FROM published_assessments WHERE code = ?', [code])
      : await query('SELECT id, assessment_json, rubric_id, user_id FROM published_assessments WHERE code = $1', [code]);
    const pubRows = pubResult.rows || pubResult;
    const pub = Array.isArray(pubRows) ? pubRows[0] : pubRows;
    if (!pub) {
      return res.status(404).json({ error: 'Assessment not found or link expired' });
    }
    const assessment = typeof pub.assessment_json === 'string' ? JSON.parse(pub.assessment_json) : pub.assessment_json;
    const questions = assessment.questions || [];
    const answerMap = new Map(answers.map((a) => [a.question_number, a.value]));
    const scriptLines = questions.map((q) => {
      const num = q.number != null ? q.number : q.question_number;
      const ans = answerMap.get(num) ?? answerMap.get(Number(num)) ?? '';
      return `Question ${num}: ${ans}`;
    });
    const scriptText = scriptLines.join('\n\n');
    const rubricResult = isMySQL
      ? await query('SELECT id, name, criteria, total_points, rubric_type FROM rubrics WHERE id = ?', [pub.rubric_id])
      : await query('SELECT id, name, criteria, total_points, rubric_type FROM rubrics WHERE id = $1', [pub.rubric_id]);
    const rubricRows = rubricResult.rows || rubricResult;
    const rubricRow = Array.isArray(rubricRows) ? rubricRows[0] : rubricRows;
    if (!rubricRow) {
      return res.status(500).json({ error: 'Rubric not found' });
    }
    const rubricData = {
      id: rubricRow.id,
      name: rubricRow.name,
      total_points: rubricRow.total_points,
      rubric_type: rubricRow.rubric_type,
      criteria: typeof rubricRow.criteria === 'string' ? JSON.parse(rubricRow.criteria) : rubricRow.criteria,
    };
    const filename = `Submission - ${student_name} - ${code}.txt`;
    const insertAssign = isMySQL
      ? await query(
          'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text, user_id) VALUES (?, ?, ?, ?, ?, ?)',
          [filename, '', 0, 'uploaded', scriptText, pub.user_id]
        )
      : await query(
          'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [filename, '', 0, 'uploaded', scriptText, pub.user_id]
        );
    const assignmentId = isMySQL ? (insertAssign.insertId ?? insertAssign.lastID) : (insertAssign.rows?.[0]?.id ?? insertAssign?.[0]?.id);
    const { generateMarking } = require('./mark');
    const markingResult = await generateMarking(scriptText, rubricData, 'assignment', null, null, 'strict', assignmentId, null);
    const insertMr = isMySQL
      ? await query(
          'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current, strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            assignmentId,
            pub.rubric_id,
            student_name,
            JSON.stringify(markingResult.scores || []),
            markingResult.feedback || '',
            markingResult.total_score ?? 0,
            1,
            1,
            'strict',
            'openai',
            markingResult.corrections ? JSON.stringify(markingResult.corrections) : null,
            markingResult.language_errors ? JSON.stringify(markingResult.language_errors) : null,
            markingResult.handwriting_recognition_confidence ?? null,
            markingResult.prompt_tokens ?? null,
            markingResult.completion_tokens ?? null,
            markingResult.total_tokens ?? null,
            markingResult.estimated_cost_usd ?? null,
            pub.user_id,
          ]
        )
      : await query(
          'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current, strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)',
          [
            assignmentId,
            pub.rubric_id,
            student_name,
            JSON.stringify(markingResult.scores || []),
            markingResult.feedback || '',
            markingResult.total_score ?? 0,
            1,
            true,
            'strict',
            'openai',
            markingResult.corrections ? JSON.stringify(markingResult.corrections) : null,
            markingResult.language_errors ? JSON.stringify(markingResult.language_errors) : null,
            markingResult.handwriting_recognition_confidence ?? null,
            markingResult.prompt_tokens ?? null,
            markingResult.completion_tokens ?? null,
            markingResult.total_tokens ?? null,
            markingResult.estimated_cost_usd ?? null,
            pub.user_id,
          ]
        );
    res.json({
      success: true,
      result: {
        total_score: markingResult.total_score,
        feedback: markingResult.feedback,
        scores: markingResult.scores,
        corrections: markingResult.corrections,
        language_errors: markingResult.language_errors,
      },
    });
  } catch (error) {
    console.error('Submit assessment error:', error);
    res.status(500).json({
      error: 'Failed to mark submission',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;

