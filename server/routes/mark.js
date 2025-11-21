const express = require('express');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { query } = require('../database/connection');
const aiConfig = require('../config/ai-config');
const aiService = require('../services/aiService');
const { annotatePdfWithIssues, buildIssuesFromMarking } = require('../services/pdfAnnotator');
const PDFReportGenerator = require('../services/pdfReportGenerator');

const router = express.Router();
const pdfGenerator = new PDFReportGenerator();

// Debug endpoint to test marking functionality
router.post('/debug', async (req, res) => {
  try {
    console.log('🔍 Debug marking endpoint called');
    const { assignment_id, rubric_id } = req.body;
    
    if (!assignment_id || !rubric_id) {
      return res.status(400).json({ error: 'assignment_id and rubric_id are required' });
    }
    
    // Get assignment details
    const assignmentResult = await query(
      'SELECT * FROM assignments WHERE id = ?',
      [assignment_id]
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
    
    // Get rubric details
    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ?',
      [rubric_id]
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
      assignment: assignment[0],
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

// Extract text from PDF (with OCR/Vision API fallback for handwritten text)
const extractTextFromPDF = async (filePath) => {
  try {
    const { extractTextFromPDF: extractWithOCR } = require('../services/pdfOCR');
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
      model: config.provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-haiku-20240307',
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
      model: config.provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-haiku-20240307',
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

// Generate AI marking using OpenAI or Anthropic
const generateMarking = async (assignmentText, rubric, documentType = null, level = null, provider = null) => {
  try {
    // Auto-detect document type if not provided
    if (!documentType) {
      console.log('🔍 Auto-detecting document type...');
      documentType = await detectDocumentType(assignmentText);
      console.log('📝 Detected document type:', documentType);
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
    const isMemo = await detectMemo(rubricText);
    
    if (isMemo) {
      console.log('📋 Rubric detected as MEMO (answer key/marking memorandum)');
      // Use memo config for memo-based marking
      documentType = 'memo';
    }
    
    // Get configuration based on document type and provider
    const config = aiConfig.getConfig(documentType, provider);
    const selectedProvider = config.provider;
    
    console.log('🤖 Starting AI marking process...');
    console.log('Provider:', selectedProvider);
    console.log('Document type:', documentType);
    console.log('Is memo:', isMemo);
    console.log('Assignment text length:', assignmentText?.length || 0);
    console.log('Text will be truncated to:', Math.min(assignmentText?.length || 0, config.maxTextLength), 'characters');
    console.log('Using model:', config.model);
    console.log('Max tokens:', config.maxTokens);
    console.log('Rubric:', JSON.stringify(rubric, null, 2));
    
    const criteria = rubric.criteria;
    const totalPoints = rubric.total_points;
    console.log('Criteria count:', criteria?.length || 0);

    // Convert complex rubric format to simple format for AI
    const simpleCriteria = criteria.map(criterion => {
      // Handle both old format (maxPoints) and new format (levels with points)
      let maxPoints;
      if (criterion.maxPoints) {
        maxPoints = criterion.maxPoints;
      } else if (criterion.levels && criterion.levels.length > 0) {
        // Find the highest points from levels
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
    
    // Respect TPM limits by constraining prompt size
    // Rough token estimate: 1 token ≈ 4 chars
    const estimateTokens = (text) => Math.ceil((text?.length || 0) / 4);
    // Different TPM limits for different providers
    // OpenAI: ~30K TPM, Anthropic: ~100K TPM (more lenient)
    const tpmLimit = selectedProvider === 'anthropic' ? 100000 : 30000;
    // Reserve room for completion tokens and system overhead (~1000 tokens)
    const requestMaxTokens = Math.min(config.maxTokens, selectedProvider === 'anthropic' ? 16000 : 6000);
    const promptBudgetTokens = Math.max(1000, tpmLimit - requestMaxTokens - 1000);
    const maxPromptCharsByTPM = promptBudgetTokens * 4;

    const maxAllowedChars = Math.min(config.maxTextLength, maxPromptCharsByTPM);
    const truncatedText = assignmentText.length > maxAllowedChars ? 
      assignmentText.substring(0, maxAllowedChars) + '...[truncated for processing]' : 
      assignmentText;

    // Create detailed rubric/memo description with levels
    const detailedRubric = criteria.map((criterion, i) => {
      let rubricText = `${i+1}. ${criterion.name} (${criterion.maxPoints} points)\n   ${criterion.description}\n`;
      
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
          ? `You are an expert examiner evaluating a Masters Degree Treatise. This is a substantial academic document requiring thorough analysis. Apply STRICT and rigorous postgraduate standards. Be critical and demanding - award marks only when work fully meets the high standards expected. Use scholarly terminology appropriate for advanced academic work.`
          : `You are an expert educator evaluating a Treatise. Apply STRICT academic standards for ${level || 'high school'} level work. Be critical and precise in your evaluation.`,
        thesis: level === 'postgraduate'
          ? `You are an expert examiner evaluating a Thesis. Apply STRICT and rigorous postgraduate standards. Be demanding and critical - this represents the culmination of significant research and must meet the highest standards. Use advanced academic terminology.`
          : `You are an expert examiner evaluating a Thesis at ${level || 'undergraduate'} level. Apply STRICT academic standards. Be critical and precise in your assessment.`,
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
          ? `You are a supervisor evaluating a Research Proposal. Emphasize clarity of problem, significance, feasibility, and methodology plan. Provide ${terms.feedback} feedback appropriate for ${level} level work.`
          : `You are evaluating a Research Proposal. Emphasize clarity of problem, significance, feasibility, and methodology plan.`,
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
          tone: 'Use encouraging, age-appropriate language',
          expectations: 'Focus on basic understanding and effort',
          feedback: 'Provide simple, clear feedback that helps students learn',
          terminology: 'Use simple terms and avoid complex academic jargon'
        },
        high_school: {
          tone: 'Use clear, supportive language appropriate for secondary students',
          expectations: 'Focus on understanding, application, and development of skills',
          feedback: 'Provide constructive feedback that helps students improve',
          terminology: 'Use educational terminology appropriate for high school level'
        },
        undergraduate: {
          tone: 'Use academic language appropriate for university-level work',
          expectations: 'Focus on critical thinking, analysis, and academic rigor',
          feedback: 'Provide analytical feedback demonstrating academic standards',
          terminology: 'Use appropriate university-level academic terminology'
        },
        postgraduate: {
          tone: 'Use scholarly, rigorous academic language',
          expectations: 'Focus on scholarly contribution, theoretical depth, and research quality',
          feedback: 'Provide in-depth, scholarly feedback appropriate for advanced work',
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
- Focus on research quality, theoretical depth, and practical application
- Provide comprehensive feedback for each criterion (${level === 'postgraduate' ? '4-5 sentences minimum' : '3-4 sentences minimum'})
- Reference specific sections, arguments, and evidence from the ${assessmentType}
- Evaluate the academic rigor, originality, and contribution to the field with STRICT criteria
- Consider the ${assessmentType}'s structure, methodology, and conclusions critically
- Assess ${analysisType} - be demanding and identify weaknesses
- CRITICAL: Provide specific, actionable improvement suggestions for each criterion
- Be critical - identify missing elements, weak arguments, insufficient evidence, and areas that fall short
- Include concrete recommendations for enhancing research methodology, literature review, analysis depth
- Suggest specific frameworks, theories, or approaches that could strengthen the work
- Identify ALL missing elements, weak arguments, or areas needing more evidence - do not overlook shortcomings
- Recommend specific sections that need expansion, restructuring, or clarification
- Highlight areas for development and be critical of weaknesses
- ${guidance.tone}
- ${guidance.terminology}
- Award points STRICTLY based on the performance levels described in the rubric - do not be generous`;
      }
      
      if (assessmentType === 'test') {
        return `EVALUATION GUIDELINES FOR TEST:
- Apply STRICT marking standards - be precise and critical
- Focus on correctness, completeness, and clarity of answers
- Assess accuracy of responses against expected answers with STRICT criteria
- Evaluate completeness - did the student address all parts of each question? Award marks only if ALL parts are addressed
- Check clarity of explanations and reasoning - be demanding about quality
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
- Be critical - identify weaknesses, gaps, and areas that do not meet standards
- Provide specific, actionable improvement suggestions
- Highlight areas for development and be demanding about what is missing or insufficient
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
- Be critical - identify weaknesses, gaps, and areas that do not meet standards
- Provide specific, actionable improvement suggestions
- Highlight areas for development and be demanding about what is missing or insufficient
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
    }
    
    const evaluationGuidelines = getEvaluationGuidelines(documentType, level, isMemo);

    const rubricLabel = isMemo ? 'MARKING MEMORANDUM (MEMO):' : 'EVALUATION RUBRIC:';

    const prompt = `${intro}

${contentLabel}
${truncatedText}

${rubricLabel}
${detailedRubric}

TOTAL: ${totalPoints} points

${evaluationGuidelines}

STRICT MARKING REQUIREMENTS:
- Apply strict academic standards - do not be lenient or generous with marks
- Award points ONLY when criteria are clearly and fully met
- Be critical in your evaluation - identify weaknesses, gaps, and areas that fall short
- Do not award full marks unless the work demonstrates excellence that fully satisfies all aspects of the criterion
- For partial marks, be precise - award marks only for what is actually present and demonstrated
- If work is incomplete, unclear, or lacks required elements, award lower marks accordingly
- Hold students to high standards - expect thoroughness, accuracy, and depth
- Do not give benefit of the doubt - if something is missing or incorrect, reflect this in the scoring
- Be rigorous in assessing whether the work meets the performance level descriptions in the rubric

IMPORTANT: For each criterion, provide a confidence level (0-100) indicating how confident you are in the marking. Consider:
- Clarity of the student's work
- Ambiguity in the rubric or student response
- Need for additional context or clarification
- Unclear or incomplete submissions

Lower confidence (< 70) indicates the assessment may need human review.

CRITICAL: You MUST respond with ONLY valid JSON. Do not include any explanatory text, markdown formatting, or code blocks. Return ONLY the JSON object.

JSON format (return ONLY this, no other text):
{
  "scores": [
    {
      "criterion_name": "name",
      "points_awarded": number,
      "max_points": number,
      "feedback": "detailed specific feedback with examples, reasoning, and actionable improvement suggestions",
      "confidence": number (0-100, where 100 = very confident, 0 = very uncertain)
    }
  ],
  "overall_feedback": "comprehensive summary highlighting key strengths, main areas for improvement, specific next steps, concrete recommendations for enhancement, and overall assessment",
  "total_score": number,
  "overall_confidence": number (0-100, representing your overall confidence in the entire assessment)
}`;

    console.log(`📤 Sending request to ${selectedProvider === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI'}...`);
    
    // Use unified AI service with retry logic (more retries for marking operations)
    const result = await aiService.createCompletionWithRetry({
      provider: selectedProvider,
      model: config.model,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: config.temperature,
      maxTokens: requestMaxTokens
    }, 5); // Increased retries for marking operations

    console.log(`📥 Received response from ${selectedProvider === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI'}`);
    const response = result.content;
    console.log('Response length:', response?.length || 0);
    console.log('Response preview:', response?.substring(0, 200) + '...');
    
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
    
    // Try to parse the JSON response
    try {
      // Clean up response - remove markdown code blocks if present
      let cleanResponse = response.trim();
      
      // Remove markdown code blocks (handle both single-line and multi-line)
      // Match ```json ... ``` or ``` ... ```
      cleanResponse = cleanResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      
      // Try to extract JSON from text that might have explanatory content
      // Look for JSON object boundaries
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        cleanResponse = jsonMatch[0];
      }
      
      // Remove any leading/trailing whitespace
      cleanResponse = cleanResponse.trim();
      
      // Log the cleaned response for debugging (first 500 chars)
      console.log('📄 Cleaned response preview:', cleanResponse.substring(0, 500));
      
      const markingResult = JSON.parse(cleanResponse);
      
      // Validate the response structure
      if (!markingResult.scores || !Array.isArray(markingResult.scores)) {
        throw new Error('Invalid response structure: missing scores array');
      }
      
      if (!markingResult.overall_feedback || typeof markingResult.overall_feedback !== 'string') {
        throw new Error('Invalid response structure: missing overall_feedback');
      }
      
      if (typeof markingResult.total_score !== 'number') {
        throw new Error('Invalid response structure: missing or invalid total_score');
      }

      // Process confidence scores - add defaults if missing (backward compatibility)
      const confidenceThreshold = 70; // Flag assessments below this confidence
      
      // Ensure each score has a confidence value (default to 80 if missing)
      markingResult.scores = markingResult.scores.map(score => ({
        ...score,
        confidence: typeof score.confidence === 'number' ? Math.max(0, Math.min(100, score.confidence)) : 80
      }));
      
      // Calculate overall confidence if not provided (average of criterion confidences)
      if (typeof markingResult.overall_confidence !== 'number') {
        const avgConfidence = markingResult.scores.length > 0
          ? markingResult.scores.reduce((sum, s) => sum + (s.confidence || 80), 0) / markingResult.scores.length
          : 80;
        markingResult.overall_confidence = Math.round(avgConfidence);
      } else {
        markingResult.overall_confidence = Math.max(0, Math.min(100, markingResult.overall_confidence));
      }
      
      // Flag low confidence assessments
      markingResult.needs_review = markingResult.overall_confidence < confidenceThreshold;
      markingResult.confidence_level = markingResult.overall_confidence >= 80 
        ? 'high' 
        : markingResult.overall_confidence >= 60 
        ? 'medium' 
        : 'low';
      
      // Calculate minimum criterion confidence for additional flagging
      const minConfidence = Math.min(...markingResult.scores.map(s => s.confidence || 80));
      markingResult.min_criterion_confidence = minConfidence;
      markingResult.has_low_criterion_confidence = minConfidence < confidenceThreshold;

      return markingResult;
    } catch (parseError) {
      console.error('❌ JSON parsing error:', parseError.message);
      console.error('Parse error stack:', parseError.stack);
      console.error('Raw AI Response (first 1000 chars):', response.substring(0, 1000));
      console.error('Raw AI Response length:', response.length);
      
      // Try to extract and fix common JSON issues
      try {
        // Find the first { and then find the matching closing }
        const jsonStart = response.indexOf('{');
        if (jsonStart !== -1) {
          let braceCount = 0;
          let jsonEnd = -1;
          
          // Find the matching closing brace
          for (let i = jsonStart; i < response.length; i++) {
            if (response[i] === '{') braceCount++;
            if (response[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                jsonEnd = i;
                break;
              }
            }
          }
          
          if (jsonEnd !== -1) {
            const extractedJson = response.substring(jsonStart, jsonEnd + 1);
            console.log('🔄 Attempting to extract JSON from response...');
            console.log('Extracted JSON preview:', extractedJson.substring(0, 500));
            
            const markingResult = JSON.parse(extractedJson);
            console.log('✅ Successfully parsed extracted JSON!');
            
            // Validate the extracted result
            if (markingResult.scores && Array.isArray(markingResult.scores)) {
              return markingResult;
            }
          }
        }
      } catch (extractError) {
        console.error('❌ Failed to extract JSON:', extractError.message);
      }
      
      throw new Error(`Failed to parse AI response as JSON: ${parseError.message}`);
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

// Generate short anchor quotes from the document for each criterion to enable pinpoint annotations
const generateAnchorPhrases = async (documentText, markingResult, documentType = 'treatise') => {
  try {
    const config = aiConfig.getConfig(documentType);

    // Keep this call small to avoid extra costs and TPM issues
    const maxEssayChars = Math.min(8000, documentText?.length || 0);
    const essaySnippet = documentText?.substring(0, maxEssayChars) || '';

    const compactScores = (markingResult?.scores || []).map(s => ({
      criterion_name: s.criterion_name,
      feedback: (s.feedback || '').slice(0, 400)
    }));

    const anchorPrompt = `You are assisting with academic markup.
We have a treatise excerpt (first ${maxEssayChars} chars) and per-criterion feedback.
For each criterion, return up to 3 SHORT exact quotes (<=120 chars) copied verbatim from the excerpt that best exemplify the issue described in the feedback. Quotes must be exact substrings of the excerpt.
Return ONLY JSON in this format:
{
  "anchors": [
    { "criterion_name": "...", "quotes": ["short exact quote", "short exact quote"] }
  ]
}

TREATISE EXCERPT:
${essaySnippet}

FEEDBACK:
${JSON.stringify(compactScores)}`;

    // Use aiService for anchor phrase generation
    const result = await aiService.createCompletionWithRetry({
      provider: config.provider,
      model: config.model,
      messages: [{ role: 'user', content: anchorPrompt }],
      temperature: 0.1,
      maxTokens: 800
    }, 2);

    const raw = result.content || '';
    let clean = raw.trim();
    if (clean.startsWith('```json')) clean = clean.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    else if (clean.startsWith('```')) clean = clean.replace(/^```\s*/, '').replace(/\s*```$/, '');

    const parsed = JSON.parse(clean);
    const map = new Map();
    for (const item of parsed.anchors || []) {
      if (item?.criterion_name && Array.isArray(item.quotes)) {
        map.set(item.criterion_name, item.quotes.filter(q => typeof q === 'string' && q.length >= 8 && q.length <= 160));
      }
    }
    return map;
  } catch (error) {
    console.warn('Anchor phrase generation failed (non-fatal):', error.message);
    return new Map();
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
router.post('/single', async (req, res) => {
  try {
    const { assignment_id, rubric_id, student_name, document_type, output_type = 'annotate', assessment_type, level, provider } = req.body;

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

    // Get rubric details
    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ?',
      [rubric_id]
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

    // Update assignment status to processing
    await query(
      'UPDATE assignments SET status = ? WHERE id = ?',
      ['processing', assignment_id]
    );

    try {
      // Extract text from PDF
      const assignmentText = await extractTextFromPDF(assignment.file_path);
      
      if (!assignmentText || assignmentText.trim().length === 0) {
        throw new Error('No text could be extracted from the PDF');
      }

      // Generate AI marking (use assessment_type if provided, otherwise auto-detect document type)
      // Provider can be specified in request or will use default from config
      const docType = assessment_type || document_type || null;
      const markingResult = await generateMarking(assignmentText, rubric, docType, level, provider);

      // Save marking result to database
      const result = await query(
        'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score) VALUES (?, ?, ?, ?, ?, ?)',
        [
          assignment_id,
          rubric_id,
          student_name || null,
          JSON.stringify(markingResult.scores),
          markingResult.overall_feedback,
          markingResult.total_score
        ]
      );
      
      // For SQLite, we need to get the last inserted ID separately
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
        overall_confidence: markingResult.overall_confidence,
        confidence_level: markingResult.confidence_level,
        needs_review: markingResult.needs_review,
        min_criterion_confidence: markingResult.min_criterion_confidence,
        has_low_criterion_confidence: markingResult.has_low_criterion_confidence
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
      // Update assignment status to error
      await query(
        'UPDATE assignments SET status = ? WHERE id = ?',
        ['error', assignment_id]
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

    // Get rubric details
    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ?',
      [rubric_id]
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
        'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score) VALUES (?, ?, ?, ?, ?, ?)',
        [
          assignment_id,
          rubric_id,
          student_name || null,
          JSON.stringify(scores),
          overall_feedback || 'Manual marking completed',
          total_score
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
      // Update assignment status to error
      await query(
        'UPDATE assignments SET status = ? WHERE id = ?',
        ['error', assignment_id]
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
      'SELECT * FROM rubrics WHERE id = ?',
      [id]
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
router.post('/multiple', async (req, res) => {
  try {
    const { assignment_ids, rubric_id, student_names, document_type, output_type = 'annotate', assessment_type, level, provider } = req.body;

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

    // Get rubric details
    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ?',
      [rubric_id]
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

    // Process each assignment
    for (let i = 0; i < assignment_ids.length; i++) {
      const assignment_id = assignment_ids[i];
      const student_name = student_names && student_names[i] ? student_names[i] : null;

      try {
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
          errors.push({ assignment_id, error: 'Assignment not found - unexpected result format' });
          continue;
        }

        if (!assignment) {
          errors.push({ assignment_id, error: 'Assignment not found' });
          continue;
        }

        // Update assignment status to processing
        await query(
          'UPDATE assignments SET status = ? WHERE id = ?',
          ['processing', assignment_id]
        );

        try {
          // Extract text from PDF
          const assignmentText = await extractTextFromPDF(assignment.file_path);
          
          if (!assignmentText || assignmentText.trim().length === 0) {
            throw new Error('No text could be extracted from the PDF');
          }

          // Generate AI marking (use assessment_type if provided, otherwise use document_type)
          // Provider can be specified in request or will use default from config
          const docType = assessment_type || document_type || null;
          const markingResult = await generateMarking(assignmentText, rubric, docType, level, provider);

          // Save marking result to database
          const result = await query(
            'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score) VALUES (?, ?, ?, ?, ?, ?)',
            [
              assignment_id,
              rubric_id,
              student_name,
              JSON.stringify(markingResult.scores),
              markingResult.overall_feedback,
              markingResult.total_score
            ]
          );
          
          // For SQLite, we need to get the last inserted ID separately
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
            overall_confidence: markingResult.overall_confidence,
            confidence_level: markingResult.confidence_level,
            needs_review: markingResult.needs_review,
            min_criterion_confidence: markingResult.min_criterion_confidence,
            has_low_criterion_confidence: markingResult.has_low_criterion_confidence
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
          // Update assignment status to error
          await query(
            'UPDATE assignments SET status = ? WHERE id = ?',
            ['error', assignment_id]
          );
          
          errors.push({ 
            assignment_id, 
            error: processingError.message 
          });
        }
      } catch (error) {
        errors.push({ 
          assignment_id, 
          error: error.message 
        });
      }
    }

    res.json({
      success: true,
      results,
      errors,
      message: `Processed ${assignment_ids.length} assignments. ${results.length} successful, ${errors.length} failed.`
    });
  } catch (error) {
    console.error('Multiple marking error:', error);
    res.status(500).json({ 
      error: 'Failed to mark assignments',
      details: error.message
    });
  }
});

module.exports = router;

