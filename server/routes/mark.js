const express = require('express');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { query } = require('../database/connection');
const aiConfig = require('../config/ai-config');
const aiService = require('../services/aiService');
const { annotatePdfWithIssues, buildIssuesFromMarking } = require('../services/pdfAnnotator');
const PDFReportGenerator = require('../services/pdfReportGenerator');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const pdfGenerator = new PDFReportGenerator();

// Debug endpoint to test marking functionality
router.post('/debug', requireAuth, async (req, res) => {
  try {
    console.log('🔍 Debug marking endpoint called');
    const { assignment_id, rubric_id } = req.body;

    if (!assignment_id || !rubric_id) {
      return res.status(400).json({ error: 'assignment_id and rubric_id are required' });
    }

    // Get assignment details (scoped to current user)
    const assignmentResult = await query(
      'SELECT * FROM assignments WHERE id = ? AND user_id = ?',
      [assignment_id, req.user.id]
    );
    
    console.log('Assignment query result:', JSON.stringify(assignmentResult, null, 2));
    
    // Handle different database result formats
    let assignment;
    if (Array.isArray(assignmentResult)) {
      assignment = assignmentResult[0];
    } else if (assignmentResult.rows && Array.isArray(assignmentResult.rows)) {
      assignment = assignmentResult.rows[0];
    } else {
      return res.status(404).json({ error: 'Assignment not found - unexpected result format' });
    }
    
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    
    // Get rubric details (scoped to current user)
    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    );
    
    console.log('Rubric query result:', JSON.stringify(rubricResult, null, 2));
    
    // Handle different database result formats
    let rubric;
    if (Array.isArray(rubricResult)) {
      rubric = rubricResult[0];
    } else if (rubricResult.rows && Array.isArray(rubricResult.rows)) {
      rubric = rubricResult.rows[0];
    } else {
      return res.status(404).json({ error: 'Rubric not found - unexpected result format' });
    }
    
    if (!rubric) {
      return res.status(404).json({ error: 'Rubric not found' });
    }
    
    console.log('Rubric data:', JSON.stringify(rubric, null, 2));
    
    // Criteria should now be properly parsed as an object by MySQL typeCast
    const rubricData = {
      ...rubric,
      criteria: rubric.criteria
    };
    
    console.log('📋 Assignment:', assignment);
    console.log('📋 Rubric:', rubricData);
    
    // Test PDF extraction
    let assignmentText;
    try {
      assignmentText = await extractTextFromPDF(assignment.file_path);
    } catch (error) {
      return res.status(500).json({ 
        error: 'PDF extraction failed', 
        details: error.message 
      });
    }
    
      // Test AI marking (use default provider)
      let markingResult;
      try {
        markingResult = await generateMarking(assignmentText, rubricData, null, null, null);
    } catch (error) {
      return res.status(500).json({ 
        error: 'AI marking failed', 
        details: error.message 
      });
    }
    
    res.json({
      success: true,
      assignment: assignment,
      rubric: rubricData,
      extracted_text_length: assignmentText.length,
      extracted_text_preview: assignmentText.substring(0, 500),
      marking_result: markingResult
    });
    
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({ 
      error: 'Debug failed', 
      details: error.message 
    });
  }
});

// AI Service is initialized in aiService.js

const extractFirstJsonObject = (text) => {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return source.slice(start);
};

