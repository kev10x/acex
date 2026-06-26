const rateLimit = require('express-rate-limit');
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { query } = require('../database/connection');
const aiService = require('../services/aiService');
const aiConfig = require('../config/ai-config');
const { requireAuth, requireFeature, optionalAuth, requireRoles } = require('../middleware/auth');
const { buildMoodleXml, buildScormPackage } = require('../services/assessmentExport');
const { runOpenAIBatchPollingCycle } = require('../services/openaiBatchMarkingService');
const contentService = require('../services/contentService');
const {
  estimateGenerationUsageCost,
  inferGenerationErrorType,
  logGenerationTelemetry,
  persistGenerationTelemetryEvent,
} = require('../services/generationTelemetryService');
const { buildEducationLevelPromptBlock, buildAcademicWritingGuidance } = require('../services/educationLevelService');
const { createGenerationJob, updateGenerationJob, JOB_STATUS } = require('../services/generationJobService');
const { resolvePromptRegistryVersion } = require('../services/promptRegistryService');
const { assertWithinBudgetOrThrow } = require('../services/budgetGuardrailService');

const router = express.Router();
const isMySQLDb = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const SUPER_ADMIN_EMAIL = 'kkativu@gmail.com';
const ASSESSMENT_AUDIO_DIR = path.join(__dirname, '..', 'uploads', 'assessment-audio');
const isSuperAdmin = (user) => String(user?.email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL;

try {
  fsSync.mkdirSync(ASSESSMENT_AUDIO_DIR, { recursive: true });
} catch (_) {}

const ASSESSMENT_CONTEXT_LIMITS = {
  assignmentPreview: 320,
  rubricDescription: 140,
  rubricLevelDescription: 90,
  topicSummary: 900
};

/**
 * Attempt to repair common JSON syntax errors from AI responses.
 * @param {string} jsonStr - The potentially malformed JSON string
 * @returns {string} - Repaired JSON string or original if unrepairable
 */
function repairJson(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return jsonStr;

  let repaired = jsonStr.trim();

  // Remove trailing commas before closing braces/brackets
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

  // Fix missing commas between properties (common AI truncation issue)
  // Look for patterns like "value"}"property": or "value"]"property":
  repaired = repaired.replace(/("[^"]*")\s*([}\]])\s*"([^"]*)":/g, '$1$2,"$3":');

  // Fix incomplete objects - if ends with a property without closing, try to close it
  if (repaired.endsWith(':')) {
    repaired = repaired.slice(0, -1) + ': null}';
  }

  // Fix unclosed strings - if odd number of quotes at end, close the string
  const quoteCount = (repaired.match(/"/g) || []).length;
  if (quoteCount % 2 === 1) {
    repaired += '"';
  }

  // Handle incomplete array elements - if ends with [" or , " without closing
  if (repaired.match(/\[[\s\S]*"[^"]*$/) && !repaired.endsWith(']')) {
    // Find the last incomplete array and complete it
    const lastArrayMatch = repaired.match(/(":\s*\[[\s\S]*"[^"]*)$/);
    if (lastArrayMatch) {
      const arrayPart = lastArrayMatch[1];
      const completeArray = arrayPart + '"]';
      repaired = repaired.replace(lastArrayMatch[1], completeArray);
    }
  }

  // Handle incomplete object properties - if ends with ,"key": without value
  if (repaired.match(/"[^"]*":\s*$/)) {
    repaired = repaired.replace(/"([^"]*)":\s*$/, '"$1": null}');
  }

  // Try to complete incomplete JSON structures
  const openBraces = (repaired.match(/{/g) || []).length;
  const closeBraces = (repaired.match(/}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;

  // Add missing closing braces
  for (let i = 0; i < openBraces - closeBraces; i++) {
    repaired += '}';
  }

  // Add missing closing brackets
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    repaired += ']';
  }

  // If it still doesn't start with {, wrap it
  if (!repaired.trim().startsWith('{')) {
    repaired = '{' + repaired + '}';
  }

  return repaired;
}

function generateCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

function generateSubmissionCode() {
  return crypto.randomBytes(9).toString('base64url').slice(0, 12);
}

function rowList(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'admin') return 'management';
  if (r === 'user') return 'lecturer';
  return r || 'lecturer';
}

function getIdentityScope(req) {
  const role = normalizeRole(req.user?.role);
  if (role === 'management') {
    const applyOrgScope = !isSuperAdmin(req.user);
    if (!applyOrgScope) {
      return { role, applyOrgScope: false, empty: false, scopeClause: '', scopeParams: [] };
    }
    if (req.user.organisation_id == null) {
      return { role, applyOrgScope: true, empty: true, scopeClause: '', scopeParams: [] };
    }
    return {
      role,
      applyOrgScope: true,
      empty: false,
      scopeClause: isMySQLDb() ? ' AND owner.organisation_id = ?' : ' AND owner.organisation_id = $1',
      scopeParams: [req.user.organisation_id]
    };
  }
  return {
    role,
    applyOrgScope: false,
    empty: false,
    scopeClause: isMySQLDb() ? ' AND owner.id = ?' : ' AND owner.id = $1',
    scopeParams: [req.user.id]
  };
}

async function moduleBelongsToUser(moduleId, userId) {
  const row = isMySQLDb()
    ? await query('SELECT id, user_id FROM modules WHERE id = ? AND user_id = ?', [moduleId, userId])
    : await query('SELECT id, user_id FROM modules WHERE id = $1 AND user_id = $2', [moduleId, userId]);
  return rowList(row)[0] || null;
}

async function getOrCreateModuleId(userId, name) {
  const cleanName = String(name || '').trim().slice(0, 255);
  if (!cleanName) return null;
  const existing = isMySQLDb()
    ? await query('SELECT id FROM modules WHERE user_id = ? AND name = ?', [userId, cleanName])
    : await query('SELECT id FROM modules WHERE user_id = $1 AND name = $2', [userId, cleanName]);
  const existingRow = rowList(existing)[0];
  if (existingRow) return existingRow.id;
  const inserted = isMySQLDb()
    ? await query('INSERT INTO modules (user_id, name) VALUES (?, ?)', [userId, cleanName])
    : await query('INSERT INTO modules (user_id, name) VALUES ($1, $2) RETURNING id', [userId, cleanName]);
  const insertedRow = rowList(inserted)[0];
  return insertedRow?.id ?? inserted.insertId ?? inserted.lastID ?? null;
}

async function addItemToModule(moduleId, userId, itemType, itemId, snapshotTitle, snapshotCode) {
  if (!Number.isFinite(moduleId) || moduleId <= 0) return;
  const moduleRow = await moduleBelongsToUser(moduleId, userId);
  if (!moduleRow) return;
  const maxQ = isMySQLDb()
    ? await query('SELECT COALESCE(MAX(position), -1) AS max_position FROM module_items WHERE module_id = ?', [moduleId])
    : await query('SELECT COALESCE(MAX(position), -1) AS max_position FROM module_items WHERE module_id = $1', [moduleId]);
  const nextPos = Number(rowList(maxQ)[0]?.max_position ?? -1) + 1;
  try {
    if (isMySQLDb()) {
      await query(
        `INSERT INTO module_items (module_id, item_type, item_id, snapshot_title, snapshot_code, position, section_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [moduleId, itemType, itemId, snapshotTitle, snapshotCode, nextPos, -1]
      );
    } else {
      await query(
        `INSERT INTO module_items (module_id, item_type, item_id, snapshot_title, snapshot_code, position, section_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [moduleId, itemType, itemId, snapshotTitle, snapshotCode, nextPos, -1]
      );
    }
  } catch (err) {
    if (!(err?.code === 'ER_DUP_ENTRY' || String(err?.message || '').toLowerCase().includes('unique'))) {
      throw err;
    }
  }
}

async function ensurePublishedAssessmentBatch(publishedAssessment, assessment) {
  if (publishedAssessment.batch_id) {
    return publishedAssessment.batch_id;
  }

  const title = String(assessment?.title || 'Published Assessment').trim();
  const batchName = `Assessment Submissions - ${title}`.slice(0, 255);
  const description = `Auto-managed submissions batch for assessment code ${publishedAssessment.code}`;
  const createResult = await query(
    'INSERT INTO batches (name, description, user_id) VALUES (?, ?, ?)',
    [batchName, description, publishedAssessment.user_id]
  );
  const batchId = createResult.insertId ?? createResult.lastID ?? createResult.rows?.[0]?.id;

  await query(
    'UPDATE published_assessments SET batch_id = ? WHERE id = ?',
    [batchId, publishedAssessment.id]
  );

  publishedAssessment.batch_id = batchId;
  return batchId;
}

async function ensureQueuedAssessmentBatchJob({ batchId, rubricId, userId }) {
  const existingJobResult = await query(
    `SELECT id
     FROM marking_jobs
     WHERE batch_id = ? AND rubric_id = ? AND user_id = ?
       AND provider = ? AND processing_mode = ? AND status = ?
       AND openai_batch_id IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [batchId, rubricId, userId, 'openai', 'openai_batch', 'scheduled']
  );
  const existingJob = Array.isArray(existingJobResult)
    ? existingJobResult[0]
    : (existingJobResult.rows?.[0] || existingJobResult?.[0]);

  if (existingJob?.id) {
    return existingJob.id;
  }

  const jobInsert = await query(
    `INSERT INTO marking_jobs (
      batch_id, rubric_id, user_id, provider, processing_mode, status, scheduled_for, total_count
    ) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
    [batchId, rubricId, userId, 'openai', 'openai_batch', 'scheduled', 0]
  );
  return jobInsert.insertId ?? jobInsert.lastID ?? jobInsert.rows?.[0]?.id ?? null;
}

function buildAssessmentScriptText(questions, answers) {
  const answerMap = new Map(answers.map((a) => [a.question_number, a.value]));
  const scriptLines = questions.map((q) => {
    const num = q.number != null ? q.number : q.question_number;
    const ans = answerMap.get(num) ?? answerMap.get(Number(num)) ?? '';
    return `Question ${num}: ${ans}`;
  });
  return scriptLines.join('\n\n');
}

function parseAssessmentSubmissionResult(row) {
  const scores = typeof row.scores === 'string' ? JSON.parse(row.scores) : (row.scores || []);
  const feedback = row.effective_feedback || row.feedback || '';
  const totalScore = row.effective_total_score ?? row.total_score ?? 0;

  return {
    total_score: totalScore,
    feedback,
    scores,
    marked_at: row.marked_at || row.completed_at || null
  };
}

function getPublishedAssessmentAudioCachePath(code, questionIndex, voiceId, language, narrationText) {
  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify({ code, questionIndex, voiceId, language, narrationText }))
    .digest('hex');
  return path.join(ASSESSMENT_AUDIO_DIR, `${cacheKey}.mp3`);
}

function buildAssessmentQuestionNarrationText(assessment, questionIndex) {
  const questions = Array.isArray(assessment?.questions) ? assessment.questions : [];
  const question = questions[questionIndex];
  if (!question) return '';

  const number = question.number != null ? question.number : question.question_number != null ? question.question_number : questionIndex + 1;
  const type = String(question.type || 'short_answer').replace(/-/g, '_');
  const parts = [
    assessment?.title ? `Assessment title: ${assessment.title}.` : '',
    `Question ${number}.`,
    question.question ? String(question.question).trim() : '',
  ];

  if (Array.isArray(question.options) && question.options.length > 0) {
    parts.push('Answer choices:');
    question.options.forEach((option, optionIndex) => {
      const optionLabel = String.fromCharCode(65 + optionIndex);
      parts.push(`Option ${optionLabel}. ${String(option || '').trim()}`);
    });
  }

  if (type === 'mix_and_match') {
    const leftColumn = Array.isArray(question.left_column) ? question.left_column : [];
    const rightColumn = Array.isArray(question.right_column) ? question.right_column : [];
    if (leftColumn.length > 0) {
      parts.push('Prompts to match:');
      leftColumn.forEach((item, itemIndex) => {
        parts.push(`Prompt ${itemIndex + 1}. ${String(item || '').trim()}`);
      });
    }
    if (rightColumn.length > 0) {
      parts.push('Available matches:');
      rightColumn.forEach((item, itemIndex) => {
        const optionLabel = String.fromCharCode(65 + itemIndex);
        parts.push(`Choice ${optionLabel}. ${String(item || '').trim()}`);
      });
    }
  }

  return parts.filter(Boolean).join('\n\n').trim();
}

function normalizeContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        if (typeof part.value === 'string') return part.value;
        return '';
      })
      .join('');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

function extractTextFromCompletion(completion) {
  const candidates = [];

  if (completion) {
    candidates.push(normalizeContentToText(completion.content));
    candidates.push(normalizeContentToText(completion.output_text));

    if (Array.isArray(completion.choices)) {
      for (const choice of completion.choices) {
        candidates.push(normalizeContentToText(choice?.message?.content));
        candidates.push(normalizeContentToText(choice?.text));
      }
    }
  }

  return candidates
    .map((c) => (c == null ? '' : String(c)).trim())
    .find((c) => c.length > 0) || '';
}

function extractLikelyJSON(rawText) {
  let cleaned = String(rawText || '').trim();
  if (!cleaned) return '';

  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return cleaned.trim();
}

function parseJsonSafe(value, fallback = null) {
  try {
    if (value == null) return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return fallback;
  }
}

function parseAssessmentJSONFromCompletion(completion) {
  const responseText = extractTextFromCompletion(completion);
  const finishReason = completion?.choices?.[0]?.finish_reason;

  if (!responseText) {
    if (finishReason === 'length') {
      throw new Error('AI response was truncated before JSON output (finish_reason=length). Increase maxTokens for assessment generation.');
    }
    throw new Error('AI returned an empty response.');
  }

  const cleanResponse = extractLikelyJSON(responseText);
  if (!cleanResponse) {
    throw new Error('AI returned text, but no JSON object could be extracted.');
  }

  try {
    return JSON.parse(cleanResponse);
  } catch (parseError) {
    // Try multiple repair strategies
    let parsed = null;
    const repairStrategies = [
      // Strategy 1: Standard repair
      () => repairJson(cleanResponse),
      // Strategy 2: More aggressive bracket/brace completion
      (str) => {
        let repaired = str;
        const openBraces = (repaired.match(/{/g) || []).length;
        const closeBraces = (repaired.match(/}/g) || []).length;
        const openBrackets = (repaired.match(/\[/g) || []).length;
        const closeBrackets = (repaired.match(/\]/g) || []).length;
        for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}';
        for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']';
        return repaired;
      },
      // Strategy 3: Extract partial JSON if possible
      (str) => {
        // Try to find the last complete property and truncate there
        const lines = str.split('\n');
        let lastValidLine = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.endsWith('}') || line.endsWith(']') || line.endsWith(',') || line.match(/"[^"]*":\s*"[^"]*"$/)) {
            lastValidLine = i;
            break;
          }
        }
        if (lastValidLine >= 0) {
          return lines.slice(0, lastValidLine + 1).join('\n') + '}';
        }
        return str;
      }
    ];

    for (const strategy of repairStrategies) {
      try {
        const repairedJson = strategy(cleanResponse);
        if (repairedJson !== cleanResponse) {
          parsed = JSON.parse(repairedJson);
          console.warn('Assessment JSON repaired using strategy');
          return parsed;
        }
      } catch (strategyErr) {
        // Continue to next strategy
      }
    }

    // All repair strategies failed
    const preview = cleanResponse.slice(0, 500);
    throw new Error(`Failed to parse AI response as JSON (${parseError.message}). Preview: ${preview}`);
  }
}

/**
 * Generate a new assessment based on existing assignment data in the database
 * This uses stored assignment text, rubrics, and marking patterns to create new assessments
 */
router.post('/generate', requireAuth, requireFeature('assessment_creation'), async (req, res) => {
  const requestStartedAt = Date.now();
  const projectedCostUsd = 0.08;
  let telemetryProvider = null;
  let telemetryModel = null;
  let telemetryUsage = null;
  let promptTrace = null;
  let generationJobId = null;
  try {
    try {
      await assertWithinBudgetOrThrow({
        userId: req.user.id,
        projectedCostUsd,
        generationType: 'assessment generation',
      });
    } catch (budgetError) {
      if (budgetError?.code === 'BUDGET_GUARDRAIL_EXCEEDED') {
        return res.status(budgetError.statusCode || 429).json({
          error: budgetError.message,
          code: budgetError.code,
          budget_status: budgetError.budget_status || null,
        });
      }
      throw budgetError;
    }

    generationJobId = await createGenerationJob({
      user_id: req.user.id,
      job_type: 'assessment_generation',
      status: JOB_STATUS.PROCESSING,
      source_route: '/assessments/generate',
      payload: req.body || {},
    });
    if (generationJobId) {
      await updateGenerationJob(generationJobId, { started_at: new Date() });
    }
    const {
      rubric_id,
      content_id = null,
      custom_topics = null, // When set, topics come from this list; rubric_id/content_id is optional
      level = null, // e.g. Grade 10, Undergraduate
      difficulty_level = 'moderate',
      question_count = 5,
      assessment_type = 'assignment',
      use_existing_patterns = true,
      topic = null,
      question_types = ['mix']
    } = req.body;

    const useCustomTopics = custom_topics && String(custom_topics).trim().length > 0;
    const useContentItem = content_id != null && Number(content_id) > 0;
    if (!useCustomTopics && !rubric_id && !useContentItem) {
      return res.status(400).json({ error: 'Rubric ID, content item, or custom topic list is required' });
    }

    let contextData = { assignments: [], rubrics: [], marking_patterns: [] };
    let selectedRubric = null;
    let rubricCriteria = null;
    let topicsFromRubric = '';

    let selectedContentItem = null;
    let selectedContentSummary = '';

    if (useContentItem) {
      const contentQuery = isMySQLDb()
        ? 'SELECT id, title, content_json FROM published_content WHERE id = ? AND user_id = ? LIMIT 1'
        : 'SELECT id, title, content_json FROM published_content WHERE id = $1 AND user_id = $2 LIMIT 1';
      const contentRowsResult = await query(contentQuery, [content_id, req.user.id]);
      const contentRows = Array.isArray(contentRowsResult) ? contentRowsResult : (contentRowsResult.rows || []);
      if (contentRows.length === 0) {
        return res.status(404).json({ error: 'Content item not found or not accessible' });
      }
      selectedContentItem = contentRows[0];

      try {
        const parsedContent = typeof selectedContentItem.content_json === 'string'
          ? JSON.parse(selectedContentItem.content_json)
          : selectedContentItem.content_json;

        const sections = Array.isArray(parsedContent?.sections) ? parsedContent.sections : [];
        selectedContentSummary = `Title: ${selectedContentItem.title || 'Untitled content'}\n`;
        if (sections.length > 0) {
          selectedContentSummary += '\nContent sections:\n';
          sections.slice(0, 3).forEach((section, idx) => {
            const heading = section.heading || section.title || `Section ${idx + 1}`;
            const body = typeof section.body === 'string' ? section.body.replace(/\s+/g, ' ').trim().slice(0, ASSESSMENT_CONTEXT_LIMITS.assignmentPreview) : '';
            selectedContentSummary += `- ${heading}: ${body}${body.length >= ASSESSMENT_CONTEXT_LIMITS.assignmentPreview ? '...' : ''}\n`;
          });
        }
      } catch (_) {
        selectedContentSummary = `Title: ${selectedContentItem.title || 'Untitled content'}`;
      }
    }

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

      // Get sample rubrics (scoped to current user)
      const rubricsQuery = `
        SELECT name, criteria, total_points, rubric_type
        FROM rubrics
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `;
      
      const rubricsResult = await query(rubricsQuery, [req.user.id]);
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

      const rubricQuery = `
        SELECT name, criteria, total_points, rubric_type
        FROM rubrics
        WHERE id = ? AND user_id = ?
      `;
      const rubricResult = await query(rubricQuery, [rubric_id, req.user.id]);
      const selectedRubricRows = Array.isArray(rubricResult) ? rubricResult : (rubricResult.rows || []);

      if (selectedRubricRows.length === 0) {
        return res.status(404).json({ error: 'Rubric not found' });
      }

      selectedRubric = selectedRubricRows[0];
      rubricCriteria = typeof selectedRubric.criteria === 'string'
        ? JSON.parse(selectedRubric.criteria)
        : selectedRubric.criteria;
      topicsFromRubric = (rubricCriteria && Array.isArray(rubricCriteria))
        ? rubricCriteria
            .map((c) => `${c.name}${c.description ? ': ' + String(c.description).slice(0, ASSESSMENT_CONTEXT_LIMITS.rubricDescription) : ''}`)
            .join('; ')
        : selectedRubric.name;
    }

    if (useCustomTopics) {
      topicsFromRubric = String(custom_topics).trim().slice(0, ASSESSMENT_CONTEXT_LIMITS.topicSummary);
      const defaultTotal = 100;
      selectedRubric = {
        name: 'Custom topics assessment',
        total_points: defaultTotal,
        rubric_type: 'rubric',
        criteria: []
      };
    }

    if (!useCustomTopics && !rubric_id && useContentItem && selectedContentItem) {
      const defaultTotal = Math.max(question_count * 10, 50);
      selectedRubric = {
        name: `Content item-based assessment: ${selectedContentItem.title || 'Selected content'}`.slice(0, 255),
        total_points: defaultTotal,
        rubric_type: 'content',
        criteria: []
      };
      topicsFromRubric = selectedContentSummary.slice(0, ASSESSMENT_CONTEXT_LIMITS.topicSummary);
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
          contextPrompt += `Content preview: ${assignment.text_preview.slice(0, ASSESSMENT_CONTEXT_LIMITS.assignmentPreview)}...\n`;
        }
        if (assignment.total_score !== null) {
          contextPrompt += `Score: ${assignment.total_score}/${selectedRubric.total_points}\n`;
        }
      });
    }

    let rubricDescription;
    if (useCustomTopics) {
      rubricDescription = `\n\nCUSTOM TOPIC LIST (create questions covering these topics):\n${topicsFromRubric}\n`;
      const levelPromptBlock = level && String(level).trim()
        ? buildEducationLevelPromptBlock(String(level).trim())
        : '';
      if (levelPromptBlock) {
        rubricDescription += `\n${levelPromptBlock}\n`;
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
            rubricDescription += `   ${criterion.description.substring(0, ASSESSMENT_CONTEXT_LIMITS.rubricDescription)}${criterion.description.length > ASSESSMENT_CONTEXT_LIMITS.rubricDescription ? '...' : ''}\n`;
          }
          if (criterion.levels && Array.isArray(criterion.levels)) {
            criterion.levels.forEach((lev, levelIdx) => {
              rubricDescription += `   Level ${levelIdx + 1}: ${String(lev.description || lev.name || '').slice(0, ASSESSMENT_CONTEXT_LIMITS.rubricLevelDescription)}\n`;
            });
          }
        });
      }
    }

    if (selectedContentItem) {
      contextPrompt += `\n\nSOURCE CONTENT ITEM TO BASE THIS ASSESSMENT ON:\n${selectedContentSummary}\n`;
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
${level && String(level).trim() ? `\n${buildEducationLevelPromptBlock(String(level).trim())}\n` : ''}

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

    const config = aiConfig.getTaskConfig('assessmentGeneration', 'openai');
    telemetryProvider = config.provider || null;
    telemetryModel = config.model || null;
    promptTrace = await resolvePromptRegistryVersion({
      user_id: req.user.id,
      generation_type: 'assessment_generation',
      prompt_key: 'assessment.generate.default',
      prompt_text: 'Default assessment generation prompt template used by /assessments/generate.',
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    });
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
      temperature: config.temperature,
      maxTokens: config.maxTokens
    });
    telemetryUsage = completion?.usage || null;

    let assessmentData;
    try {
      assessmentData = parseAssessmentJSONFromCompletion(completion);
    } catch (parseError) {
      console.error('JSON parsing error:', parseError);
      console.error('AI usage:', completion?.usage);
      console.error('AI finish_reason:', completion?.choices?.[0]?.finish_reason);
      console.error('AI Response preview:', extractTextFromCompletion(completion).slice(0, 1000));
      throw parseError;
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
      },
      generation_trace: promptTrace,
      generation_job_id: generationJobId,
    });
    const estimatedCost = estimateGenerationUsageCost(telemetryProvider, telemetryUsage);
    const successPayload = {
      event: 'assessment_generate',
      status: 'success',
      generation_type: 'assessment_generation',
      user_id: req.user.id,
      provider: telemetryProvider,
      model: telemetryModel,
      duration_ms: Date.now() - requestStartedAt,
      usage: telemetryUsage,
      estimated_cost_usd: estimatedCost,
      metadata: {
        rubric_id: rubric_id || null,
        content_id: content_id || null,
        has_custom_topics: !!useCustomTopics,
        level: level || null,
        difficulty_level,
        question_count: Number(question_count) || 0,
        assessment_type,
        prompt_key: promptTrace?.prompt_key || null,
        prompt_version: promptTrace?.prompt_version || null,
      },
    };
    logGenerationTelemetry(successPayload);
    try {
      await persistGenerationTelemetryEvent(successPayload);
    } catch (telemetryError) {
      console.warn('[assessment] Failed to persist generation telemetry:', telemetryError?.message || telemetryError);
    }
    if (generationJobId) {
      await updateGenerationJob(generationJobId, {
        status: JOB_STATUS.COMPLETED,
        result: {
          success: true,
          assessment: assessmentData,
          rubric: {
            id: useCustomTopics ? savedRubricId : rubric_id,
            name: selectedRubric?.name || null,
            total_points: assessmentData?.total_points ?? selectedRubric?.total_points ?? null,
          },
          saved_rubric_id: savedRubricId || null,
          saved_rubric_name: savedRubricName || null,
          generation_trace: promptTrace || null,
          title: assessmentData?.title || null,
          question_count: Array.isArray(assessmentData?.questions) ? assessmentData.questions.length : 0,
        },
        completed_at: new Date(),
      });
    }

  } catch (error) {
    const errorPayload = {
      event: 'assessment_generate',
      status: 'error',
      generation_type: 'assessment_generation',
      user_id: req.user?.id || null,
      provider: telemetryProvider,
      model: telemetryModel,
      duration_ms: Date.now() - requestStartedAt,
      usage: telemetryUsage,
      estimated_cost_usd: estimateGenerationUsageCost(telemetryProvider, telemetryUsage),
      error_type: inferGenerationErrorType(error),
      error_message: String(error?.message || 'Unknown error'),
      metadata: {
        rubric_id: req.body?.rubric_id || null,
        content_id: req.body?.content_id || null,
        has_custom_topics: !!req.body?.custom_topics,
        question_count: Number(req.body?.question_count || 0) || 0,
        prompt_key: promptTrace?.prompt_key || null,
        prompt_version: promptTrace?.prompt_version || null,
      },
    };
    logGenerationTelemetry(errorPayload);
    try {
      await persistGenerationTelemetryEvent(errorPayload);
    } catch (telemetryError) {
      console.warn('[assessment] Failed to persist error telemetry:', telemetryError?.message || telemetryError);
    }
    if (generationJobId) {
      await updateGenerationJob(generationJobId, {
        status: JOB_STATUS.FAILED,
        error_message: String(error?.message || 'Unknown error'),
        completed_at: new Date(),
      });
    }
    console.error('Assessment generation error:', error);
    res.status(500).json({
      error: 'Failed to generate assessment',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

router.post('/generate-practical', requireAuth, async (req, res) => {
  let generationJobId = null;
  try {
    const canCreateAssessment = req.user?.features?.assessment_creation !== false;
    const canCreateContent = req.user?.features?.content_creation !== false;
    if (!canCreateAssessment && !canCreateContent) {
      return res.status(403).json({ error: 'You do not have permission to generate practicals.' });
    }

    const {
      topic,
      level = null,
      practical_type = 'laboratory',
      mode = 'guide',
      delivery_mode = 'computer_based',
      include_code_examples = true,
      programming_language = null,
      platform_tools = [],
      include_detailed_instructions = true,
      duration_minutes = 60,
      learning_objectives = [],
      required_materials = [],
      safety_focus = [],
    } = req.body || {};

    const normalizedTopic = String(topic || '').trim();
    if (!normalizedTopic) {
      return res.status(400).json({ error: 'topic is required' });
    }

    const normalizedMode = String(mode || 'guide').toLowerCase() === 'assessment' ? 'assessment' : 'guide';
    const normalizedType = String(practical_type || 'laboratory').trim().slice(0, 120) || 'laboratory';
    const normalizedDeliveryMode = String(delivery_mode || 'computer_based').toLowerCase() === 'hands_on'
      ? 'hands_on'
      : 'computer_based';
    const shouldIncludeCodeExamples = include_code_examples !== false;
    const normalizedProgrammingLanguage = String(programming_language || '').trim().slice(0, 80);
    const normalizedPlatformTools = Array.isArray(platform_tools)
      ? platform_tools.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    const normalizedLevel = String(level || '').trim();
    const normalizedDuration = Math.max(20, Math.min(240, Number.parseInt(duration_minutes, 10) || 60));
    const normalizedObjectives = Array.isArray(learning_objectives)
      ? learning_objectives.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 10)
      : [];
    const normalizedMaterials = Array.isArray(required_materials)
      ? required_materials.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20)
      : [];
    const normalizedSafety = Array.isArray(safety_focus)
      ? safety_focus.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
      : [];

    const levelBlock = buildEducationLevelPromptBlock(normalizedLevel || 'level_4');
    const writingGuidance = buildAcademicWritingGuidance(normalizedLevel || 'level_4');
    const detailInstruction = include_detailed_instructions
      ? 'Include detailed step-by-step instructions suitable for direct classroom/lab facilitation, with setup notes and quality checkpoints.'
      : 'Keep instructions concise and high-level. Focus on task flow and outcomes rather than granular steps.';
    const modeInstruction = normalizedMode === 'assessment'
      ? 'This must function as an assessable practical task. Include marking criteria and evidence requirements.'
      : 'This must function as a practical guide only. Do not include marks, rubric scores, or grading allocations.';
    const deliveryInstruction = normalizedDeliveryMode === 'computer_based'
      ? 'Design this as a computer-based practical for IT students, with explicit software/tool workflow and machine-based execution steps.'
      : 'Design this as a hands-on practical task with physical setup and implementation steps.';
    const codeInstruction = shouldIncludeCodeExamples
      ? 'Include realistic code examples aligned to the practical workflow. Use concise, correct snippets and explain how each snippet is used.'
      : 'Do not include code examples unless strictly required by the topic.';

    const prompt = `You are an expert educator designing a high-quality practical activity.

TOPIC: ${normalizedTopic}
PRACTICAL TYPE: ${normalizedType}
MODE: ${normalizedMode}
DELIVERY MODE: ${normalizedDeliveryMode}
TARGET DURATION: ${normalizedDuration} minutes
${levelBlock}
${writingGuidance}

REQUESTED EMPHASIS:
- ${detailInstruction}
- ${modeInstruction}
- ${deliveryInstruction}
- ${codeInstruction}
${normalizedProgrammingLanguage ? `- Preferred programming language: ${normalizedProgrammingLanguage}` : ''}
${normalizedPlatformTools.length ? `- Suggested digital environment/tools: ${normalizedPlatformTools.join('; ')}` : ''}
${normalizedObjectives.length ? `- Learning objectives to include: ${normalizedObjectives.join('; ')}` : ''}
${normalizedMaterials.length ? `- Preferred materials/equipment: ${normalizedMaterials.join('; ')}` : ''}
${normalizedSafety.length ? `- Safety focus areas: ${normalizedSafety.join('; ')}` : ''}

Return JSON only (no markdown) in this structure:
{
  "title": "string",
  "topic": "string",
  "practical_type": "string",
  "mode": "guide|assessment",
  "delivery_mode": "computer_based|hands_on",
  "digital_environment": ["required software/tool 1", "required software/tool 2"],
  "estimated_duration_minutes": 60,
  "overview": "short academic overview paragraph",
  "learning_objectives": ["obj1", "obj2"],
  "materials": ["item1", "item2"],
  "safety_notes": ["note1", "note2"],
  "preparation_checklist": ["prep1", "prep2"],
  "procedure_steps": [
    {
      "step": 1,
      "title": "Step title",
      "instructions": "What to do",
      "expected_outcome": "What should happen",
      "teacher_notes": "Facilitator note",
      "code_example": {
        "language": "python",
        "code": "print('example')",
        "explanation": "how the code supports the step"
      }
    }
  ],
  "code_examples": [
    {
      "title": "Core implementation snippet",
      "language": "python",
      "code": "print('example')",
      "explanation": "what this snippet demonstrates"
    }
  ],
  "reflection_questions": ["q1", "q2"],
  "optional_assessment": {
    "submission_instructions": "How learners submit evidence",
    "evidence_requirements": ["evidence1", "evidence2"],
    "rubric_criteria": [
      { "name": "Criterion name", "description": "How to evaluate quality", "max_points": 10 }
    ],
    "total_points": 100
  }
}

Rules:
- Provide at least 6 procedure_steps.
- Use clear academic language and structured instructional design.
- Ensure safety_notes and preparation_checklist are specific and practical.
- Use academically grounded writing with clear headings, bullet-ready sequencing, and concise explanatory tone.
- For computer_based mode, include concrete software/tool setup in digital_environment and procedure steps.
- If code examples are requested, include at least two meaningful snippets in code_examples and embed step-level code_example where relevant.
- If mode is "guide", set optional_assessment to null.
- If mode is "assessment", optional_assessment is required with rubric_criteria and total_points.
- Keep the output directly usable by educators.`;

    const config = aiConfig.getTaskConfig('practicalGeneration', 'openai');
    const completion = await aiService.createCompletionWithRetry({
      provider: config.provider,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      messages: [
        { role: 'system', content: 'You are an expert practical curriculum designer. Return valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    });

    const parsed = parseAssessmentJSONFromCompletion(completion);
    const procedureSteps = Array.isArray(parsed?.procedure_steps) ? parsed.procedure_steps : [];
    if (procedureSteps.length === 0) {
      return res.status(500).json({ error: 'Practical generation failed: no procedure steps returned.' });
    }

    const practical = {
      title: String(parsed?.title || `${normalizedTopic} Practical`).slice(0, 220),
      topic: String(parsed?.topic || normalizedTopic).slice(0, 220),
      practical_type: String(parsed?.practical_type || normalizedType).slice(0, 120),
      mode: normalizedMode,
      delivery_mode: normalizedDeliveryMode,
      digital_environment: Array.isArray(parsed?.digital_environment)
        ? parsed.digital_environment.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20)
        : normalizedPlatformTools,
      estimated_duration_minutes: Math.max(20, Math.min(240, Number.parseInt(parsed?.estimated_duration_minutes, 10) || normalizedDuration)),
      overview: String(parsed?.overview || '').trim(),
      learning_objectives: Array.isArray(parsed?.learning_objectives) ? parsed.learning_objectives.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12) : [],
      materials: Array.isArray(parsed?.materials) ? parsed.materials.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30) : [],
      safety_notes: Array.isArray(parsed?.safety_notes) ? parsed.safety_notes.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20) : [],
      preparation_checklist: Array.isArray(parsed?.preparation_checklist) ? parsed.preparation_checklist.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20) : [],
      procedure_steps: procedureSteps.map((step, index) => ({
        step: Number.parseInt(step?.step, 10) || (index + 1),
        title: String(step?.title || `Step ${index + 1}`).trim(),
        instructions: String(step?.instructions || '').trim(),
        expected_outcome: String(step?.expected_outcome || '').trim(),
        teacher_notes: String(step?.teacher_notes || '').trim(),
        code_example: step?.code_example && String(step?.code_example?.code || '').trim()
          ? {
              language: String(step.code_example.language || normalizedProgrammingLanguage || 'text').trim().slice(0, 40) || 'text',
              code: String(step.code_example.code || '').trim().slice(0, 5000),
              explanation: String(step.code_example.explanation || '').trim().slice(0, 800),
            }
          : undefined,
      })).filter((step) => step.instructions).slice(0, 20),
      code_examples: Array.isArray(parsed?.code_examples)
        ? parsed.code_examples
            .map((item) => ({
              title: String(item?.title || 'Code example').trim().slice(0, 140),
              language: String(item?.language || normalizedProgrammingLanguage || 'text').trim().slice(0, 40) || 'text',
              code: String(item?.code || '').trim().slice(0, 6000),
              explanation: String(item?.explanation || '').trim().slice(0, 1200),
            }))
            .filter((item) => item.code)
            .slice(0, 12)
        : [],
      reflection_questions: Array.isArray(parsed?.reflection_questions) ? parsed.reflection_questions.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12) : [],
      optional_assessment: normalizedMode === 'assessment'
        ? {
            submission_instructions: String(parsed?.optional_assessment?.submission_instructions || '').trim(),
            evidence_requirements: Array.isArray(parsed?.optional_assessment?.evidence_requirements)
              ? parsed.optional_assessment.evidence_requirements.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
              : [],
            rubric_criteria: Array.isArray(parsed?.optional_assessment?.rubric_criteria)
              ? parsed.optional_assessment.rubric_criteria.map((criterion) => ({
                  name: String(criterion?.name || '').trim(),
                  description: String(criterion?.description || '').trim(),
                  max_points: Math.max(1, Number.parseInt(criterion?.max_points, 10) || 1),
                })).filter((criterion) => criterion.name && criterion.description).slice(0, 12)
              : [],
            total_points: Math.max(1, Number.parseInt(parsed?.optional_assessment?.total_points, 10) || 100),
          }
        : null,
    };

    if (practical.procedure_steps.length < 4) {
      return res.status(500).json({ error: 'Practical generation returned too few usable steps. Please try again.' });
    }

    res.json({
      success: true,
      practical,
      input: {
        topic: normalizedTopic,
        level: normalizedLevel || null,
        practical_type: normalizedType,
        mode: normalizedMode,
        delivery_mode: normalizedDeliveryMode,
        include_code_examples: shouldIncludeCodeExamples,
        programming_language: normalizedProgrammingLanguage || null,
        platform_tools: normalizedPlatformTools,
        include_detailed_instructions: include_detailed_instructions !== false,
      },
      generation_job_id: generationJobId,
    });
    if (generationJobId) {
      await updateGenerationJob(generationJobId, {
        status: JOB_STATUS.COMPLETED,
        result: {
          success: true,
          practical,
          input: {
            topic: normalizedTopic,
            level: normalizedLevel || null,
            practical_type: normalizedType,
            mode: normalizedMode,
            delivery_mode: normalizedDeliveryMode,
          },
        },
        completed_at: new Date(),
      });
    }
  } catch (error) {
    if (generationJobId) {
      await updateGenerationJob(generationJobId, {
        status: JOB_STATUS.FAILED,
        error_message: String(error?.message || 'Unknown error'),
        completed_at: new Date(),
      });
    }
    console.error('Practical generation error:', error);
    res.status(500).json({
      error: 'Failed to generate practical',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

/**
 * Export assessment as Moodle question bank XML (includes correct answers).
 * Body: { assessment } (full assessment object with questions, options, correct_answer, etc.)
 */
router.post('/export/moodle-xml', requireAuth, requireFeature('assessment_creation'), async (req, res) => {
  try {
    const { assessment } = req.body;
    if (!assessment || !assessment.questions || !Array.isArray(assessment.questions)) {
      return res.status(400).json({ error: 'assessment with questions array is required' });
    }
    const xml = buildMoodleXml(assessment);
    const filename = `${(assessment.title || 'assessment').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_moodle.xml`;
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  } catch (error) {
    console.error('Moodle XML export error:', error);
    res.status(500).json({ error: 'Failed to export Moodle XML' });
  }
});

/**
 * Export assessment as SCORM 1.2 package ZIP (includes answer key as separate resource).
 * Body: { assessment }
 */
router.post('/export/scorm', requireAuth, requireFeature('assessment_creation'), async (req, res) => {
  try {
    const { assessment } = req.body;
    if (!assessment || !assessment.questions || !Array.isArray(assessment.questions)) {
      return res.status(400).json({ error: 'assessment with questions array is required' });
    }
    const zipBuffer = await buildScormPackage(assessment);
    const filename = `${(assessment.title || 'assessment').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_scorm.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (error) {
    console.error('SCORM export error:', error);
    res.status(500).json({ error: 'Failed to export SCORM package' });
  }
});

/**
 * List current user's published assessments (for reusability / copy links).
 */
router.get('/published', requireAuth, async (req, res) => {
  try {
    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    const result = isMySQL
      ? await query('SELECT id, code, assessment_json, batch_id, created_at FROM published_assessments WHERE user_id = ? ORDER BY created_at DESC', [req.user.id])
      : await query('SELECT id, code, assessment_json, batch_id, created_at FROM published_assessments WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const rows = result.rows || result;
    const list = Array.isArray(rows) ? rows : [rows];
    const base = process.env.CLIENT_URL || '';
    const takePath = base ? `${base.replace(/\/$/, '')}/take-assessment` : '/take-assessment';
    const items = list.map((r) => {
      let title = '';
      let question_count = 0;
      try {
        const j = typeof r.assessment_json === 'string' ? JSON.parse(r.assessment_json) : r.assessment_json;
        title = j?.title || '';
        question_count = Array.isArray(j?.questions) ? j.questions.length : 0;
      } catch (_) {}
      return {
        id: r.id,
        code: r.code,
        batch_id: r.batch_id ?? null,
        title,
        question_count,
        link: `${takePath}?code=${r.code}`,
        created_at: r.created_at,
      };
    });
    res.json({ success: true, items });
  } catch (error) {
    console.error('Published assessments list error:', error);
    res.status(500).json({ error: 'Failed to list published assessments' });
  }
});

/**
 * Store generated assessment history item for current user.
 */
router.post('/history', requireAuth, requireFeature('assessment_creation'), async (req, res) => {
  try {
    const { assessment, input } = req.body || {};
    if (!assessment || !assessment.title || !Array.isArray(assessment.questions)) {
      return res.status(400).json({ error: 'assessment with title and questions array is required' });
    }

    const title = String(assessment.title || 'Untitled assessment').slice(0, 500);
    if (isMySQLDb()) {
      const inserted = await query(
        `INSERT INTO assessment_generation_history (user_id, title, generated_assessment_json, input_json)
         VALUES (?, ?, ?, ?)`,
        [req.user.id, title, JSON.stringify(assessment), input ? JSON.stringify(input) : null]
      );
      const id = inserted.insertId ?? inserted.lastID;
      const rowResult = await query(
        `SELECT id, title, generated_assessment_json, input_json, created_at
         FROM assessment_generation_history
         WHERE id = ? AND user_id = ?`,
        [id, req.user.id]
      );
      const row = Array.isArray(rowResult) ? rowResult[0] : (rowResult.rows && rowResult.rows[0]);
      return res.json({
        success: true,
        item: {
          id: row.id,
          title: row.title,
          assessment: parseJsonSafe(row.generated_assessment_json, null),
          input: parseJsonSafe(row.input_json, null),
          generation_trace: parseJsonSafe(row.input_json, null)?.generation_trace || null,
          created_at: row.created_at,
        }
      });
    }

    const inserted = await query(
      `INSERT INTO assessment_generation_history (user_id, title, generated_assessment_json, input_json)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, generated_assessment_json, input_json, created_at`,
      [req.user.id, title, JSON.stringify(assessment), input ? JSON.stringify(input) : null]
    );
    const row = inserted.rows?.[0] || inserted?.[0];
    return res.json({
      success: true,
      item: {
        id: row.id,
        title: row.title,
        assessment: parseJsonSafe(row.generated_assessment_json, null),
        input: parseJsonSafe(row.input_json, null),
        generation_trace: parseJsonSafe(row.input_json, null)?.generation_trace || null,
        created_at: row.created_at,
      }
    });
  } catch (error) {
    console.error('Save assessment history error:', error);
    res.status(500).json({ error: 'Failed to save assessment history' });
  }
});

/**
 * List generated assessment history for current user.
 */
router.get('/history', requireAuth, requireFeature('assessment_creation'), async (req, res) => {
  try {
    const result = isMySQLDb()
      ? await query(
          `SELECT id, title, generated_assessment_json, input_json, created_at
           FROM assessment_generation_history
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT 100`,
          [req.user.id]
        )
      : await query(
          `SELECT id, title, generated_assessment_json, input_json, created_at
           FROM assessment_generation_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 100`,
          [req.user.id]
        );
    const rows = result.rows || result || [];
    const list = Array.isArray(rows) ? rows : [rows];
    const items = list.map((row) => ({
      id: row.id,
      title: row.title,
      assessment: parseJsonSafe(row.generated_assessment_json, null),
      input: parseJsonSafe(row.input_json, null),
      generation_trace: parseJsonSafe(row.input_json, null)?.generation_trace || null,
      created_at: row.created_at,
    }));
    res.json({ success: true, items });
  } catch (error) {
    console.error('Assessment history list error:', error);
    res.status(500).json({ error: 'Failed to fetch assessment history' });
  }
});

/**
 * Delete one generated assessment history item for current user.
 */
router.delete('/history/:id', requireAuth, requireFeature('assessment_creation'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid history id' });
    }
    const deleted = isMySQLDb()
      ? await query('DELETE FROM assessment_generation_history WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('DELETE FROM assessment_generation_history WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'History item not found' });
    res.json({ success: true, message: 'History item removed' });
  } catch (error) {
    console.error('Delete assessment history error:', error);
    res.status(500).json({ error: 'Failed to delete history item' });
  }
});

/**
 * Clear all generated assessment history items for current user.
 */
router.delete('/history', requireAuth, requireFeature('assessment_creation'), async (req, res) => {
  try {
    if (isMySQLDb()) {
      await query('DELETE FROM assessment_generation_history WHERE user_id = ?', [req.user.id]);
    } else {
      await query('DELETE FROM assessment_generation_history WHERE user_id = $1', [req.user.id]);
    }
    res.json({ success: true, message: 'History cleared' });
  } catch (error) {
    console.error('Clear assessment history error:', error);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

/**
 * Delete one of the current user's published assessments.
 */
router.delete(['/published/:id', '/:id'], requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid assessment id' });
    }

    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    const existing = isMySQL
      ? await query('SELECT id, batch_id FROM published_assessments WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('SELECT id, batch_id FROM published_assessments WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const existingRows = existing.rows || existing;
    const row = Array.isArray(existingRows) ? existingRows[0] : existingRows;
    if (!row) {
      return res.status(404).json({ error: 'Published assessment not found' });
    }

    const deleted = isMySQL
      ? await query('DELETE FROM published_assessments WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('DELETE FROM published_assessments WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) {
      return res.status(404).json({ error: 'Published assessment not found' });
    }

    if (row.batch_id) {
      try {
        if (isMySQL) {
          await query('DELETE FROM batches WHERE id = ? AND user_id = ?', [row.batch_id, req.user.id]);
        } else {
          await query('DELETE FROM batches WHERE id = $1 AND user_id = $2', [row.batch_id, req.user.id]);
        }
      } catch (_) {}
    }

    res.json({ success: true, message: 'Published assessment deleted' });
  } catch (error) {
    console.error('Published assessment delete error:', error);
    res.status(500).json({ error: 'Failed to delete published assessment' });
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
router.post('/publish', requireAuth, requireFeature('assessment_creation'), async (req, res) => {
  try {
    const { assessment, rubric_id, module_id, module_name } = req.body;
    if (!assessment || !rubric_id) {
      return res.status(400).json({ error: 'assessment and rubric_id are required' });
    }
    if (!assessment.title || !assessment.questions || !Array.isArray(assessment.questions)) {
      return res.status(400).json({ error: 'Invalid assessment: needs title and questions array' });
    }
    let code;
    let publishedId = null;
    for (let i = 0; i < 5; i++) {
      code = generateCode();
      const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
      try {
        if (isMySQL) {
          const insertResult = await query(
            'INSERT INTO published_assessments (code, assessment_json, rubric_id, user_id) VALUES (?, ?, ?, ?)',
            [code, JSON.stringify(assessment), rubric_id, req.user.id]
          );
          publishedId = insertResult.insertId ?? insertResult.lastID ?? null;
        } else {
          const insertResult = await query(
            'INSERT INTO published_assessments (code, assessment_json, rubric_id, user_id) VALUES ($1, $2, $3, $4) RETURNING id',
            [code, JSON.stringify(assessment), rubric_id, req.user.id]
          );
          publishedId = insertResult.rows?.[0]?.id ?? insertResult?.[0]?.id ?? null;
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
    let moduleTargetId = null;
    if (module_name && String(module_name).trim()) {
      moduleTargetId = await getOrCreateModuleId(req.user.id, module_name);
    } else if (module_id) {
      moduleTargetId = Number(module_id);
      const moduleRow = await moduleBelongsToUser(moduleTargetId, req.user.id);
      if (!moduleRow) {
        return res.status(404).json({ error: 'Module not found' });
      }
    }

    if (publishedId && moduleTargetId) {
      await addItemToModule(moduleTargetId, req.user.id, 'assessment', publishedId, assessment.title || `Assessment ${publishedId}`, code);
    }

    const batchName = `Assessment Submissions - ${String(assessment.title || 'Published Assessment').trim()}`.slice(0, 255);
    const batchDescription = `Auto-managed submissions batch for assessment code ${code}`;
    const batchResult = await query(
      'INSERT INTO batches (name, description, user_id) VALUES (?, ?, ?)',
      [batchName, batchDescription, req.user.id]
    );
    const batchId = batchResult.insertId ?? batchResult.lastID ?? batchResult.rows?.[0]?.id ?? null;
    if (publishedId && batchId) {
      await query('UPDATE published_assessments SET batch_id = ? WHERE id = ?', [batchId, publishedId]);
    }
    const base = process.env.CLIENT_URL || '';
    const takePath = base ? `${base.replace(/\/$/, '')}/take-assessment` : '/take-assessment';
    res.json({
      success: true,
      code,
      batch_id: batchId,
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
router.get('/take/:code', publicLimiter, async (req, res) => {
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
      const { correct_answer, correct_pairings, ...rest } = q;
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

router.get('/audio/:code/:questionIndex', async (req, res) => {
  try {
    const { code } = req.params;
    const questionIndex = Number(req.params.questionIndex);
    if (!Number.isFinite(questionIndex) || questionIndex < 0) {
      return res.status(400).json({ error: 'Invalid question index' });
    }

    const result = isMySQLDb()
      ? await query('SELECT assessment_json FROM published_assessments WHERE code = ?', [code])
      : await query('SELECT assessment_json FROM published_assessments WHERE code = $1', [code]);
    const rows = result.rows || result;
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) {
      return res.status(404).json({ error: 'Assessment not found or link expired' });
    }

    const assessment = typeof row.assessment_json === 'string' ? JSON.parse(row.assessment_json) : row.assessment_json;
    const narrationText = buildAssessmentQuestionNarrationText(assessment, questionIndex);
    if (!narrationText) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const voiceId = String(req.query.voice_id || 'eve').trim().toLowerCase() || 'eve';
    const language = String(req.query.language || 'en').trim().toLowerCase() || 'en';
    const audioPath = getPublishedAssessmentAudioCachePath(code, questionIndex, voiceId, language, narrationText);

    if (!fsSync.existsSync(audioPath)) {
      const audioBuffer = await contentService.synthesizeSectionSpeech(narrationText, {
        voiceId,
        language,
      });
      await fs.writeFile(audioPath, audioBuffer);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(audioPath);
  } catch (error) {
    console.error('Assessment question audio error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate assessment audio' });
  }
});

/**
 * Get public submission status and result for an assessment submission receipt.
 */
router.get('/submission-status/:submissionCode', async (req, res) => {
  try {
    const { submissionCode } = req.params;
    if (!submissionCode || String(submissionCode).length > 64) {
      return res.status(400).json({ error: 'Invalid submission code' });
    }

    const result = await query(
      `SELECT s.submission_code, s.student_name, s.status, s.failure_reason, s.submitted_at, s.completed_at,
              mr.scores, mr.feedback, mr.total_score, mr.marked_at
       FROM assessment_submissions s
       LEFT JOIN marking_results mr ON mr.id = s.result_id
       WHERE s.submission_code = ?
       LIMIT 1`,
      [submissionCode]
    );
    const rows = result.rows || result;
    const row = Array.isArray(rows) ? rows[0] : rows;

    if (!row) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json({
      success: true,
      submission: {
        submission_code: row.submission_code,
        student_name: row.student_name,
        status: row.status,
        failure_reason: row.failure_reason || null,
        submitted_at: row.submitted_at,
        completed_at: row.completed_at || row.marked_at || null,
        result: row.status === 'completed' ? parseAssessmentSubmissionResult(row) : null
      }
    });
  } catch (error) {
    console.error('Assessment submission status error:', error);
    res.status(500).json({ error: 'Failed to load submission status' });
  }
});

router.get('/admin/submission-identity-health', requireAuth, requireRoles(['management']), async (req, res) => {
  try {
    const applyOrgScope = !isSuperAdmin(req.user);
    if (applyOrgScope && req.user.organisation_id == null) {
      return res.json({
        success: true,
        summary: {
          total_submissions: 0,
          resolved_submissions: 0,
          unresolved_submissions: 0,
          potential_backfill_matches: 0
        },
        unresolved_samples: []
      });
    }

    const scopeClause = applyOrgScope
      ? (isMySQLDb() ? ' AND owner.organisation_id = ?' : ' AND owner.organisation_id = $1')
      : '';
    const scopeParams = applyOrgScope ? [req.user.organisation_id] : [];
    const emailLocalExpr = isMySQLDb()
      ? "LOWER(TRIM(SUBSTRING_INDEX(COALESCE(u.email, ''), '@', 1)))"
      : "LOWER(TRIM(SPLIT_PART(COALESCE(u.email, ''), '@', 1)))";

    const summaryResult = await query(
      `SELECT
         COUNT(*) AS total_submissions,
         SUM(CASE WHEN s.student_user_id IS NOT NULL THEN 1 ELSE 0 END) AS resolved_submissions,
         SUM(CASE WHEN s.student_user_id IS NULL THEN 1 ELSE 0 END) AS unresolved_submissions
       FROM assessment_submissions s
       INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
       INNER JOIN users owner ON owner.id = pa.user_id
       WHERE 1=1${scopeClause}`,
      scopeParams
    );
    const summaryRow = rowList(summaryResult)[0] || {};

    const potentialMatchResult = await query(
      `SELECT COUNT(*) AS count
       FROM assessment_submissions s
       INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
       INNER JOIN users owner ON owner.id = pa.user_id
       WHERE s.student_user_id IS NULL${scopeClause}
         AND EXISTS (
           SELECT 1
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           INNER JOIN module_students ms ON ms.module_id = mi.module_id
           INNER JOIN users u ON u.id = ms.student_user_id
           WHERE mi.item_type = 'assessment'
             AND mi.item_id = s.published_assessment_id
             AND m.user_id = pa.user_id
             AND (
               LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
               OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
               OR LOWER(TRIM(COALESCE(s.student_name, ''))) = ${emailLocalExpr}
             )
         )`,
      scopeParams
    );
    const potentialMatchCount = Number(rowList(potentialMatchResult)[0]?.count || 0);

    const unresolvedSamples = rowList(await query(
      `SELECT
         s.id,
         s.submission_code,
         s.student_name,
         s.status,
         s.submitted_at,
         pa.code AS assessment_code,
         pa.user_id AS lecturer_user_id,
         CASE WHEN EXISTS (
           SELECT 1
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           INNER JOIN module_students ms ON ms.module_id = mi.module_id
           INNER JOIN users u ON u.id = ms.student_user_id
           WHERE mi.item_type = 'assessment'
             AND mi.item_id = s.published_assessment_id
             AND m.user_id = pa.user_id
             AND (
               LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
               OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
               OR LOWER(TRIM(COALESCE(s.student_name, ''))) = ${emailLocalExpr}
             )
         ) THEN 1 ELSE 0 END AS potential_match
       FROM assessment_submissions s
       INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
       INNER JOIN users owner ON owner.id = pa.user_id
       WHERE s.student_user_id IS NULL${scopeClause}
       ORDER BY s.submitted_at DESC
       LIMIT 25`,
      scopeParams
    )).map((row) => ({
      id: Number(row.id),
      submission_code: row.submission_code,
      student_name: row.student_name,
      status: row.status,
      submitted_at: row.submitted_at,
      assessment_code: row.assessment_code,
      lecturer_user_id: Number(row.lecturer_user_id || 0),
      potential_match: Number(row.potential_match || 0) === 1
    }));

    res.json({
      success: true,
      summary: {
        total_submissions: Number(summaryRow.total_submissions || 0),
        resolved_submissions: Number(summaryRow.resolved_submissions || 0),
        unresolved_submissions: Number(summaryRow.unresolved_submissions || 0),
        potential_backfill_matches: potentialMatchCount
      },
      unresolved_samples: unresolvedSamples
    });
  } catch (error) {
    console.error('Submission identity health error:', error);
    res.status(500).json({ error: 'Failed to load submission identity health' });
  }
});

router.post('/admin/submission-identity-backfill', requireAuth, requireRoles(['management']), async (req, res) => {
  try {
    const applyOrgScope = !isSuperAdmin(req.user);
    if (applyOrgScope && req.user.organisation_id == null) {
      return res.json({ success: true, updated_submissions: 0 });
    }

    const scopeClause = applyOrgScope
      ? (isMySQLDb() ? ' AND owner.organisation_id = ?' : ' AND owner.organisation_id = $1')
      : '';
    const scopeParams = applyOrgScope ? [req.user.organisation_id] : [];
    const emailLocalExpr = isMySQLDb()
      ? "LOWER(TRIM(SUBSTRING_INDEX(COALESCE(u.email, ''), '@', 1)))"
      : "LOWER(TRIM(SPLIT_PART(COALESCE(u.email, ''), '@', 1)))";

    const unresolvedBeforeResult = await query(
      `SELECT COUNT(*) AS count
       FROM assessment_submissions s
       INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
       INNER JOIN users owner ON owner.id = pa.user_id
       WHERE s.student_user_id IS NULL${scopeClause}`,
      scopeParams
    );
    const unresolvedBefore = Number(rowList(unresolvedBeforeResult)[0]?.count || 0);

    if (isMySQLDb()) {
      await query(
        `UPDATE assessment_submissions s
         INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
         INNER JOIN users owner ON owner.id = pa.user_id
         SET s.student_user_id = (
           SELECT MIN(ms.student_user_id)
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           INNER JOIN module_students ms ON ms.module_id = mi.module_id
           INNER JOIN users u ON u.id = ms.student_user_id
           WHERE mi.item_type = 'assessment'
             AND mi.item_id = s.published_assessment_id
             AND m.user_id = pa.user_id
             AND (
               LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
               OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
               OR LOWER(TRIM(COALESCE(s.student_name, ''))) = ${emailLocalExpr}
             )
         )
         WHERE s.student_user_id IS NULL${scopeClause}
           AND EXISTS (
             SELECT 1
             FROM module_items mi
             INNER JOIN modules m ON m.id = mi.module_id
             INNER JOIN module_students ms ON ms.module_id = mi.module_id
             INNER JOIN users u ON u.id = ms.student_user_id
             WHERE mi.item_type = 'assessment'
               AND mi.item_id = s.published_assessment_id
               AND m.user_id = pa.user_id
               AND (
                 LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
                 OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
                 OR LOWER(TRIM(COALESCE(s.student_name, ''))) = ${emailLocalExpr}
               )
           )`,
        scopeParams
      );
    } else {
      await query(
        `WITH target_submissions AS (
           SELECT s.id AS submission_id
           FROM assessment_submissions s
           INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
           INNER JOIN users owner ON owner.id = pa.user_id
           WHERE s.student_user_id IS NULL${scopeClause}
         ),
         candidates AS (
           SELECT
             s.id AS submission_id,
             MIN(ms.student_user_id) AS matched_student_user_id
           FROM assessment_submissions s
           INNER JOIN target_submissions ts ON ts.submission_id = s.id
           INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
           INNER JOIN module_items mi ON mi.item_type = 'assessment' AND mi.item_id = s.published_assessment_id
           INNER JOIN modules m ON m.id = mi.module_id AND m.user_id = pa.user_id
           INNER JOIN module_students ms ON ms.module_id = mi.module_id
           INNER JOIN users u ON u.id = ms.student_user_id
           WHERE (
             LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
             OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
             OR LOWER(TRIM(COALESCE(s.student_name, ''))) = ${emailLocalExpr}
           )
           GROUP BY s.id
         )
         UPDATE assessment_submissions s
         SET student_user_id = c.matched_student_user_id
         FROM candidates c
         WHERE s.id = c.submission_id
           AND s.student_user_id IS NULL`,
        scopeParams
      );
    }

    const unresolvedAfterResult = await query(
      `SELECT COUNT(*) AS count
       FROM assessment_submissions s
       INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
       INNER JOIN users owner ON owner.id = pa.user_id
       WHERE s.student_user_id IS NULL${scopeClause}`,
      scopeParams
    );
    const unresolvedAfter = Number(rowList(unresolvedAfterResult)[0]?.count || 0);
    const updated = Math.max(0, unresolvedBefore - unresolvedAfter);

    res.json({ success: true, updated_submissions: updated });
  } catch (error) {
    console.error('Submission identity backfill error:', error);
    res.status(500).json({ error: 'Failed to run submission identity backfill' });
  }
});

router.get('/submission-identity-conflicts', requireAuth, requireRoles(['management', 'lecturer']), async (req, res) => {
  try {
    const scope = getIdentityScope(req);
    if (scope.empty) {
      return res.json({
        success: true,
        summary: {
          unresolved_submissions: 0,
          single_candidate_submissions: 0,
          multi_candidate_submissions: 0,
          no_candidate_submissions: 0
        },
        items: []
      });
    }

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '25'), 10) || 25, 5), 100);
    const emailLocalExpr = isMySQLDb()
      ? "LOWER(TRIM(SUBSTRING_INDEX(COALESCE(u.email, ''), '@', 1)))"
      : "LOWER(TRIM(SPLIT_PART(COALESCE(u.email, ''), '@', 1)))";
    const unresolvedCountResult = await query(
      `SELECT COUNT(*) AS count
       FROM assessment_submissions s
       INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
       INNER JOIN users owner ON owner.id = pa.user_id
       WHERE s.student_user_id IS NULL${scope.scopeClause}`,
      scope.scopeParams
    );
    const unresolvedSubmissions = Number(rowList(unresolvedCountResult)[0]?.count || 0);

    const candidateCountResult = await query(
      `SELECT s.id AS submission_id, COUNT(DISTINCT ms.student_user_id) AS candidate_count
       FROM assessment_submissions s
       INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
       INNER JOIN users owner ON owner.id = pa.user_id
       INNER JOIN module_items mi ON mi.item_type = 'assessment' AND mi.item_id = s.published_assessment_id
       INNER JOIN modules m ON m.id = mi.module_id AND m.user_id = pa.user_id
       INNER JOIN module_students ms ON ms.module_id = mi.module_id
       INNER JOIN users u ON u.id = ms.student_user_id
       WHERE s.student_user_id IS NULL${scope.scopeClause}
         AND (
           LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
           OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
           OR LOWER(TRIM(COALESCE(s.student_name, ''))) = ${emailLocalExpr}
         )
       GROUP BY s.id`,
      scope.scopeParams
    );
    const candidateCounts = new Map(
      rowList(candidateCountResult).map((row) => [Number(row.submission_id), Number(row.candidate_count || 0)])
    );
    let singleCandidateSubmissions = 0;
    let multiCandidateSubmissions = 0;
    candidateCounts.forEach((count) => {
      if (count === 1) singleCandidateSubmissions += 1;
      if (count > 1) multiCandidateSubmissions += 1;
    });
    const noCandidateSubmissions = Math.max(0, unresolvedSubmissions - candidateCounts.size);

    const unresolvedRows = isMySQLDb()
      ? rowList(await query(
          `SELECT
             s.id,
             s.submission_code,
             s.student_name,
             s.status,
             s.submitted_at,
             s.published_assessment_id,
             pa.code AS assessment_code,
             pa.user_id AS lecturer_user_id,
             owner.name AS lecturer_name,
             owner.email AS lecturer_email
           FROM assessment_submissions s
           INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
           INNER JOIN users owner ON owner.id = pa.user_id
           WHERE s.student_user_id IS NULL${scope.scopeClause}
           ORDER BY s.submitted_at DESC
           LIMIT ?`,
          [...scope.scopeParams, limit]
        ))
      : rowList(await query(
          `SELECT
             s.id,
             s.submission_code,
             s.student_name,
             s.status,
             s.submitted_at,
             s.published_assessment_id,
             pa.code AS assessment_code,
             pa.user_id AS lecturer_user_id,
             owner.name AS lecturer_name,
             owner.email AS lecturer_email
           FROM assessment_submissions s
           INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
           INNER JOIN users owner ON owner.id = pa.user_id
           WHERE s.student_user_id IS NULL${scope.scopeClause}
           ORDER BY s.submitted_at DESC
           LIMIT $${scope.scopeParams.length + 1}`,
          [...scope.scopeParams, limit]
        ));

    const items = [];
    for (const row of unresolvedRows) {
      const normalizedName = String(row.student_name || '').trim().toLowerCase();
      const candidates = isMySQLDb()
        ? rowList(await query(
            `SELECT DISTINCT
               u.id,
               u.name,
               u.email,
               ms.module_id,
               m.name AS module_name,
               CASE
                 WHEN LOWER(TRIM(COALESCE(u.name, ''))) = ? THEN 'name'
                 WHEN LOWER(TRIM(COALESCE(u.email, ''))) = ? THEN 'email'
                 WHEN LOWER(TRIM(SUBSTRING_INDEX(COALESCE(u.email, ''), '@', 1))) = ? THEN 'email_local'
                 ELSE 'heuristic'
               END AS match_reason
             FROM module_items mi
             INNER JOIN modules m ON m.id = mi.module_id
             INNER JOIN module_students ms ON ms.module_id = mi.module_id
             INNER JOIN users u ON u.id = ms.student_user_id
             WHERE mi.item_type = 'assessment'
               AND mi.item_id = ?
               AND m.user_id = ?
               AND (
                 LOWER(TRIM(COALESCE(u.name, ''))) = ?
                 OR LOWER(TRIM(COALESCE(u.email, ''))) = ?
                 OR LOWER(TRIM(SUBSTRING_INDEX(COALESCE(u.email, ''), '@', 1))) = ?
               )
             ORDER BY
               CASE
                 WHEN LOWER(TRIM(COALESCE(u.name, ''))) = ? THEN 0
                 WHEN LOWER(TRIM(COALESCE(u.email, ''))) = ? THEN 1
                 ELSE 2
               END,
               u.name ASC
             LIMIT 10`,
            [
              normalizedName,
              normalizedName,
              normalizedName,
              row.published_assessment_id,
              row.lecturer_user_id,
              normalizedName,
              normalizedName,
              normalizedName,
              normalizedName,
              normalizedName
            ]
          ))
        : rowList(await query(
            `SELECT DISTINCT
               u.id,
               u.name,
               u.email,
               ms.module_id,
               m.name AS module_name,
               CASE
                 WHEN LOWER(TRIM(COALESCE(u.name, ''))) = $1 THEN 'name'
                 WHEN LOWER(TRIM(COALESCE(u.email, ''))) = $2 THEN 'email'
                 WHEN LOWER(TRIM(SPLIT_PART(COALESCE(u.email, ''), '@', 1))) = $3 THEN 'email_local'
                 ELSE 'heuristic'
               END AS match_reason
             FROM module_items mi
             INNER JOIN modules m ON m.id = mi.module_id
             INNER JOIN module_students ms ON ms.module_id = mi.module_id
             INNER JOIN users u ON u.id = ms.student_user_id
             WHERE mi.item_type = 'assessment'
               AND mi.item_id = $4
               AND m.user_id = $5
               AND (
                 LOWER(TRIM(COALESCE(u.name, ''))) = $6
                 OR LOWER(TRIM(COALESCE(u.email, ''))) = $7
                 OR LOWER(TRIM(SPLIT_PART(COALESCE(u.email, ''), '@', 1))) = $8
               )
             ORDER BY
               CASE
                 WHEN LOWER(TRIM(COALESCE(u.name, ''))) = $9 THEN 0
                 WHEN LOWER(TRIM(COALESCE(u.email, ''))) = $10 THEN 1
                 ELSE 2
               END,
               u.name ASC
             LIMIT 10`,
            [
              normalizedName,
              normalizedName,
              normalizedName,
              row.published_assessment_id,
              row.lecturer_user_id,
              normalizedName,
              normalizedName,
              normalizedName,
              normalizedName,
              normalizedName
            ]
          ));

      items.push({
        id: Number(row.id || 0),
        submission_code: row.submission_code,
        student_name: row.student_name,
        status: row.status,
        submitted_at: row.submitted_at,
        assessment_code: row.assessment_code,
        lecturer: {
          id: Number(row.lecturer_user_id || 0),
          name: row.lecturer_name || row.lecturer_email || `Lecturer #${row.lecturer_user_id}`,
          email: row.lecturer_email || null
        },
        candidate_count: candidates.length,
        candidates: candidates.map((candidate) => ({
          id: Number(candidate.id || 0),
          name: candidate.name || candidate.email || `Student #${candidate.id}`,
          email: candidate.email || null,
          module_id: Number(candidate.module_id || 0),
          module_name: candidate.module_name || null,
          match_reason: candidate.match_reason || 'heuristic'
        }))
      });
    }

    res.json({
      success: true,
      summary: {
        unresolved_submissions: unresolvedSubmissions,
        single_candidate_submissions: singleCandidateSubmissions,
        multi_candidate_submissions: multiCandidateSubmissions,
        no_candidate_submissions: noCandidateSubmissions
      },
      items
    });
  } catch (error) {
    console.error('Submission identity conflicts error:', error);
    res.status(500).json({ error: 'Failed to load submission identity conflicts' });
  }
});

