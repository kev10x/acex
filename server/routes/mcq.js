const express = require('express');
const fs = require('fs');
const OpenAI = require('openai');
const { query } = require('../database/connection');
const { extractTextFromPDF } = require('../services/pdfOCR');

const router = express.Router();

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Extract MCQ answers from a scanned form using Vision API
 */
const extractMCQAnswers = async (filePath, totalQuestions) => {
  try {
    console.log(`📸 Extracting MCQ answers from scanned form...`);
    
    // Use Vision API to extract answers
    const pdf2pic = require('pdf2pic');
    const { fromPath } = pdf2pic;
    const path = require('path');
    
    // Create temp directory if it doesn't exist
    const tempDir = path.join(__dirname, '../uploads/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const convert = fromPath(filePath, {
      density: 300,
      saveFilename: 'mcq_temp',
      savePath: tempDir,
      format: 'png',
      width: 2000,
      height: 2000
    });

    // Convert first page (MCQ forms are typically single page)
    const result = await convert(1);
    
    let imagePath = null;
    if (typeof result === 'string') {
      imagePath = result;
    } else if (result && result.path) {
      imagePath = result.path;
    } else if (result && result.name) {
      imagePath = result.name;
    }

    if (!imagePath) {
      throw new Error('Could not determine image path from conversion');
    }

    // Handle both absolute and relative paths
    const fullImagePath = path.isAbsolute(imagePath) ? imagePath : path.join(tempDir, imagePath);
    
    if (!fs.existsSync(fullImagePath)) {
      throw new Error(`Image file not found: ${fullImagePath}`);
    }

    // Read image as base64
    const imageBuffer = fs.readFileSync(fullImagePath);
    const base64Image = imageBuffer.toString('base64');

    // Use OpenAI Vision API to extract answers
    const prompt = `Analyze this scanned MCQ (Multiple Choice Question) form and extract the answers marked by the student.

Instructions:
1. Identify all questions numbered 1 through ${totalQuestions} (or as many as visible)
2. For each question, identify which option (A, B, C, D, or E) is marked/selected
3. Return ONLY a JSON object in this exact format:
{
  "1": "A",
  "2": "B",
  "3": "C",
  ...
}

Important:
- If a question has no answer marked, use "NONE" for that question
- Only include questions that are clearly visible
- Be accurate with the option letters (A, B, C, D, E)
- Return ONLY the JSON object, no additional text or explanation`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 1000,
      temperature: 0.1
    });

    // Clean up temp image
    if (fs.existsSync(fullImagePath)) {
      fs.unlinkSync(fullImagePath);
    }

    const content = response.choices[0].message.content.trim();
    
    // Extract JSON from response
    let jsonStr = content;
    if (jsonStr.includes('```json')) {
      jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (jsonStr.includes('```')) {
      jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    const answers = JSON.parse(jsonStr);
    console.log(`✅ Extracted ${Object.keys(answers).length} answers from MCQ form`);
    
    return answers;
  } catch (error) {
    console.error('❌ Error extracting MCQ answers:', error);
    throw new Error(`Failed to extract MCQ answers: ${error.message}`);
  }
};

/**
 * Process MCQ forms
 */
