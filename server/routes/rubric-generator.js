const express = require('express');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { query } = require('../database/connection');
const { requireAuth } = require('../middleware/auth');
const aiService = require('../services/aiService');
const aiConfig = require('../config/ai-config');

const router = express.Router();

/**
 * Sanitize JSON string by fixing common issues with control characters
 * This attempts to fix unescaped newlines, tabs, and other control characters
 */
function sanitizeJSONString(jsonString) {
  try {
    // First, try to extract just the JSON object
    let cleaned = jsonString.trim();
    
    // Remove markdown code blocks if present
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```\s*$/, '');
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```\s*$/, '');
    }
    
    // Extract JSON object if there's extra text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
    
    // Fix unescaped control characters in string values
    // We need to be careful to only escape within string values, not the JSON structure
    let fixed = cleaned;
    let inString = false;
    let escapeNext = false;
    let result = '';
    
    for (let i = 0; i < fixed.length; i++) {
      const char = fixed[i];
      
      if (escapeNext) {
        result += char;
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        result += char;
        escapeNext = true;
        continue;
      }
      
      if (char === '"') {
        inString = !inString;
        result += char;
        continue;
      }
      
      if (inString) {
        // Inside a string value - escape control characters
        if (char === '\n') {
          result += '\\n';
        } else if (char === '\r') {
          result += '\\r';
        } else if (char === '\t') {
          result += '\\t';
        } else if (char === '\f') {
          result += '\\f';
        } else if (char === '\b') {
          result += '\\b';
        } else if (char.charCodeAt(0) < 32) {
          // Other control characters - escape as unicode
          result += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          result += char;
        }
      } else {
        // Outside string - keep as is
        result += char;
      }
    }
    
    return result;
  } catch (error) {
    // If sanitization fails, return original
    return jsonString;
  }
}

/**
 * Fix common JSON syntax issues
 */
function fixJSONSyntax(jsonString) {
  let fixed = jsonString;
  
  // Remove trailing commas before closing braces/brackets
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  
  // Fix unescaped quotes in string values (but be careful not to break valid JSON)
  // This is a heuristic: look for quotes that aren't escaped and aren't string delimiters
  let result = '';
  let inString = false;
  let escapeNext = false;
  let quoteCount = 0;
  
  for (let i = 0; i < fixed.length; i++) {
    const char = fixed[i];
    const prevChar = i > 0 ? fixed[i - 1] : '';
    
    if (escapeNext) {
      result += char;
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      result += char;
      escapeNext = true;
      continue;
    }
    
    if (char === '"') {
      // Check if this is a string delimiter or an unescaped quote inside a string
      if (inString && prevChar !== '\\') {
        // This might be an unescaped quote - check context
        // If followed by : or , or } or ], it's likely a string delimiter
        const nextChars = fixed.substring(i + 1, i + 3).trim();
        if (nextChars.startsWith(':') || nextChars.startsWith(',') || 
            nextChars.startsWith('}') || nextChars.startsWith(']') ||
            nextChars === '') {
          // It's a string delimiter
          inString = false;
          result += char;
        } else {
          // It's likely an unescaped quote - escape it
          result += '\\"';
          continue;
        }
      } else {
        // Toggle string state
        inString = !inString;
        result += char;
      }
      quoteCount++;
    } else {
      result += char;
    }
  }
  
  return result;
}

/**
 * Parse JSON with multiple fallback strategies
 */
