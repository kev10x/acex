const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../database/connection');
const aiConfig = require('../config/ai-config');
const aiService = require('../services/aiService');
const { annotatePdfWithIssues, buildReviewIssues, findPhrasePages, reviewAnchorPhrase } = require('../services/pdfAnnotator');
const { attachReviewComments } = require('../services/reviewCommentsService');
const {
  chunkArray,
  getDocumentAnchorCandidates,
  rankAnchorCandidates,
  buildHeuristicAnchorsMap,
  buildIssuesWithAnchors
} = require('../services/annotationAnchorService');
const PDFReportGenerator = require('../services/pdfReportGenerator');
const { requireAuth } = require('../middleware/auth');
const {
  extractTextFromDocument,
  getPdfPageImages,
  getSupportedDocumentLabel,
  isCodeDocument,
  isDocxDocument,
  isPdfDocument
} = require('../services/documentExtractService');
const { addCommentsToDocx } = require('../services/docxCommenter');
const { generateMarking, parseMarkingResponsePayload, parseAiJsonResponse, detectMemo } = require('../services/markingService');
const { createQuestionMarker } = require('../services/questionMarkingService');
const { loadPersistedFrameImagesAsBase64 } = require('../services/videoProcessingService');

const router = express.Router();
const pdfGenerator = new PDFReportGenerator();

const getAssignmentDisplayName = (assignment) => assignment?.filename || assignment?.file_path || '';
const getCommentedDocxPath = (filePath) => filePath.replace(/\.docx$/i, '.marked-comments.docx');
const inferDocumentTypeFromAssignment = (assignment) => (isCodeDocument(getAssignmentDisplayName(assignment)) ? 'code' : null);
const resolveStudentName = (studentName, assignment) => {
  const providedName = String(studentName || '').trim();
  if (providedName) return providedName;

  const displayName = getAssignmentDisplayName(assignment);
  return displayName ? path.basename(displayName) : null;
};

// Treatise, thesis or dissertation: add detailed review comments (section and, for PDFs, page).
const prepareReviewComments = async ({ markingResult, assignment, assignmentText, docType, rubric, provider }) => {
  await attachReviewComments({ markingResult, text: assignmentText, documentType: docType, rubric, provider });
  const comments = markingResult?.review_comments;
  if (!comments?.length || !assignment?.file_path || !isPdfDocument(getAssignmentDisplayName(assignment))) return;
  try {
    const pages = await findPhrasePages(assignment.file_path, comments.map((comment) => reviewAnchorPhrase(comment.quote)));
    for (const comment of comments) {
      const page = pages.get(reviewAnchorPhrase(comment.quote));
      if (page) comment.page = page;
    }
  } catch (error) {
    console.warn('Could not find page numbers for review comments (non-fatal):', error.message);
  }
};

// Stored separately from the main insert; returns the comments (or null) for the response.
const saveReviewComments = async (markingResultId, markingResult) => {
  const comments = Array.isArray(markingResult?.review_comments) && markingResult.review_comments.length ? markingResult.review_comments : null;
  if (comments && markingResultId) {
    await query('UPDATE marking_results SET review_comments = ? WHERE id = ?', [JSON.stringify(comments), markingResultId]);
  }
  return comments;
};