router.post('/process', async (req, res) => {
  try {
    const { answer_key, assignment_ids, student_names } = req.body;

    if (!answer_key) {
      return res.status(400).json({ error: 'Answer key is required' });
    }

    if (!assignment_ids || !Array.isArray(assignment_ids) || assignment_ids.length === 0) {
      return res.status(400).json({ error: 'At least one assignment ID is required' });
    }

    // Parse answer key (should be object, but handle string if needed)
    const answerKey = typeof answer_key === 'string' ? JSON.parse(answer_key) : answer_key;
    
    // Parse student names (should be array, but handle string if needed)
    const studentNamesArray = Array.isArray(student_names) 
      ? student_names 
      : (student_names ? JSON.parse(student_names) : []);

    const totalQuestions = Object.keys(answerKey).length;
    console.log(`📋 Processing ${assignment_ids.length} MCQ form(s) with ${totalQuestions} questions each`);

    const results = [];

      // Process each form
      for (let i = 0; i < assignment_ids.length; i++) {
        const assignmentId = assignment_ids[i];
        const studentName = studentNamesArray[i] || null;

      try {
        // Get assignment details
        const assignmentResult = await query(
          'SELECT * FROM assignments WHERE id = ?',
          [assignmentId]
        );

        let assignment;
        if (Array.isArray(assignmentResult)) {
          assignment = assignmentResult[0];
        } else if (assignmentResult.rows && Array.isArray(assignmentResult.rows)) {
          assignment = assignmentResult.rows[0];
        } else {
          throw new Error('Unexpected database result format');
        }

        if (!assignment) {
          console.error(`Assignment ${assignmentId} not found`);
          continue;
        }

        const filePath = assignment.file_path || assignment.filepath;
        if (!fs.existsSync(filePath)) {
          console.error(`File not found: ${filePath}`);
          continue;
        }

        console.log(`📄 Processing MCQ form ${i + 1}/${assignment_ids.length}: ${assignment.filename}`);

        // Extract answers from scanned form
        const extractedAnswers = await extractMCQAnswers(filePath, totalQuestions);

        // Compare with answer key
        let correct = 0;
        let incorrect = 0;
        const answers = {};

        Object.keys(answerKey).forEach(questionNum => {
          const correctAnswer = answerKey[questionNum].toUpperCase();
          const studentAnswer = extractedAnswers[questionNum]?.toUpperCase() || 'NONE';
          
          answers[questionNum] = studentAnswer;
          
          if (studentAnswer === 'NONE' || studentAnswer === '') {
            // Unanswered - count as incorrect
            incorrect++;
          } else if (studentAnswer === correctAnswer) {
            correct++;
          } else {
            incorrect++;
          }
        });

        const total = correct + incorrect;
        const score = correct;
        const percentage = total > 0 ? (correct / total) * 100 : 0;

        // Save result to database
        const rubricId = null; // MCQ doesn't use rubrics
        const scores = Object.keys(answerKey).map(qNum => ({
          criterion_name: `Question ${qNum}`,
          points_awarded: extractedAnswers[qNum]?.toUpperCase() === answerKey[qNum].toUpperCase() ? 1 : 0,
          max_points: 1,
          feedback: extractedAnswers[qNum]?.toUpperCase() === answerKey[qNum].toUpperCase() 
            ? 'Correct' 
            : extractedAnswers[qNum] === 'NONE' || !extractedAnswers[qNum]
            ? 'Not answered'
            : `Incorrect. Correct answer: ${answerKey[qNum]}`
        }));

        const feedback = `MCQ Results: ${correct} correct out of ${total} questions (${percentage.toFixed(1)}%)`;
        
        await query(
          `INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, marked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            assignmentId,
            rubricId,
            studentName,
            JSON.stringify(scores),
            feedback,
            score,
            new Date().toISOString()
          ]
        );

        results.push({
          assignment_id: assignmentId,
          filename: assignment.filename,
          student_name: studentName,
          answers,
          correct,
          incorrect,
          total,
          score,
          percentage
        });

        console.log(`✅ Processed: ${correct}/${total} correct (${percentage.toFixed(1)}%)`);

      } catch (error) {
        console.error(`❌ Error processing assignment ${assignmentId}:`, error);
        // Continue with other assignments
      }
    }

    res.json({
      success: true,
      results,
      message: `Successfully processed ${results.length} MCQ form(s)`
    });

  } catch (error) {
    console.error('❌ MCQ processing error:', error);
    res.status(500).json({
      error: 'Failed to process MCQ forms',
      message: error.message
    });
  }
});

module.exports = router;