function parseJSONWithFallback(jsonString) {
  const raw = jsonString != null ? String(jsonString).trim() : '';
  if (!raw || raw.length < 10) {
    throw new Error(
      `AI returned empty or too-short response (length: ${raw.length}). ` +
      `Try again or use a shorter document.`
    );
  }
  let cleaned = sanitizeJSONString(raw);
  
  // Strategy 1: Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.log('⚠️  Initial JSON parse failed, trying fixes...');
    
    // Strategy 2: Fix common syntax issues
    try {
      let fixed = fixJSONSyntax(cleaned);
      return JSON.parse(fixed);
    } catch (error2) {
      console.log('⚠️  Fixed JSON parse failed, trying aggressive extraction...');
      
      // Strategy 3: Try to extract and rebuild JSON structure
      try {
        // Find the main JSON object boundaries
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          let coreJSON = cleaned.substring(firstBrace, lastBrace + 1);
          
          // Try to fix it again
          coreJSON = fixJSONSyntax(coreJSON);
          coreJSON = sanitizeJSONString(coreJSON);
          
          return JSON.parse(coreJSON);
        }
      } catch (error3) {
        // Strategy 4: Try to manually extract key fields if structure is too broken
        try {
          // Extract name
          const nameMatch = cleaned.match(/"name"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
          const name = nameMatch ? nameMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : 'Generated Rubric';
          
          // Extract total_points
          const pointsMatch = cleaned.match(/"total_points"\s*:\s*(\d+)/);
          const totalPoints = pointsMatch ? parseInt(pointsMatch[1], 10) : 100;
          
          // Extract criteria array (simplified)
          const criteriaMatch = cleaned.match(/"criteria"\s*:\s*\[([\s\S]*?)\]/);
          if (criteriaMatch) {
            // Try to parse individual criteria
            const criteriaText = criteriaMatch[1];
            const criteria = [];
            
            // Find individual criterion objects
            const criterionRegex = /\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"max_points"\s*:\s*(\d+)[^}]*"description"\s*:\s*"([^"]*(?:\\.[^"]*)*)"[^}]*\}/g;
            let match;
            while ((match = criterionRegex.exec(criteriaText)) !== null) {
              criteria.push({
                name: match[1],
                max_points: parseInt(match[2], 10),
                description: match[3].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t')
              });
            }
            
            if (criteria.length > 0) {
              console.log('⚠️  Using fallback parsing - extracted', criteria.length, 'criteria');
              return {
                name,
                total_points: totalPoints,
                criteria
              };
            }
          }
        } catch (error4) {
          // All strategies failed
        }
        
        // Log the problematic section
        const errorPos = parseInt(error.message.match(/position (\d+)/)?.[1] || '0', 10);
        const start = Math.max(0, errorPos - 100);
        const end = Math.min(cleaned.length, errorPos + 100);
        const problematicSection = cleaned.substring(start, end);
        
        console.error('❌ JSON parsing failed at position', errorPos);
        console.error('Problematic section:', problematicSection);
        console.error('Full response length:', cleaned.length);
        
        throw new Error(
          `JSON parsing failed after multiple attempts. ` +
          `Error at position ${errorPos}: ${error.message}. ` +
          `Problematic section: ${problematicSection.substring(0, 200)}`
        );
      }
    }
  }
  
  throw new Error('All JSON parsing strategies failed');
}

// Detect document type (question paper, memorandum, treatise, assignment, etc.)
const detectDocumentType = async (documentText) => {
  try {
    const detectionPrompt = `Analyze the following document and determine its type.

Types:
- "question_paper": A test/exam paper that CONTAINS QUESTIONS for students to answer (may have blank space or instructions). It is NOT the marking memo.
- "memo": The document IS a marking memorandum / answer key / marking guidelines. It contains model answers, marking schemes, mark allocations, and "memorandum" or "memo" or "marking guidelines" style content. Use "memo" when the document is the memorandum itself (e.g. "Memorandum", "Marking Guidelines", "Suggested Answers").
- "rubric": A standalone marking rubric or assessment criteria (not a full memo with model answers).
- "treatise": A substantial academic research document (Masters/PhD level).
- "assignment": A course assignment or homework brief.
- "thesis": A doctoral thesis.
- "report": A research report.
- "proposal": A research proposal.

DOCUMENT PREVIEW:
${documentText.substring(0, 2000)}

Respond with ONLY a JSON object:
{
  "document_type": "question_paper" or "memo" or "rubric" or "treatise" or "assignment" or "thesis" or "report" or "proposal",
  "confidence": "high" or "medium" or "low"
}`;

    const config = aiConfig.getConfig('assignment', 'openai');
    const completion = await aiService.createCompletionWithRetry({
      provider: 'openai',
      model: 'gpt-5-mini', // Use mini for detection
      messages: [
        { 
          role: "system", 
          content: "You are a document classifier. Always respond with valid JSON format only, no additional text." 
        },
        { 
          role: "user", 
          content: detectionPrompt 
        }
      ],
      temperature: 0.1,
      maxTokens: 512,
      user: "anonymous"
    });

    let response = completion.content.trim();
    
    const result = parseJSONWithFallback(response);
    console.log('🔍 Document type detection result:', result);
    return result.document_type || 'treatise';
  } catch (error) {
    console.warn('Document type detection failed, defaulting to treatise:', error.message);
    return 'treatise';
  }
};