// Save a marking result as the new current version for the assignment. Results marked
// question by question also store one item per question for review across the batch.
const saveMarkingResult = async ({ userId, assignment_id, rubric_id, studentName, markingResult, settings, markingOrder = 'script' }) => {
  const { strictness_level, provider, feedback_type, feedback_verbosity, criterion_feedback_types } = settings;

  const versionResult = await query(
    'SELECT COALESCE(MAX(version), 0) as max_version FROM marking_results WHERE assignment_id = ? AND user_id = ?',
    [assignment_id, userId]
  );
  const maxVersion = versionResult.rows?.[0]?.max_version || versionResult?.[0]?.max_version || 0;
  const newVersion = maxVersion + 1;

  await query(
    'UPDATE marking_results SET is_current = 0 WHERE assignment_id = ? AND user_id = ?',
    [assignment_id, userId]
  );

  const usageBatch = markingResult.usage || {};
  const estimatedCostUsdBatch = markingResult.estimated_cost_usd != null ? markingResult.estimated_cost_usd : null;
  const result = await query(
    'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current, strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id, feedback_type, feedback_verbosity, prescriptive_table, reflective_questions, critical_table, genie_output, improvement_forecast, criterion_feedback_types, overall_confidence, confidence_level, needs_review, min_criterion_confidence, has_low_criterion_confidence, marking_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      assignment_id,
      rubric_id,
      studentName,
      JSON.stringify(markingResult.scores),
      markingResult.overall_feedback,
      markingResult.total_score,
      newVersion,
      1,
      strictness_level,
      provider || null,
      markingResult.corrections && markingResult.corrections.length > 0 ? JSON.stringify(markingResult.corrections) : null,
      markingResult.language_errors && markingResult.language_errors.length > 0 ? JSON.stringify(markingResult.language_errors) : null,
      markingResult.handwriting_recognition_confidence != null ? markingResult.handwriting_recognition_confidence : null,
      usageBatch.prompt_tokens != null ? usageBatch.prompt_tokens : null,
      usageBatch.completion_tokens != null ? usageBatch.completion_tokens : null,
      usageBatch.total_tokens != null ? usageBatch.total_tokens : null,
      estimatedCostUsdBatch,
      userId,
      feedback_type,
      feedback_verbosity,
      markingResult.prescriptive_table && markingResult.prescriptive_table.length > 0 ? JSON.stringify(markingResult.prescriptive_table) : null,
      markingResult.reflective_questions && markingResult.reflective_questions.length > 0 ? JSON.stringify(markingResult.reflective_questions) : null,
      markingResult.critical_table && markingResult.critical_table.length > 0 ? JSON.stringify(markingResult.critical_table) : null,
      markingResult.genie_output && markingResult.genie_output.length > 0 ? JSON.stringify(markingResult.genie_output) : null,
      markingResult.improvement_forecast || null,
      criterion_feedback_types ? JSON.stringify(criterion_feedback_types) : null,
      markingResult.overall_confidence != null ? markingResult.overall_confidence : null,
      markingResult.confidence_level || null,
      markingResult.needs_review ? 1 : 0,
      markingResult.min_criterion_confidence != null ? markingResult.min_criterion_confidence : null,
      markingResult.has_low_criterion_confidence ? 1 : 0,
      markingOrder
    ]
  );

  const insertedId = result.lastID || result.rows?.[0]?.id;
  const reviewComments = await saveReviewComments(insertedId, markingResult);
  const markingWithId = {
    review_comments: reviewComments,
    id: insertedId,
    assignment_id,
    rubric_id,
    student_name: studentName,
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
    estimated_cost_usd: estimatedCostUsdBatch,
    feedback_type: feedback_type,
    feedback_verbosity: feedback_verbosity,
    prescriptive_table: markingResult.prescriptive_table || null,
    reflective_questions: markingResult.reflective_questions || null,
    critical_table: markingResult.critical_table || null,
    genie_output: markingResult.genie_output || null,
    improvement_forecast: markingResult.improvement_forecast || null,
    criterion_feedback_types: criterion_feedback_types || null,
    marking_order: markingOrder
  };

  if (Array.isArray(markingResult.items) && markingResult.items.length > 0) {
    if (!insertedId) {
      console.warn(`Marking result for assignment ${assignment_id} saved without an id; per-question items not stored`);
    } else {
      for (const item of markingResult.items) {
        await query(
          'INSERT INTO marking_result_items (marking_result_id, assignment_id, criterion_index, criterion_name, answer_text, answer_found, points_awarded, max_points, feedback, rubric_basis, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            insertedId,
            assignment_id,
            item.criterion_index,
            item.criterion_name,
            item.answer_text ?? null,
            item.answer_found === false ? 0 : 1,
            item.points_awarded,
            item.max_points,
            item.feedback || null,
            item.rubric_basis || null,
            item.confidence ?? null
          ]
        );
      }
    }
  }

  return markingWithId;
};

