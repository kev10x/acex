const express = require('express');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const { query } = require('../database/connection');

const router = express.Router();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Detect document type (question paper, treatise, assignment, etc.)
const detectDocumentType = async (documentText) => {
  try {
    const detectionPrompt = `Analyze the following document and determine its type.

Types:
- "question_paper": An exam/test paper with questions (may include answers)
- "memo": A marking memorandum/answer key with model answers
- "treatise": A substantial academic research document (Masters/PhD level)
- "assignment": A course assignment or homework
- "thesis": A doctoral thesis
- "report": A research report
- "proposal": A research proposal
- "rubric": A marking rubric or assessment criteria

DOCUMENT PREVIEW:
${documentText.substring(0, 1500)}

Respond with ONLY a JSON object:
{
  "document_type": "question_paper" or "memo" or "treatise" or "assignment" or "thesis" or "report" or "proposal" or "rubric",
  "confidence": "high" or "medium" or "low"
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: detectionPrompt }],
      temperature: 0.1,
      max_tokens: 150,
      user: "anonymous"
    });

    const response = completion.choices[0].message.content.trim();
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
    
    const prompt = `You are an expert educator creating a marking memorandum (answer key) from a question paper. 

QUESTION PAPER:
${questionPaperText}

Your task:
1. Identify all questions in the paper (numbered questions, sub-questions, etc.)
2. For each question, create a model answer that includes:
   - The complete correct answer
   - Key points that must be covered
   - Worked examples or calculations (if applicable)
   - Marking allocations for each part
3. Determine appropriate point values for each question based on complexity and length
4. Create marking levels showing how partial marks are awarded

Respond with a JSON object in this exact format:
{
  "name": "Answer Key - [Question Paper Name]",
  "criteria": [
    {
      "name": "Question 1: [Question title/brief description]",
      "max_points": 15,
      "description": "Model Answer: [Complete correct answer with all key points, worked examples if applicable, and marking allocations]\n\nMarking Scheme:\n- Full Marks ([X-Y] points): [Description of what earns full marks]\n- Partial Marks ([X-Y] points): [Description of what earns partial marks]\n- Partial Marks ([X-Y] points): [Description of lower partial marks]\n- No/Low Marks (0-[X] points): [Description of what earns no or minimal marks]"
    }
  ],
  "total_points": 100
}

IMPORTANT:
- Include keywords like "Model Answer", "Marking Scheme", "Correct Answer" in descriptions
- Make sure each criterion description clearly contains the model answer
- Be specific about what earns full marks vs partial marks
- For calculation questions, show complete worked solutions
- For essay questions, list all key points that must be covered
- Total points should be reasonable (typically 50-100 points for a full exam)`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are an expert educator creating comprehensive answer keys and marking memorandums. Always respond with valid JSON format."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 4000,
      user: "anonymous"
    });

    const response = completion.choices[0].message.content.trim();
    
    // Clean up response - remove markdown code blocks if present
    let cleanResponse = response;
    if (cleanResponse.startsWith('```json')) {
      cleanResponse = cleanResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanResponse.startsWith('```')) {
      cleanResponse = cleanResponse.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    
    try {
      const answerKeyData = JSON.parse(cleanResponse);
      
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

      console.log('✅ Answer key generated successfully');
      return {
        ...answerKeyData,
        rubric_type: 'answer_key'
      };
    } catch (parseError) {
      console.error('❌ JSON parsing error:', parseError);
      console.error('AI Response:', response);
      throw new Error('Failed to parse AI response as JSON');
    }
  } catch (error) {
    console.error('❌ OpenAI API error:', error);
    throw new Error('Failed to generate answer key with AI');
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
You are an expert educator who creates comprehensive marking rubrics. Based on the following document content, create a detailed rubric that would be appropriate for grading assignments related to this topic.

DOCUMENT CONTENT:
${pdfText}

Please create a rubric with the following structure:
1. Identify 4-6 key assessment criteria that would be relevant for assignments based on this document
2. For each criterion, provide:
   - A clear, descriptive name
   - A detailed description of what constitutes different performance levels
   - Appropriate point values (total should be around 50-100 points)
3. Consider different aspects like: content knowledge, analysis, critical thinking, writing quality, research, application, etc.

Respond with a JSON object in this exact format:
{
  "name": "Generated rubric name based on document",
  "criteria": [
    {
      "name": "Criterion Name",
      "max_points": 20,
      "description": "Detailed description of what this criterion evaluates and what different performance levels look like"
    }
  ],
  "total_points": 100
}

Make sure the rubric is:
- Specific to the document content
- Fair and comprehensive
- Clear for both students and graders
- Appropriate for the academic level of the content
`;

    const completion = await openai.completions.create({
      model: "gpt-3.5-turbo-instruct",
      prompt: `You are an expert educator who creates fair, comprehensive, and detailed marking rubrics. Always respond with valid JSON format.

${prompt}`,
      temperature: 0.3,
      max_tokens: 2000,
      user: "anonymous" // Enhanced privacy: don't send user identifiers
    });

    const response = completion.choices[0].text;
    
    try {
      const rubricData = JSON.parse(response);
      
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

      return {
        ...rubricData,
        rubric_type: 'rubric'
      };
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('AI Response:', response);
      throw new Error('Failed to parse AI response as JSON');
    }
  } catch (error) {
    console.error('OpenAI API error:', error);
    throw new Error('Failed to generate rubric with AI');
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
          case 'memo':
            finalType = 'answer_key';
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

      // Generate based on final type
      if (finalType === 'answer_key') {
        console.log('📋 Generating answer key...');
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
      } else {
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
      }
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

// Save generated rubric
router.post('/save', async (req, res) => {
  try {
    const { name, criteria, total_points, rubric_type = 'rubric' } = req.body;

    if (!name || !criteria || !total_points) {
      return res.status(400).json({ 
        error: 'Missing required fields: name, criteria, total_points' 
      });
    }

    // Validate criteria structure
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return res.status(400).json({ 
        error: 'Criteria must be a non-empty array' 
      });
    }

    // Calculate total points from criteria
    const calculatedTotal = criteria.reduce((sum, criterion) => sum + criterion.max_points, 0);
    
    if (calculatedTotal !== total_points) {
      return res.status(400).json({ 
        error: `Total points (${total_points}) does not match sum of criterion points (${calculatedTotal})` 
      });
    }

    const normalizedType = ['rubric', 'answer_key'].includes(rubric_type) ? rubric_type : 'rubric';

    const result = await query(
      'INSERT INTO rubrics (name, criteria, total_points, rubric_type) VALUES (?, ?, ?, ?)',
      [name, JSON.stringify(criteria), total_points, normalizedType]
    );
    
    // For SQLite, we need to get the last inserted ID separately
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