// Extract text from PDF (with OCR/Vision API fallback for handwritten text)
const extractTextFromPDF = async (filePath) => {
  try {
    const { extractTextFromPDF: extractWithOCR } = require('../services/pdfOCR');
    return await extractWithOCR(filePath, {
      useVisionAPI: true, // Automatically use Vision API if standard extraction fails
      useOCR: false
    });
  } catch (error) {
    console.error('PDF parsing error:', error);
    throw error;
  }
};

// Generate answer key (memo) from question paper
const generateAnswerKeyFromQuestionPaper = async (questionPaperText, rubricName) => {
  try {
    console.log('📝 Generating answer key from question paper...');
    
    // Check if text is empty or too short
    if (!questionPaperText || questionPaperText.trim().length < 50) {
      throw new Error('Question paper text extraction failed or returned insufficient content');
    }
    
    const prompt = `You are an expert educator creating a marking memorandum (answer key) from a question paper. The memorandum provides the answers; your role is to create one grading item per question and to supplement model answers with possible acceptable alternatives for use when marking.

QUESTION PAPER:
${questionPaperText}

Your task:
1. Identify EVERY main question in the document (Question 1, Question 2, Question 3, ...). Create exactly ONE criterion per question. If the assignment has 10 questions, output exactly 10 criteria. Do not merge questions or skip any. Sub-questions (e.g. 1.1, 1.2) can be one criterion per sub-question if they have separate mark allocations, OR one criterion per main question that includes all sub-parts—match how the document allocates marks.
2. Extract the mark allocation EXACTLY as stated (e.g. "Question 1 [10]", "1.1 (3 marks)"). Use only the numbers given in the document.
3. For each criterion:
   - name: the exact question label (e.g. "Question 1", "Question 2")
   - max_points: the exact marks for that question as stated
   - description: Model Answer (the correct answer) AND supplement with "Possible acceptable answers / alternatives:" — list equivalent phrasings, synonyms, or alternative correct answers that markers can credit. Include Marking Scheme (full/partial/no marks). This helps AI and human markers recognise acceptable answers when marking.
4. Set total_points to the document's stated total or the sum of all criterion max_points.

CRITICAL: One grading item per question. 10 questions = 10 criteria. Sum of criterion max_points MUST equal total_points.

Respond with a JSON object in this exact format:
{
  "name": "Answer Key - [Question Paper Name]",
  "criteria": [
    {
      "name": "Question 1",
      "max_points": <exact marks from document>,
      "description": "Model Answer: [Complete correct answer]\n\nPossible acceptable answers / alternatives: [equivalent phrasings or key phrases that can be credited]\n\nMarking Scheme:\n- Full Marks: [what earns full marks]\n- Partial Marks: [what earns partial marks]\n- No/Low Marks: [what earns no or minimal marks]"
    }
  ],
  "total_points": <document total or sum of criteria>
}

IMPORTANT:
- Include "Model Answer", "Marking Scheme", "Correct Answer" in descriptions so the system detects this as a memo.
- For calculations, show worked solutions. For essays, list key points and acceptable alternative formulations.`;

    const config = aiConfig.getConfig('assignment', 'openai');
    const completion = await aiService.createCompletionWithRetry({
      provider: 'openai',
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert educator creating answer keys and marking memorandums. You MUST respond with ONLY a single JSON object. Do not wrap in markdown (no ```json or ```). No explanation or text before or after. Your entire reply must be valid JSON starting with { and ending with }.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2,
      maxTokens: 4000,
      user: 'anonymous'
    });

    const rawContent = completion?.content;
    const response = (rawContent != null ? String(rawContent) : '').trim();
    if (!response || response.length < 20) {
      console.error('❌ AI returned empty or very short response. Length:', response.length);
      console.error('Raw completion keys:', completion ? Object.keys(completion) : 'no completion');
      throw new Error(
        'The AI returned an empty or invalid response. Please try again. If the document is very long, try a shorter section or a different document.'
      );
    }

    try {
      const answerKeyData = parseJSONWithFallback(response);
      
      // Validate the response structure
      if (!answerKeyData.name || !answerKeyData.criteria || !Array.isArray(answerKeyData.criteria)) {
        throw new Error('Invalid response structure: missing name or criteria array');
      }
      
      if (!answerKeyData.total_points || typeof answerKeyData.total_points !== 'number') {
        throw new Error('Invalid response structure: missing or invalid total_points');
      }

      // Validate each criterion
      for (const criterion of answerKeyData.criteria) {
        if (!criterion.name || !criterion.max_points || !criterion.description) {
          throw new Error('Invalid criterion structure: missing name, max_points, or description');
        }
      }

      // Use provided name if available, otherwise ensure it has "Answer Key" or "Memo" in the name
      if (rubricName) {
        answerKeyData.name = rubricName;
      } else if (!answerKeyData.name.toLowerCase().includes('answer key') && 
                 !answerKeyData.name.toLowerCase().includes('memo') &&
                 !answerKeyData.name.toLowerCase().includes('memorandum')) {
        answerKeyData.name = `Answer Key - ${answerKeyData.name}`;
      }

      // Ensure descriptions contain memo keywords for detection
      answerKeyData.criteria = answerKeyData.criteria.map(criterion => {
        if (!criterion.description.toLowerCase().includes('model answer') &&
            !criterion.description.toLowerCase().includes('correct answer') &&
            !criterion.description.toLowerCase().includes('expected answer')) {
          criterion.description = `Model Answer: ${criterion.description}`;
        }
        return criterion;
      });

      // Ensure total_points equals sum of criteria
      const criteriaSum = answerKeyData.criteria.reduce((s, c) => s + (Number(c.max_points) || 0), 0);
      if (criteriaSum > 0) {
        answerKeyData.total_points = criteriaSum;
      }

      console.log('✅ Answer key generated successfully');
      return {
        ...answerKeyData,
        rubric_type: 'answer_key'
      };
    } catch (parseError) {
      console.error('❌ JSON parsing error:', parseError.message);
      console.error('Response length:', response.length);
      console.error('Raw AI Response (first 500 chars):', response.substring(0, 500));
      console.error('Raw AI Response (last 200 chars):', response.length > 200 ? response.slice(-200) : '');
      
      const firstChars = response.substring(0, 200);
      if (parseError.message.includes('Unexpected token') || parseError.message.includes('control character')) {
        throw new Error(`Failed to parse AI response as JSON (invalid format or extra text). First 200 chars: ${firstChars}`);
      }
      if (parseError.message.includes('empty or too-short')) {
        throw new Error('The AI returned an empty or too-short response. Try again or use a shorter document.');
      }
      throw new Error(`Failed to parse AI response as JSON: ${parseError.message}. Try again.`);
    }
  } catch (error) {
    console.error('❌ Answer key generation error:', error);
    if (error.message && (error.message.includes('empty') || error.message.includes('parse AI response'))) {
      throw error;
    }
    throw new Error('Failed to generate answer key with AI. Please try again.');
  }
};