// Produce the requested output (PDF report, commented Word document or annotated PDF) for a
// saved marking result. Paths and non-fatal errors are recorded on markingWithId.
const renderMarkingOutput = async ({ markingWithId, markingResult, assignment, rubric, assignmentText, output_type, annotationDocType }) => {
  const canAnnotatePdf = isPdfDocument(getAssignmentDisplayName(assignment));

  if (output_type === 'report') {
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
  } else if (output_type === 'word_comments') {
    if (!isDocxDocument(getAssignmentDisplayName(assignment))) {
      throw new Error('Commented Word document output is only available for DOCX uploads.');
    }
    try {
      const commentedPath = getCommentedDocxPath(assignment.file_path);
      await addCommentsToDocx(assignment.file_path, commentedPath, markingResult);
      markingWithId.commented_docx_path = commentedPath;
    } catch (e) {
      console.error(`❌ Word comment insertion failed for assignment ${assignment.id}:`, e.message);
      markingWithId.annotation_error = e.message;
    }
  } else if (!canAnnotatePdf) {
    markingWithId.annotation_error = 'Inline annotation is only available for PDF files. This Word document was marked successfully.';
  } else {
    try {
      console.log(`📝 Starting PDF annotation for assignment ${assignment.id}...`);
      const batchDocType = annotationDocType || 'treatise';

      console.log('🔍 Generating anchor phrases...');
      const anchorsMap = await generateAnchorPhrases(assignmentText, markingResult, batchDocType);
      console.log('✅ Anchor phrases generated:', Object.keys(anchorsMap || {}).length, 'criteria');

      console.log('🔨 Building issues from marking result...');
      const issues = [...buildIssuesWithAnchors(markingResult, anchorsMap), ...buildReviewIssues(markingResult.review_comments)];
      console.log('✅ Issues built:', issues.length, 'issues');

      const originalPath = assignment.file_path;
      const annotatedPath = originalPath.replace(/\.pdf$/i, '.annotated.pdf');

      const annotatedDir = path.dirname(annotatedPath);
      if (!fs.existsSync(annotatedDir)) {
        fs.mkdirSync(annotatedDir, { recursive: true });
      }

      console.log('📄 Annotating PDF:', originalPath, '->', annotatedPath);
      await annotatePdfWithIssues(originalPath, annotatedPath, issues);

      if (fs.existsSync(annotatedPath)) {
        const stats = fs.statSync(annotatedPath);
        console.log(`✅ PDF annotated successfully: ${annotatedPath} (${stats.size} bytes)`);
        markingWithId.annotated_pdf_path = annotatedPath;
      } else {
        console.error('❌ Annotated PDF file was not created:', annotatedPath);
        throw new Error('Annotated PDF file was not created');
      }
    } catch (e) {
      console.error(`❌ Annotation failed for assignment ${assignment.id}:`, e.message);
      console.error('Stack trace:', e.stack);
      markingWithId.annotation_error = e.message;
    }
  }
};

// Compute comparative insight for each result once all marks in a batch are in
const applyComparativeInsights = (results) => {
  if (results.length > 1) {
    const totalPossible = results[0]?.scores?.reduce((s, c) => s + (c.max_points || 0), 0) || 0;
    const scores = results.map(r => r.total_score || 0);
    const batchAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const batchMax = Math.max(...scores);
    const batchMin = Math.min(...scores);

    for (const result of results) {
      const score = result.total_score || 0;
      const aboveCount = scores.filter(s => s < score).length;
      const percentile = Math.round((aboveCount / scores.length) * 100);
      const diff = score - batchAvg;
      const diffLabel = diff > 0
        ? `${Math.abs(diff).toFixed(1)} marks above`
        : diff < 0
        ? `${Math.abs(diff).toFixed(1)} marks below`
        : 'equal to';
      const tier = percentile >= 75 ? 'top performer in this batch'
        : percentile >= 50 ? 'above the batch average'
        : percentile >= 25 ? 'below the batch average'
        : 'in the lower quartile of this batch';

      const insight = `In this batch of ${results.length} submissions, the average score was ${batchAvg.toFixed(1)}${totalPossible ? `/${totalPossible}` : ''} (range: ${batchMin}–${batchMax}). Your score of ${score}${totalPossible ? `/${totalPossible}` : ''} is ${diffLabel} the batch average, placing you in the ${tier} (top ${100 - percentile}%).`;

      result.comparative_insight = insight;
      if (result.id) {
        query(
          'UPDATE marking_results SET comparative_insight = ? WHERE id = ?',
          [insight, result.id]
        ).catch(e => console.warn('comparative_insight update failed:', e.message));
      }
    }
  }
};

// Build the /mark/multiple response body (shared by both marking orders).
const buildBatchResponse = ({ total, results, errors, skipped }) => {
  const hasPartialSuccess = results.length > 0 && errors.length > 0;
  const allSucceeded = results.length > 0 && errors.length === 0;

  return {
    success: allSucceeded || hasPartialSuccess,
    results,
    errors,
    skipped,
    summary: {
      total,
      successful: results.length,
      failed: errors.length,
      skipped: skipped.length,
      success_rate: ((results.length / total) * 100).toFixed(1) + '%'
    },
    message: allSucceeded
      ? `Successfully marked all ${results.length} assignments`
      : hasPartialSuccess
      ? `Partially successful: ${results.length} succeeded, ${errors.length} failed`
      : `All assignments failed. ${errors.length} errors occurred.`,
    failed_assignment_ids: errors.map(e => e.assignment_id)
  };
};