const normalizeJsonCandidate = (value) => String(value || '')
  .trim()
  .replace(/^\`\`\`(?:json)?\s*/i, '')
  .replace(/\s*\`\`\`$/i, '')
  .replace(/^\uFEFF/, '')
  .replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2018\u2019]/g, "'");

// Escape literal control characters (bare newlines, tabs, CRs) and unescaped double-quotes
// inside JSON string values. The AI sometimes emits multi-line feedback or inline citations
// like Smith (2019) without escaping the inner quotes, which causes
// "Expected , or } after property value" parse errors mid-string.
const sanitizeJsonControlChars = (str) => {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; }
      else if (ch === '\\') { out += ch; esc = true; }
      else if (ch === '"') {
        // Determine whether this quote ends the string or is an unescaped quote inside it.
        // Peek ahead (skip whitespace) and check the next structural character.
        // A legitimate string terminator is followed by :  ,  }  ]  or end-of-input.
        let j = i + 1;
        while (j < str.length && (str[j] === ' ' || str[j] === '\t')) j++;
        const next = str[j] !== undefined ? str[j] : '';
        if (next === '' || next === ':' || next === ',' || next === '}' || next === ']') {
          // Looks like end of string
          out += ch;
          inStr = false;
        } else {
          // Looks like an unescaped quote inside the string value - escape it
          out += '\\"';
        }
      }
      else if (ch === '\n') { out += '\\n'; }
      else if (ch === '\r') { out += '\\r'; }
      else if (ch === '\t') { out += '\\t'; }
      else { out += ch; }
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
};

const repairJsonCandidate = (value) => {
  const normalized = normalizeJsonCandidate(value);
  const sanitized = sanitizeJsonControlChars(normalized);
  return sanitized
    .replace(/":\s*\\"/g, '": "')
    .replace(/\\"(\s*[,}\]])/g, '"$1')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .replace(/([{,]\s*)'([^']+?)'(\s*:)/g, '$1"$2"$3');
};

const parseAiJsonResponse = (rawResponse) => {
  const extracted = extractFirstJsonObject(rawResponse);
  const baseCandidates = [normalizeJsonCandidate(rawResponse)];
  if (extracted) {
    baseCandidates.push(normalizeJsonCandidate(extracted));
  }

  const seen = new Set();
  let lastError = null;

  for (const candidate of baseCandidates) {
    if (!candidate) continue;
    for (const variant of [candidate, repairJsonCandidate(candidate)]) {
      if (!variant || seen.has(variant)) continue;
      seen.add(variant);
      try {
        return {
          parsed: JSON.parse(variant),
          cleanedText: variant
        };
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error('Failed to parse AI response as JSON');
};

// PDF helpers (extract text or get page images for vision-based marking)
const { extractTextFromPDF: extractWithOCR, getPdfPageImages } = require('../services/pdfOCR');

const extractTextFromPDF = async (filePath) => {
  try {
    return await extractWithOCR(filePath, {
      useVisionAPI: true, // Automatically use Vision API if standard extraction fails
      useOCR: false
    });
  } catch (error) {
    console.error('❌ PDF text extraction error:', error);
    throw error;
  }
};

// Detect if a rubric is actually a memo (answer key/marking memorandum)
const detectMemo = async (rubricText) => {
  try {
    // Check for common memo/answer key indicators
    const memoIndicators = [
      'memo', 'memorandum', 'answer key', 'answer sheet', 'marking memo',
      'model answer', 'sample answer', 'expected answer', 'correct answer',
      'solution', 'marking scheme', 'marking guide', 'examiner\'s guide'
    ];
    
    const textLower = rubricText.toLowerCase();
    const hasMemoKeywords = memoIndicators.some(indicator => textLower.includes(indicator));
    
    // Also check for rubric indicators - if these are strong, it's likely not a memo
    const rubricIndicators = [
      'performance level', 'evaluation criteria', 'assessment rubric',
      'grading scale', 'rubric', 'criteria', 'performance descriptor'
    ];
    const hasRubricKeywords = rubricIndicators.some(indicator => textLower.includes(indicator));
    
    // If strong rubric keywords and no memo keywords, likely not a memo
    if (hasRubricKeywords && !hasMemoKeywords && rubricText.length > 200) {
      return false;
    }
    
    // Use AI to detect if it's a memo (always run for accuracy, but skip if clearly a rubric)
    const detectionPrompt = `Analyze the following document and determine if it is a MEMO (marking memorandum/answer key) or a RUBRIC (marking criteria).

A MEMO typically contains:
- Model answers or expected responses
- Correct answers to questions
- Marking allocations per question/part
- Examiner's notes or solutions
- Point distributions for specific answers
- Specific solutions or worked examples

A RUBRIC typically contains:
- Assessment criteria and descriptions
- Performance level descriptions (e.g., "Excellent", "Good", "Fair", "Poor")
- General marking guidelines
- Evaluation standards
- Qualitative descriptors

DOCUMENT:
${rubricText.substring(0, 2000)}

Respond with ONLY a JSON object:
{
  "is_memo": true or false,
  "confidence": "high" or "medium" or "low",
  "reason": "brief explanation"
}`;

    // Use default provider for memo detection (usually fast, so mini model is fine)
    const config = aiConfig.getConfig('default');
    const aiResult = await aiService.createCompletionWithRetry({
      provider: config.provider,
      model: config.provider === 'openai' ? 'gpt-5-mini' : 'claude-3-haiku-20240307',
      messages: [{ role: "user", content: detectionPrompt }],
      temperature: 0.1,
      maxTokens: 200
    });

    const response = aiResult.content.trim();
    let cleanResponse = response;
    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const result = JSON.parse(cleanResponse);
    console.log('🔍 Memo detection result:', result);
    // Only return true if confidence is medium or high
    return result.is_memo === true && (result.confidence === 'high' || result.confidence === 'medium');
  } catch (error) {
    console.warn('Memo detection failed, assuming not a memo:', error.message);
    return false;
  }
};

// Detect document type (question paper, treatise, assignment, etc.)
const detectDocumentType = async (documentText) => {
  try {
    const detectionPrompt = `Analyze the following document and determine its type.

Types:
- "question_paper": An exam/test paper with questions (may include answers)
- "treatise": A substantial academic research document (Masters/PhD level)
- "assignment": A course assignment or homework
- "thesis": A doctoral thesis
- "report": A research report
- "proposal": A research proposal

DOCUMENT PREVIEW:
${documentText.substring(0, 1500)}

Respond with ONLY a JSON object:
{
  "document_type": "question_paper" or "treatise" or "assignment" or "thesis" or "report" or "proposal",
  "confidence": "high" or "medium" or "low"
}`;

    // Use default provider for document type detection
    const config = aiConfig.getConfig('default');
    const aiResult = await aiService.createCompletionWithRetry({
      provider: config.provider,
      model: config.provider === 'openai' ? 'gpt-5-mini' : 'claude-3-haiku-20240307',
      messages: [{ role: "user", content: detectionPrompt }],
      temperature: 0.1,
      maxTokens: 150
    });

    const response = aiResult.content.trim();
    let cleanResponse = response;
    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const result = JSON.parse(cleanResponse);
    console.log('🔍 Document type detection result:', result);
    return result.document_type || 'treatise';
  } catch (error) {
    console.warn('Document type detection failed, defaulting to treatise:', error.message);
    return 'treatise';
  }
};

const parseMarkingResponsePayload = (response, { selectedProvider = 'openai', usage = null, imageBased = false } = {}) => {
  const trimmedResponse = String(response || '').trim();
  if (!trimmedResponse) {
    throw new Error('The AI returned an empty response. This can happen with content filters, rate limits, or token limits. Please try again or use a shorter submission.');
  }

  let cleanResponse = parseAiJsonResponse(trimmedResponse).cleanedText;
  cleanResponse = cleanResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleanResponse = jsonMatch[0];
  }

  cleanResponse = cleanResponse.trim();
  cleanResponse = cleanResponse.replace(/":\s*\\"/g, '": "');
  cleanResponse = cleanResponse.replace(/\\"(\s*[,}\]])/g, '"$1');

  let markingResult;
  try {
    markingResult = JSON.parse(cleanResponse);
  } catch (firstParseError) {
    const repaired = cleanResponse.replace(/([^\\])\\"([^"\\]|$)/g, (_, before, after) => before + '"' + after);
    markingResult = JSON.parse(repaired);
  }

  if (!markingResult.scores || !Array.isArray(markingResult.scores)) {
    throw new Error('Invalid response structure: missing scores array');
  }
  if (!markingResult.overall_feedback || typeof markingResult.overall_feedback !== 'string') {
    throw new Error('Invalid response structure: missing overall_feedback');
  }
  if (typeof markingResult.total_score !== 'number') {
    throw new Error('Invalid response structure: missing or invalid total_score');
  }

  const confidenceThreshold = 70;

  markingResult.scores = markingResult.scores.map((score) => ({
    ...score,
    confidence: typeof score.confidence === 'number' ? Math.max(0, Math.min(100, score.confidence)) : 80
  }));

  if (typeof markingResult.overall_confidence !== 'number') {
    const avgConfidence = markingResult.scores.length > 0
      ? markingResult.scores.reduce((sum, score) => sum + (score.confidence || 80), 0) / markingResult.scores.length
      : 80;
    markingResult.overall_confidence = Math.round(avgConfidence);
  } else {
    markingResult.overall_confidence = Math.max(0, Math.min(100, markingResult.overall_confidence));
  }

  if (!markingResult.corrections || !Array.isArray(markingResult.corrections)) {
    markingResult.corrections = [];
  } else {
    markingResult.corrections = markingResult.corrections.filter((correction) => (
      correction &&
      typeof correction.type === 'string' &&
      (correction.type === 'correction' || correction.type === 'suggestion') &&
      typeof correction.location === 'string' &&
      typeof correction.issue === 'string' &&
      typeof correction.correction === 'string'
    ));
  }

  if (!markingResult.language_errors || !Array.isArray(markingResult.language_errors)) {
    markingResult.language_errors = [];
  }

  markingResult.needs_review = markingResult.overall_confidence < confidenceThreshold;
  markingResult.confidence_level = markingResult.overall_confidence >= 80
    ? 'high'
    : markingResult.overall_confidence >= 60
    ? 'medium'
    : 'low';

  if (imageBased) {
    const handwritingConfidence = markingResult.handwriting_recognition_confidence;
    markingResult.handwriting_recognition_confidence = typeof handwritingConfidence === 'number' && !Number.isNaN(handwritingConfidence)
      ? Math.max(0, Math.min(100, Math.round(handwritingConfidence)))
      : null;
  } else {
    markingResult.handwriting_recognition_confidence = null;
  }

  const minConfidence = Math.min(...markingResult.scores.map((score) => score.confidence || 80));
  markingResult.min_criterion_confidence = minConfidence;
  markingResult.has_low_criterion_confidence = minConfidence < confidenceThreshold;

  markingResult.scores = markingResult.scores.map((score) => {
    const maxPoints = score.max_points || 0;
    let normalizedPoints = score.points_awarded || 0;

    if (maxPoints > 0 && Number.isInteger(maxPoints)) {
      normalizedPoints = Math.round(normalizedPoints * 2) / 2;
    } else {
      normalizedPoints = Math.round(normalizedPoints * 10) / 10;
    }

    normalizedPoints = Math.min(Math.max(normalizedPoints, 0), maxPoints);

    return {
      ...score,
      points_awarded: normalizedPoints,
      feedback: score.feedback
        ? score.feedback.replace(/\s+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim()
        : score.feedback
    };
  });

  markingResult.total_score = Math.round(
    markingResult.scores.reduce((sum, score) => sum + (score.points_awarded || 0), 0) * 10
  ) / 10;

  if (markingResult.overall_feedback) {
    markingResult.overall_feedback = markingResult.overall_feedback
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }

  if (usage) {
    markingResult.usage = usage;
    markingResult.estimated_cost_usd = aiConfig.estimateCost(usage.prompt_tokens, usage.completion_tokens, selectedProvider);
  }

  return markingResult;
};

// Generate AI marking using OpenAI or Anthropic
// When assignmentImages (array of base64 strings) is provided, the PDF is marked from images instead of extracted text (vision-based).
const generateMarking = async (assignmentText, rubric, documentType = null, level = null, provider = null, strictnessLevel = 'strict', assignmentId = null, assignmentImages = null) => {
  const imageBased = Array.isArray(assignmentImages) && assignmentImages.length > 0;
  try {
    // Auto-detect document type if not provided (only when we have text; for image-based use provided or default)
    if (!documentType) {
      if (imageBased) {
        documentType = documentType || 'assignment';
        console.log('📝 Using document type (image-based):', documentType);
      } else {
        console.log('🔍 Auto-detecting document type...');
        documentType = await detectDocumentType(assignmentText);
        console.log('📝 Detected document type:', documentType);
      }
    }
    
    // Check if rubric is actually a memo (answer key)
    // Extract text from rubric for memo detection - get descriptive text from criteria
    let rubricText = (rubric.name || '') + ' ';
    if (rubric.criteria && Array.isArray(rubric.criteria)) {
      rubricText += rubric.criteria.map(c => {
        return (c.name || '') + ' ' + (c.description || '') + ' ' + 
               (c.levels ? c.levels.map(l => l.description || '').join(' ') : '');
      }).join(' ');
    } else {
      rubricText += JSON.stringify(rubric.criteria || []);
    }
    let isMemo = false;
    if (rubric?.rubric_type === 'answer_key') {
      isMemo = true;
    } else {
      isMemo = await detectMemo(rubricText);
    }
    
    if (isMemo) {
      console.log('📋 Rubric detected as MEMO (answer key/marking memorandum)');
      // Use memo config for memo-based marking
      documentType = 'memo';
    }
    
    // Get configuration based on document type and provider
    const config = aiConfig.getConfig(documentType, provider);
    const selectedProvider = config.provider;
    
    // Fetch previous marking examples only for re-marking the same assignment
    let previousMarkingExamples = null;
    
    if (assignmentId) {
      try {
        // Fetch previous marking results for this assignment (only for re-marking the same assignment)
        const previousResults = await query(
          'SELECT scores, total_score FROM marking_results WHERE assignment_id = ? AND is_current = 1 ORDER BY marked_at DESC LIMIT 1',
          [assignmentId]
        );
        
        // Handle different database result formats
        let previousResult;
        if (Array.isArray(previousResults)) {
          previousResult = previousResults[0];
        } else if (previousResults.rows && Array.isArray(previousResults.rows)) {
          previousResult = previousResults.rows[0];
        }
        
        if (previousResult) {
          // Parse scores (could be JSON string or already parsed)
          let scores = previousResult.scores;
          if (typeof scores === 'string') {
            scores = JSON.parse(scores);
          }
          
          // Validate that scores is a non-null array before including
          if (scores && Array.isArray(scores) && scores.length > 0) {
            previousMarkingExamples = {
              total_score: previousResult.total_score,
              scores: scores
            };
            console.log('📚 Found previous marking for this assignment:', previousMarkingExamples);
          } else {
            console.warn('Previous marking result has invalid or null scores, skipping');
          }
        }
      } catch (error) {
        console.warn('Could not fetch previous marking examples:', error.message);
      }
    }
    
    console.log('🤖 Starting AI marking process...');
    console.log('Provider:', selectedProvider);
    console.log('Document type:', documentType);
    console.log('Is memo:', isMemo);
    console.log('Image-based (mark from PDF images):', imageBased);
    if (!imageBased) {
      console.log('Assignment text length:', assignmentText?.length || 0);
      console.log('Text will be truncated to:', Math.min(assignmentText?.length || 0, config.maxTextLength), 'characters');
    } else {
      console.log('Assignment page images:', assignmentImages.length);
    }
    // Use vision-capable model when marking from images (GPT-5.2 supports image input)
    const modelToUse = imageBased
      ? (selectedProvider === 'openai' ? 'gpt-5.2' : 'claude-3-haiku-20240307')
      : config.model;
    console.log('Using model:', modelToUse);
    console.log('Max tokens:', config.maxTokens);
    console.log('Rubric:', JSON.stringify(rubric, null, 2));

    // Normalize criteria so it's always an array
    let criteria = rubric.criteria;
    if (typeof criteria === 'string') {
      try {
        criteria = JSON.parse(criteria);
      } catch (e) {
        console.error('Failed to parse rubric.criteria JSON string:', e);
      }
    }
    if (!Array.isArray(criteria)) {
      console.error('Rubric criteria is not an array:', criteria);
      return res.status(500).json({
        error: 'Rubric has an invalid criteria format. Please recreate or edit this rubric.'
      });
    }

    const totalPoints = rubric.total_points;
    console.log('Criteria count:', criteria?.length || 0);

    // Convert complex rubric format to simple format for AI
    const simpleCriteria = criteria.map(criterion => {
      // Handle maxPoints, max_points (snake_case), and levels with points
      let maxPoints;
      if (criterion.maxPoints != null && criterion.maxPoints !== '') {
        maxPoints = Number(criterion.maxPoints);
      } else if (criterion.max_points != null && criterion.max_points !== '') {
        maxPoints = Number(criterion.max_points);
      } else if (criterion.levels && criterion.levels.length > 0) {
        maxPoints = Math.max(...criterion.levels.map(level => level.points));
      } else {
        maxPoints = 0;
      }
      
      console.log(`Criterion: ${criterion.name}, maxPoints: ${maxPoints}`);
      
      return {
        name: criterion.name,
        max_points: maxPoints,
        description: criterion.description
      };
    });
    
    console.log('Simple criteria:', JSON.stringify(simpleCriteria, null, 2));
    
    // Use model context window size to determine how much text we can include.
    // Rough token estimate: 1 token ≈ 4 chars
    const estimateTokens = (text) => Math.ceil((text?.length || 0) / 4);
    // GPT-5.2 has a 128K-token context window; Claude Haiku/Sonnet has 200K.
    const contextWindowTokens = selectedProvider === 'anthropic' ? 200000 : 128000;
    // Reserve room for completion tokens and system overhead (~1000 tokens)
    const requestMaxTokens = Math.min(config.maxTokens, 16000);
    const promptBudgetTokens = Math.max(1000, contextWindowTokens - requestMaxTokens - 1000);
    const maxPromptCharsByContextWindow = promptBudgetTokens * 4;

    const maxAllowedChars = Math.min(config.maxTextLength, maxPromptCharsByContextWindow);
    const truncatedText = imageBased
      ? `The submission is provided as ${assignmentImages.length} page image(s) below (in order). Assess the work from these images—including any handwritten or typed content—and apply the rubric. Handwriting may be messy or partially legible; assess the content and ideas, and be fair about legibility. Return only the JSON.`
      : (assignmentText.length > maxAllowedChars
          ? assignmentText.substring(0, maxAllowedChars) + '...[truncated for processing]'
          : assignmentText);

    // Create detailed rubric/memo description with levels
    const detailedRubric = criteria.map((criterion, i) => {
      const pts = criterion.maxPoints ?? criterion.max_points ?? 0;
      let rubricText = `${i+1}. ${criterion.name} (${pts} points)\n   ${criterion.description || ''}\n`;
      
      if (criterion.levels && criterion.levels.length > 0) {
        rubricText += "   Performance Levels:\n";
        criterion.levels.forEach(level => {
          rubricText += `   - ${level.level} (${level.points} points): ${level.description}\n`;
        });
      }
      
      return rubricText;
    }).join('\n');

    // Generate category-specific intro and guidelines based on assessment type and level
    const getIntro = (assessmentType, level) => {
      const levelTerminology = {
        primary_school: {
          student: 'student',
          work: 'work',
          feedback: 'clear and encouraging',
          tone: 'supportive and age-appropriate'
        },
        high_school: {
          student: 'student',
          work: 'assignment',
          feedback: 'constructive and specific',
          tone: 'supportive yet challenging'
        },
        undergraduate: {
          student: 'student',
          work: 'assignment',
          feedback: 'analytical and comprehensive',
          tone: 'academic and rigorous'
        },
        postgraduate: {
          student: 'student',
          work: 'work',
          feedback: 'scholarly and in-depth',
          tone: 'rigorous and critical'
        }
      };
      
      const terms = levelTerminology[level] || levelTerminology.high_school;
      
      const introMap = {
        treatise: level === 'postgraduate' 
          ? `You are an expert examiner evaluating a Masters Degree Treatise. This is a substantial academic document requiring thorough analysis. Apply STRICT and rigorous postgraduate standards. Be critical and demanding - award marks only when work fully meets the high standards expected. Be very direct about the issues you identify: state problems, gaps, and weaknesses clearly and explicitly—do not soften or hedge. Use scholarly terminology appropriate for advanced academic work.`
          : `You are an expert educator evaluating a Treatise. Apply STRICT academic standards for ${level || 'high school'} level work. Be critical and precise in your evaluation. Be very direct about the issues you identify: state problems and weaknesses clearly—do not soften or hedge.`,
        thesis: level === 'postgraduate'
          ? `You are an expert examiner evaluating a Thesis. Apply STRICT and rigorous postgraduate standards. Be demanding and critical - this represents the culmination of significant research and must meet the highest standards. Be very direct about the issues you identify: state problems, gaps, and weaknesses clearly and explicitly—do not soften or hedge. Use advanced academic terminology.`
          : `You are an expert examiner evaluating a Thesis at ${level || 'undergraduate'} level. Apply STRICT academic standards. Be critical and precise in your assessment. Be very direct about the issues you identify: state problems and weaknesses clearly—do not soften or hedge.`,
        assignment: level === 'primary_school'
          ? `You are a primary school teacher evaluating a student's assignment. Apply STRICT but age-appropriate standards. Provide ${terms.feedback} feedback that is ${terms.tone}. Use simple, clear language that encourages learning while maintaining high expectations.`
          : level === 'high_school'
          ? `You are a high school teacher evaluating a student's assignment. Apply STRICT academic standards. Be critical and precise - award marks only when criteria are fully met. Provide ${terms.feedback} feedback that is ${terms.tone} and helps students understand how to improve their work.`
          : level === 'undergraduate'
          ? `You are a university lecturer evaluating an undergraduate assignment. Apply STRICT academic standards. Be critical and demanding - do not be lenient. Provide ${terms.feedback} feedback that demonstrates ${terms.tone} academic evaluation appropriate for university-level work.`
          : `You are a lecturer evaluating a postgraduate assignment. Apply STRICT and rigorous standards. Be highly critical and demanding. Provide ${terms.feedback} feedback that is ${terms.tone} and appropriate for advanced academic work.`,
        test: level === 'primary_school'
          ? `You are a primary school teacher marking a test. Apply STRICT but age-appropriate standards. Focus on correctness and provide ${terms.feedback}, age-appropriate feedback. Use encouraging language while maintaining high expectations and helping students understand mistakes.`
          : level === 'high_school'
          ? `You are a high school teacher marking a test. Apply STRICT marking standards. Be precise and critical - award marks only for correct, complete, and clear answers. Focus on correctness, completeness, and clarity. Provide ${terms.feedback} feedback that helps students understand their performance.`
          : level === 'undergraduate'
          ? `You are a university lecturer marking an undergraduate test. Apply STRICT academic standards. Be critical and precise - do not award marks for incomplete or incorrect answers. Focus on accuracy, completeness, and demonstration of understanding. Provide ${terms.feedback} feedback appropriate for university-level assessment.`
          : `You are an examiner marking a postgraduate test. Apply STRICT and rigorous standards. Be highly critical and demanding. Focus on accuracy, depth of understanding, and critical analysis. Provide ${terms.feedback} feedback appropriate for advanced academic assessment.`,
        report: level === 'primary_school'
          ? `You are a primary school teacher evaluating a student's report. Provide ${terms.feedback} feedback that encourages learning and uses age-appropriate language.`
          : level === 'high_school'
          ? `You are a high school teacher evaluating a research report. Emphasize methodology, analysis depth, and organization. Provide ${terms.feedback} feedback appropriate for high school level.`
          : level === 'undergraduate'
          ? `You are a university lecturer evaluating an undergraduate research report. Emphasize methodology, analysis depth, synthesis, and academic rigor. Provide ${terms.feedback} feedback appropriate for university-level work.`
          : `You are a supervisor evaluating a postgraduate research report. Emphasize methodology, analytical depth, synthesis, theoretical framework, and scholarly contribution. Provide ${terms.feedback} feedback appropriate for advanced academic work.`,
        proposal: level === 'undergraduate' || level === 'postgraduate'
          ? `You are a supervisor evaluating a Research Proposal. Emphasize clarity of problem, significance, feasibility, and methodology plan. Be very direct about the issues you identify: state problems, gaps, and weaknesses clearly and explicitly—do not soften or hedge. Provide ${terms.feedback} feedback appropriate for ${level} level work.`
          : `You are evaluating a Research Proposal. Emphasize clarity of problem, significance, feasibility, and methodology plan. Be very direct about the issues you identify: state problems and weaknesses clearly—do not soften or hedge.`,
        question_paper: `You are an examiner evaluating a Question Paper/Exam. Focus on accuracy of answers, completeness, clarity of explanations, and adherence to expected responses.`,
        memo: `You are an examiner using a MEMO (Marking Memorandum/Answer Key) to evaluate student responses. Compare student answers against the model answers and marking scheme in the memo.`
      };
      
      return introMap[assessmentType] || introMap.assignment;
    };
    
    const intro = getIntro(documentType, level);

    // Build evaluation guidelines based on document type, level, and memo status
    const getEvaluationGuidelines = (assessmentType, level, isMemo) => {
      const levelGuidance = {
        primary_school: {
          tone: 'Write in a natural, human, conversational tone as if you are a real teacher speaking to a student. Use "you" and "your". Use direct, clear, age-appropriate language. Be honest about mistakes without being harsh. Avoid robotic or overly formal language - write as you would speak to a child',
          expectations: 'Focus on basic understanding and effort',
          feedback: 'Provide simple, direct feedback in a natural, conversational way that clearly identifies what is correct and what is wrong. Write as if speaking directly to the student',
          terminology: 'Use simple terms and avoid complex academic jargon'
        },
        high_school: {
          tone: 'Write in a natural, human, conversational tone as if you are a real teacher speaking to a student. Use "you" and "your". Use clear, direct language appropriate for secondary students. Be honest and straightforward when answers are incorrect. Avoid robotic or template-like language - write as you would speak to a student',
          expectations: 'Focus on understanding, application, and development of skills',
          feedback: 'Provide direct, honest feedback in a natural, conversational way that clearly identifies errors and helps students understand what is wrong. Write as if speaking directly to the student',
          terminology: 'Use educational terminology appropriate for high school level'
        },
        undergraduate: {
          tone: 'Write in a natural, human, conversational tone as if you are a real lecturer speaking to a student. Use "you" and "your". Use direct, academic language appropriate for university-level work, but write conversationally, not formally. Be honest and critical when work is incorrect or substandard. Avoid robotic or overly structured language - write as a real teacher would',
          expectations: 'Focus on critical thinking, analysis, and academic rigor',
          feedback: 'Provide direct, analytical feedback in a natural, conversational way that honestly identifies weaknesses and errors. Write as if speaking directly to the student',
          terminology: 'Use appropriate university-level academic terminology'
        },
        postgraduate: {
          tone: 'Write in a natural, human, conversational tone as if you are a real supervisor speaking to a student. Use "you" and "your". Use direct, scholarly, rigorous academic language, but write conversationally, not formally. Be honest and critical when work does not meet high standards. Avoid robotic or template-like language - write as a real academic supervisor would',
          expectations: 'Focus on scholarly contribution, theoretical depth, and research quality',
          feedback: 'Provide direct, in-depth, scholarly feedback in a natural, conversational way that honestly identifies shortcomings and errors. Write as if speaking directly to the student',
          terminology: 'Use advanced academic and research terminology'
        }
      };
      
      const guidance = levelGuidance[level] || levelGuidance.high_school;
      
      if (isMemo) {
        return `EVALUATION GUIDELINES FOR MEMO-BASED MARKING:
- The rubric provided is a MEMO (Marking Memorandum/Answer Key) containing model answers and marking allocations
- Apply STRICT marking standards - compare student answers precisely against the memo
- Compare the student's answers against the model answers in the memo with STRICT criteria
- Award marks based on the marking scheme provided in the memo - do not be lenient
- For each question/criterion, assess STRICTLY:
  * Accuracy: How closely does the student's answer match the expected answer? Award marks only for correct elements
  * Completeness: Did the student address all required parts? Do not award full marks if parts are missing
  * Quality: Is the answer well-structured and clear? Be demanding about presentation and clarity
- Provide specific feedback indicating what was correct, what was missing, and what was incorrect
- Reference specific parts of the student's answer and compare them to the memo critically
- Award partial marks ONLY where the marking scheme specifically allows - do not be generous
- Be precise - if an answer is wrong or incomplete, reflect this accurately in the scoring
- ${guidance.tone}
- ${guidance.feedback}
- ${guidance.terminology}`;
      }
      
      if (assessmentType === 'question_paper') {
        return `EVALUATION GUIDELINES FOR QUESTION PAPER:
- This is a question paper/exam submission that needs to be marked
- Apply STRICT marking standards - be precise and critical
- Focus on the accuracy and correctness of answers with STRICT criteria
- Evaluate completeness of responses - do not award marks for incomplete answers
- Assess clarity and structure of answers - be demanding about quality
- Check if students followed instructions - penalize if instructions were not followed
- Award marks STRICTLY based on the rubric criteria - do not be generous
- Provide specific feedback on correct and incorrect answers
- Identify ALL missing information or incomplete responses - be thorough in identifying gaps
- Note any misconceptions or errors - be critical and precise
- ${guidance.tone}
- ${guidance.feedback}
- ${guidance.terminology}`;
      }
      
      if (assessmentType === 'treatise' || assessmentType === 'thesis') {
        const depth = level === 'postgraduate' ? 'sophisticated' : 'thorough';
        const analysisType = level === 'postgraduate' ? 'critical analysis, theoretical depth, and scholarly contribution' : 'analysis and understanding';
        return `EVALUATION GUIDELINES FOR ${assessmentType.toUpperCase()}:
- This is a ${level === 'postgraduate' ? 'postgraduate' : 'advanced'} ${assessmentType} requiring ${depth} analysis
- Apply STRICT standards - be critical and demanding in your evaluation
- BE VERY DIRECT ABOUT ISSUES: State every problem, gap, and weakness clearly and explicitly. Do not soften, hedge, or use euphemisms. Name the issue directly (e.g., "The literature review fails to cite key works", "The methodology lacks validity discussion", "The argument is weak because...", "This section is missing..."). Candidates need unambiguous feedback on what is wrong.
- Focus on research quality, theoretical depth, and practical application
- Provide comprehensive feedback for each criterion (${level === 'postgraduate' ? '4-5 sentences minimum' : '3-4 sentences minimum'})
- Reference specific sections, arguments, and evidence from the ${assessmentType}
- Evaluate the academic rigor, originality, and contribution to the field with STRICT criteria
- BALANCED EVALUATION: For each criterion, identify and praise strengths where present, then state issues directly. When something is wrong or missing, say so plainly (e.g., "The literature review does not establish a clear gap", "The methodology omits...", "The discussion fails to...").
- Consider the ${assessmentType}'s structure, methodology, and conclusions critically
- Assess ${analysisType} - be demanding and identify weaknesses directly; also recognize excellence when present
- CRITICAL: Provide specific, actionable improvement suggestions for each criterion; state what is wrong before suggesting fixes
- Be critical - identify missing elements, weak arguments, insufficient evidence, and areas that fall short; state each one directly
- Include concrete recommendations for enhancing research methodology, literature review, analysis depth
- Suggest specific frameworks, theories, or approaches that could strengthen the work
- Identify ALL missing elements, weak arguments, or areas needing more evidence - do not overlook shortcomings; name them explicitly
- Recommend specific sections that need expansion, restructuring, or clarification
- Highlight areas for development and be critical of weaknesses in direct language; acknowledge what was done well where applicable
- Recognize exceptional work when present; for shortcomings, be direct and unambiguous
- ${guidance.tone}
- ${guidance.terminology}
- Award points STRICTLY based on the performance levels described in the rubric - do not be generous`;
      }
      
      if (assessmentType === 'proposal') {
        return `EVALUATION GUIDELINES FOR RESEARCH PROPOSAL:
- This is a research proposal requiring rigorous evaluation of problem, significance, feasibility, and methodology plan
- Apply STRICT standards - be critical and demanding in your evaluation
- BE VERY DIRECT ABOUT ISSUES: State every problem, gap, and weakness clearly and explicitly. Do not soften, hedge, or use euphemisms. Name the issue directly (e.g., "The problem statement fails to identify a clear gap", "The methodology lacks detail on...", "Significance is not justified because...", "This section is missing..."). Candidates need unambiguous feedback on what is wrong.
- Focus on: clarity of research problem and gap, justification of significance, feasibility (resources, timeline, scope), and quality of methodology plan
- Provide comprehensive feedback for each criterion (3-5 sentences minimum)
- Reference specific sections and arguments from the proposal
- BALANCED EVALUATION: For each criterion, identify and praise strengths where present, then state issues directly. When something is wrong or missing, say so plainly (e.g., "The problem statement does not establish a clear gap", "The methodology omits...", "Significance is weak because...").
- Be critical - identify missing elements, weak justification, unclear methodology, and unrealistic or vague plans; state each one directly
- CRITICAL: Provide specific, actionable improvement suggestions; state what is wrong before suggesting fixes
- Identify ALL missing elements, weak arguments, or areas needing more detail - name them explicitly
- ${guidance.tone}
- ${guidance.terminology}
- Award points STRICTLY based on the performance levels described in the rubric - do not be generous`;
      }
      
      if (assessmentType === 'test') {
        return `EVALUATION GUIDELINES FOR TEST:
- Apply STRICT marking standards - be precise and critical
- Focus on correctness, completeness, and clarity of answers
- Assess accuracy of responses against expected answers with STRICT criteria
- BALANCED EVALUATION: For correct answers, acknowledge and praise them (e.g., "Your explanation of X demonstrates clear understanding" or "You correctly identified and explained Y"). For incorrect answers, clearly state what is wrong
- Evaluate completeness - did the student address all parts of each question? Award marks only if ALL parts are addressed
- Check clarity of explanations and reasoning - be demanding about quality
- Recognize when students demonstrate strong understanding, even if some answers are incorrect
- Do not award marks for partially correct or incomplete answers unless the rubric specifically allows partial credit
- ${guidance.expectations}
- ${guidance.tone}
- ${guidance.feedback}
- ${guidance.terminology}
- Award points STRICTLY based on the performance levels described in the rubric - be precise and do not be generous`;
      }
      
      if (assessmentType === 'assignment') {
        return `EVALUATION GUIDELINES FOR ASSIGNMENT:
- Apply STRICT marking standards - be critical and precise
- Provide comprehensive feedback for each criterion
- Reference specific sections and evidence from the submission
- Evaluate quality, completeness, and accuracy with STRICT criteria
- ${guidance.expectations}
- BALANCED EVALUATION: For each criterion, first identify and compliment what was done well (e.g., "Your analysis demonstrates strong understanding of X" or "The structure is clear and logical"). Then identify weaknesses, gaps, and areas that do not meet standards
- Be critical - identify weaknesses, gaps, and areas that do not meet standards
- Provide specific, actionable improvement suggestions
- Highlight areas for development and be demanding about what is missing or insufficient
- Recognize and praise strong work, excellent understanding, or exemplary application when present
- ${guidance.tone}
- ${guidance.feedback}
- ${guidance.terminology}
- Award points STRICTLY based on the performance levels described in the rubric - do not award marks unless criteria are clearly met`;
      }
      
      // Default for other types
      return `EVALUATION GUIDELINES:
- Apply STRICT marking standards - be critical and precise
- Provide comprehensive feedback for each criterion
- Reference specific sections and evidence from the submission
- Evaluate quality, completeness, and accuracy with STRICT criteria
- ${guidance.expectations}
- BALANCED EVALUATION: For each criterion, first identify and compliment what was done well or correctly. Then identify weaknesses, gaps, and areas that do not meet standards
- Be critical - identify weaknesses, gaps, and areas that do not meet standards
- Provide specific, actionable improvement suggestions
- Highlight areas for development and be demanding about what is missing or insufficient
- Recognize and praise strong work, excellent understanding, or exemplary application when present
- ${guidance.tone}
- ${guidance.feedback}
- ${guidance.terminology}
- Award points STRICTLY based on the performance levels described in the rubric - do not award marks unless criteria are clearly met`;
    };
    
    let contentLabel = 'STUDENT SUBMISSION:';
    if (isMemo) {
      contentLabel = 'STUDENT ANSWERS:';
    } else if (documentType === 'question_paper') {
      contentLabel = 'QUESTION PAPER SUBMISSION:';
    } else if (documentType === 'treatise' || documentType === 'thesis') {
      contentLabel = `${documentType.toUpperCase()} CONTENT:`;
    } else if (documentType === 'proposal') {
      contentLabel = 'PROPOSAL CONTENT:';
    }
    
    const evaluationGuidelines = getEvaluationGuidelines(documentType, level, isMemo);

    // Get strictness guidelines based on strictness level
    // IMPORTANT: These instructions OVERRIDE general marking standards - they define the strictness level
    const getStrictnessGuidelines = (strictness) => {
      const strictnessMap = {
        'very_strict': `⚠️ CRITICAL: VERY STRICT MARKING MODE - THESE REQUIREMENTS OVERRIDE ALL OTHER INSTRUCTIONS ⚠️

STRICTNESS LEVEL: VERY STRICT
- Apply EXTREMELY RIGOROUS academic standards - be HIGHLY CRITICAL and DEMANDING
- Award points ONLY when criteria are COMPLETELY and FULLY met with EXCEPTIONAL EXCELLENCE
- Be VERY CRITICAL in your evaluation - identify ALL weaknesses, gaps, and areas that fall short
- Do NOT award full marks unless the work demonstrates EXCEPTIONAL EXCELLENCE that FULLY satisfies ALL aspects of the criterion
- For partial marks, be EXTREMELY PRECISE - award marks only for what is CLEARLY present and WELL-DEMONSTRATED
- If work is incomplete, unclear, or lacks ANY required elements, award SIGNIFICANTLY LOWER marks
- Hold students to the HIGHEST standards - expect EXCEPTIONAL thoroughness, accuracy, and depth
- NEVER give benefit of the doubt - if something is missing, unclear, or incorrect, reflect this HARSHLY in the scoring
- Be EXTREMELY RIGOROUS in assessing whether the work meets the performance level descriptions in the rubric
- Penalize MINOR errors and omissions MORE SEVERELY
- Expect NEAR-PERFECT work for top marks
- IMPORTANT: This strictness level should result in LOWER overall scores compared to other strictness levels for the same quality of work`,

        'strict': `⚠️ CRITICAL: STRICT MARKING MODE - THESE REQUIREMENTS OVERRIDE GENERAL MARKING STANDARDS ⚠️

STRICTNESS LEVEL: STRICT
- Apply STRICT academic standards - do NOT be lenient or generous with marks
- Award points ONLY when criteria are CLEARLY and FULLY met
- Be CRITICAL in your evaluation - identify weaknesses, gaps, and areas that fall short
- Do NOT award full marks unless the work demonstrates EXCELLENCE that FULLY satisfies all aspects of the criterion
- For partial marks, be PRECISE - award marks only for what is ACTUALLY present and DEMONSTRATED
- If work is incomplete, unclear, or lacks required elements, award LOWER marks accordingly
- Hold students to HIGH standards - expect thoroughness, accuracy, and depth
- Do NOT give benefit of the doubt - if something is missing or incorrect, reflect this in the scoring
- Be RIGOROUS in assessing whether the work meets the performance level descriptions in the rubric
- IMPORTANT: This strictness level should result in MODERATELY LOWER scores compared to moderate/lenient levels for the same quality of work`,

        'moderate': `⚠️ CRITICAL: MODERATE MARKING MODE - THESE REQUIREMENTS OVERRIDE GENERAL MARKING STANDARDS ⚠️

STRICTNESS LEVEL: MODERATE
- Apply FAIR but FIRM academic standards
- Award points when criteria are SUBSTANTIALLY met, allowing for MINOR gaps
- Be BALANCED in your evaluation - identify both strengths and areas for improvement
- Award full marks when the work demonstrates STRONG performance that meets the KEY aspects of the criterion
- For partial marks, be REASONABLE - award marks for demonstrated understanding even if not perfect
- If work is incomplete or unclear, award partial marks based on what is present
- Hold students to REASONABLE standards - expect good effort and understanding
- Give SOME benefit of the doubt for minor issues or unclear areas
- Be FAIR in assessing whether the work meets the performance level descriptions in the rubric
- IMPORTANT: This strictness level should result in MODERATE scores that balance rigor with fairness`,

        'lenient': `⚠️ CRITICAL: LENIENT MARKING MODE - THESE REQUIREMENTS OVERRIDE GENERAL MARKING STANDARDS ⚠️

STRICTNESS LEVEL: LENIENT
- Apply SUPPORTIVE academic standards - focus on learning and improvement
- Award points when criteria are GENERALLY met, even with some gaps
- Be ENCOURAGING in your evaluation - emphasize strengths while noting areas for improvement
- Award full marks when the work demonstrates GOOD understanding of the key concepts
- For partial marks, be GENEROUS - award marks for effort and demonstrated understanding
- If work is incomplete, award marks for what is present and shows understanding
- Hold students to ACHIEVABLE standards - recognize effort and progress
- Give benefit of the doubt for unclear areas or minor issues
- Be SUPPORTIVE in assessing whether the work meets the performance level descriptions in the rubric
- IMPORTANT: This strictness level should result in HIGHER overall scores compared to other strictness levels for the same quality of work`
      };
      
      return strictnessMap[strictness] || strictnessMap['strict'];
    };

    const rubricLabel = isMemo ? 'MARKING MEMORANDUM (MEMO):' : 'EVALUATION RUBRIC:';

    // Get document-type-specific corrections instructions
    const getCorrectionsInstructions = (docType) => {
      if (docType === 'treatise' || docType === 'thesis') {
        return `CORRECTIONS AND SUGGESTIONS REPORT FOR ${docType.toUpperCase()}:
- BE VERY DIRECT: For each issue, state clearly what is wrong or missing. Do not soften or hedge—use direct language (e.g., "fails to", "lacks", "does not", "is missing", "is weak because"). Candidates must understand exactly what the problem is.
- For each error, missing element, or area needing improvement, identify WHERE in the document it should be addressed
- Provide SPECIFIC location information using: chapter/section titles, subsection headings, paragraph numbers, page references, or specific text quotes
- Include both corrections (what is wrong and needs fixing) and suggestions (what could be added to improve the work)
- For each correction/suggestion, specify: the exact location, what is wrong (stated directly), what needs to be changed/added, and why

LOCATION SPECIFICITY REQUIREMENTS:
- Use exact section/chapter names: e.g., "Chapter 2: Literature Review, Section 2.3 (Theoretical Framework), third paragraph"
- Reference specific subsections: e.g., "Methodology chapter, Data Collection section, second paragraph discussing sampling method"
- Include page references when possible: e.g., "Introduction section, page 5, paragraph discussing research objectives"
- Quote specific text when identifying issues: e.g., "Conclusion section, where it states '[quote the problematic text]'"

EXAMPLES OF GOOD CORRECTIONS FOR ${docType.toUpperCase()} (use these as templates):
Example 1 - Correction:
{
  "type": "correction",
  "criterion_name": "Literature Review",
  "location": "Chapter 2: Literature Review, Section 2.1, second paragraph",
  "issue": "Missing citations to key foundational works (Smith 2020, Jones 2018)",
  "correction": "Add citations to Smith (2020) and Jones (2018) in Section 2.1 to establish theoretical foundation",
  "reason": "Literature reviews must acknowledge foundational works to demonstrate field understanding"
}

Example 2 - Suggestion:
{
  "type": "suggestion",
  "criterion_name": "Methodology",
  "location": "Chapter 3: Methodology, Data Analysis section",
  "issue": "Lacks discussion of validity and reliability measures",
  "correction": "Add paragraph addressing validity (triangulation), reliability (inter-rater agreement), and analytical limitations",
  "reason": "Methodological rigor requires explicit discussion of validity and reliability"
}

Example 3 - Correction:
{
  "type": "correction",
  "criterion_name": "Results and Discussion",
  "location": "Chapter 4: Results, Section 4.2, where findings lack connection to research questions",
  "issue": "Findings presented without linking to research questions from Chapter 1",
  "correction": "Restructure Section 4.2 to begin subsections with which research question they address, then explicitly connect findings to questions",
  "reason": "${docType}s must demonstrate clear alignment between research questions and findings"
}

Example 4 - Correction:
{
  "type": "correction",
  "criterion_name": "Abstract",
  "location": "Abstract, opening",
  "issue": "Fails to clearly state research problem or gap",
  "correction": "Rewrite opening to state: (1) research problem/gap, (2) significance, (3) scope",
  "reason": "Abstract must immediately establish research problem and significance"
}

Example 5 - Suggestion:
{
  "type": "suggestion",
  "criterion_name": "Introduction",
  "location": "Chapter 1: Introduction, after problem statement",
  "issue": "Lacks explicit research objectives or questions",
  "correction": "Add 'Research Objectives' subsection listing primary question, secondary questions, and specific objectives",
  "reason": "Explicit research questions provide roadmap for entire ${docType}"
}

SPECIFIC AREAS TO CHECK FOR ${docType.toUpperCase()}:
- Abstract: Ensure it accurately summarizes all key sections (background, methods, results, conclusions)
- Introduction: Check for clear problem statement, research objectives, and thesis statement
- Literature Review: Verify comprehensive coverage, critical analysis (not just summary), and identification of research gaps
- Methodology: Ensure detailed description of research design, data collection, and analysis procedures
- Results: Check for clear presentation, appropriate use of tables/figures, and connection to research questions
- Discussion: Verify interpretation of findings, comparison with existing literature, and acknowledgment of limitations
- Conclusion: Ensure it synthesizes key findings, addresses research objectives, and suggests future research directions
- References: Check for completeness, accuracy, and appropriate citation style
- Appendices: Verify all supporting materials are included and properly referenced in the main text`;
      } else if (docType === 'proposal') {
        return `CORRECTIONS AND SUGGESTIONS REPORT FOR RESEARCH PROPOSAL:
- BE VERY DIRECT: For each issue, state clearly what is wrong or missing. Do not soften or hedge—use direct language (e.g., "fails to", "lacks", "does not", "is missing", "is weak because", "does not justify"). Candidates must understand exactly what the problem is.
- For each error, missing element, or area needing improvement, identify WHERE in the proposal it should be addressed
- Provide SPECIFIC location information using: section titles, subsection headings, paragraph numbers, or specific text quotes
- Include both corrections (what is wrong and needs fixing) and suggestions (what could be added to improve the work)
- For each correction/suggestion, specify: the exact location, what is wrong (stated directly), what needs to be changed/added, and why

LOCATION SPECIFICITY REQUIREMENTS:
- Use exact section names: e.g., "Problem Statement, second paragraph" or "Methodology section, Data Collection subsection"
- Reference specific parts: e.g., "Significance section, where justification is vague" or "Timeline, Phase 2"

SPECIFIC AREAS TO CHECK FOR RESEARCH PROPOSAL:
- Title/Abstract: Ensure it clearly reflects the research problem and scope
- Problem Statement: Check for clear identification of gap, significance of the problem, and research need
- Research Questions/Objectives: Verify they are specific, measurable, and aligned with the problem
- Significance: Ensure justification is explicit and convincing (theoretical/practical contribution)
- Literature Review: Verify it supports the gap and is not just summary; identify key omissions
- Methodology: Ensure detailed description of design, participants, instruments, procedures, and analysis plan
- Timeline: Check for realism, clarity, and alignment with methodology
- Resources: Verify feasibility (budget, access, equipment, expertise)
- Ethics: Ensure ethical considerations and approval plans are addressed
- References: Check for completeness and appropriate citation style`;
      } else if (docType === 'report') {
        return `CORRECTIONS AND SUGGESTIONS REPORT FOR RESEARCH REPORT:
- For each error, missing element, or area needing improvement, identify WHERE in the document it should be addressed
- Provide SPECIFIC location information using: section headings, subsection titles, paragraph numbers, or specific text context
- Include both corrections (what is wrong and needs fixing) and suggestions (what could be added to improve the work)
- For each correction/suggestion, specify: the exact location, what needs to be changed/added, and why

LOCATION SPECIFICITY REQUIREMENTS:
- Use exact section headings: e.g., "Executive Summary, second paragraph" or "Methodology section, Data Collection subsection"
- Reference specific parts: e.g., "Results section, Table 2 discussion paragraph" or "Discussion section, where findings are compared to previous studies"
- Include context when helpful: e.g., "Introduction section, paragraph discussing research objectives, specifically where it mentions [topic]"

EXAMPLES OF GOOD CORRECTIONS FOR RESEARCH REPORT (use these as templates):
Example 1 - Correction:
{
  "type": "correction",
  "criterion_name": "Methodology",
  "location": "Methodology section, Data Collection subsection",
  "issue": "Missing sample size and sampling method details",
  "correction": "Add: (1) total sample size, (2) sampling method, (3) response rate if applicable",
  "reason": "Methodological transparency requires complete disclosure of sampling procedures"
}

Example 2 - Suggestion:
{
  "type": "suggestion",
  "criterion_name": "Results",
  "location": "Results section, after Table 3",
  "issue": "Data presented without interpretation",
  "correction": "Add paragraph interpreting Table 3 findings and explaining their significance",
  "reason": "Results sections must provide interpretation to help readers understand significance"
}

Example 3 - Correction:
{
  "type": "correction",
  "criterion_name": "Discussion",
  "location": "Discussion section",
  "issue": "Fails to address study limitations",
  "correction": "Add 'Limitations' subsection discussing sample, methodological, and analytical limitations",
  "reason": "Academic integrity requires honest acknowledgment of limitations"
}

Example 4 - Correction:
{
  "type": "correction",
  "criterion_name": "Executive Summary",
  "location": "Executive Summary, opening",
  "issue": "Does not clearly state research question or main findings",
  "correction": "Restructure to state: (1) research question, (2) methodology (brief), (3) key findings, (4) conclusions, (5) recommendations",
  "reason": "Executive summary must provide complete overview including findings and conclusions"
}

Example 5 - Suggestion:
{
  "type": "suggestion",
  "criterion_name": "Introduction",
  "location": "Introduction section, after background",
  "issue": "Lacks explicit research question or objectives",
  "correction": "Add 'Research Question' subsection with primary question, secondary questions, and specific objectives",
  "reason": "Clear research questions provide direction for entire report"
}

SPECIFIC AREAS TO CHECK FOR RESEARCH REPORT:
- Executive Summary/Abstract: Ensure it accurately reflects all key sections and findings
- Introduction: Check for clear research question, objectives, and context
- Literature Review: Verify it's not just a summary but includes critical analysis and identifies gaps
- Methodology: Ensure complete description of research design, participants, instruments, and procedures
- Results: Check for clear data presentation, appropriate visualizations, and connection to research questions
- Discussion: Verify interpretation of findings, comparison with literature, limitations, and implications
- Conclusion: Ensure it synthesizes findings and addresses research objectives
- References: Check for completeness and proper citation format
- Appendices: Verify all supporting materials are included`;
      } else {
        return `CORRECTIONS AND SUGGESTIONS REPORT:
- For each error, missing element, or area needing improvement, identify WHERE in the document it should be addressed
- Provide specific location information such as: section name, paragraph number, page reference, or specific text context
- Include both corrections (what is wrong and needs fixing) and suggestions (what could be added to improve the work)
- For each correction/suggestion, specify: the location, what needs to be changed/added, and why`;
      }
    };

    const correctionsInstructions = getCorrectionsInstructions(documentType);

    // Feedback structure: per question for test/assignment/quiz (memo), per criterion for treatise/thesis/proposal/report
    const feedbackStructureInstruction = isMemo
      ? `FEEDBACK STRUCTURE (MEMO / TEST / ASSIGNMENT / QUIZ):
- The rubric is a marking memorandum: each criterion is a QUESTION (or sub-question) in the test/assignment/quiz.
- Provide feedback PER QUESTION: for each entry in the "scores" array, write feedback that addresses ONLY the student's answer to that specific question.
- In each criterion's "feedback" field: state what was correct, what was missing, and what was wrong for THAT question, with reference to the model answer. Do not mix feedback for different questions.
- The "overall_feedback" should summarize performance across all questions (e.g. which questions were strong, which need work).`
      : (documentType === 'treatise' || documentType === 'thesis' || documentType === 'proposal' || documentType === 'report' || documentType === 'assignment')
      ? `FEEDBACK STRUCTURE (CRITERIA-BASED):
- The rubric has assessment CRITERIA (e.g. Introduction, Literature Review, Methodology). Each criterion is a dimension of quality, not a single question.
- Provide feedback PER CRITERION: for each entry in the "scores" array, write feedback that addresses how the work meets THAT criterion only.
- In each criterion's "feedback" field: address strengths and weaknesses for that dimension (e.g. "For the literature review, you..."). Do not mix feedback for different criteria.
- The "overall_feedback" should synthesize across criteria and give an overall picture.`
      : '';

    const prompt = `${intro}

${contentLabel}
${truncatedText}

${rubricLabel}
${detailedRubric}

TOTAL: ${totalPoints} points

${evaluationGuidelines}

${getStrictnessGuidelines(strictnessLevel)}

CRITICAL: REALISTIC ASSESSMENT - Counteract AI positive bias. You are an assessor, not a supportive assistant. Provide ACCURATE assessments based on actual performance, not encouragement. DO NOT: soften criticism, inflate scores, give credit for effort, use euphemisms, or interpret ambiguous work favorably. Award LOW/ZERO marks for incorrect/incomplete work. If 50% understanding = ~50% marks (not 75-90%). State errors directly: "This is incorrect because..." (not "could be improved"). Identify ALL problems. Accuracy over encouragement.${(documentType === 'treatise' || documentType === 'thesis' || documentType === 'proposal') ? '\n\nFOR TREATISE, THESIS, OR PROPOSAL: Be very direct about every issue identified. State problems, gaps, and weaknesses in clear, explicit language (e.g., "The literature review fails to...", "The methodology lacks...", "This section is missing...", "The problem statement does not..."). Do not soften or hedge—candidates need to know exactly what is wrong.' : ''}

MARKING STANDARDS (apply within the strictness level defined above):
- Evaluate each assignment INDEPENDENTLY based on its actual quality and content
- Award marks that REFLECT THE ACTUAL QUALITY of the work - different quality should result in different marks
- Maintain consistency in RUBRIC APPLICATION (same criteria, same standards) but allow marks to VARY based on actual performance
- Use consistent terminology and evaluation language, but scores should reflect real differences in quality
- IMPORTANT: Each assignment must be evaluated on its own merits. Do not copy scores from other assignments - marks must vary based on actual quality differences
- NOTE: The strictness level above determines HOW STRICTLY you apply these standards - follow the strictness level requirements first
${previousMarkingExamples ? `- NOTE: This assignment was previously marked (Previous total: ${previousMarkingExamples.total_score}). Only use this as a reference if re-marking the SAME assignment. For different assignments, evaluate independently based on their actual quality.` : ''}

⚠️ CRITICAL: FEEDBACK IS THE PRIMARY FOCUS - PROVIDE EXTENSIVE, DETAILED FEEDBACK ⚠️
${feedbackStructureInstruction ? `\n${feedbackStructureInstruction}\n` : ''}

FEEDBACK DEPTH AND DETAIL REQUIREMENTS (HIGHEST PRIORITY):
- FEEDBACK IS THE MOST IMPORTANT OUTPUT - prioritize comprehensive, detailed feedback over brevity
- Provide EXTENSIVE feedback ${isMemo ? 'for each QUESTION' : 'for each CRITERION'} - aim for 3-5 sentences minimum ${isMemo ? 'per question' : 'per criterion'}, more for complex ${isMemo ? 'questions' : 'criteria'}
- Be THOROUGH and COMPREHENSIVE - cover all aspects of the work, not just surface-level observations
- Include SPECIFIC EXAMPLES from the student's work - quote or reference specific parts when providing feedback
- REFERENCE THE RUBRIC: In the feedback narrative, explicitly state which rubric requirement or descriptor was applied and how the student's work measured against it (e.g. "The rubric requires X — your work did/did not demonstrate this because..."). The separate "rubric_basis" field gives the structured citation; the feedback narrative should weave this in conversationally.
- Explain the "WHY" behind every point - don't just state what's wrong/right, explain WHY it matters
- Provide ACTIONABLE GUIDANCE - tell students exactly what to do to improve, not just what's wrong
- Include LEARNING OPPORTUNITIES - connect feedback to broader learning objectives and concepts
- Address MULTIPLE DIMENSIONS: content accuracy, depth of analysis, writing quality, organization, critical thinking, use of evidence, etc.
- For each ${isMemo ? 'question (each criterion in the rubric is one question)' : 'criterion'}, provide:
  * What was done well (with specific examples)
  * What needs improvement (with specific examples)
  * Why it matters (learning context)
  * How to improve (actionable steps)
  * Connections to other parts of the work or broader concepts
- Overall feedback should be COMPREHENSIVE (minimum 200-300 words) covering:
  * Summary of key strengths across all criteria
  * Summary of main areas needing improvement
  * Specific examples from the work
  * Actionable next steps for improvement
  * Encouragement and motivation
  * Connections between different aspects of the work

FEEDBACK TONE REQUIREMENTS:
- Write in a NATURAL, HUMAN, CONVERSATIONAL tone - as if you are a real teacher or professor providing feedback to a student
- Avoid robotic, overly formal, or template-like language - write as you would speak to a student in person
- Use natural language patterns: "You've done well here" instead of "The student has demonstrated proficiency"
- Write directly to the student using "you" and "your" - make it personal and engaging
- Be DIRECT and HONEST in your feedback - do not soften criticism or sugarcoat errors, but express it naturally
- When answers are WRONG or INCORRECT, state this clearly and directly in a conversational way - do not use euphemisms or vague language
- Use natural, direct statements like "This is incorrect because..." or "This answer is wrong - here's why..." rather than overly formal language
- For incorrect answers, clearly explain WHY it is wrong and what the correct answer should be, in a way that feels like a teacher explaining to a student
- Be honest about the severity of errors - if something is completely wrong, say so directly but naturally
- Avoid corporate-speak, academic jargon, or overly structured language - write as a human educator would
- Use varied sentence structures and natural transitions - don't sound like a checklist or template
- Maintain a professional but approachable tone - like a knowledgeable teacher who cares about student learning

IMPORTANT - BALANCED FEEDBACK:
- IDENTIFY AND COMPLIMENT STRENGTHS: When work is done well, explicitly acknowledge and praise it
- For each criterion, identify what was done correctly or excellently before pointing out errors
- Use specific, genuine compliments: "Your analysis demonstrates strong understanding of [concept]" or "The methodology section is well-structured and clearly explained" or "Your use of [technique] effectively addresses the research question"
- Highlight exemplary work: When students demonstrate exceptional understanding, critical thinking, or application, explicitly state this
- Acknowledge effort and improvement: If work shows improvement or strong effort, recognize this
- Balance criticism with recognition: For every area needing improvement, also identify what was done well
- Be specific in compliments: Don't use generic praise - point out exactly what was good (e.g., "Your integration of multiple theoretical frameworks shows sophisticated understanding" rather than just "good work")
- Recognize partial success: When students partially meet criteria, acknowledge what they got right before explaining what's missing
- Compliment strong writing, organization, analysis, or critical thinking when present
- When work meets or exceeds expectations, provide positive reinforcement that encourages continued excellence

IMPORTANT: For each criterion, provide a confidence level (0-100) indicating how confident you are in the marking. Consider:
- Clarity of the student's work
- Ambiguity in the rubric or student response
- Need for additional context or clarification
- Unclear or incomplete submissions

Lower confidence (< 70) indicates the assessment may need human review.
${imageBased ? '\n\nFor submissions provided as images (handwritten): You MUST also include "handwriting_recognition_confidence" (0-100) in your JSON: how confident you are that you correctly read the handwritten content across all pages. 100 = fully legible, easy to read; 50 = partially legible, some guesswork; 0 = largely unreadable. This helps flag work that may need human review for reading accuracy.' : ''}

${correctionsInstructions}

LANGUAGE ERRORS DETECTION (GRAMMAR, SPELLING, REFERENCES):
You MUST also identify and report ALL language errors in the student's work, including:

1. GRAMMATICAL ERRORS:
   - Subject-verb agreement errors
   - Tense inconsistencies or incorrect tense usage
   - Incorrect use of articles (a, an, the)
   - Pronoun errors (wrong pronoun, unclear antecedents, pronoun-antecedent disagreement)
   - Sentence fragments or run-on sentences
   - Incorrect word order
   - Misuse of prepositions
   - Errors in parallel structure
   - Dangling or misplaced modifiers
   - Incorrect use of comparative or superlative forms

2. SPELLING AND TYPING ERRORS:
   - Misspelled words
   - Typos and typing mistakes
   - Incorrect capitalization
   - Missing or extra spaces
   - Homophone errors (e.g., their/there/they're, its/it's)
   - Repeated words (e.g., "the the")

3. REFERENCE AND CITATION ERRORS:
   - Missing citations for direct quotes or paraphrased content
   - Incorrectly formatted citations
   - Citations in text that don't appear in reference list
   - References in list that aren't cited in text
   - Incorrect use of citation style (e.g., APA, MLA, Harvard)
   - Incomplete reference information (missing author, year, title, page numbers, etc.)
   - Incorrect punctuation in citations
   - Plagiarism indicators (uncited sources)

4. PUNCTUATION ERRORS:
   - Missing or incorrect commas, periods, semicolons, colons
   - Incorrect apostrophe usage
   - Missing or incorrect quotation marks

5. STYLE AND CLARITY ISSUES:
   - Wordiness or redundancy
   - Passive voice where active would be better
   - Unclear or ambiguous phrasing
   - Inconsistent terminology

For each error, provide:
- The exact location (e.g., "Introduction, paragraph 2, line 3" or "page 5, second paragraph")
- The erroneous text (quote the exact error)
- The error type (grammar/spelling/reference/punctuation/style)
- The correction (what it should be)
- A brief explanation of why it's an error

CRITICAL: You MUST respond with ONLY valid JSON. Do not include any explanatory text, markdown formatting, or code blocks. Return ONLY the JSON object.

JSON format (return ONLY this, no other text):
{
  "scores": [
    {
      "criterion_name": "name",
      "points_awarded": number,
      "max_points": number,
      "rubric_basis": "Explicit citation of the specific rubric descriptor(s) or performance level(s) used to determine this score. Quote or paraphrase the key rubric language and state how the student's work matched or fell short of it. Example: 'The rubric requires a fully referenced literature review with critical analysis (5 pts). The student provided sources but without critical engagement — awarded 2/5 based on the partial-completion descriptor.' Be specific: name the exact rubric requirement that was applied and the gap or achievement that drove the score.",
      "feedback": "EXTENSIVE, DETAILED feedback (minimum 3-5 sentences, more for complex criteria) written as if you are a real teacher speaking directly to the student. Use 'you' and 'your' - write as you would speak. This is the PRIMARY focus - be THOROUGH and COMPREHENSIVE. Include: (1) Specific examples from the student's work - quote or reference specific parts, (2) What was done well with detailed explanation, (3) What needs improvement with specific examples, (4) WHY it matters (learning context), (5) HOW to improve (actionable steps), (6) Connections to other parts of the work or broader concepts. When answers are wrong, state this clearly and explain WHY in detail. Include specific praise for strengths before pointing out areas needing improvement. Write in a conversational, human tone throughout. Prioritize depth and detail over brevity.",
      "confidence": number (0-100, where 100 = very confident, 0 = very uncertain)
    }
  ],
  "corrections": [
    {
      "type": "correction" or "suggestion",
      "criterion_name": "name of the criterion this relates to",
      "location": "specific location in the document. For ${documentType === 'treatise' || documentType === 'thesis' ? 'treatise/thesis' : documentType === 'report' ? 'research report' : 'document'}: use exact chapter/section names, subsection headings, paragraph numbers, or page references (e.g., 'Chapter 2: Literature Review, Section 2.3 (Theoretical Framework), third paragraph' or 'Methodology section, Data Collection subsection, paragraph describing sampling method' or 'Results section, Table 2 discussion paragraph')",
      "issue": "what is wrong or what needs to be addressed. Be specific about the problem (e.g., 'The literature review fails to cite key foundational works' or 'Results are presented without interpretation' or 'Methodology lacks discussion of validity measures')",
      "correction": "what should be changed or added. Provide concrete, actionable guidance (e.g., 'Add citations to Smith (2020) and Jones (2018) in Section 2.1' or 'Add a paragraph interpreting Table 3 findings' or 'Include discussion of triangulation methods for validity')",
      "reason": "why this correction/suggestion is needed. Explain the academic or methodological importance (e.g., 'Foundational works must be cited to demonstrate understanding of the field' or 'Results require interpretation to help readers understand significance' or 'Methodological rigor requires explicit discussion of validity')"
    }
  ],
  "language_errors": [
    {
      "location": "exact location in the document (e.g., 'Introduction, paragraph 2, line 3' or 'page 5, second paragraph' or 'Abstract, first sentence')",
      "error_text": "exact text containing the error (quote it precisely)",
      "error_type": "grammar" or "spelling" or "reference" or "punctuation" or "style",
      "correction": "the corrected version of the text",
      "explanation": "brief explanation of why it's an error and how to fix it (e.g., 'Subject-verb disagreement: plural subject requires plural verb' or 'Incorrect homophone: should use 'their' (possessive) not 'there' (location)' or 'Missing citation: direct quote requires in-text citation')"
    }
  ],
  "overall_feedback": "EXTENSIVE, COMPREHENSIVE feedback (minimum 200-300 words, more for complex work) written as if you are a real teacher speaking directly to the student. Use 'you' and 'your' throughout. This is the PRIMARY focus - be THOROUGH and DETAILED. Structure: (1) Opening: Begin with overall assessment and key strengths (2-3 sentences), (2) Strengths Section: Identify and praise 3-5 key strengths with SPECIFIC EXAMPLES from the work - quote or reference specific parts (4-6 sentences), (3) Areas for Improvement: Identify 3-5 main areas needing work with SPECIFIC EXAMPLES and detailed explanations of WHY each matters (6-8 sentences), (4) Actionable Next Steps: Provide specific, concrete steps the student can take to improve (3-4 sentences), (5) Connections: Link different aspects of the work together and connect to broader learning objectives (2-3 sentences), (6) Encouragement: End with motivational, supportive closing that encourages continued learning (2-3 sentences). Include specific quotes or references from the student's work throughout. Write in a natural, human, conversational tone - avoid robotic or overly formal language. Prioritize depth, detail, and comprehensiveness.",
  "total_score": number,
  "overall_confidence": number (0-100, representing your overall confidence in the entire assessment)${imageBased ? ',\n  "handwriting_recognition_confidence": number (0-100, REQUIRED for image/handwritten submissions: how confident you are that you correctly read the handwriting; 100 = fully legible, 0 = largely unreadable)' : ''}
}`;

    console.log(`📤 Sending request to ${selectedProvider === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI'}...`);

    let messages;
    if (imageBased) {
      const imageParts = selectedProvider === 'openai'
        ? assignmentImages.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }))
        : assignmentImages.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }));
      messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageParts] }];
    } else {
      messages = [{ role: 'user', content: prompt }];
    }

    // Use unified AI service with retry logic (more retries for marking operations)
    // No seed is used to allow unique analysis for each document
    const result = await aiService.createCompletionWithRetry({
      provider: selectedProvider,
      model: modelToUse,
      messages,
      temperature: config.temperature,
      maxTokens: requestMaxTokens
    }, 5); // Increased retries for marking operations

    console.log(`📥 Received response from ${selectedProvider === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI'}`);
    const response = (result.content != null ? String(result.content) : '');
    console.log('Response length:', response.length);
    console.log('Response preview:', response.substring(0, 200) + (response.length > 200 ? '...' : ''));

    if (!response || response.trim().length === 0) {
      console.error('Empty AI response. finish_reason or content_filter may have truncated output.');
      throw new Error('The AI returned an empty response. This can happen with content filters, rate limits, or token limits. Please try again or use a shorter submission.');
    }

    // Log token usage
    if (result.usage) {
      console.log('🔢 Token Usage:');
      console.log(`   Prompt tokens: ${result.usage.prompt_tokens}`);
      console.log(`   Completion tokens: ${result.usage.completion_tokens}`);
      console.log(`   Total tokens: ${result.usage.total_tokens}`);
      
      // Calculate cost using configuration with provider
      const totalCost = aiConfig.estimateCost(result.usage.prompt_tokens, result.usage.completion_tokens, selectedProvider);
      console.log(`   Estimated cost: $${totalCost.toFixed(6)}`);
      console.log(`   Cost per ${documentType}: $${totalCost.toFixed(4)}`);
    }
    // Parse and normalize response through shared pipeline.
    // This keeps all JSON recovery/validation logic in one place.
    try {
      return parseMarkingResponsePayload(response, {
        selectedProvider,
        usage: result?.usage || null,
        imageBased
      });
    } catch (parseError) {
      console.error('JSON parsing error:', parseError.message);
      console.error('Parse error stack:', parseError.stack);
      console.error('Raw AI Response (first 1000 chars):', response.substring(0, 1000));
      console.error('Raw AI Response length:', response.length);

      const extractedJson = extractFirstJsonObject(response);
      if (extractedJson && extractedJson !== response) {
        try {
          return parseMarkingResponsePayload(extractedJson, {
            selectedProvider,
            usage: result?.usage || null,
            imageBased
          });
        } catch (extractError) {
          console.error('Failed to parse extracted JSON candidate:', extractError.message);
        }
      }

      throw new Error('Failed to parse AI response as JSON: ' + parseError.message);
    }
  } catch (error) {
    console.error(`❌ ${error.provider || 'AI'} API error:`, error);
    console.error('Error details:', {
      message: error.message,
      status: error.status || error.statusCode,
      type: error.type,
      code: error.code
    });
    throw new Error('Failed to generate marking with AI');
  }
};