// Extract rubric from a document that IS already a marking memorandum (direct memo from test/assignment)
const extractRubricFromMemo = async (memoText, rubricName) => {
  try {
    console.log('📋 Extracting rubric from existing memorandum...');
    if (!memoText || memoText.trim().length < 50) {
      throw new Error('Memorandum text extraction failed or returned insufficient content');
    }

    const prompt = `The following document IS a marking memorandum / answer key. It provides answers to questions. Your task is to EXTRACT its structure so there is exactly ONE grading item per question, and to SUPPLEMENT the memo's model answers with possible acceptable alternatives for use when marking.

MEMORANDUM DOCUMENT:
${memoText}

Your task:
1. Identify EVERY question in the memorandum (Question 1, Question 2, ...). Create exactly ONE criterion per question. If the memo has 10 questions, output exactly 10 criteria. Do not merge questions or omit any. One grading item per question.
2. For each question, EXTRACT from the document:
   - name: the exact question label as it appears (e.g. "Question 1", "Question 2")
   - max_points: the exact marks for that question as stated
   - description: Extract the model answer and marking scheme from the memo. Preserve the document's wording. Then SUPPLEMENT with "Possible acceptable answers / alternatives:" — add equivalent phrasings, synonyms, or alternative correct answers that markers can credit when marking. Include "Model Answer", "Marking Scheme", or "Correct Answer" so the system recognises this as a memo.
3. Set total_points to the document's stated total (e.g. "TOTAL: 75") or the sum of all criterion max_points.

CRITICAL: One criterion per question. 10 questions = 10 criteria. Sum of criterion max_points MUST equal total_points. Extract the memo's content first; then add brief acceptable alternatives to help marking.

Respond with a JSON object in this exact format:
{
  "name": "Memorandum - [document title or 'Extracted Memo']",
  "criteria": [
    {
      "name": "Question 1",
      "max_points": <exact marks from document>,
      "description": "Model Answer: [extracted from memo]\n\nPossible acceptable answers / alternatives: [equivalent phrasings or key phrases to credit when marking]\n\nMarking Scheme: [extracted from memo]"
    }
  ],
  "total_points": <document total or sum of criteria>
}`;

    const config = aiConfig.getConfig('assignment', 'openai');
    const completion = await aiService.createCompletionWithRetry({
      provider: 'openai',
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'You extract marking memorandums into a rubric. Respond with ONLY a single JSON object. Do not use markdown code blocks. No text before or after. Your entire reply must be valid JSON starting with { and ending with }.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      maxTokens: 4000,
      user: 'anonymous'
    });

    const rawContent = completion?.content;
    const response = (rawContent != null ? String(rawContent) : '').trim();
    if (!response || response.length < 20) {
      console.error('❌ Extract memo: AI returned empty or very short response. Length:', response.length);
      throw new Error('The AI returned an empty or invalid response. Please try again.');
    }
    const rubricData = parseJSONWithFallback(response);

    if (!rubricData.name || !rubricData.criteria || !Array.isArray(rubricData.criteria)) {
      throw new Error('Invalid response structure: missing name or criteria array');
    }
    if (!rubricData.total_points || typeof rubricData.total_points !== 'number') {
      throw new Error('Invalid response structure: missing or invalid total_points');
    }
    for (const criterion of rubricData.criteria) {
      if (!criterion.name || !criterion.max_points || !criterion.description) {
        throw new Error('Invalid criterion structure: missing name, max_points, or description');
      }
    }

    if (rubricName) rubricData.name = rubricName;
    else if (!/memo|memorandum|answer key|marking guideline/i.test(rubricData.name || '')) {
      rubricData.name = `Memorandum - ${rubricData.name || 'Extracted'}`;
    }

    const criteriaSum = rubricData.criteria.reduce((s, c) => s + (Number(c.max_points) || 0), 0);
    if (criteriaSum > 0) rubricData.total_points = criteriaSum;

    rubricData.criteria = rubricData.criteria.map(c => {
      if (!/model answer|correct answer|marking scheme|expected answer/i.test((c.description || ''))) {
        c.description = `Model Answer: ${c.description || ''}`;
      }
      return c;
    });

    console.log('✅ Rubric extracted from memorandum successfully');
    return { ...rubricData, rubric_type: 'answer_key' };
  } catch (error) {
    console.error('❌ Extract from memo error:', error);
    throw new Error(error.message || 'Failed to extract rubric from memorandum');
  }
};