router.post('/submission-identity-conflicts/:submissionId/resolve', requireAuth, requireRoles(['management', 'lecturer']), async (req, res) => {
  try {
    const submissionId = Number(req.params.submissionId);
    const studentUserId = Number(req.body?.student_user_id);
    if (!Number.isFinite(submissionId) || submissionId <= 0) {
      return res.status(400).json({ error: 'Invalid submission id' });
    }
    if (!Number.isFinite(studentUserId) || studentUserId <= 0) {
      return res.status(400).json({ error: 'student_user_id is required' });
    }

    const scope = getIdentityScope(req);
    if (scope.empty) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const submissionResult = isMySQLDb()
      ? await query(
          `SELECT
             s.id,
             s.submission_code,
             s.student_name,
             s.status,
             s.submitted_at,
             s.student_user_id,
             s.published_assessment_id,
             pa.user_id AS lecturer_user_id
           FROM assessment_submissions s
           INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
           INNER JOIN users owner ON owner.id = pa.user_id
           WHERE s.id = ?${scope.scopeClause}`,
          [submissionId, ...scope.scopeParams]
        )
      : await query(
          `SELECT
             s.id,
             s.submission_code,
             s.student_name,
             s.status,
             s.submitted_at,
             s.student_user_id,
             s.published_assessment_id,
             pa.user_id AS lecturer_user_id
           FROM assessment_submissions s
           INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
           INNER JOIN users owner ON owner.id = pa.user_id
           WHERE s.id = $1${scope.scopeClause.replace('$1', '$2')}`,
          [submissionId, ...scope.scopeParams]
        );
    const submissionRow = rowList(submissionResult)[0];
    if (!submissionRow) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const candidateAllowed = rowList(await query(
      `SELECT 1
       FROM module_items mi
       INNER JOIN modules m ON m.id = mi.module_id
       INNER JOIN module_students ms ON ms.module_id = mi.module_id
       WHERE mi.item_type = 'assessment'
         AND mi.item_id = ?
         AND m.user_id = ?
         AND ms.student_user_id = ?
       LIMIT 1`,
      [submissionRow.published_assessment_id, submissionRow.lecturer_user_id, studentUserId]
    ))[0];
    if (!candidateAllowed) {
      return res.status(400).json({ error: 'Selected student is not enrolled for this assessment module' });
    }

    if (isMySQLDb()) {
      await query('UPDATE assessment_submissions SET student_user_id = ? WHERE id = ?', [studentUserId, submissionId]);
    } else {
      await query('UPDATE assessment_submissions SET student_user_id = $1 WHERE id = $2', [studentUserId, submissionId]);
    }

    const resolvedResult = isMySQLDb()
      ? await query(
          `SELECT
             s.id,
             s.submission_code,
             s.student_name,
             s.status,
             s.submitted_at,
             s.student_user_id,
             u.name AS resolved_student_name,
             u.email AS resolved_student_email
           FROM assessment_submissions s
           LEFT JOIN users u ON u.id = s.student_user_id
           WHERE s.id = ?`,
          [submissionId]
        )
      : await query(
          `SELECT
             s.id,
             s.submission_code,
             s.student_name,
             s.status,
             s.submitted_at,
             s.student_user_id,
             u.name AS resolved_student_name,
             u.email AS resolved_student_email
           FROM assessment_submissions s
           LEFT JOIN users u ON u.id = s.student_user_id
           WHERE s.id = $1`,
          [submissionId]
        );
    const resolved = rowList(resolvedResult)[0];

    res.json({
      success: true,
      item: {
        id: Number(resolved.id || 0),
        submission_code: resolved.submission_code,
        student_name: resolved.student_name,
        status: resolved.status,
        submitted_at: resolved.submitted_at,
        student_user_id: Number(resolved.student_user_id || 0),
        resolved_student_name: resolved.resolved_student_name || resolved.resolved_student_email || null,
        resolved_student_email: resolved.resolved_student_email || null
      }
    });
  } catch (error) {
    console.error('Submission identity resolve error:', error);
    res.status(500).json({ error: 'Failed to resolve submission identity conflict' });
  }
});