const ANCHOR_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'before', 'between', 'could', 'does',
  'doing', 'during', 'each', 'from', 'have', 'having', 'into', 'more', 'most', 'other',
  'over', 'should', 'some', 'such', 'than', 'that', 'their', 'there', 'these', 'they',
  'this', 'those', 'through', 'under', 'very', 'what', 'when', 'where', 'which', 'while',
  'with', 'would', 'your', 'student', 'criterion', 'feedback'
]);

const chunkArray = (items, chunkSize) => {
  const result = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
};

const extractAnchorKeywords = (...values) => {
  const seen = new Set();
  const keywords = [];

  values
    .map((value) => String(value || '').toLowerCase())
    .join(' ')
    .match(/[a-z0-9]{4,}/g)
    ?.forEach((word) => {
      if (seen.has(word) || ANCHOR_STOP_WORDS.has(word)) return;
      seen.add(word);
      keywords.push(word);
    });

  return keywords.slice(0, 12);
};

const getDocumentAnchorCandidates = (documentText) => {
  const rawSegments = String(documentText || '')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;:])\s+/))
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment.length >= 20 && segment.length <= 160);

  const unique = [];
  const seen = new Set();
  for (const segment of rawSegments) {
    const normalized = segment.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(segment);
    if (unique.length >= 500) break;
  }

  return unique;
};