// Generate rubric from PDF content
const generateRubricFromPDF = async (pdfText, rubricName) => {
  try {
    // Debug: Log the extracted text length and first 500 characters
    console.log('PDF text extraction successful!');
    console.log('Extracted text length:', pdfText.length);
    console.log('First 500 characters of extracted text:');
    console.log(pdfText.substring(0, 500));
    console.log('...');
    
    // Check if text is empty or too short
    if (!pdfText || pdfText.trim().length < 50) {
      throw new Error('PDF text extraction failed or returned insufficient content');
    }
    
    const prompt = `
You are an expert educator who creates marking rubrics that EXACTLY match the uploaded document. The rubric MUST give a breakdown BY QUESTION (or by section/part), not by abstract themes.

DOCUMENT CONTENT:
${pdfText}

Your task:
1. BREAKDOWN BY QUESTION: Identify every question, part, or section that has a mark allocation in the document (e.g. "Question 1 (10 marks)", "1.1 [3]", "Question 2 – 20 marks", "Section A – 15"). Create exactly ONE criterion per question/part/section. If the document has 6 questions, output exactly 6 criteria—one per question. Do NOT merge questions into fewer criteria. Do NOT replace question numbers with thematic names.
2. Use the EXACT labels from the document for each criterion name: "Question 1", "Question 2", "1.1", "1.2", "Section A", etc. Do NOT invent criterion names like "Technical Content Accuracy", "Analysis and Application", or "Design of Defence" unless that exact phrase is a question/section heading in the document. When in doubt, use "Question 1", "Question 2", ... with the exact marks per question.
3. For each criterion: name = question/section label from document; max_points = exact marks for that question/part; description = what that question assesses and marking levels (use document wording where present).
4. Set total_points to the document's stated total or the sum of all criterion max_points.

CRITICAL: One grading item per question/part. Sum of criterion max_points MUST equal total_points. Give a breakdown by question, not by abstract criteria.

Respond with a JSON object in this exact format:
{
  "name": "Generated rubric name based on document",
  "criteria": [
    {
      "name": "Question 1",
      "max_points": <exact marks from document>,
      "description": "What this question assesses and marking levels, using document wording where available"
    }
  ],
  "total_points": <document total or sum of criteria>
}
`;

    const config = aiConfig.getConfig('assignment', 'openai');
    const completion = await aiService.createCompletionWithRetry({
      provider: 'openai',
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert educator who creates marking rubrics. You MUST respond with ONLY a single JSON object. Do not use markdown (no ```json or ```). No text before or after. Your entire reply must be valid JSON starting with { and ending with }.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      maxTokens: 2000,
      user: 'anonymous'
    });

    const rawContent = completion?.content;
    const response = (rawContent != null ? String(rawContent) : '').trim();
    if (!response || response.length < 20) {
      console.error('❌ Generate rubric: AI returned empty or very short response. Length:', response.length);
      throw new Error('The AI returned an empty or invalid response. Please try again.');
    }

    try {
      const rubricData = parseJSONWithFallback(response);
      
      // Validate the response structure
      if (!rubricData.name || !rubricData.criteria || !Array.isArray(rubricData.criteria)) {
        throw new Error('Invalid response structure: missing name or criteria array');
      }
      
      if (!rubricData.total_points || typeof rubricData.total_points !== 'number') {
        throw new Error('Invalid response structure: missing or invalid total_points');
      }

      // Validate each criterion
      for (const criterion of rubricData.criteria) {
        if (!criterion.name || !criterion.max_points || !criterion.description) {
          throw new Error('Invalid criterion structure: missing name, max_points, or description');
        }
      }

      // Use provided name if available
      if (rubricName) {
        rubricData.name = rubricName;
      }

      // Ensure total_points equals sum of criteria (AI may have rounded or miscounted)
      const criteriaSum = rubricData.criteria.reduce((s, c) => s + (Number(c.max_points) || 0), 0);
      if (criteriaSum > 0) {
        rubricData.total_points = criteriaSum;
      }

      return {
        ...rubricData,
        rubric_type: 'rubric'
      };
    } catch (parseError) {
      console.error('❌ JSON parsing error:', parseError.message);
      console.error('Response length:', response.length);
      console.error('Raw AI Response (first 500 chars):', response.substring(0, 500));
      if (parseError.message.includes('Unexpected token') || parseError.message.includes('control character')) {
        throw new Error(`Failed to parse AI response as JSON. The response may contain invalid JSON or extra text. Try again.`);
      }
      if (parseError.message.includes('empty or too-short')) {
        throw new Error('The AI returned an empty or too-short response. Try again or use a shorter document.');
      }
      throw new Error(`Failed to parse AI response as JSON: ${parseError.message}. Try again.`);
    }
  } catch (error) {
    console.error('❌ Generate rubric error:', error);
    if (error.message && (error.message.includes('empty') || error.message.includes('parse AI response'))) {
      throw error;
    }
    throw new Error('Failed to generate rubric with AI. Please try again.');
  }
};