/**
 * Submit student answers and queue marking. Public. Returns submission receipt.
 */
router.post('/submit', publicLimiter, optionalAuth, async (req, res) => {
  try {
    const { code, student_name, answers } = req.body;
    if (!code || !student_name || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'code, student_name, and answers array are required' });
    }
    if (String(code).length > 32) return res.status(400).json({ error: 'code too long' });
    if (String(student_name).length > 200) return res.status(400).json({ error: 'student_name too long' });
    const isMySQL = (process.env.DATABASE_URL || '').startsWith('mysql');
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: 'Automated assessment marking is unavailable right now' });
    }

    const pubResult = isMySQL
      ? await query('SELECT id, code, assessment_json, rubric_id, batch_id, user_id FROM published_assessments WHERE code = ?', [code])
      : await query('SELECT id, code, assessment_json, rubric_id, batch_id, user_id FROM published_assessments WHERE code = $1', [code]);
    const pubRows = pubResult.rows || pubResult;
    const pub = Array.isArray(pubRows) ? pubRows[0] : pubRows;
    if (!pub) {
      return res.status(404).json({ error: 'Assessment not found or link expired' });
    }
    const assessment = typeof pub.assessment_json === 'string' ? JSON.parse(pub.assessment_json) : pub.assessment_json;
    const batchId = await ensurePublishedAssessmentBatch(pub, assessment);
    const rubricResult = isMySQL
      ? await query('SELECT id FROM rubrics WHERE id = ?', [pub.rubric_id])
      : await query('SELECT id FROM rubrics WHERE id = $1', [pub.rubric_id]);
    const rubricRows = rubricResult.rows || rubricResult;
    const rubricRow = Array.isArray(rubricRows) ? rubricRows[0] : rubricRows;
    if (!rubricRow) {
      return res.status(500).json({ error: 'Rubric not found' });
    }

    const studentUserId = req.user && String(req.user.role || '').toLowerCase() === 'student'
      ? Number(req.user.id)
      : null;

    const scriptText = buildAssessmentScriptText(assessment.questions || [], answers);
    const filename = `Submission - ${student_name} - ${code}.txt`;
    const insertAssign = isMySQL
      ? await query(
          'INSERT INTO assignments (filename, file_path, file_size, status, batch_id, extracted_text, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [filename, '', 0, 'uploaded', batchId, scriptText, pub.user_id]
        )
      : await query(
          'INSERT INTO assignments (filename, file_path, file_size, status, batch_id, extracted_text, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
          [filename, '', 0, 'uploaded', batchId, scriptText, pub.user_id]
        );
    const assignmentId = isMySQL ? (insertAssign.insertId ?? insertAssign.lastID) : (insertAssign.rows?.[0]?.id ?? insertAssign?.[0]?.id);
    let submissionCode;
    for (let i = 0; i < 5; i += 1) {
      submissionCode = generateSubmissionCode();
      try {
        await query(
          `INSERT INTO assessment_submissions (
            submission_code, published_assessment_id, assignment_id, student_user_id, student_name, status
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [submissionCode, pub.id, assignmentId, studentUserId, student_name.trim(), 'queued']
        );
        break;
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY' || error.message?.includes('unique') || error.code === '23505') {
          continue;
        }
        throw error;
      }
    }

    if (!submissionCode) {
      return res.status(500).json({ error: 'Could not generate submission receipt' });
    }

    await ensureQueuedAssessmentBatchJob({
      batchId,
      rubricId: pub.rubric_id,
      userId: pub.user_id
    });
    runOpenAIBatchPollingCycle().catch((pollError) => {
      console.error('Assessment submission batch polling trigger failed:', pollError);
    });

    res.status(202).json({
      success: true,
      submission: {
        submission_code: submissionCode,
        status: 'queued',
        student_user_id: studentUserId,
        student_name: student_name.trim(),
        submitted_at: new Date().toISOString(),
        batch_id: batchId
      },
    });
  } catch (error) {
    console.error('Submit assessment error:', error);
    res.status(500).json({
      error: 'Failed to queue submission for marking',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;