const buildHeuristicAnchorsMap = (documentText, markingResult) => {
  const candidates = getDocumentAnchorCandidates(documentText);
  const map = new Map();

  for (const score of markingResult?.scores || []) {
    const keywords = extractAnchorKeywords(score.criterion_name, score.feedback);
    if (keywords.length === 0) continue;

    const ranked = candidates
      .map((candidate) => {
        const lower = candidate.toLowerCase();
        const keywordHits = keywords.reduce((sum, keyword) => sum + (lower.includes(keyword) ? 1 : 0), 0);
        const phraseBoost = lower.includes(String(score.criterion_name || '').toLowerCase()) ? 1 : 0;
        const scoreValue = keywordHits * 10 + phraseBoost - Math.abs(candidate.length - 90) / 40;
        return { candidate, scoreValue };
      })
      .filter((item) => item.scoreValue > 0)
      .sort((a, b) => b.scoreValue - a.scoreValue)
      .slice(0, 3)
      .map((item) => item.candidate);

    if (ranked.length > 0) {
      map.set(score.criterion_name, ranked);
    }
  }

  return map;
};

// Generate short anchor quotes from the document for each criterion to enable pinpoint annotations
const generateAnchorPhrases = async (documentText, markingResult, documentType = 'treatise') => {
  const heuristicAnchors = buildHeuristicAnchorsMap(documentText, markingResult);

  try {
    const config = aiConfig.getConfig(documentType);

    // Keep this call small to avoid extra costs and TPM issues
    const maxEssayChars = Math.min(4000, documentText?.length || 0);
    const essaySnippet = documentText?.substring(0, maxEssayChars) || '';

    const compactScores = (markingResult?.scores || []).map(s => ({
      criterion_name: s.criterion_name,
      feedback: (s.feedback || '').slice(0, 220)
    }));

    const map = new Map();
    const anchorConfig = aiConfig.getTaskConfig('anchorExtraction', config.provider);
    const scoreChunks = chunkArray(compactScores, 6);

    for (const scoreChunk of scoreChunks) {
      const anchorPrompt = `Return exact anchor quotes for PDF comments.
Use only the excerpt below.
For each criterion, return up to 2 exact quotes copied verbatim from the excerpt.
Each quote must be 8 to 120 characters.
Return JSON only:
{"anchors":[{"criterion_name":"...","quotes":["exact quote"]}]}

EXCERPT:
${essaySnippet}

CRITERIA:
${JSON.stringify(scoreChunk)}`;

      const result = await aiService.createCompletionWithRetry({
        provider: anchorConfig.provider,
        model: anchorConfig.model,
        messages: [{ role: 'user', content: anchorPrompt }],
        temperature: anchorConfig.temperature,
        maxTokens: anchorConfig.maxTokens
      }, 2);

      const raw = result.content || '';
      const parsed = parseAiJsonResponse(raw).parsed;
      for (const item of parsed.anchors || []) {
        if (!item?.criterion_name || !Array.isArray(item.quotes)) continue;
        const filteredQuotes = item.quotes.filter((q) => typeof q === 'string' && q.length >= 8 && q.length <= 160);
        if (filteredQuotes.length > 0) {
          map.set(item.criterion_name, filteredQuotes.slice(0, 2));
        }
      }
    }

    for (const [criterionName, quotes] of heuristicAnchors.entries()) {
      if (!map.has(criterionName) && quotes.length > 0) {
        map.set(criterionName, quotes);
      }
    }

    return map;
  } catch (error) {
    console.warn('Anchor phrase generation failed (non-fatal):', error.message);
    return heuristicAnchors;
  }
};