// Generate rubric from PDF
router.post('/from-pdf', async (req, res) => {
  try {
    const { assignment_id, rubric_name, rubric_type } = req.body;

    if (!assignment_id) {
      return res.status(400).json({ 
        error: 'Missing required field: assignment_id' 
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

    try {
      // Extract text from PDF
      console.log('Starting PDF text extraction for file:', assignment.file_path);
      const assignmentText = await extractTextFromPDF(assignment.file_path);
      console.log('PDF text extraction completed. Text length:', assignmentText ? assignmentText.length : 0);
      
      if (!assignmentText || assignmentText.trim().length === 0) {
        throw new Error('No text could be extracted from the PDF');
      }

      // Determine what to generate based on user selection or auto-detection
      let finalType = rubric_type || 'auto';
      if (finalType === 'memorandum' || finalType === 'memo') {
        finalType = 'extract_memo';
      }
      let detectedType = null;
      
      let autoDetectedType = null;
      if (finalType === 'auto') {
        // Auto-detect document type
        console.log('🔍 Auto-detecting document type...');
        detectedType = await detectDocumentType(assignmentText);
        console.log('📝 Detected document type:', detectedType);
        
        // Auto-generate based on detection
        autoDetectedType = detectedType;
        switch (detectedType) {
          case 'question_paper':
            finalType = 'answer_key';  // generate memo from question paper
            break;
          case 'memo':
            finalType = 'extract_memo';  // document IS the memo: extract structure
            break;
          case 'rubric':
            finalType = 'rubric';
            break;
          default:
            finalType = 'rubric';
            break;
        }
      } else {
        // User selected type - still detect for logging but use their selection
        detectedType = await detectDocumentType(assignmentText);
        console.log('📝 Detected document type:', detectedType, '(using user selection:', finalType, ')');
        autoDetectedType = detectedType;
      }

      // Generate or extract based on final type
      if (finalType === 'answer_key') {
        console.log('📋 Generating answer key from question paper...');
        const answerKeyName = rubric_name || `Answer Key - ${assignment.filename.replace('.pdf', '')}`;
        const answerKeyData = await generateAnswerKeyFromQuestionPaper(assignmentText, answerKeyName);
        return res.json({
          success: true,
          rubric: answerKeyData,
          message: 'Answer key generated successfully. This can be used as a rubric to mark student responses.',
          detected_type: autoDetectedType || detectedType,
          final_type: 'answer_key',
          is_answer_key: true,
          rubric_type: 'answer_key'
        });
      }
      if (finalType === 'extract_memo') {
        console.log('📋 Document is a memorandum: extracting structure...');
        const memoName = rubric_name || assignment.filename.replace(/\.pdf$/i, '');
        const extractedData = await extractRubricFromMemo(assignmentText, memoName);
        return res.json({
          success: true,
          rubric: extractedData,
          message: 'Memorandum detected and extracted. You can save it as a rubric to mark scripts.',
          detected_type: 'memo',
          final_type: 'answer_key',
          is_answer_key: true,
          rubric_type: 'answer_key'
        });
      }
      // Generate regular rubric
      console.log('📋 Generating regular rubric...');
      const rubricData = await generateRubricFromPDF(assignmentText, rubric_name);
      return res.json({
        success: true,
        rubric: rubricData,
        message: 'Rubric generated successfully from PDF',
        detected_type: autoDetectedType || detectedType,
        final_type: 'rubric',
        is_answer_key: false,
        rubric_type: 'rubric'
      });
    } catch (processingError) {
      throw processingError;
    }
  } catch (error) {
    console.error('Rubric generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate rubric from PDF',
      details: error.message
    });
  }
});

// Save generated rubric (requires auth; assigns creator as user_id)
router.post('/save', requireAuth, async (req, res) => {
  try {
    const { name, criteria, total_points, rubric_type = 'rubric' } = req.body;

    if (!name || !criteria || !total_points) {
      return res.status(400).json({ 
        error: 'Missing required fields: name, criteria, total_points' 
      });
    }

    const userId = req.user?.id;
    if (userId == null || userId === undefined) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Validate criteria structure
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return res.status(400).json({ 
        error: 'Criteria must be a non-empty array' 
      });
    }

    // Sum of criterion points (may differ from total_points when user overrides total to match document)
    const calculatedTotal = criteria.reduce((sum, criterion) => sum + (Number(criterion.max_points) || 0), 0);
    if (calculatedTotal !== total_points) {
      console.log(`Save rubric: total_points ${total_points} (user override) differs from sum of criteria ${calculatedTotal}`);
    }

    const normalizedType = ['rubric', 'answer_key'].includes(rubric_type) ? rubric_type : 'rubric';

    const result = await query(
      'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES (?, ?, ?, ?, ?)',
      [name, JSON.stringify(criteria), total_points, normalizedType, userId]
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
      message: 'Generated rubric saved successfully'
    });
  } catch (error) {
    console.error('Save generated rubric error:', error);
    res.status(500).json({ error: 'Failed to save generated rubric' });
  }
});

module.exports = router;