// Mark a batch question by question: each question (or criterion) is marked across every
// script before moving to the next, so all answers to it are held to the same standard.
const markBatchByQuestion = async (req, res, { assignment_ids, student_names, rubric, rubric_id, settings }) => {
  const { output_type, assessment_type, document_type, level, provider, strictness_level, feedback_verbosity } = settings;
  const checkAborted = () => req.aborted || req.socket.destroyed;
  const errors = [];
  const skipped = [];
  const scripts = [];
  const prepared = new Map();

  for (let i = 0; i < assignment_ids.length; i++) {
    const assignment_id = assignment_ids[i];
    const assignmentResult = await query(
      'SELECT * FROM assignments WHERE id = ? AND user_id = ?',
      [assignment_id, req.user.id]
    );
    const assignment = Array.isArray(assignmentResult) ? assignmentResult[0] : assignmentResult.rows?.[0];
    if (!assignment) {
      errors.push({ assignment_id, error: 'Assignment not found' });
      continue;
    }
    if (assignment.status === 'completed') {
      skipped.push({ assignment_id, filename: assignment.filename, reason: 'Already marked' });
      continue;
    }
    if (assignment.media_type && (!assignment.extracted_text || String(assignment.extracted_text).trim().length === 0)) {
      errors.push({
        assignment_id,
        error: assignment.status === 'error'
          ? 'This video/audio submission failed to process and cannot be marked. Check the error and re-upload.'
          : 'This video/audio submission is still being processed (transcribing/extracting frames). Please try again shortly.'
      });
      continue;
    }
    try {
      const text = assignment.extracted_text && String(assignment.extracted_text).trim().length > 0
        ? assignment.extracted_text
        : await extractTextFromDocument(assignment.file_path, getAssignmentDisplayName(assignment));
      if (!text || text.trim().length === 0) {
        throw new Error(`No text could be extracted from the ${getSupportedDocumentLabel(getAssignmentDisplayName(assignment))}`);
      }
      await query('UPDATE assignments SET status = ? WHERE id = ?', ['processing', assignment_id]);
      scripts.push({ assignment_id, text });
      prepared.set(assignment_id, {
        assignment,
        text,
        studentName: resolveStudentName(student_names && student_names[i], assignment)
      });
    } catch (error) {
      errors.push({ assignment_id, error: error.message });
    }
  }

  const resetUnfinished = async (doneIds) => {
    for (const id of prepared.keys()) {
      if (!doneIds.has(id)) {
        await query('UPDATE assignments SET status = ? WHERE id = ?', ['uploaded', id]);
      }
    }
  };

  const results = [];
  const done = new Set();
  try {
    if (scripts.length > 0) {
      const isMemo = rubric?.rubric_type === 'answer_key' || await detectMemo(buildRubricText(rubric));
      const documentType = isMemo ? 'memo' : (assessment_type || document_type || 'assignment');
      const { markByQuestion } = createQuestionMarker({ provider, documentType });
      const outcome = await markByQuestion({
        scripts,
        rubric,
        isMemo,
        level,
        strictnessLevel: strictness_level,
        feedbackVerbosity: feedback_verbosity,
        isCancelled: checkAborted
      });

      if (outcome.cancelled) {
        return res.status(499).json({
          success: false,
          cancelled: true,
          message: 'Marking request was cancelled',
          results,
          errors,
          skipped
        });
      }
      errors.push(...outcome.errors);

      for (const { assignment_id } of scripts) {
        const markingResult = outcome.results.get(assignment_id);
        if (!markingResult) continue;
        const { assignment, text, studentName } = prepared.get(assignment_id);
        try {
          const markingWithId = await saveMarkingResult({
            userId: req.user.id,
            assignment_id,
            rubric_id,
            studentName,
            markingResult,
            settings: { strictness_level, provider, feedback_type: 'standard', feedback_verbosity, criterion_feedback_types: null },
            markingOrder: 'question'
          });
          markingWithId.items = markingResult.items;
          await renderMarkingOutput({
            markingWithId,
            markingResult,
            assignment,
            rubric,
            assignmentText: text,
            output_type,
            annotationDocType: assessment_type || document_type
          });
          await query('UPDATE assignments SET status = ? WHERE id = ?', ['completed', assignment_id]);
          done.add(assignment_id);
          results.push(markingWithId);
        } catch (error) {
          console.error(`Error saving question-by-question result for assignment ${assignment_id}:`, error);
          errors.push({ assignment_id, error: error.message });
        }
      }
    }
  } finally {
    await resetUnfinished(done);
  }

  applyComparativeInsights(results);
  return res.json(buildBatchResponse({ total: assignment_ids.length, results, errors, skipped }));
};

// Rubric text used for memo detection; matches what generateMarking() inspects.
const buildRubricText = (rubric) => {
  let criteria = rubric?.criteria;
  if (typeof criteria === 'string') {
    try { criteria = JSON.parse(criteria); } catch (e) { /* use the raw string below */ }
  }
  const body = Array.isArray(criteria)
    ? criteria.map(c => `${c.name || ''} ${c.description || ''} ${c.levels ? c.levels.map(l => l.description || '').join(' ') : ''}`).join(' ')
    : JSON.stringify(criteria || []);
  return `${rubric?.name || ''} ${body}`;
};