function buildIssuesWithAnchors(markingResult, anchorsMap) {
  if (!(anchorsMap && anchorsMap.size)) {
    return buildIssuesFromMarking(markingResult);
  }
  const issues = [];
  for (const s of markingResult.scores || []) {
    const note = `${s.criterion_name}: ${s.feedback}`;
    const anchorPhrases = anchorsMap.get(s.criterion_name) || [];
    if (anchorPhrases.length === 0) {
      // fallback heuristic
      const fallback = buildIssuesFromMarking({ scores: [s] });
      issues.push(...fallback);
    } else {
      issues.push({ anchorPhrases, note });
    }
  }
  return issues;
}

// Mark a single assignment
router.post('/single', requireAuth, async (req, res) => {
  try {
    const { assignment_id, rubric_id, student_name, document_type, output_type = 'annotate', assessment_type, level, provider, strictness_level = 'strict', mark_as_image = false } = req.body;

    if (!assignment_id || !rubric_id) {
      return res.status(400).json({ 
        error: 'Missing required fields: assignment_id, rubric_id' 
      });
    }

    // Get assignment details
    const assignmentResult = await query(
      'SELECT * FROM assignments WHERE id = ?',
      [assignment_id]
    );

    // Handle different database result formats
    let assignment;
    if (Array.isArray(assignmentResult)) {
      assignment = assignmentResult[0];
    } else if (assignmentResult.rows && Array.isArray(assignmentResult.rows)) {
      assignment = assignmentResult.rows[0];
    } else {
      return res.status(404).json({ error: 'Assignment not found - unexpected result format' });
    }

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Get rubric details (scoped to current user)
    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    );

    // Handle different database result formats
    let rubric;
    if (Array.isArray(rubricResult)) {
      rubric = rubricResult[0];
    } else if (rubricResult.rows && Array.isArray(rubricResult.rows)) {
      rubric = rubricResult.rows[0];
    } else {
      return res.status(404).json({ error: 'Rubric not found - unexpected result format' });
    }

    if (!rubric) {
      return res.status(404).json({ error: 'Rubric not found' });
    }

    // Criteria should now be properly parsed as an object by MySQL typeCast
    // No additional parsing needed

    // Check again before processing
    if (checkAborted()) {
      return res.status(499).json({
        success: false,
        cancelled: true,
        message: 'Marking request was cancelled'
      });
    }

    // Update assignment status to processing
    await query(
      'UPDATE assignments SET status = ? WHERE id = ?',
      ['processing', assignment_id]
    );

    try {
      // Check before PDF extraction
      if (checkAborted()) {
        await query(
          'UPDATE assignments SET status = ? WHERE id = ?',
          ['uploaded', assignment_id]
        );
        return res.status(499).json({
          success: false,
          cancelled: true,
          message: 'Marking request was cancelled'
        });
      }

      let assignmentText = '';
      let assignmentImages = null;

      if (mark_as_image) {
        const { base64Images, lastError } = await getPdfPageImages(assignment.file_path, 15);
        if (!base64Images || base64Images.length === 0) {
          if (lastError) {
            console.error('Mark-as-image conversion failed. Detail:', lastError);
          }
          const detail = lastError ? ` ${lastError}` : ' Check PM2 logs for "PDF→image" or "Mark-as-image" for the real error.';
          throw new Error(
            'Could not convert PDF to images. Install ImageMagick and Ghostscript (e.g. apt install imagemagick ghostscript), then allow PDF in policy.xml. See docs/PDF-TO-IMAGE-TROUBLESHOOTING.md.' + detail
          );
        }
        assignmentImages = base64Images;
      } else {
        assignmentText = await extractTextFromPDF(assignment.file_path);
        if (!assignmentText || assignmentText.trim().length === 0) {
          throw new Error('No text could be extracted from the PDF');
        }
      }

      // Check before AI marking
      if (checkAborted()) {
        await query(
          'UPDATE assignments SET status = ? WHERE id = ?',
          ['uploaded', assignment_id]
        );
        return res.status(499).json({
          success: false,
          cancelled: true,
          message: 'Marking request was cancelled'
        });
      }

      // Generate AI marking (use assessment_type if provided, otherwise auto-detect document type)
      const docType = assessment_type || document_type || null;
      const markingResult = await generateMarking(assignmentText, rubric, docType, level, provider, strictness_level, assignment_id, assignmentImages);
      
      // Check after AI marking
      if (checkAborted()) {
        await query(
          'UPDATE assignments SET status = ? WHERE id = ?',
          ['uploaded', assignment_id]
        );
        return res.status(499).json({
          success: false,
          cancelled: true,
          message: 'Marking request was cancelled after marking'
        });
      }

      // Get current version number for this assignment
      const versionResult = await query(
        'SELECT COALESCE(MAX(version), 0) as max_version FROM marking_results WHERE assignment_id = ?',
        [assignment_id]
      );
      const maxVersion = versionResult.rows?.[0]?.max_version || versionResult?.[0]?.max_version || 0;
      const newVersion = maxVersion + 1;

      // Mark all previous versions as not current
      await query(
        'UPDATE marking_results SET is_current = 0 WHERE assignment_id = ? AND user_id = ?',
        [assignment_id, req.user.id]
      );

      const usage = markingResult.usage || {};
      const estimatedCostUsd = markingResult.estimated_cost_usd != null ? markingResult.estimated_cost_usd : null;
      // Save marking result to database with version info
      const result = await query(
        'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current, strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          assignment_id,
          rubric_id,
          student_name || null,
          JSON.stringify(markingResult.scores),
          markingResult.overall_feedback,
          markingResult.total_score,
          newVersion,
          1, // is_current
          strictness_level,
          provider || null,
          markingResult.corrections && markingResult.corrections.length > 0 ? JSON.stringify(markingResult.corrections) : null,
          markingResult.language_errors && markingResult.language_errors.length > 0 ? JSON.stringify(markingResult.language_errors) : null,
          markingResult.handwriting_recognition_confidence != null ? markingResult.handwriting_recognition_confidence : null,
          usage.prompt_tokens != null ? usage.prompt_tokens : null,
          usage.completion_tokens != null ? usage.completion_tokens : null,
          usage.total_tokens != null ? usage.total_tokens : null,
          estimatedCostUsd,
          req.user.id
        ]
      );
      
      // Get the last inserted ID
      const insertedId = result.lastID || result.rows?.[0]?.id;
      const markingWithId = {
        id: insertedId,
        assignment_id,
        rubric_id,
        student_name: student_name || null,
        scores: markingResult.scores,
        feedback: markingResult.overall_feedback,
        total_score: markingResult.total_score,
        marked_at: new Date().toISOString(),
        version: newVersion,
        is_current: true,
        strictness_level: strictness_level,
        provider: provider || null,
        overall_confidence: markingResult.overall_confidence,
        confidence_level: markingResult.confidence_level,
        needs_review: markingResult.needs_review,
        min_criterion_confidence: markingResult.min_criterion_confidence,
        has_low_criterion_confidence: markingResult.has_low_criterion_confidence,
        handwriting_recognition_confidence: markingResult.handwriting_recognition_confidence ?? null,
        corrections: markingResult.corrections || [],
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        estimated_cost_usd: estimatedCostUsd
      };

      // Generate output based on output_type
      if (output_type === 'report') {
        // Generate PDF report
        try {
          const report = await pdfGenerator.generateAssignmentReport(
            markingWithId,
            assignment,
            rubric
          );
          console.log(`✅ PDF report generated: ${report.fileName}`);
          markingWithId.report_path = report.filePath;
        } catch (e) {
          console.warn('Report generation failed (non-fatal):', e.message);
        }
      } else {
        // Attempt advanced PDF annotation (best-effort, non-blocking)
        try {
          console.log('📝 Starting PDF annotation process...');
          // Generate anchor phrases via a small follow-up call (limited tokens)
          const config = aiConfig.getConfig(documentType || 'treatise');
          const estimateTokens = (text) => Math.ceil((text?.length || 0) / 4);
          const tpmLimit = 30000;
          const requestMaxTokens = Math.min(config.maxTokens, 6000);
          const promptBudgetTokens = Math.max(1000, tpmLimit - requestMaxTokens - 1000);
          const maxPromptCharsByTPM = promptBudgetTokens * 4;
          const maxAllowedChars = Math.min(config.maxTextLength, maxPromptCharsByTPM, 8000);
          const essayForAnchors = assignmentText.length > maxAllowedChars ? assignmentText.substring(0, maxAllowedChars) : assignmentText;
          
          console.log('🔍 Generating anchor phrases...');
          const anchorsMap = await generateAnchorPhrases(essayForAnchors, markingResult, documentType || 'treatise');
          console.log('✅ Anchor phrases generated:', Object.keys(anchorsMap || {}).length, 'criteria');
          
          console.log('🔨 Building issues from marking result...');
          const issues = buildIssuesWithAnchors(markingResult, anchorsMap);
          console.log('✅ Issues built:', issues.length, 'issues');
          
          const originalPath = assignment.file_path;
          const annotatedPath = originalPath.replace(/\.pdf$/i, '.annotated.pdf');
          
          // Ensure the directory exists
          const path = require('path');
          const fs = require('fs');
          const annotatedDir = path.dirname(annotatedPath);
          if (!fs.existsSync(annotatedDir)) {
            fs.mkdirSync(annotatedDir, { recursive: true });
          }
          
          console.log('📄 Annotating PDF:', originalPath, '->', annotatedPath);
          await annotatePdfWithIssues(originalPath, annotatedPath, issues);
          
          // Verify the file was created
          if (fs.existsSync(annotatedPath)) {
            const stats = fs.statSync(annotatedPath);
            console.log(`✅ PDF annotated successfully: ${annotatedPath} (${stats.size} bytes)`);
            markingWithId.annotated_pdf_path = annotatedPath;
          } else {
            console.error('❌ Annotated PDF file was not created:', annotatedPath);
            throw new Error('Annotated PDF file was not created');
          }
        } catch (e) {
          console.error('❌ Annotation failed:', e.message);
          console.error('Stack trace:', e.stack);
          // Don't fail the entire marking process, but log the error clearly
          markingWithId.annotation_error = e.message;
        }
      }

      // Update assignment status to completed
      await query(
        'UPDATE assignments SET status = ? WHERE id = ?',
        ['completed', assignment_id]
      );

      res.json({
        success: true,
        result: markingWithId,
        message: 'Assignment marked successfully'
      });
    } catch (processingError) {
      // Keep assignment as uploaded so user can retry without re-uploading
      await query(
        'UPDATE assignments SET status = ? WHERE id = ?',
        ['uploaded', assignment_id]
      );
      
      throw processingError;
    }
  } catch (error) {
    console.error('Marking error:', error);
    res.status(500).json({ 
      error: 'Failed to mark assignment',
      details: error.message
    });
  }
});

// Manual marking endpoint - no AI required
router.post('/manual', async (req, res) => {
  try {
    const { assignment_id, rubric_id, student_name, scores, overall_feedback } = req.body;

    if (!assignment_id || !rubric_id || !scores) {
      return res.status(400).json({ 
        error: 'Missing required fields: assignment_id, rubric_id, scores' 
      });
    }

    // Get assignment details
    const assignmentResult = await query(
      'SELECT * FROM assignments WHERE id = ?',
      [assignment_id]
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = assignmentResult.rows[0];

    // Get rubric details (scoped to current user)
    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    );

    if (rubricResult.rows.length === 0) {
      return res.status(404).json({ error: 'Rubric not found' });
    }

    const rubric = rubricResult.rows[0];

    // Validate scores structure
    if (!Array.isArray(scores)) {
      return res.status(400).json({ error: 'Scores must be an array' });
    }

    // Calculate total score
    const total_score = scores.reduce((sum, score) => {
      return sum + (score.points_awarded || 0);
    }, 0);

    // Validate total score doesn't exceed rubric total
    if (total_score > rubric.total_points) {
      return res.status(400).json({ 
        error: `Total score (${total_score}) cannot exceed rubric total points (${rubric.total_points})` 
      });
    }

    // Update assignment status to processing
    await query(
      'UPDATE assignments SET status = ? WHERE id = ?',
      ['processing', assignment_id]
    );

    try {
      // Save marking result to database
      const result = await query(
        'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          assignment_id,
          rubric_id,
          student_name || null,
          JSON.stringify(scores),
          overall_feedback || 'Manual marking completed',
          total_score,
          req.user.id
        ]
      );
      
      // Get the inserted ID
      const insertedId = result.lastID || result.rows?.[0]?.id;
      const markingWithId = {
        id: insertedId,
        assignment_id,
        rubric_id,
        student_name: student_name || null,
        scores: scores,
        feedback: overall_feedback || 'Manual marking completed',
        total_score: total_score,
        marked_at: new Date().toISOString()
      };

      // Update assignment status to completed
      await query(
        'UPDATE assignments SET status = ? WHERE id = ?',
        ['completed', assignment_id]
      );

      res.json({
        success: true,
        result: markingWithId,
        message: 'Assignment marked successfully (manual)'
      });
    } catch (processingError) {
      // Keep assignment as uploaded so user can retry without re-uploading
      await query(
        'UPDATE assignments SET status = ? WHERE id = ?',
        ['uploaded', assignment_id]
      );
      
      throw processingError;
    }
  } catch (error) {
    console.error('Manual marking error:', error);
    res.status(500).json({ 
      error: 'Failed to mark assignment manually',
      details: error.message
    });
  }
});