// Debug endpoint to test marking functionality
router.post('/debug', requireAuth, async (req, res) => {
  try {
    console.log('🔍 Debug marking endpoint called');
    const { assignment_id, rubric_id } = req.body;

    if (!assignment_id || !rubric_id) {
      return res.status(400).json({ error: 'assignment_id and rubric_id are required' });
    }

    const assignmentResult = await query(
      'SELECT * FROM assignments WHERE id = ? AND user_id = ?',
      [assignment_id, req.user.id]
    );

    console.log('Assignment query result:', JSON.stringify(assignmentResult, null, 2));

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

    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    );

    console.log('Rubric query result:', JSON.stringify(rubricResult, null, 2));

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

    const rubricData = {
      ...rubric,
      criteria: rubric.criteria
    };

    console.log('📋 Assignment:', assignment);
    console.log('📋 Rubric:', rubricData);

    let assignmentText;
    try {
      assignmentText = await extractTextFromDocument(assignment.file_path, getAssignmentDisplayName(assignment));
    } catch (error) {
      return res.status(500).json({
        error: 'Document extraction failed',
        details: error.message
      });
    }

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

// ---------------------------------------------------------------------------
// Anchor phrase utilities (used by /single and /multiple route handlers)
// ---------------------------------------------------------------------------

const generateAnchorPhrases = async (documentText, markingResult, documentType = 'treatise') => {
  const candidates = getDocumentAnchorCandidates(documentText);
  const heuristicAnchors = buildHeuristicAnchorsMap(documentText, markingResult, candidates);
  const normalizedDocument = String(documentText || '').replace(/\s+/g, ' ').toLowerCase();
  const inDocument = (quote) => normalizedDocument.includes(String(quote).replace(/\s+/g, ' ').trim().toLowerCase());

  try {
    const config = aiConfig.getConfig(documentType);
    const map = new Map();
    const anchorConfig = aiConfig.getTaskConfig('anchorExtraction', config.provider);
    const scoreChunks = chunkArray(markingResult?.scores || [], 6);

    for (const scoreChunk of scoreChunks) {
      // The passages that best match these criteria, from anywhere in the document (not just its start).
      const passages = [];
      for (const score of scoreChunk) {
        for (const candidate of rankAnchorCandidates(candidates, score, 8)) {
          if (!passages.includes(candidate)) passages.push(candidate);
        }
      }
      const excerpt = passages.length
        ? passages.join('\n').slice(0, 8000)
        : String(documentText || '').slice(0, 4000);
      const compactScores = scoreChunk.map((s) => ({
        criterion_name: s.criterion_name,
        feedback: (s.feedback || '').slice(0, 220)
      }));

      const anchorPrompt = `Return exact anchor quotes for PDF comments.
Use only the excerpt below.
For each criterion, return up to 2 exact quotes copied verbatim from the excerpt, choosing the text the feedback is about.
Each quote must be 8 to 120 characters.
Return JSON only:
{"anchors":[{"criterion_name":"...","quotes":["exact quote"]}]}

EXCERPT:
${excerpt}

CRITERIA:
${JSON.stringify(compactScores)}`;

      const result = await aiService.createCompletionWithRetry({
        provider: anchorConfig.provider,
        model: anchorConfig.model,
        messages: [{ role: 'user', content: anchorPrompt }],
        temperature: anchorConfig.temperature,
        maxTokens: anchorConfig.maxTokens
      }, 2);

      const parsed = parseAiJsonResponse(result.content || '').parsed;
      for (const item of parsed.anchors || []) {
        if (!item?.criterion_name || !Array.isArray(item.quotes)) continue;
        const filteredQuotes = item.quotes.filter((q) => typeof q === 'string' && q.length >= 8 && q.length <= 160 && inDocument(q));
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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// Mark a single assignment
router.post('/single', requireAuth, async (req, res) => {
  try {
    const { assignment_id, rubric_id, student_name, document_type, output_type = 'annotate', assessment_type, level, provider, strictness_level = 'strict', mark_as_image = false, feedback_type = 'standard', feedback_verbosity = 'standard', criterion_feedback_types = null } = req.body;

    if (!assignment_id || !rubric_id) {
      return res.status(400).json({
        error: 'Missing required fields: assignment_id, rubric_id'
      });
    }

    const checkAborted = () => req.aborted || req.socket.destroyed;

    const assignmentResult = await query(
      'SELECT * FROM assignments WHERE id = ?',
      [assignment_id]
    );

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
    if (assignment.media_type && (!assignment.extracted_text || String(assignment.extracted_text).trim().length === 0)) {
      return res.status(409).json({
        error: assignment.status === 'error'
          ? 'This video/audio submission failed to process and cannot be marked. Check the error and re-upload.'
          : 'This video/audio submission is still being processed (transcribing/extracting frames). Please try again shortly.'
      });
    }
    const resolvedStudentName = resolveStudentName(student_name, assignment);

    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    );

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

    if (checkAborted()) {
      return res.status(499).json({
        success: false,
        cancelled: true,
        message: 'Marking request was cancelled'
      });
    }

    await query(
      'UPDATE assignments SET status = ? WHERE id = ?',
      ['processing', assignment_id]
    );

    try {
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
        if (!isPdfDocument(getAssignmentDisplayName(assignment))) {
          throw new Error('Mark as image is only available for PDF files. DOCX Word documents are marked from extracted text.');
        }
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
        assignmentText = assignment.extracted_text && String(assignment.extracted_text).trim().length > 0
          ? assignment.extracted_text
          : await extractTextFromDocument(assignment.file_path, getAssignmentDisplayName(assignment));
        if (!assignmentText || assignmentText.trim().length === 0) {
          throw new Error(`No text could be extracted from the ${getSupportedDocumentLabel(getAssignmentDisplayName(assignment))}`);
        }
        if (assignment.media_type === 'video') {
          assignmentImages = loadPersistedFrameImagesAsBase64(assignment.media_frame_paths);
        }
      }

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

      const docType = assessment_type || document_type || inferDocumentTypeFromAssignment(assignment);
      const mediaMode = assignment.media_type === 'video' ? 'video' : null;
      const markingResult = await generateMarking(assignmentText, rubric, docType, level, provider, strictness_level, assignment_id, assignmentImages, feedback_type, feedback_verbosity, criterion_feedback_types, mediaMode);

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

      await prepareReviewComments({ markingResult, assignment, assignmentText, docType, rubric, provider });

      const versionResult = await query(
        'SELECT COALESCE(MAX(version), 0) as max_version FROM marking_results WHERE assignment_id = ?',
        [assignment_id]
      );
      const maxVersion = versionResult.rows?.[0]?.max_version || versionResult?.[0]?.max_version || 0;
      const newVersion = maxVersion + 1;

      await query(
        'UPDATE marking_results SET is_current = 0 WHERE assignment_id = ? AND user_id = ?',
        [assignment_id, req.user.id]
      );

      const usage = markingResult.usage || {};
      const estimatedCostUsd = markingResult.estimated_cost_usd != null ? markingResult.estimated_cost_usd : null;
      const result = await query(
        'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current, strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id, feedback_type, feedback_verbosity, prescriptive_table, reflective_questions, critical_table, genie_output, improvement_forecast, criterion_feedback_types, overall_confidence, confidence_level, needs_review, min_criterion_confidence, has_low_criterion_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          assignment_id,
          rubric_id,
          resolvedStudentName,
          JSON.stringify(markingResult.scores),
          markingResult.overall_feedback,
          markingResult.total_score,
          newVersion,
          1,
          strictness_level,
          provider || null,
          markingResult.corrections && markingResult.corrections.length > 0 ? JSON.stringify(markingResult.corrections) : null,
          markingResult.language_errors && markingResult.language_errors.length > 0 ? JSON.stringify(markingResult.language_errors) : null,
          markingResult.handwriting_recognition_confidence != null ? markingResult.handwriting_recognition_confidence : null,
          usage.prompt_tokens != null ? usage.prompt_tokens : null,
          usage.completion_tokens != null ? usage.completion_tokens : null,
          usage.total_tokens != null ? usage.total_tokens : null,
          estimatedCostUsd,
          req.user.id,
          feedback_type,
          feedback_verbosity,
          markingResult.prescriptive_table && markingResult.prescriptive_table.length > 0 ? JSON.stringify(markingResult.prescriptive_table) : null,
          markingResult.reflective_questions && markingResult.reflective_questions.length > 0 ? JSON.stringify(markingResult.reflective_questions) : null,
          markingResult.critical_table && markingResult.critical_table.length > 0 ? JSON.stringify(markingResult.critical_table) : null,
          markingResult.genie_output && markingResult.genie_output.length > 0 ? JSON.stringify(markingResult.genie_output) : null,
          markingResult.improvement_forecast || null,
          criterion_feedback_types ? JSON.stringify(criterion_feedback_types) : null,
          markingResult.overall_confidence != null ? markingResult.overall_confidence : null,
          markingResult.confidence_level || null,
          markingResult.needs_review ? 1 : 0,
          markingResult.min_criterion_confidence != null ? markingResult.min_criterion_confidence : null,
          markingResult.has_low_criterion_confidence ? 1 : 0
        ]
      );

      const insertedId = result.lastID || result.rows?.[0]?.id;
      const reviewComments = await saveReviewComments(insertedId, markingResult);
      const markingWithId = {
        review_comments: reviewComments,
        id: insertedId,
        assignment_id,
        rubric_id,
        student_name: resolvedStudentName,
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
        estimated_cost_usd: estimatedCostUsd,
        feedback_type: feedback_type,
        feedback_verbosity: feedback_verbosity,
        prescriptive_table: markingResult.prescriptive_table || null,
        reflective_questions: markingResult.reflective_questions || null,
        critical_table: markingResult.critical_table || null,
        genie_output: markingResult.genie_output || null,
        improvement_forecast: markingResult.improvement_forecast || null,
        criterion_feedback_types: criterion_feedback_types || null
      };

      const canAnnotatePdf = isPdfDocument(getAssignmentDisplayName(assignment));

      if (output_type === 'report') {
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
      } else if (output_type === 'word_comments') {
        if (!isDocxDocument(getAssignmentDisplayName(assignment))) {
          throw new Error('Commented Word document output is only available for DOCX uploads.');
        }
        try {
          const commentedPath = getCommentedDocxPath(assignment.file_path);
          await addCommentsToDocx(assignment.file_path, commentedPath, markingResult);
          markingWithId.commented_docx_path = commentedPath;
        } catch (e) {
          console.error('❌ Word comment insertion failed:', e.message);
          markingWithId.annotation_error = e.message;
        }
      } else if (!canAnnotatePdf) {
        markingWithId.annotation_error = 'Inline annotation is only available for PDF files. This Word document was marked successfully.';
      } else {
        try {
          console.log('📝 Starting PDF annotation process...');

          console.log('🔍 Generating anchor phrases...');
          const anchorsMap = await generateAnchorPhrases(assignmentText, markingResult, docType || 'treatise');
          console.log('✅ Anchor phrases generated:', Object.keys(anchorsMap || {}).length, 'criteria');

          console.log('🔨 Building issues from marking result...');
          const issues = [...buildIssuesWithAnchors(markingResult, anchorsMap), ...buildReviewIssues(markingResult.review_comments)];
          console.log('✅ Issues built:', issues.length, 'issues');

          const originalPath = assignment.file_path;
          const annotatedPath = originalPath.replace(/\.pdf$/i, '.annotated.pdf');

          const annotatedDir = path.dirname(annotatedPath);
          if (!fs.existsSync(annotatedDir)) {
            fs.mkdirSync(annotatedDir, { recursive: true });
          }

          console.log('📄 Annotating PDF:', originalPath, '->', annotatedPath);
          await annotatePdfWithIssues(originalPath, annotatedPath, issues);

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
          markingWithId.annotation_error = e.message;
        }
      }

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

    const assignmentResult = await query(
      'SELECT * FROM assignments WHERE id = ?',
      [assignment_id]
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    const assignment = assignmentResult.rows[0];
    const resolvedStudentName = resolveStudentName(student_name, assignment);

    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    );

    if (rubricResult.rows.length === 0) {
      return res.status(404).json({ error: 'Rubric not found' });
    }

    const rubric = rubricResult.rows[0];

    if (!Array.isArray(scores)) {
      return res.status(400).json({ error: 'Scores must be an array' });
    }

    const total_score = scores.reduce((sum, score) => {
      return sum + (score.points_awarded || 0);
    }, 0);

    if (total_score > rubric.total_points) {
      return res.status(400).json({
        error: `Total score (${total_score}) cannot exceed rubric total points (${rubric.total_points})`
      });
    }

    await query(
      'UPDATE assignments SET status = ? WHERE id = ?',
      ['processing', assignment_id]
    );

    try {
      const result = await query(
        'INSERT INTO marking_results (assignment_id, rubric_id, student_name, scores, feedback, total_score, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          assignment_id,
          rubric_id,
          resolvedStudentName,
          JSON.stringify(scores),
          overall_feedback || 'Manual marking completed',
          total_score,
          req.user.id
        ]
      );

      const insertedId = result.lastID || result.rows?.[0]?.id;
      const markingWithId = {
        id: insertedId,
        assignment_id,
        rubric_id,
        student_name: resolvedStudentName,
        scores: scores,
        feedback: overall_feedback || 'Manual marking completed',
        total_score: total_score,
        marked_at: new Date().toISOString()
      };

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
    const { assignment_ids, rubric_id, student_names, document_type, output_type = 'annotate', assessment_type, level, provider, strictness_level = 'strict', mark_as_image = false, feedback_type = 'standard', feedback_verbosity = 'standard', criterion_feedback_types = null, marking_order = 'script' } = req.body;

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

    const rubricResult = await query(
      'SELECT * FROM rubrics WHERE id = ? AND user_id = ?',
      [rubric_id, req.user.id]
    );

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

    if (marking_order === 'question') {
      if (mark_as_image) {
        return res.status(400).json({
          error: 'Question-by-question marking works from extracted text. Turn off "Mark as image" or use script-by-script marking.'
        });
      }
      return await markBatchByQuestion(req, res, {
        assignment_ids,
        student_names,
        rubric,
        rubric_id,
        settings: { output_type, assessment_type, document_type, level, provider, strictness_level, feedback_verbosity }
      });
    }

    const results = [];
    const errors = [];
    const skipped = [];

    const checkAborted = () => {
      if (req.aborted || req.socket.destroyed) {
        return true;
      }
      return false;
    };

    for (let i = 0; i < assignment_ids.length; i++) {
      if (checkAborted()) {
        console.log('⚠️  Marking request was cancelled by client');
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
        const assignmentResult = await query(
          'SELECT * FROM assignments WHERE id = ? AND user_id = ?',
          [assignment_id, req.user.id]
        );

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
        if (assignment.status === 'completed') {
          skipped.push({ assignment_id, filename: assignment.filename, reason: 'Already marked' });
          continue;
        }
        if (assignment.media_type && (!assignment.extracted_text || String(assignment.extracted_text).trim().length === 0)) {
          errors.push({
            assignment_id,
            error: assignment.status === 'error'
              ? 'This video/audio submission failed to process and cannot be marked. Check the error and re-upload.'
              : 'This video/audio submission is still being processed (transcribing/extracting frames). Please try again shortly.'
          });
          continue;
        }
        const resolvedStudentName = resolveStudentName(student_name, assignment);

        if (checkAborted()) {
          console.log(`⚠️  Request cancelled before processing assignment ${assignment_id}`);
          errors.push({ assignment_id, error: 'Request was cancelled' });
          continue;
        }

        await query(
          'UPDATE assignments SET status = ? WHERE id = ?',
          ['processing', assignment_id]
        );

        try {
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
            if (!isPdfDocument(getAssignmentDisplayName(assignment))) {
              throw new Error('Mark as image is only available for PDF files. DOCX Word documents are marked from extracted text.');
            }
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
            assignmentText = assignment.extracted_text && String(assignment.extracted_text).trim().length > 0
              ? assignment.extracted_text
              : await extractTextFromDocument(assignment.file_path, getAssignmentDisplayName(assignment));
            if (!assignmentText || assignmentText.trim().length === 0) {
              throw new Error(`No text could be extracted from the ${getSupportedDocumentLabel(getAssignmentDisplayName(assignment))}`);
            }
            if (assignment.media_type === 'video') {
              assignmentImages = loadPersistedFrameImagesAsBase64(assignment.media_frame_paths);
            }
          }

          if (checkAborted()) {
            await query(
              'UPDATE assignments SET status = ? WHERE id = ?',
              ['uploaded', assignment_id]
            );
            errors.push({ assignment_id, error: 'Request was cancelled' });
            continue;
          }

          const docType = assessment_type || document_type || inferDocumentTypeFromAssignment(assignment);
          const mediaMode = assignment.media_type === 'video' ? 'video' : null;
          const markingResult = await generateMarking(assignmentText, rubric, docType, level, provider, strictness_level, assignment_id, assignmentImages, feedback_type, feedback_verbosity, criterion_feedback_types, mediaMode);

          if (checkAborted()) {
            await query(
              'UPDATE assignments SET status = ? WHERE id = ?',
              ['uploaded', assignment_id]
            );
            errors.push({ assignment_id, error: 'Request was cancelled after marking' });
            continue;
          }

          await prepareReviewComments({ markingResult, assignment, assignmentText, docType, rubric, provider });

          const markingWithId = await saveMarkingResult({
            userId: req.user.id,
            assignment_id,
            rubric_id,
            studentName: resolvedStudentName,
            markingResult,
            settings: { strictness_level, provider, feedback_type, feedback_verbosity, criterion_feedback_types }
          });

          await renderMarkingOutput({
            markingWithId,
            markingResult,
            assignment,
            rubric,
            assignmentText,
            output_type,
            annotationDocType: assessment_type || document_type
          });

          await query(
            'UPDATE assignments SET status = ? WHERE id = ?',
            ['completed', assignment_id]
          );

          results.push(markingWithId);
        } catch (processingError) {
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

    applyComparativeInsights(results);

    res.json(buildBatchResponse({ total: assignment_ids.length, results, errors, skipped }));
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

    const resultQuery = await query(
      'SELECT assignment_id FROM marking_results WHERE id = ?',
      [result_id]
    );

    if (!resultQuery.rows || resultQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Marking result not found' });
    }

    const assignment_id = resultQuery.rows[0].assignment_id;

    await query(
      'UPDATE marking_results SET is_current = 0 WHERE assignment_id = ?',
      [assignment_id]
    );

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