// Get rubric details for manual marking
router.get('/rubric/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );

    if (rubricResult.rows.length === 0) {
      return res.status(404).json({ error: 'Rubric not found' });
    }

    const rubric = rubricResult.rows[0];
    
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
    res.status(500).json({ 
      error: 'Failed to get rubric',
      details: error.message
    });
  }
});

// Mark multiple assignments
router.post('/multiple', requireAuth, async (req, res) => {
  try {
    const { assignment_ids, rubric_id, student_names, document_type, output_type = 'annotate', assessment_type, level, provider, strictness_level = 'strict', mark_as_image = false } = req.body;

    if (!assignment_ids || !Array.isArray(assignment_ids) || assignment_ids.length === 0) {
      return res.status(400).json({ 
        error: 'Missing or invalid assignment_ids array' 
      });
    }

    if (!rubric_id) {
      return res.status(400).json({ 
        error: 'Missing required field: rubric_id' 
      });
    }

    // Get rubric details (scoped to current user)
    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    );

    // Handle different database result formats
    let rubric;
    if (Array.isArray(rubricResult)) {
      rubric = rubricResult[0];
    } else if (rubricResult.rows && Array.isArray(rubricResult.rows)) {
      rubric = rubricResult.rows[0];
    } else {
      return res.status(404).json({ error: 'Rubric not found - unexpected result format' });
    }

    if (!rubric) {
      return res.status(404).json({ error: 'Rubric not found' });
    }
    
    // Criteria should now be properly parsed as an object by MySQL typeCast
    // No additional parsing needed
    
    const results = [];
    const errors = [];
    const skipped = []; // Track assignments that were already successfully marked

    // Helper function to check if request was aborted
    const checkAborted = () => {
      if (req.aborted || req.socket.destroyed) {
        return true;
      }
      return false;
    };

    // Process each assignment
    for (let i = 0; i < assignment_ids.length; i++) {
      // Check if request was cancelled before processing next assignment
      if (checkAborted()) {
        console.log('⚠️  Marking request was cancelled by client');
        // Reset any assignments that were set to processing but not completed
        for (let j = i; j < assignment_ids.length; j++) {
          const remainingId = assignment_ids[j];
          try {
            const statusCheck = await query(
              'SELECT status FROM assignments WHERE id = ?',
              [remainingId]
            );
            const status = Array.isArray(statusCheck) 
              ? statusCheck[0]?.status 
              : (statusCheck.rows?.[0]?.status || statusCheck?.[0]?.status);
            if (status === 'processing') {
              await query(
                'UPDATE assignments SET status = ? WHERE id = ?',
                ['uploaded', remainingId]
              );
            }
          } catch (cleanupErr) {
            console.error(`Error cleaning up assignment ${remainingId}:`, cleanupErr);
          }
        }
        return res.status(499).json({
          success: false,
          cancelled: true,
          message: 'Marking request was cancelled',
          results: results,
          errors: errors,
          skipped: skipped,
          processed: i,
          total: assignment_ids.length
        });
      }

      const assignment_id = assignment_ids[i];
      const student_name = student_names && student_names[i] ? student_names[i] : null;

      try {
        // Get assignment details (only user's assignments)
        const assignmentResult = await query(
          'SELECT * FROM assignments WHERE id = ? AND user_id = ?',
          [assignment_id, req.user.id]
        );

        // Handle different database result formats
        let assignment;
        if (Array.isArray(assignmentResult)) {
          assignment = assignmentResult[0];
        } else if (assignmentResult.rows && Array.isArray(assignmentResult.rows)) {
          assignment = assignmentResult.rows[0];
        } else {
          errors.push({ assignment_id, error: 'Assignment not found - unexpected result format' });
          continue;
        }

        if (!assignment) {
          errors.push({ assignment_id, error: 'Assignment not found' });
          continue;
        }

        // Check again before starting processing
        if (checkAborted()) {
          console.log(`⚠️  Request cancelled before processing assignment ${assignment_id}`);
          errors.push({ assignment_id, error: 'Request was cancelled' });
          continue;
        }

        // Update assignment status to processing
        await query(
          'UPDATE assignments SET status = ? WHERE id = ?',
          ['processing', assignment_id]
        );

        try {
          // Check before PDF extraction
          if (checkAborted()) {
            await query(
              'UPDATE assignments SET status = ? WHERE id = ?',
              ['uploaded', assignment_id]
            );
            errors.push({ assignment_id, error: 'Request was cancelled' });
            continue;
          }

          let assignmentText = '';
          let assignmentImages = null;

          if (mark_as_image) {
            const { base64Images, lastError } = await getPdfPageImages(assignment.file_path, 15);
            if (!base64Images || base64Images.length === 0) {
              if (lastError) {
                console.error('Mark-as-image conversion failed. Detail:', lastError);
              }
              const detail = lastError ? ` ${lastError}` : ' Check PM2 logs for "PDF→image" or "Mark-as-image" for the real error.';
              throw new Error(
                'Could not convert PDF to images. Install ImageMagick and Ghostscript (e.g. apt install imagemagick ghostscript), then allow PDF in policy.xml. See docs/PDF-TO-IMAGE-TROUBLESHOOTING.md.' + detail
              );
            }
            assignmentImages = base64Images;
          } else {
            assignmentText = await extractTextFromPDF(assignment.file_path);
            if (!assignmentText || assignmentText.trim().length === 0) {
              throw new Error('No text could be extracted from the PDF');
            }
          }

          // Check before AI marking (this is the longest operation)
          if (checkAborted()) {
            await query(
              'UPDATE assignments SET status = ? WHERE id = ?',
              ['uploaded', assignment_id]
            );
            errors.push({ assignment_id, error: 'Request was cancelled' });
            continue;
          }

          const docType = assessment_type || document_type || null;
          const markingResult = await generateMarking(assignmentText, rubric, docType, level, provider, strictness_level, assignment_id, assignmentImages);
          
          // Check after AI marking (in case it took a long time)
          if (checkAborted()) {
            await query(
              'UPDATE assignments SET status = ? WHERE id = ?',
              ['uploaded', assignment_id]
            );
            errors.push({ assignment_id, error: 'Request was cancelled after marking' });
            continue;
          }

          // Get current version number for this assignment
          const versionResult = await query(
            'SELECT COALESCE(MAX(version), 0) as max_version FROM marking_results WHERE assignment_id = ? AND user_id = ?',
            [assignment_id, req.user.id]
          );
          const maxVersion = versionResult.rows?.[0]?.max_version || versionResult?.[0]?.max_version || 0;
          const newVersion = maxVersion + 1;

          // Mark all previous versions as not current
          await query(
            'UPDATE marking_results SET is_current = 0 WHERE assignment_id = ? AND user_id = ?',
            [assignment_id, req.user.id]
          );

          const usageBatch = markingResult.usage || {};
          const estimatedCostUsdBatch = markingResult.estimated_cost_usd != null ? markingResult.estimated_cost_usd : null;
          // Save marking result to database with version info
          const result = await query(
            'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current, strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              assignment_id,
              rubric_id,
              student_name,
              JSON.stringify(markingResult.scores),
              markingResult.overall_feedback,
              markingResult.total_score,
              newVersion,
              1, // is_current
              strictness_level,
              provider || null,
              markingResult.corrections && markingResult.corrections.length > 0 ? JSON.stringify(markingResult.corrections) : null,
              markingResult.language_errors && markingResult.language_errors.length > 0 ? JSON.stringify(markingResult.language_errors) : null,
              markingResult.handwriting_recognition_confidence != null ? markingResult.handwriting_recognition_confidence : null,
              usageBatch.prompt_tokens != null ? usageBatch.prompt_tokens : null,
              usageBatch.completion_tokens != null ? usageBatch.completion_tokens : null,
              usageBatch.total_tokens != null ? usageBatch.total_tokens : null,
              estimatedCostUsdBatch,
              req.user.id
            ]
          );
          
          // Get the last inserted ID
          const insertedId = result.lastID || result.rows?.[0]?.id;
          const markingWithId = {
            id: insertedId,
            assignment_id,
            rubric_id,
            student_name: student_name,
            scores: markingResult.scores,
            feedback: markingResult.overall_feedback,
            total_score: markingResult.total_score,
            marked_at: new Date().toISOString(),
            version: newVersion,
            is_current: true,
            strictness_level: strictness_level,
            provider: provider || null,
            overall_confidence: markingResult.overall_confidence,
            confidence_level: markingResult.confidence_level,
            needs_review: markingResult.needs_review,
            min_criterion_confidence: markingResult.min_criterion_confidence,
            has_low_criterion_confidence: markingResult.has_low_criterion_confidence,
            handwriting_recognition_confidence: markingResult.handwriting_recognition_confidence ?? null,
            corrections: markingResult.corrections || [],
            prompt_tokens: usageBatch.prompt_tokens ?? null,
            completion_tokens: usageBatch.completion_tokens ?? null,
            total_tokens: usageBatch.total_tokens ?? null,
            estimated_cost_usd: estimatedCostUsdBatch
          };

          // Generate output based on output_type
          if (output_type === 'report') {
            // Generate PDF report
            try {
              const report = await pdfGenerator.generateAssignmentReport(
                markingWithId,
                assignment,
                rubric
              );
              console.log(`✅ PDF report generated: ${report.fileName}`);
              markingWithId.report_path = report.filePath;
            } catch (e) {
              console.warn('Report generation failed (non-fatal):', e.message);
            }
          } else {
            // Attempt advanced PDF annotation (best-effort, non-blocking)
            try {
              console.log(`📝 Starting PDF annotation for assignment ${assignment_id}...`);
              const docType = assessment_type || document_type || 'treatise';
              const config = aiConfig.getConfig(docType);
              const tpmLimit = 30000;
              const requestMaxTokens = Math.min(config.maxTokens, 6000);
              const promptBudgetTokens = Math.max(1000, tpmLimit - requestMaxTokens - 1000);
              const maxPromptCharsByTPM = promptBudgetTokens * 4;
              const maxAllowedChars = Math.min(config.maxTextLength, maxPromptCharsByTPM, 8000);
              const essayForAnchors = assignmentText.length > maxAllowedChars ? assignmentText.substring(0, maxAllowedChars) : assignmentText;
              
              console.log('🔍 Generating anchor phrases...');
              const anchorsMap = await generateAnchorPhrases(essayForAnchors, markingResult, docType);
              console.log('✅ Anchor phrases generated:', Object.keys(anchorsMap || {}).length, 'criteria');
              
              console.log('🔨 Building issues from marking result...');
              const issues = buildIssuesWithAnchors(markingResult, anchorsMap);
              console.log('✅ Issues built:', issues.length, 'issues');
              
              const originalPath = assignment.file_path;
              const annotatedPath = originalPath.replace(/\.pdf$/i, '.annotated.pdf');
              
              // Ensure the directory exists
              const path = require('path');
              const fs = require('fs');
              const annotatedDir = path.dirname(annotatedPath);
              if (!fs.existsSync(annotatedDir)) {
                fs.mkdirSync(annotatedDir, { recursive: true });
              }
              
              console.log('📄 Annotating PDF:', originalPath, '->', annotatedPath);
              await annotatePdfWithIssues(originalPath, annotatedPath, issues);
              
              // Verify the file was created
              if (fs.existsSync(annotatedPath)) {
                const stats = fs.statSync(annotatedPath);
                console.log(`✅ PDF annotated successfully: ${annotatedPath} (${stats.size} bytes)`);
                markingWithId.annotated_pdf_path = annotatedPath;
              } else {
                console.error('❌ Annotated PDF file was not created:', annotatedPath);
                throw new Error('Annotated PDF file was not created');
              }
            } catch (e) {
              console.error(`❌ Annotation failed for assignment ${assignment_id}:`, e.message);
              console.error('Stack trace:', e.stack);
              // Don't fail the entire marking process, but log the error clearly
              markingWithId.annotation_error = e.message;
            }
          }

          // Update assignment status to completed
          await query(
            'UPDATE assignments SET status = ? WHERE id = ?',
            ['completed', assignment_id]
          );

          results.push(markingWithId);
        } catch (processingError) {
          // Keep assignment as uploaded so user can retry without re-uploading
          await query(
            'UPDATE assignments SET status = ? WHERE id = ?',
            ['uploaded', assignment_id]
          );
          
          const errorDetails = {
            assignment_id,
            error: processingError.message,
            error_type: processingError.name || 'UnknownError',
            stack: process.env.NODE_ENV === 'development' ? processingError.stack : undefined
          };
          
          errors.push(errorDetails);
          console.error(`Error marking assignment ${assignment_id}:`, processingError);
        }
      } catch (error) {
        // Keep assignment as uploaded so user can retry without re-uploading
        await query(
          'UPDATE assignments SET status = ? WHERE id = ?',
          ['uploaded', assignment_id]
        );
        
        const errorDetails = {
          assignment_id,
          error: error.message,
          error_type: error.name || 'UnknownError',
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        };
        
        errors.push(errorDetails);
        console.error(`Error processing assignment ${assignment_id}:`, error);
      }
    }

    // Determine overall success status
    const hasPartialSuccess = results.length > 0 && errors.length > 0;
    const allFailed = results.length === 0 && errors.length > 0;
    const allSucceeded = results.length > 0 && errors.length === 0;

    res.json({
      success: allSucceeded || hasPartialSuccess,
      results,
      errors,
      summary: {
        total: assignment_ids.length,
        successful: results.length,
        failed: errors.length,
        success_rate: ((results.length / assignment_ids.length) * 100).toFixed(1) + '%'
      },
      message: allSucceeded 
        ? `Successfully marked all ${results.length} assignments`
        : hasPartialSuccess
        ? `Partially successful: ${results.length} succeeded, ${errors.length} failed`
        : `All assignments failed. ${errors.length} errors occurred.`,
      failed_assignment_ids: errors.map(e => e.assignment_id) // For easy retry
    });
  } catch (error) {
    console.error('Multiple marking error:', error);
    res.status(500).json({ 
      error: 'Failed to mark assignments',
      details: error.message
    });
  }
});

// Get marking history for an assignment
router.get('/history/:assignment_id', async (req, res) => {
  try {
    const { assignment_id } = req.params;

    const result = await query(
      'SELECT * FROM marking_results WHERE assignment_id = ? ORDER BY version DESC',
      [assignment_id]
    );

    const history = result.rows.map(row => ({
      ...row,
      scores: typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores,
      corrections: row.corrections ? (typeof row.corrections === 'string' ? JSON.parse(row.corrections) : row.corrections) : [],
      is_current: row.is_current === 1 || row.is_current === true
    }));

    res.json({
      success: true,
      history: history
    });
  } catch (error) {
    console.error('Get marking history error:', error);
    res.status(500).json({ 
      error: 'Failed to get marking history',
      details: error.message
    });
  }
});

// Restore a previous marking version (make it current)
router.post('/history/:result_id/restore', async (req, res) => {
  try {
    const { result_id } = req.params;

    // Get the result to find its assignment_id
    const resultQuery = await query(
      'SELECT assignment_id FROM marking_results WHERE id = ?',
      [result_id]
    );

    if (!resultQuery.rows || resultQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Marking result not found' });
    }

    const assignment_id = resultQuery.rows[0].assignment_id;

    // Mark all versions as not current
    await query(
      'UPDATE marking_results SET is_current = 0 WHERE assignment_id = ?',
      [assignment_id]
    );

    // Mark the selected version as current
    await query(
      'UPDATE marking_results SET is_current = 1 WHERE id = ?',
      [result_id]
    );

    res.json({
      success: true,
      message: 'Marking version restored successfully'
    });
  } catch (error) {
    console.error('Restore marking version error:', error);
    res.status(500).json({ 
      error: 'Failed to restore marking version',
      details: error.message
    });
  }
});

// Compare two marking versions
router.get('/history/compare/:result_id1/:result_id2', requireAuth, async (req, res) => {
  try {
    const { result_id1, result_id2 } = req.params;

    const [result1, result2] = await Promise.all([
      query('SELECT * FROM marking_results WHERE id = ? AND user_id = ?', [result_id1, req.user.id]),
      query('SELECT * FROM marking_results WHERE id = ? AND user_id = ?', [result_id2, req.user.id])
    ]);

    if (!result1.rows || result1.rows.length === 0 || !result2.rows || result2.rows.length === 0) {
      return res.status(404).json({ error: 'One or both marking results not found' });
    }

    let scores1, scores2;
    try {
      scores1 = typeof result1.rows[0].scores === 'string' ? JSON.parse(result1.rows[0].scores) : result1.rows[0].scores;
      scores2 = typeof result2.rows[0].scores === 'string' ? JSON.parse(result2.rows[0].scores) : result2.rows[0].scores;
    } catch (parseError) {
      return res.status(500).json({ error: 'Failed to parse scores data' });
    }

    const version1 = { ...result1.rows[0], scores: scores1 };
    const version2 = { ...result2.rows[0], scores: scores2 };

    res.json({
      success: true,
      version1,
      version2,
      differences: {
        total_score_diff: version1.total_score - version2.total_score,
        score_differences: version1.scores.map((s1, idx) => {
          const s2 = version2.scores[idx];
          return {
            criterion_name: s1.criterion_name,
            version1_points: s1.points_awarded,
            version2_points: s2?.points_awarded || 0,
            difference: (s1.points_awarded || 0) - (s2?.points_awarded || 0)
          };
        })
      }
    });
  } catch (error) {
    console.error('Compare marking versions error:', error);
    res.status(500).json({ 
      error: 'Failed to compare marking versions',
      details: error.message
    });
  }
});

module.exports = router;
module.exports.generateMarking = generateMarking;
module.exports.parseMarkingResponsePayload = parseMarkingResponsePayload;

