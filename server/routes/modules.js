const express = require('express');
const crypto = require('crypto');
const { query } = require('../database/connection');
const { requireAuth, requireFeature, requireRoles } = require('../middleware/auth');
const contentService = require('../services/contentService');
const aiService = require('../services/aiService');
const aiConfig = require('../config/ai-config');
const {
  inferGenerationErrorType,
  logGenerationTelemetry,
  persistGenerationTelemetryEvent,
} = require('../services/generationTelemetryService');
const { createGenerationJob, updateGenerationJob, JOB_STATUS, listGenerationJobs } = require('../services/generationJobService');
const {
  listPromptRegistry,
  createPromptRegistryVersion,
  resolvePromptRegistryVersion,
} = require('../services/promptRegistryService');
const { recordAuditEvent, getRequestMetadata } = require('../services/auditEventService');
const { assertWithinBudgetOrThrow, getBudgetGuardrailConfig } = require('../services/budgetGuardrailService');
const { buildEducationLevelPromptBlock } = require('../services/educationLevelService');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'kkativu@gmail.com').trim().toLowerCase();
const isSuperAdmin = (user) => String(user?.email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL;
const HOMEWORK_ANALYTICS_CACHE_TTL_MS = 60 * 1000;
const HOMEWORK_ANALYTICS_CACHE_MAX_ENTRIES = 500;
const homeworkAnalyticsCache = new Map();

function toBooleanQueryFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function normalizeQueryForCache(query) {
  const entries = Object.entries(query || {})
    .filter(([, value]) => value != null && String(value).trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.join('&');
}

function buildHomeworkAnalyticsCacheKey(req, endpointKey) {
  return `${endpointKey}|u:${Number(req?.user?.id) || 0}|q:${normalizeQueryForCache(req?.query || {})}`;
}

function getHomeworkAnalyticsCachedResponse(req, endpointKey) {
  if (toBooleanQueryFlag(req?.query?.bypass_cache)) return null;
  const key = buildHomeworkAnalyticsCacheKey(req, endpointKey);
  const cached = homeworkAnalyticsCache.get(key);
  if (!cached) return null;
  if ((Date.now() - cached.createdAt) > HOMEWORK_ANALYTICS_CACHE_TTL_MS) {
    homeworkAnalyticsCache.delete(key);
    return null;
  }
  return JSON.parse(JSON.stringify(cached.payload));
}

function setHomeworkAnalyticsCachedResponse(req, endpointKey, payload) {
  const key = buildHomeworkAnalyticsCacheKey(req, endpointKey);
  if (homeworkAnalyticsCache.size >= HOMEWORK_ANALYTICS_CACHE_MAX_ENTRIES) {
    const oldest = homeworkAnalyticsCache.keys().next().value;
    if (oldest) homeworkAnalyticsCache.delete(oldest);
  }
  homeworkAnalyticsCache.set(key, {
    createdAt: Date.now(),
    payload: JSON.parse(JSON.stringify(payload)),
  });
}

function invalidateHomeworkAnalyticsCacheForUser(userId) {
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId) || numericUserId <= 0) return;
  const needle = `|u:${numericUserId}|`;
  for (const key of homeworkAnalyticsCache.keys()) {
    if (key.includes(needle)) {
      homeworkAnalyticsCache.delete(key);
    }
  }
}

function paginateList(items, limitRaw, offsetRaw, defaultLimit = 100, maxLimit = 500) {
  const total = Array.isArray(items) ? items.length : 0;
  const limit = Math.max(1, Math.min(maxLimit, Number(limitRaw) || defaultLimit));
  const offset = Math.max(0, Number(offsetRaw) || 0);
  const sliced = (Array.isArray(items) ? items : []).slice(offset, offset + limit);
  return {
    items: sliced,
    pagination: {
      total,
      limit,
      offset,
      returned: sliced.length,
      has_more: (offset + sliced.length) < total,
    },
  };
}

async function mysqlIndexExists(tableName, indexName) {
  try {
    if (tableName !== 'module_items') return false;
    const result = await query('SHOW INDEX FROM module_items WHERE Key_name = ?', [indexName]);
    const rows = rowList(result);
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

async function mysqlColumnExists(tableName, columnName) {
  try {
    if (tableName !== 'module_items') return false;
    const result = await query(
      `SELECT COUNT(*) AS count
       FROM information_schema.COLUMNS
       WHERE table_schema = DATABASE()
         AND table_name = ?
         AND column_name = ?`,
      [tableName, columnName]
    );
    const row = rowList(result)[0] || {};
    return Number(row.count || 0) > 0;
  } catch (_) {
    return false;
  }
}

// Auto-migration: add section_index column and update unique constraint
;(async () => {
  try {
    if (isMySQL()) {
      const hasSectionIndex = await mysqlColumnExists('module_items', 'section_index');
      if (!hasSectionIndex) {
        await query('ALTER TABLE module_items ADD COLUMN section_index INT NOT NULL DEFAULT -1');
      }
      if (await mysqlIndexExists('module_items', 'uniq_module_item')) {
        try { await query('ALTER TABLE module_items DROP INDEX uniq_module_item'); } catch (_) {}
      }
      if (!(await mysqlIndexExists('module_items', 'uniq_module_item_v2'))) {
        try { await query('ALTER TABLE module_items ADD UNIQUE KEY uniq_module_item_v2 (module_id, item_type, item_id, section_index)'); } catch (_) {}
      }
    } else {
      try { await query('ALTER TABLE module_items ADD COLUMN IF NOT EXISTS section_index INTEGER NOT NULL DEFAULT -1'); } catch (_) {}
      try { await query('ALTER TABLE module_items DROP CONSTRAINT module_items_module_id_item_type_item_id_key'); } catch (_) {}
      try { await query('ALTER TABLE module_items ADD CONSTRAINT uniq_module_item_v2 UNIQUE (module_id, item_type, item_id, section_index)'); } catch (_) {}
    }
  } catch (e) {
    console.warn('[modules] section_index migration warning:', e.message);
  }
})();

function rowList(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

function generateCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

function parseClampedInt(value, fallback, min, max) {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
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

function extractLikelyJson(rawText) {
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

function parseJsonFromCompletion(completion) {
  const text = extractTextFromCompletion(completion);
  const candidate = extractLikelyJson(text);
  if (!candidate) throw new Error('AI did not return JSON output');
  try {
    return JSON.parse(candidate);
  } catch (err) {
    const preview = candidate.slice(0, 500);
    throw new Error(`Failed to parse AI JSON (${err.message}). Preview: ${preview}`);
  }
}

function buildWeaknessSummary(rows) {
  const criterionMap = new Map();
  const feedbackLines = [];
  let scoredResultCount = 0;

  for (const row of rows) {
    const scores = typeof row.scores === 'string' ? safeJsonParse(row.scores, []) : (row.scores || []);
    if (Array.isArray(scores) && scores.length > 0) {
      scoredResultCount += 1;
    }
    for (const score of (Array.isArray(scores) ? scores : [])) {
      const key = String(score?.criterion_name || '').trim();
      const max = Number(score?.max_points || 0);
      const points = Number(score?.points_awarded || 0);
      if (!key || !Number.isFinite(max) || max <= 0 || !Number.isFinite(points)) continue;
      const agg = criterionMap.get(key) || { criterion_name: key, total_points: 0, total_max: 0, attempts: 0 };
      agg.total_points += Math.max(points, 0);
      agg.total_max += max;
      agg.attempts += 1;
      criterionMap.set(key, agg);
    }

    const feedback = String(row.effective_feedback || row.feedback || '').trim();
    if (feedback) {
      const firstSentence = feedback.split(/\r?\n|[.!?]\s/).map((s) => s.trim()).find(Boolean);
      if (firstSentence) feedbackLines.push(firstSentence.slice(0, 180));
    }
  }

  const weakAreas = Array.from(criterionMap.values())
    .map((item) => {
      const avgPercent = item.total_max > 0 ? (item.total_points / item.total_max) * 100 : 0;
      return {
        criterion_name: item.criterion_name,
        avg_percent: Number(avgPercent.toFixed(1)),
        attempts: item.attempts,
      };
    })
    .sort((a, b) => a.avg_percent - b.avg_percent)
    .slice(0, 6);

  const fallbackWeakAreas = weakAreas.length > 0 ? weakAreas : [{
    criterion_name: 'Core concept mastery',
    avg_percent: 0,
    attempts: scoredResultCount || rows.length,
  }];

  return {
    weak_areas: fallbackWeakAreas,
    feedback_themes: feedbackLines.filter((line, idx) => idx < 8),
    scored_results: scoredResultCount,
  };
}

function buildHomeworkReasonPayload({
  sourceModule,
  studentLabel,
  weaknessSummary,
  completedCount,
  rubricAlignment = null,
  rubricCriteria = null,
}) {
  const weakAreas = Array.isArray(weaknessSummary?.weak_areas) ? weaknessSummary.weak_areas.slice(0, 6) : [];
  const feedbackThemes = Array.isArray(weaknessSummary?.feedback_themes) ? weaknessSummary.feedback_themes.slice(0, 5) : [];
  const topWeakNames = weakAreas.map((w) => String(w?.criterion_name || '').trim()).filter(Boolean);
  const summary = topWeakNames.length > 0
    ? `Generated from ${completedCount} marked submissions for ${studentLabel}. Focus areas: ${topWeakNames.join(', ')}.`
    : `Generated from ${completedCount} marked submissions for ${studentLabel} to reinforce weak areas.`;
  return {
    reason_summary: summary.slice(0, 2000),
    reason_payload: {
      source_module_name: sourceModule,
      student_label: studentLabel,
      submissions_analyzed: completedCount,
      weak_areas: weakAreas,
      feedback_themes: feedbackThemes,
      rubric_alignment: rubricAlignment == null ? null : String(rubricAlignment).slice(0, 1200),
      rubric_criteria: Array.isArray(rubricCriteria)
        ? rubricCriteria.slice(0, 10).map((c) => ({
            name: String(c?.name || '').slice(0, 255),
            max_points: Number(c?.max_points || 0),
          }))
        : [],
      generated_at: new Date().toISOString(),
    },
  };
}

function safeJsonParse(value, fallback) {
  try {
    if (value == null) return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return fallback;
  }
}

function normalizeHomeworkQuestionType(type, fallbackType = 'short_answer') {
  const cleanType = String(type || '').trim().toLowerCase();
  const allowed = new Set(['multiple_choice', 'short_answer', 'problem', 'mix_and_match', 'essay']);
  return allowed.has(cleanType) ? cleanType : fallbackType;
}

function normalizeHomeworkQuestions(rawQuestions, questionCount) {
  const normalized = (Array.isArray(rawQuestions) ? rawQuestions : [])
    .map((q, idx) => ({
      number: Number(q?.number) || idx + 1,
      type: normalizeHomeworkQuestionType(q?.type, idx === 0 ? 'multiple_choice' : 'short_answer'),
      question: String(q?.question || '').trim(),
      points: Math.max(1, Number(q?.points || 0) || 10),
      options: Array.isArray(q?.options) ? q.options : undefined,
      correct_answer: q?.correct_answer != null ? String(q.correct_answer) : undefined,
      left_column: Array.isArray(q?.left_column) ? q.left_column : undefined,
      right_column: Array.isArray(q?.right_column) ? q.right_column : undefined,
      correct_pairings: Array.isArray(q?.correct_pairings) ? q.correct_pairings : undefined,
      hints: Array.isArray(q?.hints) ? q.hints : undefined,
      related_criteria: Array.isArray(q?.related_criteria) ? q.related_criteria : undefined,
    }))
    .filter((q) => q.question.length > 0);

  const limited = normalized.slice(0, questionCount);
  if (limited.length > 0) {
    limited.forEach((q, idx) => {
      q.number = idx + 1;
    });
  }
  return limited;
}

function buildFallbackHomeworkAssessment({
  studentLabel,
  sourceModuleName,
  questionCount,
  weakAreas,
  generatedContent,
}) {
  const safeWeakAreas = Array.isArray(weakAreas) && weakAreas.length > 0
    ? weakAreas
    : [{ criterion_name: 'Core concept mastery', avg_percent: 0 }];
  const sectionHeadings = Array.isArray(generatedContent?.sections)
    ? generatedContent.sections
      .map((s) => String(s?.heading || s?.title || '').trim())
      .filter(Boolean)
    : [];

  const questions = [];
  for (let i = 0; i < questionCount; i += 1) {
    const weakArea = safeWeakAreas[i % safeWeakAreas.length];
    const areaName = String(weakArea?.criterion_name || `Weak Area ${i + 1}`).trim();
    const sectionHint = sectionHeadings.length > 0 ? sectionHeadings[i % sectionHeadings.length] : '';
    const qType = i === 0 ? 'multiple_choice' : (i === 1 ? 'short_answer' : (i % 3 === 0 ? 'problem' : 'short_answer'));
    const prompt = sectionHint
      ? `Based on "${sectionHint}", show how you would improve your performance in: ${areaName}.`
      : `Demonstrate improved understanding in this focus area: ${areaName}.`;
    const baseQuestion = {
      number: i + 1,
      type: qType,
      question: prompt,
      points: 10,
      hints: [
        'Refer to the lesson examples before answering.',
        'State your reasoning clearly.',
      ],
      related_criteria: [areaName],
    };
    if (qType === 'multiple_choice') {
      questions.push({
        ...baseQuestion,
        options: [
          `Applies ${areaName} correctly with clear justification`,
          `Partially applies ${areaName} but misses a key step`,
          `Uses an unrelated method`,
          `Does not address the core concept`,
        ],
        correct_answer: 'A',
      });
    } else {
      questions.push(baseQuestion);
    }
  }

  const criteria = safeWeakAreas.map((area, idx) => ({
    name: String(area?.criterion_name || `Criterion ${idx + 1}`).slice(0, 255),
    max_points: Math.max(5, Math.round((questionCount * 10) / safeWeakAreas.length)),
    description: `Measures improvement in ${String(area?.criterion_name || `criterion ${idx + 1}`)} using targeted remedial questions.`,
  }));

  return {
    title: `Targeted Homework Assessment - ${studentLabel}`.slice(0, 255),
    topic: `Remediation for ${sourceModuleName}`.slice(0, 255),
    difficulty_level: 'moderate',
    assessment_type: 'assignment',
    instructions: 'Answer all questions. Explain your reasoning and show each step where relevant.',
    questions,
    total_points: questions.reduce((sum, q) => sum + Number(q.points || 0), 0),
    estimated_time: `${Math.max(30, questionCount * 6)} minutes`,
    rubric_alignment: 'Fallback assessment generated from detected weak areas to ensure homework continuity.',
    suggested_rubric_criteria: criteria,
  };
}

function normalizeUsageMetrics(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens));
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : null,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : null,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : null,
  };
}

function estimateUsageCost(provider, usage) {
  const normalized = normalizeUsageMetrics(usage);
  if (!normalized) return null;
  try {
    return aiConfig.estimateCost(
      normalized.prompt_tokens || 0,
      normalized.completion_tokens || 0,
      provider || 'openai'
    );
  } catch (_) {
    return null;
  }
}

function logCustomHomeworkTelemetry(payload) {
  try {
    console.log('[telemetry][custom-homework]', JSON.stringify(payload));
  } catch (_) {
    console.log('[telemetry][custom-homework]', payload);
  }
}

async function persistCustomHomeworkTelemetry(payload) {
  const toNullableNumber = (value) => {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const usage = normalizeUsageMetrics(payload?.assessment_usage);
  const metadata = {
    source_module_id: payload?.source_module_id ?? null,
    student_user_id: payload?.student_user_id ?? null,
    level: payload?.level ?? null,
    num_sections: payload?.num_sections ?? null,
    question_count: payload?.question_count ?? null,
    include_diagrams: payload?.include_diagrams ?? null,
    include_images: payload?.include_images ?? null,
    assessment_provider: payload?.assessment_provider ?? null,
    assessment_model: payload?.assessment_model ?? null,
    assessment_generation_mode: payload?.assessment_generation_mode ?? null,
    assessment_generation_warning: payload?.assessment_generation_warning ?? null,
    submission_rows: payload?.submission_rows ?? null,
    completed_rows: payload?.completed_rows ?? null,
    weak_area_count: payload?.weak_area_count ?? null,
    generated_question_count: payload?.generated_question_count ?? null,
    homework_module_id: payload?.homework_module_id ?? null,
  };

  const params = [
    Number(payload?.user_id) || null,
    String(payload?.status || 'unknown').slice(0, 20),
    Math.max(0, Number(payload?.duration_ms || 0) || 0),
    toNullableNumber(payload?.content_generation_ms),
    toNullableNumber(payload?.assessment_generation_ms),
    String(payload?.assessment_generation_mode || '').trim() || null,
    usage?.prompt_tokens ?? null,
    usage?.completion_tokens ?? null,
    usage?.total_tokens ?? null,
    toNullableNumber(payload?.assessment_estimated_cost_usd),
    payload?.error_message ? String(payload.error_message).slice(0, 2000) : null,
    JSON.stringify(metadata),
  ];

  if (isMySQL()) {
    await query(
      `INSERT INTO custom_homework_telemetry (
        user_id, status, duration_ms, content_generation_ms, assessment_generation_ms, assessment_generation_mode,
        prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, error_message, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
    return;
  }

  await query(
    `INSERT INTO custom_homework_telemetry (
      user_id, status, duration_ms, content_generation_ms, assessment_generation_ms, assessment_generation_mode,
      prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, error_message, metadata_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    params
  );
}

async function persistHomeworkWorkflowEvent(payload) {
  const safeModuleIds = Array.isArray(payload?.module_ids)
    ? payload.module_ids.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0).slice(0, 500)
    : [];
  const metadata = {
    status: String(payload?.status || '').slice(0, 20) || null,
    updated_ids: Array.isArray(payload?.updated_ids)
      ? payload.updated_ids.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0).slice(0, 500)
      : [],
    skipped_ids: Array.isArray(payload?.skipped_ids)
      ? payload.skipped_ids.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0).slice(0, 500)
      : [],
  };

  const params = [
    Number(payload?.user_id) || null,
    String(payload?.action || 'workflow_update').slice(0, 60),
    String(payload?.status || '').slice(0, 20) || null,
    Number(payload?.target_count || 0) || 0,
    Number(payload?.updated_count || 0) || 0,
    Number(payload?.skipped_count || 0) || 0,
    JSON.stringify(safeModuleIds),
    JSON.stringify(metadata),
  ];

  if (isMySQL()) {
    await query(
      `INSERT INTO homework_workflow_events (
        user_id, action, status, target_count, updated_count, skipped_count, module_ids_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
    return;
  }

  await query(
    `INSERT INTO homework_workflow_events (
      user_id, action, status, target_count, updated_count, skipped_count, module_ids_json, metadata_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    params
  );
}

async function createModule(userId, name) {
  const cleanName = String(name || '').trim().slice(0, 255);
  if (!cleanName) throw new Error('Module name is required');
  if (isMySQL()) {
    const inserted = await query('INSERT INTO modules (user_id, name) VALUES (?, ?)', [userId, cleanName]);
    return inserted.insertId ?? inserted.lastID ?? null;
  }
  const inserted = await query('INSERT INTO modules (user_id, name) VALUES ($1, $2) RETURNING id', [userId, cleanName]);
  return rowList(inserted)[0]?.id ?? null;
}

const HOMEWORK_WORKFLOW_STATES = new Set(['draft', 'reviewed', 'published']);

async function ensureHomeworkWorkflow(homeworkModuleId, userId, status = 'draft', notes = null, reasonSummary = null, reasonPayload = null) {
  const safeStatus = HOMEWORK_WORKFLOW_STATES.has(String(status)) ? String(status) : 'draft';
  const safeNotes = notes == null ? null : String(notes).slice(0, 2000);
  const safeReasonSummary = reasonSummary == null ? null : String(reasonSummary).slice(0, 2000);
  const safeReasonPayload = reasonPayload == null ? null : JSON.stringify(reasonPayload);
  if (isMySQL()) {
    await query(
      `INSERT INTO homework_module_workflows (homework_module_id, user_id, status, review_notes, reason_summary, reason_payload_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         review_notes = VALUES(review_notes),
         reason_summary = COALESCE(VALUES(reason_summary), reason_summary),
         reason_payload_json = COALESCE(VALUES(reason_payload_json), reason_payload_json),
         updated_at = CURRENT_TIMESTAMP`,
      [homeworkModuleId, userId, safeStatus, safeNotes, safeReasonSummary, safeReasonPayload]
    );
    return;
  }
  await query(
    `INSERT INTO homework_module_workflows (homework_module_id, user_id, status, review_notes, reason_summary, reason_payload_json)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (homework_module_id) DO UPDATE
       SET status = EXCLUDED.status,
           review_notes = EXCLUDED.review_notes,
           reason_summary = COALESCE(EXCLUDED.reason_summary, homework_module_workflows.reason_summary),
           reason_payload_json = COALESCE(EXCLUDED.reason_payload_json, homework_module_workflows.reason_payload_json),
           updated_at = CURRENT_TIMESTAMP`,
    [homeworkModuleId, userId, safeStatus, safeNotes, safeReasonSummary, safeReasonPayload]
  );
}

async function addStudentToModuleIfMissing(moduleId, studentUserId) {
  try {
    if (isMySQL()) {
      await query('INSERT INTO module_students (module_id, student_user_id) VALUES (?, ?)', [moduleId, studentUserId]);
    } else {
      await query('INSERT INTO module_students (module_id, student_user_id) VALUES ($1, $2)', [moduleId, studentUserId]);
    }
  } catch (err) {
    if (!(err?.code === 'ER_DUP_ENTRY' || String(err?.message || '').toLowerCase().includes('unique'))) {
      throw err;
    }
  }
}

function normalizeCriterionName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function computeScorePercentFromRow(row) {
  const scores = typeof row?.scores === 'string' ? safeJsonParse(row.scores, []) : (row?.scores || []);
  if (Array.isArray(scores) && scores.length > 0) {
    let totalPoints = 0;
    let totalMax = 0;
    for (const score of scores) {
      const points = Number(score?.points_awarded ?? score?.points ?? 0);
      const max = Number(score?.max_points ?? score?.points ?? 0);
      if (Number.isFinite(points) && Number.isFinite(max) && max > 0) {
        totalPoints += Math.max(0, points);
        totalMax += max;
      }
    }
    if (totalMax > 0) return Number(((totalPoints / totalMax) * 100).toFixed(1));
  }
  return null;
}

function aggregateCriteriaFromSubmissionRows(rows) {
  const criterionMap = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const scores = typeof row?.scores === 'string' ? safeJsonParse(row.scores, []) : (row?.scores || []);
    for (const score of (Array.isArray(scores) ? scores : [])) {
      const rawName = String(score?.criterion_name || score?.name || '').trim();
      const key = normalizeCriterionName(rawName);
      const points = Number(score?.points_awarded ?? score?.points ?? 0);
      const max = Number(score?.max_points ?? score?.points ?? 0);
      if (!key || !Number.isFinite(points) || !Number.isFinite(max) || max <= 0) continue;
      const existing = criterionMap.get(key) || {
        criterion_name: rawName || 'Criterion',
        total_points: 0,
        total_max: 0,
        attempts: 0,
      };
      existing.total_points += Math.max(0, points);
      existing.total_max += max;
      existing.attempts += 1;
      criterionMap.set(key, existing);
    }
  }
  return Array.from(criterionMap.values()).map((item) => ({
    criterion_name: item.criterion_name,
    avg_percent: item.total_max > 0 ? Number(((item.total_points / item.total_max) * 100).toFixed(1)) : 0,
    attempts: item.attempts,
  }));
}

function buildWeakAreaOutcomes(baselineWeakAreas, currentCriteria) {
  const currentMap = new Map(
    (Array.isArray(currentCriteria) ? currentCriteria : [])
      .map((item) => [normalizeCriterionName(item?.criterion_name), item])
  );
  return (Array.isArray(baselineWeakAreas) ? baselineWeakAreas : []).map((baseline) => {
    const baselinePercent = Number(baseline?.avg_percent || 0);
    const key = normalizeCriterionName(baseline?.criterion_name);
    const current = key ? currentMap.get(key) : null;
    const currentPercent = current ? Number(current.avg_percent || 0) : null;
    const delta = currentPercent == null ? null : Number((currentPercent - baselinePercent).toFixed(1));
    const status = delta == null ? 'unknown' : (delta >= 5 ? 'improved' : (delta <= -5 ? 'declined' : 'unchanged'));
    return {
      criterion_name: String(baseline?.criterion_name || 'Criterion'),
      baseline_percent: baselinePercent,
      current_percent: currentPercent,
      delta_percent: delta,
      status,
    };
  });
}

function computePublishBlockers({ reasonPayload, reviewNotes, hasContent, hasAssessment }) {
  const blockers = [];
  const weakAreas = Array.isArray(reasonPayload?.weak_areas) ? reasonPayload.weak_areas : [];
  const rubricCriteria = Array.isArray(reasonPayload?.rubric_criteria) ? reasonPayload.rubric_criteria : [];
  const notesLength = String(reviewNotes || '').trim().length;
  if (!hasContent) blockers.push('Missing generated content item');
  if (!hasAssessment) blockers.push('Missing generated assessment item');
  if (weakAreas.length === 0) blockers.push('Missing weak-area analysis');
  if (rubricCriteria.length === 0) blockers.push('Missing rubric criteria targets');
  if (notesLength < 15) blockers.push('Review notes are too short (minimum 15 characters)');
  return blockers;
}

async function fetchModuleItemTypeCounts(moduleIds) {
  const ids = Array.from(new Set((Array.isArray(moduleIds) ? moduleIds : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0)));
  const counts = new Map();
  if (ids.length === 0) return counts;
  const rows = rowList(
    isMySQL()
      ? await query(
          `SELECT module_id, item_type, COUNT(*) AS item_count
           FROM module_items
           WHERE module_id IN (${ids.map(() => '?').join(', ')})
           GROUP BY module_id, item_type`,
          ids
        )
      : await query(
          `SELECT module_id, item_type, COUNT(*) AS item_count
           FROM module_items
           WHERE module_id = ANY($1::int[])
           GROUP BY module_id, item_type`,
          [ids]
        )
  );
  for (const row of rows) {
    const moduleId = Number(row.module_id || 0);
    const itemType = String(row.item_type || '');
    const count = Number(row.item_count || 0);
    if (!counts.has(moduleId)) {
      counts.set(moduleId, { content: 0, assessment: 0 });
    }
    const entry = counts.get(moduleId);
    if (itemType === 'content') entry.content = count;
    if (itemType === 'assessment') entry.assessment = count;
  }
  return counts;
}

async function createRubricForHomework(userId, title, criteria) {
  const cleanName = String(title || 'Custom Homework Rubric').slice(0, 255);
  const normalizedCriteria = (Array.isArray(criteria) ? criteria : [])
    .map((c) => ({
      name: String(c?.name || 'Criterion').slice(0, 255),
      max_points: Math.max(1, Number(c?.max_points || 0)),
      description: String(c?.description || 'Targeted weakness area').slice(0, 500),
    }))
    .slice(0, 20);

  const totalPoints = normalizedCriteria.reduce((sum, c) => sum + Number(c.max_points || 0), 0);
  if (normalizedCriteria.length === 0 || totalPoints <= 0) {
    throw new Error('Could not construct rubric criteria for homework assessment');
  }

  if (isMySQL()) {
    const inserted = await query(
      'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES (?, ?, ?, ?, ?)',
      [cleanName, JSON.stringify(normalizedCriteria), totalPoints, 'rubric', userId]
    );
    return { id: inserted.insertId ?? inserted.lastID ?? null, total_points: totalPoints, criteria: normalizedCriteria };
  }

  const inserted = await query(
    'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [cleanName, JSON.stringify(normalizedCriteria), totalPoints, 'rubric', userId]
  );
  return { id: rowList(inserted)[0]?.id ?? null, total_points: totalPoints, criteria: normalizedCriteria };
}

async function publishContentForHomework(userId, content, rubricId) {
  const normalizedContent = contentService.normalizeGeneratedContent(content);
  let code = null;
  let insertedId = null;
  for (let i = 0; i < 5; i += 1) {
    code = generateCode();
    try {
      if (isMySQL()) {
        const inserted = await query(
          'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES (?, ?, ?, ?, ?)',
          [code, normalizedContent.title, JSON.stringify(normalizedContent), rubricId ?? null, userId]
        );
        insertedId = inserted.insertId ?? inserted.lastID ?? null;
      } else {
        const inserted = await query(
          'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [code, normalizedContent.title, JSON.stringify(normalizedContent), rubricId ?? null, userId]
        );
        insertedId = rowList(inserted)[0]?.id ?? null;
      }
      break;
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY' || err?.code === '23505' || String(err?.message || '').toLowerCase().includes('unique')) {
        continue;
      }
      throw err;
    }
  }
  if (!code || !insertedId) throw new Error('Failed to publish generated homework content');
  return { id: insertedId, code, content: normalizedContent };
}

async function publishAssessmentForHomework(userId, assessment, rubricId) {
  let code = null;
  let insertedId = null;
  for (let i = 0; i < 5; i += 1) {
    code = generateCode();
    try {
      if (isMySQL()) {
        const inserted = await query(
          'INSERT INTO published_assessments (code, assessment_json, rubric_id, user_id) VALUES (?, ?, ?, ?)',
          [code, JSON.stringify(assessment), rubricId, userId]
        );
        insertedId = inserted.insertId ?? inserted.lastID ?? null;
      } else {
        const inserted = await query(
          'INSERT INTO published_assessments (code, assessment_json, rubric_id, user_id) VALUES ($1, $2, $3, $4) RETURNING id',
          [code, JSON.stringify(assessment), rubricId, userId]
        );
        insertedId = rowList(inserted)[0]?.id ?? null;
      }
      break;
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY' || err?.code === '23505' || String(err?.message || '').toLowerCase().includes('unique')) {
        continue;
      }
      throw err;
    }
  }

  if (!code || !insertedId) throw new Error('Failed to publish generated homework assessment');

  const batchName = `Assessment Submissions - ${String(assessment?.title || 'Published Assessment').trim()}`.slice(0, 255);
  const batchDescription = `Auto-managed submissions batch for assessment code ${code}`;
  const batchResult = await query(
    'INSERT INTO batches (name, description, user_id) VALUES (?, ?, ?)',
    [batchName, batchDescription, userId]
  );
  const batchId = batchResult.insertId ?? batchResult.lastID ?? batchResult.rows?.[0]?.id ?? null;
  if (batchId) {
    await query('UPDATE published_assessments SET batch_id = ? WHERE id = ?', [batchId, insertedId]);
  }

  return { id: insertedId, code, batch_id: batchId };
}

function groupModules(modules, items, students) {
  const grouped = new Map();
  modules.forEach((m) => grouped.set(m.id, { ...m, items: [], students: [] }));
  items.forEach((i) => {
    const mod = grouped.get(i.module_id);
    if (!mod) return;
    mod.items.push({
      id: i.id,
      module_id: i.module_id,
      item_type: i.item_type,
      item_id: i.item_id,
      title: i.snapshot_title || `${i.item_type} ${i.item_id}`,
      code: i.snapshot_code || '',
      position: i.position ?? 0,
      section_index: i.section_index ?? -1,
      created_at: i.created_at,
    });
  });
  students.forEach((s) => {
    const mod = grouped.get(s.module_id);
    if (!mod) return;
    mod.students.push({
      id: s.student_user_id,
      name: s.name || s.email,
      email: s.email,
      created_at: s.created_at,
    });
  });
  for (const mod of grouped.values()) {
    mod.items.sort((a, b) => (a.position - b.position) || (a.id - b.id));
    mod.students.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }
  return Array.from(grouped.values());
}

async function moduleBelongsToUser(moduleId, userId) {
  const moduleQ = isMySQL()
    ? await query('SELECT id, user_id FROM modules WHERE id = ? AND user_id = ?', [moduleId, userId])
    : await query('SELECT id, user_id FROM modules WHERE id = $1 AND user_id = $2', [moduleId, userId]);
  return rowList(moduleQ)[0] || null;
}

async function getEligibleStudent(studentUserId, requester) {
  if (requester.organisation_id) {
    const q = isMySQL()
      ? await query(
          `SELECT id, name, email, organisation_id
           FROM users
           WHERE id = ? AND is_active = 1
             AND LOWER(role) = 'student'
             AND organisation_id = ?`,
          [studentUserId, requester.organisation_id]
        )
      : await query(
          `SELECT id, name, email, organisation_id
           FROM users
           WHERE id = $1 AND is_active = TRUE
             AND LOWER(role) = 'student'
             AND organisation_id = $2`,
          [studentUserId, requester.organisation_id]
        );
    return rowList(q)[0] || null;
  }

  const q = isMySQL()
    ? await query(
        `SELECT id, name, email, organisation_id
         FROM users
         WHERE id = ? AND is_active = 1
           AND LOWER(role) = 'student'`,
        [studentUserId]
      )
    : await query(
        `SELECT id, name, email, organisation_id
         FROM users
         WHERE id = $1 AND is_active = TRUE
           AND LOWER(role) = 'student'`,
        [studentUserId]
      );
  return rowList(q)[0] || null;
}

async function getAssessmentMeta(itemId, userId) {
  const q = isMySQL()
    ? await query(
        'SELECT code, assessment_json FROM published_assessments WHERE id = ? AND user_id = ?',
        [itemId, userId]
      )
    : await query(
        'SELECT code, assessment_json FROM published_assessments WHERE id = $1 AND user_id = $2',
        [itemId, userId]
      );
  const row = rowList(q)[0];
  if (!row) return null;
  let title = '';
  try {
    const parsed = typeof row.assessment_json === 'string' ? JSON.parse(row.assessment_json) : row.assessment_json;
    title = parsed?.title || '';
  } catch (_) {}
  return { title: title || `Assessment ${itemId}`, code: row.code || '' };
}

async function getContentMeta(itemId, userId, sectionIndex = -1) {
  const q = isMySQL()
    ? await query('SELECT code, title, content_json FROM published_content WHERE id = ? AND user_id = ?', [itemId, userId])
    : await query('SELECT code, title, content_json FROM published_content WHERE id = $1 AND user_id = $2', [itemId, userId]);
  const row = rowList(q)[0];
  if (!row) return null;
  let title = row.title || `Content ${itemId}`;
  if (sectionIndex >= 0) {
    try {
      const parsed = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
      const section = parsed?.sections?.[sectionIndex];
      if (section) {
        const sTitle = section.heading || section.title || `Section ${sectionIndex + 1}`;
        title = `${title} \u203a Page ${sectionIndex + 1}: ${sTitle}`;
      }
    } catch (_) {}
  }
  return { title, code: row.code || '' };
}

// A module can be attached to a course only by someone who runs that course.
async function userCanUseCourse(user, courseId) {
  if (!Number.isFinite(courseId) || courseId <= 0) return false;
  const courseQ = isMySQL()
    ? await query('SELECT id, owner_user_id FROM courses WHERE id = ?', [courseId])
    : await query('SELECT id, owner_user_id FROM courses WHERE id = $1', [courseId]);
  const course = rowList(courseQ)[0];
  if (!course) return false;
  if (String(user.role || '').toLowerCase() === 'management') return true;
  if (Number(course.owner_user_id) === Number(user.id)) return true;
  const staffQ = isMySQL()
    ? await query('SELECT id FROM course_staff WHERE course_id = ? AND user_id = ?', [courseId, user.id])
    : await query('SELECT id FROM course_staff WHERE course_id = $1 AND user_id = $2', [courseId, user.id]);
  return rowList(staffQ).length > 0;
}

// Everyone actively enrolled in a course gets access to each of its modules.
async function syncCourseStudentsToModule(moduleId, courseId) {
  if (isMySQL()) {
    await query(
      `INSERT IGNORE INTO module_students (module_id, student_user_id)
       SELECT ?, student_user_id FROM course_enrollments WHERE course_id = ? AND status = 'active'`,
      [moduleId, courseId]
    );
  } else {
    await query(
      `INSERT INTO module_students (module_id, student_user_id)
       SELECT $1, student_user_id FROM course_enrollments WHERE course_id = $2 AND status = 'active'
       ON CONFLICT DO NOTHING`,
      [moduleId, courseId]
    );
  }
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const modulesQ = isMySQL()
      ? await query('SELECT m.id, m.name, m.created_at, m.course_id, c.name AS course_name FROM modules m LEFT JOIN courses c ON c.id = m.course_id WHERE m.user_id = ? ORDER BY m.created_at DESC', [req.user.id])
      : await query('SELECT m.id, m.name, m.created_at, m.course_id, c.name AS course_name FROM modules m LEFT JOIN courses c ON c.id = m.course_id WHERE m.user_id = $1 ORDER BY m.created_at DESC', [req.user.id]);
    const modules = rowList(modulesQ);
    if (modules.length === 0) return res.json({ success: true, modules: [] });

    const itemsQ = isMySQL()
      ? await query(
          `SELECT mi.id, mi.module_id, mi.item_type, mi.item_id, mi.snapshot_title, mi.snapshot_code, mi.position, mi.section_index, mi.created_at
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           WHERE m.user_id = ?
           ORDER BY mi.position ASC, mi.created_at ASC`,
          [req.user.id]
        )
      : await query(
          `SELECT mi.id, mi.module_id, mi.item_type, mi.item_id, mi.snapshot_title, mi.snapshot_code, mi.position, mi.section_index, mi.created_at
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           WHERE m.user_id = $1
           ORDER BY mi.position ASC, mi.created_at ASC`,
          [req.user.id]
        );
    const items = rowList(itemsQ);
    const studentsQ = isMySQL()
      ? await query(
          `SELECT ms.module_id, ms.student_user_id, ms.created_at, u.name, u.email
           FROM module_students ms
           INNER JOIN modules m ON m.id = ms.module_id
           INNER JOIN users u ON u.id = ms.student_user_id
           WHERE m.user_id = ?`,
          [req.user.id]
        )
      : await query(
          `SELECT ms.module_id, ms.student_user_id, ms.created_at, u.name, u.email
           FROM module_students ms
           INNER JOIN modules m ON m.id = ms.module_id
           INNER JOIN users u ON u.id = ms.student_user_id
           WHERE m.user_id = $1`,
          [req.user.id]
        );
    const students = rowList(studentsQ);
    res.json({ success: true, modules: groupModules(modules, items, students) });
  } catch (error) {
    console.error('List modules error:', error);
    res.status(500).json({ error: 'Failed to list modules' });
  }
});

router.get('/students/available', requireAuth, async (req, res) => {
  try {
    const rows = req.user.organisation_id
      ? rowList(
          isMySQL()
            ? await query(
                `SELECT id, name, email
                 FROM users
                 WHERE is_active = 1
                   AND LOWER(role) = 'student'
                   AND organisation_id = ?
                 ORDER BY name ASC, email ASC`,
                [req.user.organisation_id]
              )
            : await query(
                `SELECT id, name, email
                 FROM users
                 WHERE is_active = TRUE
                   AND LOWER(role) = 'student'
                   AND organisation_id = $1
                 ORDER BY name ASC, email ASC`,
                [req.user.organisation_id]
              )
        )
      : rowList(
          isMySQL()
            ? await query(
                `SELECT id, name, email
                 FROM users
                 WHERE is_active = 1
                   AND LOWER(role) = 'student'
                 ORDER BY name ASC, email ASC
                 LIMIT 200`,
                []
              )
            : await query(
                `SELECT id, name, email
                 FROM users
                 WHERE is_active = TRUE
                   AND LOWER(role) = 'student'
                 ORDER BY name ASC, email ASC
                 LIMIT 200`,
                []
              )
        );
    res.json({ success: true, students: rows });
  } catch (error) {
    console.error('List available students error:', error);
    res.status(500).json({ error: 'Failed to list students' });
  }
});

router.get('/student', requireAuth, async (req, res) => {
  try {
    const modulesQ = isMySQL()
      ? await query(
          `SELECT DISTINCT m.id, m.name, m.created_at, m.course_id, c.name AS course_name
           FROM modules m
           LEFT JOIN courses c ON c.id = m.course_id
           INNER JOIN module_students ms ON ms.module_id = m.id
           LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
           WHERE ms.student_user_id = ?
             AND (hmw.homework_module_id IS NULL OR hmw.status = 'published')
           ORDER BY (m.course_id IS NULL) ASC, m.course_id ASC, m.created_at ASC, m.id ASC`,
          [req.user.id]
        )
      : await query(
          `SELECT DISTINCT m.id, m.name, m.created_at, m.course_id, c.name AS course_name
           FROM modules m
           LEFT JOIN courses c ON c.id = m.course_id
           INNER JOIN module_students ms ON ms.module_id = m.id
           LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
           WHERE ms.student_user_id = $1
             AND (hmw.homework_module_id IS NULL OR hmw.status = 'published')
           ORDER BY (m.course_id IS NULL) ASC, m.course_id ASC, m.created_at ASC, m.id ASC`,
          [req.user.id]
        );
    const modules = rowList(modulesQ);
    if (modules.length === 0) return res.json({ success: true, modules: [] });

    const itemsQ = isMySQL()
      ? await query(
          `SELECT mi.id, mi.module_id, mi.item_type, mi.item_id, mi.snapshot_title, mi.snapshot_code, mi.position, mi.section_index, mi.created_at
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           INNER JOIN module_students ms ON ms.module_id = m.id
           LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
           WHERE ms.student_user_id = ?
             AND (hmw.homework_module_id IS NULL OR hmw.status = 'published')
           ORDER BY mi.position ASC, mi.created_at ASC`,
          [req.user.id]
        )
      : await query(
          `SELECT mi.id, mi.module_id, mi.item_type, mi.item_id, mi.snapshot_title, mi.snapshot_code, mi.position, mi.section_index, mi.created_at
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           INNER JOIN module_students ms ON ms.module_id = m.id
           LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
           WHERE ms.student_user_id = $1
             AND (hmw.homework_module_id IS NULL OR hmw.status = 'published')
           ORDER BY mi.position ASC, mi.created_at ASC`,
          [req.user.id]
        );

    res.json({ success: true, modules: groupModules(modules, rowList(itemsQ), []) });
  } catch (error) {
    console.error('List student modules error:', error);
    res.status(500).json({ error: 'Failed to list student modules' });
  }
});

router.get('/student/homework-progress', requireAuth, async (req, res) => {
  try {
    const moduleRows = rowList(
      isMySQL()
        ? await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               hmw.reason_payload_json,
               mi.item_type,
               mi.item_id,
               mi.snapshot_title
             FROM modules m
             INNER JOIN module_students ms ON ms.module_id = m.id
             INNER JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_items mi ON mi.module_id = m.id
             WHERE ms.student_user_id = ?
               AND hmw.status = 'published'
               AND m.name LIKE ?
             ORDER BY m.created_at DESC, mi.position ASC, mi.id ASC`,
            [req.user.id, '% - Homework for %']
          )
        : await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               hmw.reason_payload_json,
               mi.item_type,
               mi.item_id,
               mi.snapshot_title
             FROM modules m
             INNER JOIN module_students ms ON ms.module_id = m.id
             INNER JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_items mi ON mi.module_id = m.id
             WHERE ms.student_user_id = $1
               AND hmw.status = 'published'
               AND m.name LIKE $2
             ORDER BY m.created_at DESC, mi.position ASC, mi.id ASC`,
            [req.user.id, '% - Homework for %']
          )
    );

    const grouped = new Map();
    for (const row of moduleRows) {
      const moduleId = Number(row.homework_module_id || 0);
      if (!moduleId) continue;
      if (!grouped.has(moduleId)) {
        grouped.set(moduleId, {
          homework_module_id: moduleId,
          homework_module_name: row.homework_module_name,
          homework_created_at: row.homework_created_at,
          reason_payload: safeJsonParse(row.reason_payload_json, null),
          assessment_id: null,
          assessment_title: null,
        });
      }
      const entry = grouped.get(moduleId);
      if (row.item_type === 'assessment' && !entry.assessment_id) {
        entry.assessment_id = Number(row.item_id) || null;
        entry.assessment_title = row.snapshot_title || 'Homework assessment';
      }
    }

    const items = Array.from(grouped.values());
    const assessmentIds = Array.from(new Set(items.map((item) => Number(item.assessment_id)).filter((id) => Number.isFinite(id) && id > 0)));
    const submissions = assessmentIds.length > 0
      ? rowList(
          isMySQL()
            ? await query(
                `SELECT
                   s.published_assessment_id,
                   s.status,
                   s.submitted_at,
                   s.completed_at,
                   s.assignment_id,
                   mr.scores,
                   mr.marked_at
                 FROM assessment_submissions s
                 LEFT JOIN marking_results mr
                   ON (mr.id = s.result_id OR (s.assignment_id IS NOT NULL AND mr.assignment_id = s.assignment_id AND mr.is_current = 1))
                 WHERE s.student_user_id = ?
                   AND s.published_assessment_id IN (${assessmentIds.map(() => '?').join(', ')})
                   AND s.status IN ('completed', 'processing', 'queued')
                 ORDER BY COALESCE(mr.marked_at, s.completed_at, s.submitted_at) DESC`,
                [req.user.id, ...assessmentIds]
              )
            : await query(
                `SELECT
                   s.published_assessment_id,
                   s.status,
                   s.submitted_at,
                   s.completed_at,
                   s.assignment_id,
                   mr.scores,
                   mr.marked_at
                 FROM assessment_submissions s
                 LEFT JOIN marking_results mr
                   ON (mr.id = s.result_id OR (s.assignment_id IS NOT NULL AND mr.assignment_id = s.assignment_id AND mr.is_current = TRUE))
                 WHERE s.student_user_id = $1
                   AND s.published_assessment_id = ANY($2::int[])
                   AND s.status IN ('completed', 'processing', 'queued')
                 ORDER BY COALESCE(mr.marked_at, s.completed_at, s.submitted_at) DESC`,
                [req.user.id, assessmentIds]
              )
        )
      : [];

    const progressItems = items.map((item) => {
      const scoped = submissions.filter((row) => Number(row.published_assessment_id) === Number(item.assessment_id));
      const completed = scoped.filter((row) => row.status === 'completed');
      const criteria = aggregateCriteriaFromSubmissionRows(completed);
      const weakAreaOutcomes = buildWeakAreaOutcomes(item.reason_payload?.weak_areas, criteria);
      const latest = completed[0] || null;
      return {
        homework_module_id: item.homework_module_id,
        homework_module_name: item.homework_module_name,
        homework_created_at: toIsoOrNull(item.homework_created_at),
        assessment: { id: item.assessment_id, title: item.assessment_title },
        attempts_total: scoped.length,
        completed_attempts: completed.length,
        latest_completed_at: toIsoOrNull(latest?.marked_at || latest?.completed_at || latest?.submitted_at || null),
        latest_score_percent: latest ? computeScorePercentFromRow(latest) : null,
        weak_area_outcomes: weakAreaOutcomes,
      };
    });

    res.json({ success: true, items: progressItems });
  } catch (error) {
    console.error('Student homework progress error:', error);
    res.status(500).json({ error: 'Failed to load student homework progress' });
  }
});

router.get('/homework-history', requireAuth, async (req, res) => {
  try {
    const cached = getHomeworkAnalyticsCachedResponse(req, 'homework-history');
    if (cached) return res.json(cached);

    const rows = rowList(
      isMySQL()
        ? await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               COALESCE(hmw.status, 'published') AS workflow_status,
               hmw.review_notes,
               hmw.reason_summary,
               hmw.reason_payload_json,
               hmw.reviewed_at,
               hmw.published_at,
               ms.student_user_id,
               u.name AS student_name,
               u.email AS student_email,
               mi.item_type,
               mi.item_id,
               mi.snapshot_title,
               mi.snapshot_code,
               mi.position
             FROM modules m
             LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_students ms ON ms.module_id = m.id
             LEFT JOIN users u ON u.id = ms.student_user_id
             LEFT JOIN module_items mi ON mi.module_id = m.id
             WHERE m.user_id = ?
               AND m.name LIKE ?
             ORDER BY m.created_at DESC, mi.position ASC, mi.id ASC`,
            [req.user.id, '% - Homework for %']
          )
        : await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               COALESCE(hmw.status, 'published') AS workflow_status,
               hmw.review_notes,
               hmw.reason_summary,
               hmw.reason_payload_json,
               hmw.reviewed_at,
               hmw.published_at,
               ms.student_user_id,
               u.name AS student_name,
               u.email AS student_email,
               mi.item_type,
               mi.item_id,
               mi.snapshot_title,
               mi.snapshot_code,
               mi.position
             FROM modules m
             LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_students ms ON ms.module_id = m.id
             LEFT JOIN users u ON u.id = ms.student_user_id
             LEFT JOIN module_items mi ON mi.module_id = m.id
             WHERE m.user_id = $1
               AND m.name LIKE $2
             ORDER BY m.created_at DESC, mi.position ASC, mi.id ASC`,
            [req.user.id, '% - Homework for %']
          )
    );

    const grouped = new Map();
    for (const row of rows) {
      const key = Number(row.homework_module_id);
      if (!Number.isFinite(key) || key <= 0) continue;
      if (!grouped.has(key)) {
        const moduleName = String(row.homework_module_name || `Homework ${key}`);
        const sourceModuleName = moduleName.split(' - Homework for ')[0] || moduleName;
        grouped.set(key, {
          homework_module_id: key,
          homework_module_name: moduleName,
          homework_created_at: row.homework_created_at,
          source_module_name: sourceModuleName,
          workflow: {
            status: String(row.workflow_status || 'published'),
            review_notes: row.review_notes || null,
            reason_summary: row.reason_summary || null,
            reason_payload: safeJsonParse(row.reason_payload_json, null),
            reviewed_at: row.reviewed_at || null,
            published_at: row.published_at || null,
            publish_blockers: [],
          },
          student: {
            id: Number(row.student_user_id) || null,
            name: row.student_name || row.student_email || 'Unknown student',
            email: row.student_email || null,
          },
          content: null,
          assessment: null,
        });
      }

      const entry = grouped.get(key);
      if (row.item_type === 'content' && !entry.content) {
        entry.content = {
          id: Number(row.item_id) || null,
          title: row.snapshot_title || 'Homework content',
          code: row.snapshot_code || null,
        };
      }
      if (row.item_type === 'assessment' && !entry.assessment) {
        entry.assessment = {
          id: Number(row.item_id) || null,
          title: row.snapshot_title || 'Homework assessment',
          code: row.snapshot_code || null,
        };
      }
    }

    const items = Array.from(grouped.values())
      .sort((a, b) => new Date(String(b.homework_created_at || 0)).getTime() - new Date(String(a.homework_created_at || 0)).getTime());

    const sourceNames = Array.from(new Set(items.map((item) => String(item.source_module_name || '').trim()).filter(Boolean)));
    let sourceIdByName = new Map();
    if (sourceNames.length > 0) {
      const sourceRows = rowList(
        isMySQL()
          ? await query(
              `SELECT id, name
               FROM modules
               WHERE user_id = ?
                 AND name IN (${sourceNames.map(() => '?').join(',')})`,
              [req.user.id, ...sourceNames]
            )
          : await query(
              `SELECT id, name
               FROM modules
               WHERE user_id = $1
                 AND name = ANY($2::text[])`,
              [req.user.id, sourceNames]
            )
      );
      sourceIdByName = new Map(sourceRows.map((row) => [String(row.name || ''), Number(row.id) || null]));
    }

    const enrichedItems = items.map((item) => {
      const blockers = computePublishBlockers({
        reasonPayload: item.workflow?.reason_payload,
        reviewNotes: item.workflow?.review_notes,
        hasContent: !!item.content?.code,
        hasAssessment: !!item.assessment?.code,
      });
      return {
        ...item,
        source_module_id: sourceIdByName.get(String(item.source_module_name || '')) ?? null,
        workflow: {
          ...item.workflow,
          publish_blockers: blockers,
        },
      };
    });
    const { items: pagedItems, pagination } = paginateList(
      enrichedItems,
      req.query?.limit,
      req.query?.offset,
      100,
      500
    );
    const responsePayload = { success: true, items: pagedItems, pagination };
    setHomeworkAnalyticsCachedResponse(req, 'homework-history', responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('List homework history error:', error);
    res.status(500).json({ error: 'Failed to load homework history' });
  }
});

router.get('/homework-review-queue', requireAuth, async (req, res) => {
  try {
    const cached = getHomeworkAnalyticsCachedResponse(req, 'homework-review-queue');
    if (cached) return res.json(cached);

    const statusFilter = String(req.query?.status || 'all').trim().toLowerCase();
    const olderThanDays = Math.max(0, Math.min(90, Number(req.query?.older_than_days || 0) || 0));
    const reminderDays = Math.max(1, Math.min(30, Number(req.query?.reminder_days || 3) || 3));
    const allowedStatus = new Set(['all', 'draft', 'reviewed']);
    if (!allowedStatus.has(statusFilter)) {
      return res.status(400).json({ error: 'status must be one of all, draft, reviewed' });
    }

    const statusClauseMy = statusFilter === 'all' ? `hmw.status IN ('draft', 'reviewed')` : 'hmw.status = ?';
    const statusClausePg = statusFilter === 'all' ? `hmw.status IN ('draft', 'reviewed')` : 'hmw.status = $2';
    const paramsMy = statusFilter === 'all' ? [req.user.id] : [req.user.id, statusFilter];
    const paramsPg = statusFilter === 'all' ? [req.user.id] : [req.user.id, statusFilter];
    const rows = rowList(
      isMySQL()
        ? await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               hmw.status AS workflow_status,
               hmw.review_notes,
               hmw.reason_payload_json,
               hmw.updated_at,
               ms.student_user_id,
               u.name AS student_name,
               u.email AS student_email
             FROM modules m
             INNER JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_students ms ON ms.module_id = m.id
             LEFT JOIN users u ON u.id = ms.student_user_id
             WHERE m.user_id = ?
               AND ${statusClauseMy}
               AND m.name LIKE ?
             ORDER BY hmw.updated_at ASC, m.created_at ASC`,
            [...paramsMy, '% - Homework for %']
          )
        : await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               hmw.status AS workflow_status,
               hmw.review_notes,
               hmw.reason_payload_json,
               hmw.updated_at,
               ms.student_user_id,
               u.name AS student_name,
               u.email AS student_email
             FROM modules m
             INNER JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_students ms ON ms.module_id = m.id
             LEFT JOIN users u ON u.id = ms.student_user_id
             WHERE m.user_id = $1
               AND ${statusClausePg}
               AND m.name LIKE $${statusFilter === 'all' ? 2 : 3}
             ORDER BY hmw.updated_at ASC, m.created_at ASC`,
            [...paramsPg, '% - Homework for %']
          )
    );

    const itemCounts = await fetchModuleItemTypeCounts(rows.map((row) => Number(row.homework_module_id || 0)));
    const now = Date.now();
    const items = rows.map((row) => {
      const moduleId = Number(row.homework_module_id || 0);
      const reasonPayload = safeJsonParse(row.reason_payload_json, null);
      const counts = itemCounts.get(moduleId) || { content: 0, assessment: 0 };
      const blockers = computePublishBlockers({
        reasonPayload,
        reviewNotes: row.review_notes,
        hasContent: counts.content > 0,
        hasAssessment: counts.assessment > 0,
      });
      const updatedAt = new Date(row.updated_at || row.homework_created_at || new Date());
      const ageDays = Math.max(0, Math.floor((now - updatedAt.getTime()) / 86400000));
      return {
        homework_module_id: moduleId,
        homework_module_name: row.homework_module_name,
        workflow_status: String(row.workflow_status || 'draft'),
        student: {
          id: Number(row.student_user_id) || null,
          name: row.student_name || row.student_email || 'Unknown student',
          email: row.student_email || null,
        },
        updated_at: toIsoOrNull(row.updated_at) || toIsoOrNull(row.homework_created_at),
        age_days: ageDays,
        needs_reminder: ageDays >= reminderDays,
        blockers,
      };
    }).filter((item) => (olderThanDays > 0 ? item.age_days >= olderThanDays : true));

    const { items: pagedItems, pagination } = paginateList(
      items,
      req.query?.limit,
      req.query?.offset,
      200,
      500
    );
    const responsePayload = {
      success: true,
      summary: {
        queue_count: items.length,
        reminder_count: items.filter((item) => item.needs_reminder).length,
        older_than_days: olderThanDays,
        reminder_days: reminderDays,
      },
      items: pagedItems,
      pagination,
    };
    setHomeworkAnalyticsCachedResponse(req, 'homework-review-queue', responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('Homework review queue error:', error);
    res.status(500).json({ error: 'Failed to load homework review queue' });
  }
});

router.get('/homework-outcomes', requireAuth, async (req, res) => {
  try {
    const cached = getHomeworkAnalyticsCachedResponse(req, 'homework-outcomes');
    if (cached) return res.json(cached);

    const rows = rowList(
      isMySQL()
        ? await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               hmw.reason_payload_json,
               ms.student_user_id,
               u.name AS student_name,
               u.email AS student_email,
               mi.item_type,
               mi.item_id,
               mi.snapshot_title
             FROM modules m
             LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_students ms ON ms.module_id = m.id
             LEFT JOIN users u ON u.id = ms.student_user_id
             LEFT JOIN module_items mi ON mi.module_id = m.id
             WHERE m.user_id = ?
               AND m.name LIKE ?
             ORDER BY m.created_at DESC, mi.position ASC, mi.id ASC`,
            [req.user.id, '% - Homework for %']
          )
        : await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               hmw.reason_payload_json,
               ms.student_user_id,
               u.name AS student_name,
               u.email AS student_email,
               mi.item_type,
               mi.item_id,
               mi.snapshot_title
             FROM modules m
             LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_students ms ON ms.module_id = m.id
             LEFT JOIN users u ON u.id = ms.student_user_id
             LEFT JOIN module_items mi ON mi.module_id = m.id
             WHERE m.user_id = $1
               AND m.name LIKE $2
             ORDER BY m.created_at DESC, mi.position ASC, mi.id ASC`,
            [req.user.id, '% - Homework for %']
          )
    );

    const grouped = new Map();
    for (const row of rows) {
      const moduleId = Number(row.homework_module_id || 0);
      if (!moduleId) continue;
      if (!grouped.has(moduleId)) {
        grouped.set(moduleId, {
          homework_module_id: moduleId,
          homework_module_name: row.homework_module_name,
          homework_created_at: row.homework_created_at,
          student: {
            id: Number(row.student_user_id) || null,
            name: row.student_name || row.student_email || 'Unknown student',
            email: row.student_email || null,
          },
          reason_payload: safeJsonParse(row.reason_payload_json, null),
          assessment_id: null,
          assessment_title: null,
        });
      }
      const entry = grouped.get(moduleId);
      if (row.item_type === 'assessment' && !entry.assessment_id) {
        entry.assessment_id = Number(row.item_id) || null;
        entry.assessment_title = row.snapshot_title || 'Homework assessment';
      }
    }

    const baseItems = Array.from(grouped.values());
    const assessmentIds = Array.from(new Set(baseItems.map((item) => Number(item.assessment_id)).filter((id) => Number.isFinite(id) && id > 0)));
    const studentIds = Array.from(new Set(baseItems.map((item) => Number(item.student?.id)).filter((id) => Number.isFinite(id) && id > 0)));

    const submissionRows = (assessmentIds.length > 0 && studentIds.length > 0)
      ? rowList(
          isMySQL()
            ? await query(
                `SELECT
                   s.published_assessment_id,
                   s.student_user_id,
                   s.status,
                   s.submitted_at,
                   s.completed_at,
                   s.assignment_id,
                   mr.scores,
                   mr.total_score,
                   mr.effective_total_score,
                   mr.marked_at
                 FROM assessment_submissions s
                 LEFT JOIN marking_results mr
                   ON (mr.id = s.result_id OR (s.assignment_id IS NOT NULL AND mr.assignment_id = s.assignment_id AND mr.is_current = 1))
                 WHERE s.published_assessment_id IN (${assessmentIds.map(() => '?').join(', ')})
                   AND s.student_user_id IN (${studentIds.map(() => '?').join(', ')})
                   AND s.status IN ('completed', 'processing', 'queued')`,
                [...assessmentIds, ...studentIds]
              )
            : await query(
                `SELECT
                   s.published_assessment_id,
                   s.student_user_id,
                   s.status,
                   s.submitted_at,
                   s.completed_at,
                   s.assignment_id,
                   mr.scores,
                   mr.total_score,
                   mr.effective_total_score,
                   mr.marked_at
                 FROM assessment_submissions s
                 LEFT JOIN marking_results mr
                   ON (mr.id = s.result_id OR (s.assignment_id IS NOT NULL AND mr.assignment_id = s.assignment_id AND mr.is_current = TRUE))
                 WHERE s.published_assessment_id = ANY($1::int[])
                   AND s.student_user_id = ANY($2::int[])
                   AND s.status IN ('completed', 'processing', 'queued')`,
                [assessmentIds, studentIds]
              )
        )
      : [];

    const items = baseItems.map((item) => {
      const scopedRows = submissionRows.filter(
        (row) => Number(row.published_assessment_id) === Number(item.assessment_id)
          && Number(row.student_user_id) === Number(item.student?.id)
      );
      const completedRows = scopedRows.filter((row) => row.status === 'completed');
      const sortedCompleted = completedRows.slice().sort((a, b) => {
        const da = new Date(a.marked_at || a.completed_at || a.submitted_at || 0).getTime();
        const db = new Date(b.marked_at || b.completed_at || b.submitted_at || 0).getTime();
        return db - da;
      });
      const latest = sortedCompleted[0] || null;
      const criteria = aggregateCriteriaFromSubmissionRows(completedRows);
      const weakAreaOutcomes = buildWeakAreaOutcomes(item.reason_payload?.weak_areas, criteria);
      const improvedCount = weakAreaOutcomes.filter((w) => w.status === 'improved').length;
      const declinedCount = weakAreaOutcomes.filter((w) => w.status === 'declined').length;
      const unchangedCount = weakAreaOutcomes.filter((w) => w.status === 'unchanged').length;
      const knownDeltas = weakAreaOutcomes
        .map((w) => (w.delta_percent == null ? null : Number(w.delta_percent)))
        .filter((v) => Number.isFinite(v));
      const impactPercent = knownDeltas.length > 0
        ? Number((knownDeltas.reduce((sum, val) => sum + Number(val), 0) / knownDeltas.length).toFixed(1))
        : null;
      const impactStatus = impactPercent == null
        ? 'unknown'
        : impactPercent >= 2
          ? 'positive'
          : impactPercent <= -2
            ? 'negative'
            : 'neutral';
      return {
        homework_module_id: item.homework_module_id,
        homework_module_name: item.homework_module_name,
        homework_created_at: toIsoOrNull(item.homework_created_at),
        student: item.student,
        assessment: {
          id: item.assessment_id,
          title: item.assessment_title,
        },
        attempts_total: scopedRows.length,
        completed_attempts: completedRows.length,
        latest_completed_at: toIsoOrNull(latest?.marked_at || latest?.completed_at || latest?.submitted_at || null),
        latest_score_percent: latest ? computeScorePercentFromRow(latest) : null,
        weak_area_outcomes: weakAreaOutcomes,
        summary: {
          improved_count: improvedCount,
          declined_count: declinedCount,
          unchanged_count: unchangedCount,
          impact_percent: impactPercent,
          impact_status: impactStatus,
          follow_up_recommended: declinedCount > 0 || (completedRows.length > 0 && improvedCount === 0),
        },
      };
    }).sort((a, b) => new Date(String(b.homework_created_at || 0)).getTime() - new Date(String(a.homework_created_at || 0)).getTime());

    const { items: pagedItems, pagination } = paginateList(
      items,
      req.query?.limit,
      req.query?.offset,
      200,
      500
    );
    const responsePayload = { success: true, items: pagedItems, pagination };
    setHomeworkAnalyticsCachedResponse(req, 'homework-outcomes', responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('Homework outcomes error:', error);
    res.status(500).json({ error: 'Failed to load homework outcomes' });
  }
});

router.get('/homework-trends', requireAuth, async (req, res) => {
  try {
    const cached = getHomeworkAnalyticsCachedResponse(req, 'homework-trends');
    if (cached) return res.json(cached);

    const studentFilter = req.query?.student_id != null ? Number(req.query.student_id) : null;
    const rows = rowList(
      isMySQL()
        ? await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               hmw.reason_payload_json,
               ms.student_user_id,
               u.name AS student_name,
               u.email AS student_email,
               mi.item_type,
               mi.item_id,
               mi.snapshot_title
             FROM modules m
             LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_students ms ON ms.module_id = m.id
             LEFT JOIN users u ON u.id = ms.student_user_id
             LEFT JOIN module_items mi ON mi.module_id = m.id
             WHERE m.user_id = ?
               AND m.name LIKE ?
             ORDER BY m.created_at DESC, mi.position ASC, mi.id ASC`,
            [req.user.id, '% - Homework for %']
          )
        : await query(
            `SELECT
               m.id AS homework_module_id,
               m.name AS homework_module_name,
               m.created_at AS homework_created_at,
               hmw.reason_payload_json,
               ms.student_user_id,
               u.name AS student_name,
               u.email AS student_email,
               mi.item_type,
               mi.item_id,
               mi.snapshot_title
             FROM modules m
             LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
             LEFT JOIN module_students ms ON ms.module_id = m.id
             LEFT JOIN users u ON u.id = ms.student_user_id
             LEFT JOIN module_items mi ON mi.module_id = m.id
             WHERE m.user_id = $1
               AND m.name LIKE $2
             ORDER BY m.created_at DESC, mi.position ASC, mi.id ASC`,
            [req.user.id, '% - Homework for %']
          )
    );

    const grouped = new Map();
    for (const row of rows) {
      const moduleId = Number(row.homework_module_id || 0);
      if (!moduleId) continue;
      if (!grouped.has(moduleId)) {
        grouped.set(moduleId, {
          homework_module_id: moduleId,
          homework_module_name: row.homework_module_name,
          homework_created_at: row.homework_created_at,
          student: {
            id: Number(row.student_user_id) || null,
            name: row.student_name || row.student_email || 'Unknown student',
            email: row.student_email || null,
          },
          reason_payload: safeJsonParse(row.reason_payload_json, null),
          assessment_id: null,
          assessment_title: null,
        });
      }
      const entry = grouped.get(moduleId);
      if (row.item_type === 'assessment' && !entry.assessment_id) {
        entry.assessment_id = Number(row.item_id) || null;
        entry.assessment_title = row.snapshot_title || 'Homework assessment';
      }
    }
    const baseItems = Array.from(grouped.values());
    const assessmentIds = Array.from(new Set(baseItems.map((item) => Number(item.assessment_id)).filter((id) => Number.isFinite(id) && id > 0)));
    const studentIds = Array.from(new Set(baseItems.map((item) => Number(item.student?.id)).filter((id) => Number.isFinite(id) && id > 0)));
    const submissionRows = (assessmentIds.length > 0 && studentIds.length > 0)
      ? rowList(
          isMySQL()
            ? await query(
                `SELECT
                   s.published_assessment_id,
                   s.student_user_id,
                   s.status,
                   s.submitted_at,
                   s.completed_at,
                   s.assignment_id,
                   mr.scores,
                   mr.total_score,
                   mr.effective_total_score,
                   mr.marked_at
                 FROM assessment_submissions s
                 LEFT JOIN marking_results mr
                   ON (mr.id = s.result_id OR (s.assignment_id IS NOT NULL AND mr.assignment_id = s.assignment_id AND mr.is_current = 1))
                 WHERE s.published_assessment_id IN (${assessmentIds.map(() => '?').join(', ')})
                   AND s.student_user_id IN (${studentIds.map(() => '?').join(', ')})
                   AND s.status IN ('completed', 'processing', 'queued')`,
                [...assessmentIds, ...studentIds]
              )
            : await query(
                `SELECT
                   s.published_assessment_id,
                   s.student_user_id,
                   s.status,
                   s.submitted_at,
                   s.completed_at,
                   s.assignment_id,
                   mr.scores,
                   mr.total_score,
                   mr.effective_total_score,
                   mr.marked_at
                 FROM assessment_submissions s
                 LEFT JOIN marking_results mr
                   ON (mr.id = s.result_id OR (s.assignment_id IS NOT NULL AND mr.assignment_id = s.assignment_id AND mr.is_current = TRUE))
                 WHERE s.published_assessment_id = ANY($1::int[])
                   AND s.student_user_id = ANY($2::int[])
                   AND s.status IN ('completed', 'processing', 'queued')`,
                [assessmentIds, studentIds]
              )
        )
      : [];

    const outcomeItems = baseItems.map((item) => {
      const scopedRows = submissionRows.filter(
        (row) => Number(row.published_assessment_id) === Number(item.assessment_id)
          && Number(row.student_user_id) === Number(item.student?.id)
      );
      const completedRows = scopedRows.filter((row) => row.status === 'completed');
      const sortedCompleted = completedRows.slice().sort((a, b) => {
        const da = new Date(a.marked_at || a.completed_at || a.submitted_at || 0).getTime();
        const db = new Date(b.marked_at || b.completed_at || b.submitted_at || 0).getTime();
        return db - da;
      });
      const latest = sortedCompleted[0] || null;
      const criteria = aggregateCriteriaFromSubmissionRows(completedRows);
      const weakAreaOutcomes = buildWeakAreaOutcomes(item.reason_payload?.weak_areas, criteria);
      const improvedCount = weakAreaOutcomes.filter((w) => w.status === 'improved').length;
      const declinedCount = weakAreaOutcomes.filter((w) => w.status === 'declined').length;
      const unchangedCount = weakAreaOutcomes.filter((w) => w.status === 'unchanged').length;
      const knownDeltas = weakAreaOutcomes
        .map((w) => (w.delta_percent == null ? null : Number(w.delta_percent)))
        .filter((v) => Number.isFinite(v));
      const impactPercent = knownDeltas.length > 0
        ? Number((knownDeltas.reduce((sum, val) => sum + Number(val), 0) / knownDeltas.length).toFixed(1))
        : null;
      const impactStatus = impactPercent == null
        ? 'unknown'
        : impactPercent >= 2
          ? 'positive'
          : impactPercent <= -2
            ? 'negative'
            : 'neutral';
      return {
        homework_module_id: item.homework_module_id,
        homework_module_name: item.homework_module_name,
        homework_created_at: toIsoOrNull(item.homework_created_at),
        student: item.student,
        assessment: {
          id: item.assessment_id,
          title: item.assessment_title,
        },
        attempts_total: scopedRows.length,
        completed_attempts: completedRows.length,
        latest_completed_at: toIsoOrNull(latest?.marked_at || latest?.completed_at || latest?.submitted_at || null),
        latest_score_percent: latest ? computeScorePercentFromRow(latest) : null,
        weak_area_outcomes: weakAreaOutcomes,
        summary: {
          improved_count: improvedCount,
          declined_count: declinedCount,
          unchanged_count: unchangedCount,
          impact_percent: impactPercent,
          impact_status: impactStatus,
          follow_up_recommended: declinedCount > 0 || (completedRows.length > 0 && improvedCount === 0),
        },
      };
    });

    const scopedOutcomes = studentFilter && Number.isFinite(studentFilter) && studentFilter > 0
      ? outcomeItems.filter((item) => Number(item?.student?.id) === studentFilter)
      : outcomeItems;

    const sortedTimeline = scopedOutcomes
      .slice()
      .sort((a, b) => new Date(String(a.homework_created_at || 0)).getTime() - new Date(String(b.homework_created_at || 0)).getTime());

    const studentMap = new Map();
    for (const item of sortedTimeline) {
      const sid = Number(item?.student?.id || 0);
      if (!sid) continue;
      if (!studentMap.has(sid)) {
        studentMap.set(sid, {
          student: item.student,
          rows: [],
        });
      }
      studentMap.get(sid).rows.push(item);
    }

    const student_summaries = Array.from(studentMap.values())
      .map((entry) => {
        const rows = entry.rows;
        const latest = rows[rows.length - 1] || null;
        const scores = rows
          .map((row) => (row.latest_score_percent == null ? null : Number(row.latest_score_percent)))
          .filter((v) => Number.isFinite(v));
        const impacts = rows
          .map((row) => (row.summary?.impact_percent == null ? null : Number(row.summary.impact_percent)))
          .filter((v) => Number.isFinite(v));
        return {
          student: entry.student,
          cycles: rows.length,
          latest_score_percent: latest?.latest_score_percent ?? null,
          avg_score_percent: scores.length > 0
            ? Number((scores.reduce((sum, val) => sum + Number(val), 0) / scores.length).toFixed(1))
            : null,
          avg_impact_percent: impacts.length > 0
            ? Number((impacts.reduce((sum, val) => sum + Number(val), 0) / impacts.length).toFixed(1))
            : null,
          improved_cycles: rows.filter((row) => String(row?.summary?.impact_status || '') === 'positive').length,
          declined_cycles: rows.filter((row) => String(row?.summary?.impact_status || '') === 'negative').length,
          latest_completed_at: latest?.latest_completed_at || null,
        };
      })
      .sort((a, b) => String(a.student?.name || '').localeCompare(String(b.student?.name || '')));

    const allImpacts = sortedTimeline
      .map((row) => (row.summary?.impact_percent == null ? null : Number(row.summary.impact_percent)))
      .filter((v) => Number.isFinite(v));

    const { items: pagedTimeline, pagination } = paginateList(
      sortedTimeline.map((item) => ({
        homework_module_id: item.homework_module_id,
        homework_module_name: item.homework_module_name,
        homework_created_at: item.homework_created_at,
        student: item.student,
        latest_score_percent: item.latest_score_percent,
        latest_completed_at: item.latest_completed_at,
        impact_percent: item.summary?.impact_percent ?? null,
        impact_status: item.summary?.impact_status || 'unknown',
        improved_count: item.summary?.improved_count || 0,
        unchanged_count: item.summary?.unchanged_count || 0,
        declined_count: item.summary?.declined_count || 0,
        follow_up_recommended: !!item.summary?.follow_up_recommended,
      })),
      req.query?.limit,
      req.query?.offset,
      200,
      500
    );
    const responsePayload = {
      success: true,
      summary: {
        total_cycles: sortedTimeline.length,
        student_count: student_summaries.length,
        improved_cycles: sortedTimeline.filter((row) => String(row?.summary?.impact_status || '') === 'positive').length,
        declined_cycles: sortedTimeline.filter((row) => String(row?.summary?.impact_status || '') === 'negative').length,
        avg_impact_percent: allImpacts.length > 0
          ? Number((allImpacts.reduce((sum, val) => sum + Number(val), 0) / allImpacts.length).toFixed(1))
          : null,
      },
      students: student_summaries,
      timeline: pagedTimeline,
      pagination,
    };
    setHomeworkAnalyticsCachedResponse(req, 'homework-trends', responsePayload);
    res.json(responsePayload);
  } catch (error) {
    console.error('Homework trends error:', error);
    res.status(500).json({ error: 'Failed to load homework trends' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const cleanName = name.slice(0, 255);
    const rawCourseId = req.body?.course_id;
    const courseId = rawCourseId === undefined || rawCourseId === null || rawCourseId === '' ? null : Number(rawCourseId);
    if (courseId !== null && !(await userCanUseCourse(req.user, courseId))) {
      return res.status(403).json({ error: 'You cannot add modules to that course' });
    }
    let moduleId;
    if (isMySQL()) {
      const inserted = await query('INSERT INTO modules (user_id, name, course_id) VALUES (?, ?, ?)', [req.user.id, cleanName, courseId]);
      moduleId = inserted.insertId ?? inserted.lastID;
    } else {
      const inserted = await query('INSERT INTO modules (user_id, name, course_id) VALUES ($1, $2, $3) RETURNING id', [req.user.id, cleanName, courseId]);
      moduleId = rowList(inserted)[0]?.id;
    }
    if (courseId !== null) await syncCourseStudentsToModule(moduleId, courseId);
    const q = isMySQL()
      ? await query('SELECT m.id, m.name, m.created_at, m.course_id, c.name AS course_name FROM modules m LEFT JOIN courses c ON c.id = m.course_id WHERE m.id = ? AND m.user_id = ?', [moduleId, req.user.id])
      : await query('SELECT m.id, m.name, m.created_at, m.course_id, c.name AS course_name FROM modules m LEFT JOIN courses c ON c.id = m.course_id WHERE m.id = $1 AND m.user_id = $2', [moduleId, req.user.id]);
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);
    res.json({ success: true, module: { ...rowList(q)[0], items: [], students: [] } });
  } catch (error) {
    console.error('Create module error:', error);
    res.status(500).json({ error: 'Failed to create module' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid module id' });
    const hasName = req.body?.name !== undefined;
    const hasCourse = Object.prototype.hasOwnProperty.call(req.body || {}, 'course_id');
    const name = String(req.body?.name || '').trim().slice(0, 255);
    if (hasName && !name) return res.status(400).json({ error: 'name is required' });
    if (!hasName && !hasCourse) return res.status(400).json({ error: 'name or course_id is required' });

    const moduleRow = await moduleBelongsToUser(id, req.user.id);
    if (!moduleRow) return res.status(404).json({ error: 'Module not found' });

    let courseId = null;
    if (hasCourse) {
      const raw = req.body.course_id;
      courseId = raw === null || raw === '' ? null : Number(raw);
      if (courseId !== null && !(await userCanUseCourse(req.user, courseId))) {
        return res.status(403).json({ error: 'You cannot add modules to that course' });
      }
    }
    if (hasName) {
      if (isMySQL()) await query('UPDATE modules SET name = ? WHERE id = ? AND user_id = ?', [name, id, req.user.id]);
      else await query('UPDATE modules SET name = $1 WHERE id = $2 AND user_id = $3', [name, id, req.user.id]);
    }
    if (hasCourse) {
      if (isMySQL()) await query('UPDATE modules SET course_id = ? WHERE id = ? AND user_id = ?', [courseId, id, req.user.id]);
      else await query('UPDATE modules SET course_id = $1 WHERE id = $2 AND user_id = $3', [courseId, id, req.user.id]);
      if (courseId !== null) await syncCourseStudentsToModule(id, courseId);
    }
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);
    res.json({ success: true, message: 'Module updated' });
  } catch (error) {
    console.error('Update module error:', error);
    res.status(500).json({ error: 'Failed to update module' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid module id' });
    const deleted = isMySQL()
      ? await query('DELETE FROM modules WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('DELETE FROM modules WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'Module not found' });
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);
    res.json({ success: true, message: 'Module deleted' });
  } catch (error) {
    console.error('Delete module error:', error);
    res.status(500).json({ error: 'Failed to delete module' });
  }
});

router.post('/:id/items', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const itemType = String(req.body?.item_type || '').trim().toLowerCase();
    const itemId = Number(req.body?.item_id);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!['content', 'assessment'].includes(itemType)) {
      return res.status(400).json({ error: 'item_type must be content or assessment' });
    }
    if (!Number.isFinite(itemId) || itemId <= 0) return res.status(400).json({ error: 'Invalid item_id' });

    const sectionIndex = (req.body?.section_index !== undefined && req.body?.section_index !== null)
      ? Number(req.body.section_index)
      : -1;

    const moduleRow = await moduleBelongsToUser(moduleId, req.user.id);
    if (!moduleRow) return res.status(404).json({ error: 'Module not found' });

    const meta = itemType === 'content'
      ? await getContentMeta(itemId, req.user.id, sectionIndex)
      : await getAssessmentMeta(itemId, req.user.id);
    if (!meta) return res.status(404).json({ error: `${itemType} item not found` });

    const maxQ = isMySQL()
      ? await query('SELECT COALESCE(MAX(position), -1) AS max_position FROM module_items WHERE module_id = ?', [moduleId])
      : await query('SELECT COALESCE(MAX(position), -1) AS max_position FROM module_items WHERE module_id = $1', [moduleId]);
    const nextPos = Number(rowList(maxQ)[0]?.max_position ?? -1) + 1;

    if (isMySQL()) {
      await query(
        `INSERT INTO module_items (module_id, item_type, item_id, snapshot_title, snapshot_code, position, section_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [moduleId, itemType, itemId, meta.title, meta.code, nextPos, sectionIndex]
      );
    } else {
      await query(
        `INSERT INTO module_items (module_id, item_type, item_id, snapshot_title, snapshot_code, position, section_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [moduleId, itemType, itemId, meta.title, meta.code, nextPos, sectionIndex]
      );
    }
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);
    res.json({ success: true, message: 'Item added to module' });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' || String(error?.message || '').toLowerCase().includes('unique')) {
      return res.status(409).json({ error: 'Item already exists in this module' });
    }
    console.error('Add module item error:', error);
    res.status(500).json({ error: 'Failed to add item to module' });
  }
});

router.post('/:id/students', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const studentUserId = Number(req.body?.student_user_id);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!Number.isFinite(studentUserId) || studentUserId <= 0) {
      return res.status(400).json({ error: 'student_user_id is required' });
    }

    const moduleRow = await moduleBelongsToUser(moduleId, req.user.id);
    if (!moduleRow) return res.status(404).json({ error: 'Module not found' });

    const student = await getEligibleStudent(studentUserId, req.user);
    if (!student) {
      return res.status(404).json({ error: 'Student not found or not eligible for this module' });
    }

    if (isMySQL()) {
      await query(
        'INSERT INTO module_students (module_id, student_user_id) VALUES (?, ?)',
        [moduleId, studentUserId]
      );
    } else {
      await query(
        'INSERT INTO module_students (module_id, student_user_id) VALUES ($1, $2)',
        [moduleId, studentUserId]
      );
    }
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);
    res.json({ success: true, message: 'Student added to module' });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' || String(error?.message || '').toLowerCase().includes('unique')) {
      return res.status(409).json({ error: 'Student already added to this module' });
    }
    console.error('Add module student error:', error);
    res.status(500).json({ error: 'Failed to add student to module' });
  }
});

router.delete('/:id/students/:studentUserId', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const studentUserId = Number(req.params.studentUserId);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!Number.isFinite(studentUserId) || studentUserId <= 0) return res.status(400).json({ error: 'Invalid student id' });
    const deleted = isMySQL()
      ? await query(
          `DELETE ms FROM module_students ms
           INNER JOIN modules m ON m.id = ms.module_id
           WHERE ms.module_id = ? AND ms.student_user_id = ? AND m.user_id = ?`,
          [moduleId, studentUserId, req.user.id]
        )
      : await query(
          `DELETE FROM module_students
           WHERE module_id = $1
             AND student_user_id = $2
             AND module_id IN (SELECT id FROM modules WHERE id = $1 AND user_id = $3)`,
          [moduleId, studentUserId, req.user.id]
        );
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'Student not enrolled in this module' });
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);
    res.json({ success: true, message: 'Student removed from module' });
  } catch (error) {
    console.error('Remove module student error:', error);
    res.status(500).json({ error: 'Failed to remove student from module' });
  }
});

router.delete('/:id/items/:moduleItemId', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const moduleItemId = Number(req.params.moduleItemId);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!Number.isFinite(moduleItemId) || moduleItemId <= 0) return res.status(400).json({ error: 'Invalid module item id' });
    const deleted = isMySQL()
      ? await query(
          `DELETE mi FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           WHERE mi.id = ? AND mi.module_id = ? AND m.user_id = ?`,
          [moduleItemId, moduleId, req.user.id]
        )
      : await query(
          `DELETE FROM module_items
           WHERE id = $1 AND module_id = $2
             AND module_id IN (SELECT id FROM modules WHERE id = $2 AND user_id = $3)`,
          [moduleItemId, moduleId, req.user.id]
        );
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'Module item not found' });
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);
    res.json({ success: true, message: 'Item removed' });
  } catch (error) {
    console.error('Delete module item error:', error);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

router.put('/:id/reorder', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const orderedIds = Array.isArray(req.body?.item_ids) ? req.body.item_ids.map((v) => Number(v)) : [];
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (orderedIds.length === 0) return res.status(400).json({ error: 'item_ids is required' });

    const moduleRow = await moduleBelongsToUser(moduleId, req.user.id);
    if (!moduleRow) return res.status(404).json({ error: 'Module not found' });

    const existingQ = isMySQL()
      ? await query('SELECT id FROM module_items WHERE module_id = ?', [moduleId])
      : await query('SELECT id FROM module_items WHERE module_id = $1', [moduleId]);
    const existingIds = rowList(existingQ).map((r) => Number(r.id)).sort((a, b) => a - b);
    const requestedIds = orderedIds.slice().sort((a, b) => a - b);
    if (existingIds.length !== requestedIds.length || existingIds.some((v, idx) => v !== requestedIds[idx])) {
      return res.status(400).json({ error: 'item_ids must include all module item ids exactly once' });
    }

    for (let i = 0; i < orderedIds.length; i += 1) {
      const itemId = orderedIds[i];
      if (isMySQL()) {
        await query('UPDATE module_items SET position = ? WHERE id = ? AND module_id = ?', [i, itemId, moduleId]);
      } else {
        await query('UPDATE module_items SET position = $1 WHERE id = $2 AND module_id = $3', [i, itemId, moduleId]);
      }
    }
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);
    res.json({ success: true, message: 'Module items reordered' });
  } catch (error) {
    console.error('Reorder module items error:', error);
    res.status(500).json({ error: 'Failed to reorder module items' });
  }
});

router.put('/homework-workflow/bulk', requireAuth, async (req, res) => {
  try {
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!HOMEWORK_WORKFLOW_STATES.has(status)) {
      return res.status(400).json({ error: 'status must be one of draft, reviewed, published' });
    }

    const moduleIds = Array.from(new Set(
      (Array.isArray(req.body?.module_ids) ? req.body.module_ids : [])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
    ));
    if (moduleIds.length === 0) {
      return res.status(400).json({ error: 'module_ids must contain at least one module id' });
    }
    if (moduleIds.length > 200) {
      return res.status(400).json({ error: 'You can update at most 200 modules at once' });
    }

    const scopedModulesQ = isMySQL()
      ? await query(
          `SELECT m.id, m.name, hmw.status AS workflow_status, hmw.review_notes, hmw.reason_payload_json, hmw.reviewed_at, hmw.reviewed_by_user_id, hmw.published_at, hmw.published_by_user_id
           FROM modules m
           LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
           WHERE m.user_id = ? AND m.id IN (${moduleIds.map(() => '?').join(', ')})`,
          [req.user.id, ...moduleIds]
        )
      : await query(
          `SELECT m.id, m.name, hmw.status AS workflow_status, hmw.review_notes, hmw.reason_payload_json, hmw.reviewed_at, hmw.reviewed_by_user_id, hmw.published_at, hmw.published_by_user_id
           FROM modules m
           LEFT JOIN homework_module_workflows hmw ON hmw.homework_module_id = m.id
           WHERE m.user_id = $1 AND m.id IN (${moduleIds.map((_, idx) => `$${idx + 2}`).join(', ')})`,
          [req.user.id, ...moduleIds]
        );

    const scopedRows = rowList(scopedModulesQ);
    const scopedById = new Map(scopedRows.map((row) => [Number(row.id), row]));
    const skippedIds = [];
    const eligibleRows = [];
    for (const moduleId of moduleIds) {
      const row = scopedById.get(moduleId);
      if (!row) {
        skippedIds.push(moduleId);
        continue;
      }
      const isHomeworkModule = !!row.workflow_status || String(row.name || '').includes(' - Homework for ');
      if (!isHomeworkModule) {
        skippedIds.push(moduleId);
        continue;
      }
      eligibleRows.push(row);
    }

    if (eligibleRows.length === 0) {
      return res.status(400).json({ error: 'No eligible homework modules found for bulk update', skipped_ids: skippedIds });
    }

    const itemCounts = await fetchModuleItemTypeCounts(moduleIds);
    const updatedIds = [];
    const skippedDetails = [];
    for (const row of eligibleRows) {
      const moduleId = Number(row.id);
      if (!row.workflow_status) {
        await ensureHomeworkWorkflow(moduleId, req.user.id, 'draft', row.review_notes || null);
      }

      const now = new Date();
      let reviewedAt = row.reviewed_at || null;
      let reviewedBy = row.reviewed_by_user_id || null;
      let publishedAt = row.published_at || null;
      let publishedBy = row.published_by_user_id || null;
      const reviewNotes = row.review_notes == null ? null : String(row.review_notes).slice(0, 2000);
      const reasonPayload = safeJsonParse(row.reason_payload_json, null);
      const counts = itemCounts.get(moduleId) || { content: 0, assessment: 0 };
      const blockers = status === 'published'
        ? computePublishBlockers({
            reasonPayload,
            reviewNotes,
            hasContent: counts.content > 0,
            hasAssessment: counts.assessment > 0,
          })
        : [];
      if (blockers.length > 0) {
        skippedIds.push(moduleId);
        skippedDetails.push({ module_id: moduleId, blockers });
        continue;
      }

      if (status === 'draft') {
        publishedAt = null;
        publishedBy = null;
      } else if (status === 'reviewed') {
        reviewedAt = reviewedAt || now;
        reviewedBy = reviewedBy || req.user.id;
        publishedAt = null;
        publishedBy = null;
      } else if (status === 'published') {
        reviewedAt = reviewedAt || now;
        reviewedBy = reviewedBy || req.user.id;
        publishedAt = now;
        publishedBy = req.user.id;
      }

      if (isMySQL()) {
        await query(
          `UPDATE homework_module_workflows
           SET status = ?, review_notes = ?, reviewed_at = ?, reviewed_by_user_id = ?, published_at = ?, published_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE homework_module_id = ?`,
          [status, reviewNotes, reviewedAt, reviewedBy, publishedAt, publishedBy, moduleId]
        );
      } else {
        await query(
          `UPDATE homework_module_workflows
           SET status = $1, review_notes = $2, reviewed_at = $3, reviewed_by_user_id = $4, published_at = $5, published_by_user_id = $6, updated_at = CURRENT_TIMESTAMP
           WHERE homework_module_id = $7`,
          [status, reviewNotes, reviewedAt, reviewedBy, publishedAt, publishedBy, moduleId]
        );
      }

      updatedIds.push(moduleId);
    }

    try {
      await persistHomeworkWorkflowEvent({
        user_id: req.user.id,
        action: 'bulk_workflow_status_update',
        status,
        target_count: moduleIds.length,
        updated_count: updatedIds.length,
        skipped_count: skippedIds.length,
        module_ids: moduleIds,
        updated_ids: updatedIds,
        skipped_ids: skippedIds,
        skipped_details: skippedDetails,
      });
    } catch (eventError) {
      console.warn('[homework-workflow] Failed to persist workflow event:', eventError?.message || eventError);
    }

    await recordAuditEvent({
      user_id: req.user.id,
      category: 'module_workflow',
      action: 'bulk_workflow_status_update',
      outcome: 'success',
      organisation_id: req.user?.organisation_id ?? null,
      department_id: req.user?.department_id ?? null,
      metadata: getRequestMetadata(req, {
        status,
        target_count: moduleIds.length,
        updated_count: updatedIds.length,
        skipped_count: skippedIds.length,
        module_ids: moduleIds,
      }),
    });
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);

    res.json({
      success: true,
      status,
      updated_count: updatedIds.length,
      updated_ids: updatedIds,
      skipped_ids: skippedIds,
      skipped_details: skippedDetails,
    });
  } catch (error) {
    console.error('Bulk update homework workflow error:', error);
    res.status(500).json({ error: 'Failed to bulk update homework workflow' });
  }
});

router.put('/:id/homework-workflow', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const status = String(req.body?.status || '').trim().toLowerCase();
    const reviewNotes = req.body?.review_notes == null ? null : String(req.body.review_notes).slice(0, 2000);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!HOMEWORK_WORKFLOW_STATES.has(status)) {
      return res.status(400).json({ error: 'status must be one of draft, reviewed, published' });
    }

    const moduleQ = isMySQL()
      ? await query('SELECT id, name, user_id FROM modules WHERE id = ? AND user_id = ?', [moduleId, req.user.id])
      : await query('SELECT id, name, user_id FROM modules WHERE id = $1 AND user_id = $2', [moduleId, req.user.id]);
    const moduleRow = rowList(moduleQ)[0];
    if (!moduleRow) return res.status(404).json({ error: 'Module not found' });

    const workflowQ = isMySQL()
      ? await query(
          `SELECT homework_module_id, status, review_notes, reason_summary, reason_payload_json, reviewed_at, reviewed_by_user_id, published_at, published_by_user_id
           FROM homework_module_workflows
           WHERE homework_module_id = ?`,
          [moduleId]
        )
      : await query(
          `SELECT homework_module_id, status, review_notes, reason_summary, reason_payload_json, reviewed_at, reviewed_by_user_id, published_at, published_by_user_id
           FROM homework_module_workflows
           WHERE homework_module_id = $1`,
          [moduleId]
        );
    const currentWorkflow = rowList(workflowQ)[0] || null;
    const moduleName = String(moduleRow.name || '');
    const isHomeworkModule = !!currentWorkflow || moduleName.includes(' - Homework for ');
    if (!isHomeworkModule) {
      return res.status(400).json({ error: 'Workflow is only available for custom homework modules' });
    }

    if (!currentWorkflow) {
      await ensureHomeworkWorkflow(moduleId, req.user.id, 'draft', reviewNotes);
    }

    const refreshedQ = isMySQL()
      ? await query(
          `SELECT homework_module_id, status, review_notes, reason_summary, reason_payload_json, reviewed_at, reviewed_by_user_id, published_at, published_by_user_id
           FROM homework_module_workflows
           WHERE homework_module_id = ?`,
          [moduleId]
        )
      : await query(
          `SELECT homework_module_id, status, review_notes, reason_summary, reason_payload_json, reviewed_at, reviewed_by_user_id, published_at, published_by_user_id
           FROM homework_module_workflows
           WHERE homework_module_id = $1`,
          [moduleId]
        );
    const existing = rowList(refreshedQ)[0] || {};
    const reasonPayload = safeJsonParse(existing.reason_payload_json, null);
    const itemCounts = await fetchModuleItemTypeCounts([moduleId]);
    const counts = itemCounts.get(moduleId) || { content: 0, assessment: 0 };
    if (status === 'published') {
      const blockers = computePublishBlockers({
        reasonPayload,
        reviewNotes,
        hasContent: counts.content > 0,
        hasAssessment: counts.assessment > 0,
      });
      if (blockers.length > 0) {
        return res.status(400).json({
          error: 'Cannot publish homework module until all publish guardrails are satisfied',
          blockers,
        });
      }
    }
    const now = new Date();
    let reviewedAt = existing.reviewed_at || null;
    let reviewedBy = existing.reviewed_by_user_id || null;
    let publishedAt = existing.published_at || null;
    let publishedBy = existing.published_by_user_id || null;

    if (status === 'draft') {
      publishedAt = null;
      publishedBy = null;
    } else if (status === 'reviewed') {
      reviewedAt = reviewedAt || now;
      reviewedBy = reviewedBy || req.user.id;
      publishedAt = null;
      publishedBy = null;
    } else if (status === 'published') {
      reviewedAt = reviewedAt || now;
      reviewedBy = reviewedBy || req.user.id;
      publishedAt = now;
      publishedBy = req.user.id;
    }

    if (isMySQL()) {
      await query(
        `UPDATE homework_module_workflows
         SET status = ?, review_notes = ?, reviewed_at = ?, reviewed_by_user_id = ?, published_at = ?, published_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE homework_module_id = ?`,
        [status, reviewNotes, reviewedAt, reviewedBy, publishedAt, publishedBy, moduleId]
      );
    } else {
      await query(
        `UPDATE homework_module_workflows
         SET status = $1, review_notes = $2, reviewed_at = $3, reviewed_by_user_id = $4, published_at = $5, published_by_user_id = $6, updated_at = CURRENT_TIMESTAMP
         WHERE homework_module_id = $7`,
        [status, reviewNotes, reviewedAt, reviewedBy, publishedAt, publishedBy, moduleId]
      );
    }

    try {
      await persistHomeworkWorkflowEvent({
        user_id: req.user.id,
        action: 'single_workflow_status_update',
        status,
        target_count: 1,
        updated_count: 1,
        skipped_count: 0,
        module_ids: [moduleId],
        updated_ids: [moduleId],
        skipped_ids: [],
      });
    } catch (eventError) {
      console.warn('[homework-workflow] Failed to persist single workflow event:', eventError?.message || eventError);
    }
    invalidateHomeworkAnalyticsCacheForUser(req.user.id);

    res.json({
      success: true,
      workflow: {
        status,
        review_notes: reviewNotes,
        reason_summary: existing.reason_summary || null,
        reason_payload: reasonPayload,
        reviewed_at: reviewedAt ? new Date(reviewedAt).toISOString() : null,
        reviewed_by_user_id: reviewedBy ? Number(reviewedBy) : null,
        published_at: publishedAt ? new Date(publishedAt).toISOString() : null,
        published_by_user_id: publishedBy ? Number(publishedBy) : null,
        publish_blockers: computePublishBlockers({
          reasonPayload,
          reviewNotes,
          hasContent: counts.content > 0,
          hasAssessment: counts.assessment > 0,
        }),
      },
    });
  } catch (error) {
    console.error('Update homework workflow error:', error);
    res.status(500).json({ error: 'Failed to update homework workflow' });
  }
});

router.get('/admin/custom-homework-telemetry', requireAuth, requireRoles(['management']), async (req, res) => {
  try {
    const applyOrgScope = !isSuperAdmin(req.user);
    if (applyOrgScope && req.user.organisation_id == null) {
      return res.json({
        success: true,
        summary: {
          total_events: 0,
          success_events: 0,
          error_events: 0,
          fallback_events: 0,
          average_duration_ms: 0,
          total_estimated_cost_usd: 0,
        },
        daily_trend: [],
        recent_events: [],
        workflow_recent_events: [],
        workflow_metrics: {
          review_backlog_count: 0,
          average_publish_latency_hours: 0,
          published_completion_rate_percent: 0,
          published_modules: 0,
        },
      });
    }

    const scopeClause = applyOrgScope ? ' AND owner.organisation_id = ?' : '';
    const scopeParams = applyOrgScope ? [req.user.organisation_id] : [];

    const summaryResult = isMySQL()
      ? await query(
          `SELECT
             COUNT(*) AS total_events,
             SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             SUM(CASE WHEN t.assessment_generation_mode = 'fallback' THEN 1 ELSE 0 END) AS fallback_events,
             AVG(t.duration_ms) AS average_duration_ms,
             COALESCE(SUM(t.estimated_cost_usd), 0) AS total_estimated_cost_usd
           FROM custom_homework_telemetry t
           INNER JOIN users owner ON owner.id = t.user_id
           WHERE 1=1${scopeClause}`,
          scopeParams
        )
      : await query(
          `SELECT
             COUNT(*) AS total_events,
             SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             SUM(CASE WHEN t.assessment_generation_mode = 'fallback' THEN 1 ELSE 0 END) AS fallback_events,
             AVG(t.duration_ms) AS average_duration_ms,
             COALESCE(SUM(t.estimated_cost_usd), 0) AS total_estimated_cost_usd
           FROM custom_homework_telemetry t
           INNER JOIN users owner ON owner.id = t.user_id
           WHERE 1=1${applyOrgScope ? ' AND owner.organisation_id = $1' : ''}`,
          scopeParams
        );

    const trendResult = isMySQL()
      ? await query(
          `SELECT
             DATE(t.created_at) AS date,
             COUNT(*) AS total_events,
             SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             SUM(CASE WHEN t.assessment_generation_mode = 'fallback' THEN 1 ELSE 0 END) AS fallback_events
           FROM custom_homework_telemetry t
           INNER JOIN users owner ON owner.id = t.user_id
           WHERE t.created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)${scopeClause}
           GROUP BY DATE(t.created_at)
           ORDER BY DATE(t.created_at) DESC`,
          scopeParams
        )
      : await query(
          `SELECT
             DATE(t.created_at) AS date,
             COUNT(*) AS total_events,
             SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             SUM(CASE WHEN t.assessment_generation_mode = 'fallback' THEN 1 ELSE 0 END) AS fallback_events
           FROM custom_homework_telemetry t
           INNER JOIN users owner ON owner.id = t.user_id
           WHERE t.created_at >= NOW() - INTERVAL '14 days'${applyOrgScope ? ' AND owner.organisation_id = $1' : ''}
           GROUP BY DATE(t.created_at)
           ORDER BY DATE(t.created_at) DESC`,
          scopeParams
        );

    const recentResult = isMySQL()
      ? await query(
          `SELECT
             t.id,
             t.status,
             t.duration_ms,
             t.content_generation_ms,
             t.assessment_generation_ms,
             t.assessment_generation_mode,
             t.prompt_tokens,
             t.completion_tokens,
             t.total_tokens,
             t.estimated_cost_usd,
             t.error_message,
             t.metadata_json,
             t.created_at,
             owner.id AS owner_user_id,
             owner.name AS owner_name,
             owner.email AS owner_email
           FROM custom_homework_telemetry t
           INNER JOIN users owner ON owner.id = t.user_id
           WHERE 1=1${scopeClause}
           ORDER BY t.created_at DESC
           LIMIT 25`,
          scopeParams
        )
      : await query(
          `SELECT
             t.id,
             t.status,
             t.duration_ms,
             t.content_generation_ms,
             t.assessment_generation_ms,
             t.assessment_generation_mode,
             t.prompt_tokens,
             t.completion_tokens,
             t.total_tokens,
             t.estimated_cost_usd,
             t.error_message,
             t.metadata_json,
             t.created_at,
             owner.id AS owner_user_id,
             owner.name AS owner_name,
             owner.email AS owner_email
           FROM custom_homework_telemetry t
           INNER JOIN users owner ON owner.id = t.user_id
           WHERE 1=1${applyOrgScope ? ' AND owner.organisation_id = $1' : ''}
           ORDER BY t.created_at DESC
           LIMIT 25`,
          scopeParams
        );

    const workflowRecentResult = isMySQL()
      ? await query(
          `SELECT
             e.id,
             e.action,
             e.status,
             e.target_count,
             e.updated_count,
             e.skipped_count,
             e.module_ids_json,
             e.metadata_json,
             e.created_at,
             owner.id AS owner_user_id,
             owner.name AS owner_name,
             owner.email AS owner_email
           FROM homework_workflow_events e
           INNER JOIN users owner ON owner.id = e.user_id
           WHERE 1=1${scopeClause}
           ORDER BY e.created_at DESC
           LIMIT 25`,
          scopeParams
        )
      : await query(
          `SELECT
             e.id,
             e.action,
             e.status,
             e.target_count,
             e.updated_count,
             e.skipped_count,
             e.module_ids_json,
             e.metadata_json,
             e.created_at,
             owner.id AS owner_user_id,
             owner.name AS owner_name,
             owner.email AS owner_email
           FROM homework_workflow_events e
           INNER JOIN users owner ON owner.id = e.user_id
           WHERE 1=1${applyOrgScope ? ' AND owner.organisation_id = $1' : ''}
           ORDER BY e.created_at DESC
           LIMIT 25`,
          scopeParams
        );

    const workflowMetricsResult = isMySQL()
      ? await query(
          `SELECT
             SUM(CASE WHEN hmw.status IN ('draft', 'reviewed') THEN 1 ELSE 0 END) AS review_backlog_count,
             AVG(CASE WHEN hmw.published_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, m.created_at, hmw.published_at) / 3600 END) AS average_publish_latency_hours,
             SUM(CASE WHEN hmw.status = 'published' THEN 1 ELSE 0 END) AS published_modules
           FROM homework_module_workflows hmw
           INNER JOIN modules m ON m.id = hmw.homework_module_id
           INNER JOIN users owner ON owner.id = m.user_id
           WHERE 1=1${scopeClause}`,
          scopeParams
        )
      : await query(
          `SELECT
             SUM(CASE WHEN hmw.status IN ('draft', 'reviewed') THEN 1 ELSE 0 END) AS review_backlog_count,
             AVG(CASE WHEN hmw.published_at IS NOT NULL THEN EXTRACT(EPOCH FROM (hmw.published_at - m.created_at)) / 3600.0 END) AS average_publish_latency_hours,
             SUM(CASE WHEN hmw.status = 'published' THEN 1 ELSE 0 END) AS published_modules
           FROM homework_module_workflows hmw
           INNER JOIN modules m ON m.id = hmw.homework_module_id
           INNER JOIN users owner ON owner.id = m.user_id
           WHERE 1=1${applyOrgScope ? ' AND owner.organisation_id = $1' : ''}`,
          scopeParams
        );

    const workflowCompletionResult = isMySQL()
      ? await query(
          `SELECT
             COUNT(DISTINCT hm.module_id) AS published_modules_with_assessment,
             COUNT(DISTINCT CASE WHEN s.status = 'completed' THEN hm.module_id END) AS modules_with_completed_submission
           FROM (
             SELECT
               hmw.homework_module_id AS module_id,
               MAX(CASE WHEN mi.item_type = 'assessment' THEN mi.item_id END) AS assessment_id,
               m.user_id
             FROM homework_module_workflows hmw
             INNER JOIN modules m ON m.id = hmw.homework_module_id
             LEFT JOIN module_items mi ON mi.module_id = hmw.homework_module_id
             INNER JOIN users owner ON owner.id = m.user_id
             WHERE hmw.status = 'published'${scopeClause}
             GROUP BY hmw.homework_module_id, m.user_id
           ) hm
           LEFT JOIN assessment_submissions s ON s.published_assessment_id = hm.assessment_id`,
          scopeParams
        )
      : await query(
          `SELECT
             COUNT(DISTINCT hm.module_id) AS published_modules_with_assessment,
             COUNT(DISTINCT CASE WHEN s.status = 'completed' THEN hm.module_id END) AS modules_with_completed_submission
           FROM (
             SELECT
               hmw.homework_module_id AS module_id,
               MAX(CASE WHEN mi.item_type = 'assessment' THEN mi.item_id END) AS assessment_id,
               m.user_id
             FROM homework_module_workflows hmw
             INNER JOIN modules m ON m.id = hmw.homework_module_id
             LEFT JOIN module_items mi ON mi.module_id = hmw.homework_module_id
             INNER JOIN users owner ON owner.id = m.user_id
             WHERE hmw.status = 'published'${applyOrgScope ? ' AND owner.organisation_id = $1' : ''}
             GROUP BY hmw.homework_module_id, m.user_id
           ) hm
           LEFT JOIN assessment_submissions s ON s.published_assessment_id = hm.assessment_id`,
          scopeParams
        );

    const summary = rowList(summaryResult)[0] || {};
    const dailyTrend = rowList(trendResult).map((row) => ({
      date: row.date,
      total_events: Number(row.total_events || 0),
      success_events: Number(row.success_events || 0),
      error_events: Number(row.error_events || 0),
      fallback_events: Number(row.fallback_events || 0),
    }));
    const recentEvents = rowList(recentResult).map((row) => ({
      id: Number(row.id || 0),
      status: row.status,
      duration_ms: Number(row.duration_ms || 0),
      content_generation_ms: row.content_generation_ms != null ? Number(row.content_generation_ms) : null,
      assessment_generation_ms: row.assessment_generation_ms != null ? Number(row.assessment_generation_ms) : null,
      assessment_generation_mode: row.assessment_generation_mode || null,
      prompt_tokens: row.prompt_tokens != null ? Number(row.prompt_tokens) : null,
      completion_tokens: row.completion_tokens != null ? Number(row.completion_tokens) : null,
      total_tokens: row.total_tokens != null ? Number(row.total_tokens) : null,
      estimated_cost_usd: row.estimated_cost_usd != null ? Number(row.estimated_cost_usd) : null,
      error_message: row.error_message || null,
      metadata: safeJsonParse(row.metadata_json, {}),
      created_at: row.created_at,
      owner: {
        id: Number(row.owner_user_id || 0),
        name: row.owner_name || row.owner_email || 'Unknown',
        email: row.owner_email || null,
      },
    }));
    const workflowRecentEvents = rowList(workflowRecentResult).map((row) => ({
      id: Number(row.id || 0),
      action: row.action || 'workflow_update',
      status: row.status || null,
      target_count: Number(row.target_count || 0),
      updated_count: Number(row.updated_count || 0),
      skipped_count: Number(row.skipped_count || 0),
      module_ids: safeJsonParse(row.module_ids_json, []),
      metadata: safeJsonParse(row.metadata_json, {}),
      created_at: row.created_at,
      owner: {
        id: Number(row.owner_user_id || 0),
        name: row.owner_name || row.owner_email || 'Unknown',
        email: row.owner_email || null,
      },
    }));
    const workflowMetrics = rowList(workflowMetricsResult)[0] || {};
    const completionMetrics = rowList(workflowCompletionResult)[0] || {};
    const publishedModulesWithAssessment = Number(completionMetrics.published_modules_with_assessment || 0);
    const modulesWithCompletedSubmission = Number(completionMetrics.modules_with_completed_submission || 0);
    const completionRate = publishedModulesWithAssessment > 0
      ? Number(((modulesWithCompletedSubmission / publishedModulesWithAssessment) * 100).toFixed(1))
      : 0;

    res.json({
      success: true,
      summary: {
        total_events: Number(summary.total_events || 0),
        success_events: Number(summary.success_events || 0),
        error_events: Number(summary.error_events || 0),
        fallback_events: Number(summary.fallback_events || 0),
        average_duration_ms: Number(summary.average_duration_ms || 0),
        total_estimated_cost_usd: Number(summary.total_estimated_cost_usd || 0),
      },
      daily_trend: dailyTrend,
      recent_events: recentEvents,
      workflow_recent_events: workflowRecentEvents,
      workflow_metrics: {
        review_backlog_count: Number(workflowMetrics.review_backlog_count || 0),
        average_publish_latency_hours: Number(workflowMetrics.average_publish_latency_hours || 0),
        published_completion_rate_percent: completionRate,
        published_modules: Number(workflowMetrics.published_modules || 0),
      },
    });
  } catch (error) {
    console.error('Custom homework telemetry analytics error:', error);
    res.status(500).json({ error: 'Failed to load custom homework telemetry' });
  }
});

router.get('/admin/generation-telemetry', requireAuth, requireRoles(['management']), async (req, res) => {
  try {
    const applyOrgScope = !isSuperAdmin(req.user);
    if (applyOrgScope && req.user.organisation_id == null) {
      return res.json({
        success: true,
        summary: {
          total_events: 0,
          success_events: 0,
          error_events: 0,
          error_rate_percent: 0,
          average_duration_ms: 0,
          total_estimated_cost_usd: 0,
        },
        by_type: [],
        daily_trend: [],
        recent_events: [],
      });
    }

    const days = parseClampedInt(req.query?.days, 14, 1, 60);
    const eventLimit = parseClampedInt(req.query?.limit, 30, 5, 100);
    const scopeClause = applyOrgScope ? ' AND owner.organisation_id = ?' : '';
    const scopeParams = applyOrgScope ? [req.user.organisation_id] : [];

    const summaryResult = isMySQL()
      ? await query(
          `SELECT
             COUNT(*) AS total_events,
             SUM(CASE WHEN g.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN g.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             AVG(g.duration_ms) AS average_duration_ms,
             COALESCE(SUM(g.estimated_cost_usd), 0) AS total_estimated_cost_usd
           FROM generation_telemetry_events g
           INNER JOIN users owner ON owner.id = g.user_id
           WHERE g.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${scopeClause}`,
          [days, ...scopeParams]
        )
      : await query(
          `SELECT
             COUNT(*) AS total_events,
             SUM(CASE WHEN g.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN g.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             AVG(g.duration_ms) AS average_duration_ms,
             COALESCE(SUM(g.estimated_cost_usd), 0) AS total_estimated_cost_usd
           FROM generation_telemetry_events g
           INNER JOIN users owner ON owner.id = g.user_id
           WHERE g.created_at >= NOW() - ($1::text || ' days')::interval${applyOrgScope ? ' AND owner.organisation_id = $2' : ''}`,
          applyOrgScope ? [days, req.user.organisation_id] : [days]
        );

    const byTypeResult = isMySQL()
      ? await query(
          `SELECT
             g.generation_type,
             COUNT(*) AS total_events,
             SUM(CASE WHEN g.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN g.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             AVG(g.duration_ms) AS average_duration_ms,
             COALESCE(SUM(g.estimated_cost_usd), 0) AS total_estimated_cost_usd
           FROM generation_telemetry_events g
           INNER JOIN users owner ON owner.id = g.user_id
           WHERE g.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${scopeClause}
           GROUP BY g.generation_type
           ORDER BY total_events DESC, g.generation_type ASC`,
          [days, ...scopeParams]
        )
      : await query(
          `SELECT
             g.generation_type,
             COUNT(*) AS total_events,
             SUM(CASE WHEN g.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN g.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             AVG(g.duration_ms) AS average_duration_ms,
             COALESCE(SUM(g.estimated_cost_usd), 0) AS total_estimated_cost_usd
           FROM generation_telemetry_events g
           INNER JOIN users owner ON owner.id = g.user_id
           WHERE g.created_at >= NOW() - ($1::text || ' days')::interval${applyOrgScope ? ' AND owner.organisation_id = $2' : ''}
           GROUP BY g.generation_type
           ORDER BY total_events DESC, g.generation_type ASC`,
          applyOrgScope ? [days, req.user.organisation_id] : [days]
        );

    const trendResult = isMySQL()
      ? await query(
          `SELECT
             DATE(g.created_at) AS date,
             COUNT(*) AS total_events,
             SUM(CASE WHEN g.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN g.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             COALESCE(SUM(g.estimated_cost_usd), 0) AS total_estimated_cost_usd
           FROM generation_telemetry_events g
           INNER JOIN users owner ON owner.id = g.user_id
           WHERE g.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${scopeClause}
           GROUP BY DATE(g.created_at)
           ORDER BY DATE(g.created_at) DESC`,
          [days, ...scopeParams]
        )
      : await query(
          `SELECT
             DATE(g.created_at) AS date,
             COUNT(*) AS total_events,
             SUM(CASE WHEN g.status = 'success' THEN 1 ELSE 0 END) AS success_events,
             SUM(CASE WHEN g.status = 'error' THEN 1 ELSE 0 END) AS error_events,
             COALESCE(SUM(g.estimated_cost_usd), 0) AS total_estimated_cost_usd
           FROM generation_telemetry_events g
           INNER JOIN users owner ON owner.id = g.user_id
           WHERE g.created_at >= NOW() - ($1::text || ' days')::interval${applyOrgScope ? ' AND owner.organisation_id = $2' : ''}
           GROUP BY DATE(g.created_at)
           ORDER BY DATE(g.created_at) DESC`,
          applyOrgScope ? [days, req.user.organisation_id] : [days]
        );

    const recentResult = isMySQL()
      ? await query(
          `SELECT
             g.id,
             g.generation_type,
             g.status,
             g.provider,
             g.model,
             g.duration_ms,
             g.prompt_tokens,
             g.completion_tokens,
             g.total_tokens,
             g.estimated_cost_usd,
             g.error_type,
             g.error_message,
             g.metadata_json,
             g.created_at,
             owner.id AS owner_user_id,
             owner.name AS owner_name,
             owner.email AS owner_email
           FROM generation_telemetry_events g
           INNER JOIN users owner ON owner.id = g.user_id
           WHERE g.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${scopeClause}
           ORDER BY g.created_at DESC
           LIMIT ?`,
          [days, ...scopeParams, eventLimit]
        )
      : await query(
          `SELECT
             g.id,
             g.generation_type,
             g.status,
             g.provider,
             g.model,
             g.duration_ms,
             g.prompt_tokens,
             g.completion_tokens,
             g.total_tokens,
             g.estimated_cost_usd,
             g.error_type,
             g.error_message,
             g.metadata_json,
             g.created_at,
             owner.id AS owner_user_id,
             owner.name AS owner_name,
             owner.email AS owner_email
           FROM generation_telemetry_events g
           INNER JOIN users owner ON owner.id = g.user_id
           WHERE g.created_at >= NOW() - ($1::text || ' days')::interval${applyOrgScope ? ' AND owner.organisation_id = $2' : ''}
           ORDER BY g.created_at DESC
           LIMIT $${applyOrgScope ? '3' : '2'}`,
          applyOrgScope ? [days, req.user.organisation_id, eventLimit] : [days, eventLimit]
        );

    const summary = rowList(summaryResult)[0] || {};
    const totalEvents = Number(summary.total_events || 0);
    const errorEvents = Number(summary.error_events || 0);
    const errorRatePercent = totalEvents > 0 ? Number(((errorEvents / totalEvents) * 100).toFixed(1)) : 0;
    const byType = rowList(byTypeResult).map((row) => {
      const typeTotal = Number(row.total_events || 0);
      const typeErrors = Number(row.error_events || 0);
      return {
        generation_type: row.generation_type || 'unknown',
        total_events: typeTotal,
        success_events: Number(row.success_events || 0),
        error_events: typeErrors,
        error_rate_percent: typeTotal > 0 ? Number(((typeErrors / typeTotal) * 100).toFixed(1)) : 0,
        average_duration_ms: Number(row.average_duration_ms || 0),
        total_estimated_cost_usd: Number(row.total_estimated_cost_usd || 0),
      };
    });
    const dailyTrend = rowList(trendResult).map((row) => ({
      date: row.date,
      total_events: Number(row.total_events || 0),
      success_events: Number(row.success_events || 0),
      error_events: Number(row.error_events || 0),
      total_estimated_cost_usd: Number(row.total_estimated_cost_usd || 0),
    }));
    const recentEvents = rowList(recentResult).map((row) => ({
      id: Number(row.id || 0),
      generation_type: row.generation_type || 'unknown',
      status: row.status || 'unknown',
      provider: row.provider || null,
      model: row.model || null,
      duration_ms: Number(row.duration_ms || 0),
      prompt_tokens: row.prompt_tokens != null ? Number(row.prompt_tokens) : null,
      completion_tokens: row.completion_tokens != null ? Number(row.completion_tokens) : null,
      total_tokens: row.total_tokens != null ? Number(row.total_tokens) : null,
      estimated_cost_usd: row.estimated_cost_usd != null ? Number(row.estimated_cost_usd) : null,
      error_type: row.error_type || null,
      error_message: row.error_message || null,
      metadata: safeJsonParse(row.metadata_json, {}),
      created_at: row.created_at,
      owner: {
        id: Number(row.owner_user_id || 0),
        name: row.owner_name || row.owner_email || 'Unknown',
        email: row.owner_email || null,
      },
    }));

    res.json({
      success: true,
      summary: {
        total_events: totalEvents,
        success_events: Number(summary.success_events || 0),
        error_events: errorEvents,
        error_rate_percent: errorRatePercent,
        average_duration_ms: Number(summary.average_duration_ms || 0),
        total_estimated_cost_usd: Number(summary.total_estimated_cost_usd || 0),
      },
      by_type: byType,
      daily_trend: dailyTrend,
      recent_events: recentEvents,
    });
  } catch (error) {
    console.error('Generation telemetry analytics error:', error);
    res.status(500).json({ error: 'Failed to load generation telemetry' });
  }
});

router.get('/admin/budget-guardrails', requireAuth, requireRoles(['management']), async (req, res) => {
  try {
    const applyOrgScope = !isSuperAdmin(req.user);
    if (applyOrgScope && req.user.organisation_id == null) {
      const config = getBudgetGuardrailConfig();
      return res.json({
        success: true,
        config,
        summary: {
          users_analyzed: 0,
          users_at_or_above_budget: 0,
          users_near_budget: 0,
          total_spent_last_24h_usd: 0,
          average_spent_last_24h_usd: 0,
        },
        items: [],
      });
    }

    const config = getBudgetGuardrailConfig();
    const nearThresholdPercent = Math.max(1, Math.min(100, parseClampedInt(req.query?.near_threshold_percent, 80, 1, 100)));
    const limit = parseClampedInt(req.query?.limit, 100, 10, 300);

    const rowsResult = isMySQL()
      ? await query(
          `SELECT
             owner.id AS owner_user_id,
             owner.name AS owner_name,
             owner.email AS owner_email,
             COALESCE(SUM(g.estimated_cost_usd), 0) AS spent_last_24h_usd
           FROM users owner
           LEFT JOIN generation_telemetry_events g
             ON g.user_id = owner.id
             AND g.status = 'success'
             AND g.created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
           WHERE owner.role IN ('management', 'lecturer')
             ${applyOrgScope ? 'AND owner.organisation_id = ?' : ''}
           GROUP BY owner.id, owner.name, owner.email
           ORDER BY spent_last_24h_usd DESC, owner.id ASC
           LIMIT ?`,
          applyOrgScope ? [req.user.organisation_id, limit] : [limit]
        )
      : await query(
          `SELECT
             owner.id AS owner_user_id,
             owner.name AS owner_name,
             owner.email AS owner_email,
             COALESCE(SUM(g.estimated_cost_usd), 0) AS spent_last_24h_usd
           FROM users owner
           LEFT JOIN generation_telemetry_events g
             ON g.user_id = owner.id
             AND g.status = 'success'
             AND g.created_at >= NOW() - INTERVAL '24 hours'
           WHERE owner.role IN ('management', 'lecturer')
             ${applyOrgScope ? 'AND owner.organisation_id = $1' : ''}
           GROUP BY owner.id, owner.name, owner.email
           ORDER BY spent_last_24h_usd DESC, owner.id ASC
           LIMIT $${applyOrgScope ? '2' : '1'}`,
          applyOrgScope ? [req.user.organisation_id, limit] : [limit]
        );

    const items = rowList(rowsResult).map((row) => {
      const spent = Number(row.spent_last_24h_usd || 0);
      const usagePercent = config.daily_budget_usd > 0 ? Number(((spent / config.daily_budget_usd) * 100).toFixed(1)) : 0;
      const remaining = Math.max(0, config.daily_budget_usd - spent);
      const atOrAboveBudget = spent >= config.daily_budget_usd;
      const nearBudget = !atOrAboveBudget && usagePercent >= nearThresholdPercent;
      return {
        user: {
          id: Number(row.owner_user_id || 0),
          name: row.owner_name || row.owner_email || 'Unknown',
          email: row.owner_email || null,
        },
        spent_last_24h_usd: Number(spent.toFixed(4)),
        daily_budget_usd: Number(config.daily_budget_usd.toFixed(4)),
        remaining_usd: Number(remaining.toFixed(4)),
        usage_percent: usagePercent,
        at_or_above_budget: atOrAboveBudget,
        near_budget: nearBudget,
      };
    });

    const totalSpent = items.reduce((sum, item) => sum + Number(item.spent_last_24h_usd || 0), 0);
    const usersAtOrAboveBudget = items.filter((item) => item.at_or_above_budget).length;
    const usersNearBudget = items.filter((item) => item.near_budget).length;

    res.json({
      success: true,
      config,
      summary: {
        users_analyzed: items.length,
        users_at_or_above_budget: usersAtOrAboveBudget,
        users_near_budget: usersNearBudget,
        total_spent_last_24h_usd: Number(totalSpent.toFixed(4)),
        average_spent_last_24h_usd: items.length > 0 ? Number((totalSpent / items.length).toFixed(4)) : 0,
      },
      items,
    });
  } catch (error) {
    console.error('Budget guardrail analytics error:', error);
    res.status(500).json({ error: 'Failed to load budget guardrail analytics' });
  }
});

router.get('/admin/prompt-registry', requireAuth, requireRoles(['management', 'lecturer']), async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    const isManager = role === 'management' || role === 'admin';
    const scope = isManager && String(req.query?.scope || '').toLowerCase() === 'all' ? 'all' : 'mine';
    const generationType = String(req.query?.generation_type || '').trim() || null;
    const limit = parseClampedInt(req.query?.limit, 100, 1, 300);
    const rows = await listPromptRegistry({
      user_id: req.user.id,
      generation_type: generationType,
      scope,
      limit,
    });

    const items = rows.map((row) => ({
      id: Number(row.id || 0),
      user_id: row.user_id == null ? null : Number(row.user_id),
      generation_type: row.generation_type || 'unknown',
      prompt_key: row.prompt_key || 'default',
      version: Number(row.version || 1),
      prompt_text: row.prompt_text || '',
      provider: row.provider || null,
      model: row.model || null,
      temperature: row.temperature == null ? null : Number(row.temperature),
      max_tokens: row.max_tokens == null ? null : Number(row.max_tokens),
      notes: row.notes || null,
      is_active: !!row.is_active,
      created_at: row.created_at || null,
    }));

    res.json({ success: true, items });
  } catch (error) {
    console.error('Prompt registry list error:', error);
    res.status(500).json({ error: 'Failed to load prompt registry' });
  }
});

router.post('/admin/prompt-registry', requireAuth, requireRoles(['management', 'lecturer']), async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    const isManager = role === 'management' || role === 'admin';
    const useGlobalPrompt = isManager && req.body?.is_global === true;
    const created = await createPromptRegistryVersion({
      user_id: useGlobalPrompt ? null : req.user.id,
      generation_type: req.body?.generation_type,
      prompt_key: req.body?.prompt_key || 'default',
      prompt_text: req.body?.prompt_text,
      provider: req.body?.provider || null,
      model: req.body?.model || null,
      temperature: req.body?.temperature ?? null,
      max_tokens: req.body?.max_tokens ?? null,
      notes: req.body?.notes || null,
      is_active: req.body?.is_active !== false,
    });
    if (!created) {
      return res.status(500).json({ error: 'Failed to create prompt version' });
    }

    res.status(201).json({
      success: true,
      item: {
        id: Number(created.id || 0),
        user_id: created.user_id == null ? null : Number(created.user_id),
        generation_type: created.generation_type || 'unknown',
        prompt_key: created.prompt_key || 'default',
        version: Number(created.version || 1),
        prompt_text: created.prompt_text || '',
        provider: created.provider || null,
        model: created.model || null,
        temperature: created.temperature == null ? null : Number(created.temperature),
        max_tokens: created.max_tokens == null ? null : Number(created.max_tokens),
        notes: created.notes || null,
        is_active: !!created.is_active,
        created_at: created.created_at || null,
      },
    });
  } catch (error) {
    console.error('Prompt registry create error:', error);
    res.status(500).json({ error: error.message || 'Failed to create prompt version' });
  }
});

router.get('/generation-jobs', requireAuth, async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    const isManager = role === 'management' || role === 'admin';
    const limit = parseClampedInt(req.query?.limit, 50, 1, 200);
    const includeFullResult = ['1', 'true', 'yes'].includes(String(req.query?.include_full_result || '').toLowerCase());
    const rows = await listGenerationJobs({
      user_id: isManager && req.query?.scope === 'all' ? null : req.user.id,
      limit,
    });

    const items = rows.map((row) => {
      const payload = includeFullResult ? safeJsonParse(row.payload_json, null) : null;
      const rawResult = safeJsonParse(row.result_json, null);
      const result = includeFullResult
        ? rawResult
        : rawResult && typeof rawResult === 'object'
          ? {
              success: rawResult.success,
              progress: rawResult.progress || null,
              has_content: !!rawResult.content,
              has_assessment: !!rawResult.assessment,
              has_practical: !!rawResult.practical,
            }
          : null;
      const events = [
        row.created_at ? { status: 'scheduled', at: row.created_at } : null,
        row.started_at ? { status: 'processing', at: row.started_at } : null,
        row.completed_at ? { status: row.status, at: row.completed_at } : null,
      ].filter(Boolean);
      return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        job_type: row.job_type || 'unknown',
        status: row.status || 'scheduled',
        source_route: row.source_route || null,
        retry_count: Number(row.retry_count || 0),
        max_retries: Number(row.max_retries || 0),
        scheduled_for: row.scheduled_for || null,
        started_at: row.started_at || null,
        completed_at: row.completed_at || null,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        error_message: row.error_message || null,
        payload,
        result,
        timeline: events,
      };
    });

    res.json({ success: true, items });
  } catch (error) {
    console.error('List generation jobs error:', error);
    res.status(500).json({ error: 'Failed to load generation jobs' });
  }
});

router.get('/generation-jobs/dead-letters', requireAuth, requireRoles(['management']), async (req, res) => {
  try {
    const limit = parseClampedInt(req.query?.limit, 50, 1, 200);
    const applyOrgScope = !isSuperAdmin(req.user);
    if (applyOrgScope && req.user.organisation_id == null) {
      return res.json({ success: true, items: [] });
    }
    const scopeClause = applyOrgScope ? ' AND owner.organisation_id = ?' : '';
    const scopeParams = applyOrgScope ? [req.user.organisation_id] : [];

    const rows = isMySQL()
      ? rowList(await query(
          `SELECT
             dl.id, dl.job_id, dl.user_id, dl.job_type, dl.status, dl.retry_count, dl.max_retries,
             dl.error_message, dl.payload_json, dl.result_json, dl.dead_letter_reason, dl.created_at,
             owner.name AS owner_name, owner.email AS owner_email
           FROM generation_job_dead_letters dl
           INNER JOIN users owner ON owner.id = dl.user_id
           WHERE 1=1${scopeClause}
           ORDER BY dl.created_at DESC
           LIMIT ?`,
          [...scopeParams, limit]
        ))
      : rowList(await query(
          `SELECT
             dl.id, dl.job_id, dl.user_id, dl.job_type, dl.status, dl.retry_count, dl.max_retries,
             dl.error_message, dl.payload_json, dl.result_json, dl.dead_letter_reason, dl.created_at,
             owner.name AS owner_name, owner.email AS owner_email
           FROM generation_job_dead_letters dl
           INNER JOIN users owner ON owner.id = dl.user_id
           WHERE 1=1${applyOrgScope ? ' AND owner.organisation_id = $1' : ''}
           ORDER BY dl.created_at DESC
           LIMIT $${applyOrgScope ? '2' : '1'}`,
          applyOrgScope ? [req.user.organisation_id, limit] : [limit]
        ));

    const items = rows.map((row) => ({
      id: Number(row.id || 0),
      job_id: Number(row.job_id || 0),
      user_id: Number(row.user_id || 0),
      owner_name: row.owner_name || row.owner_email || 'Unknown',
      owner_email: row.owner_email || null,
      job_type: row.job_type || 'unknown',
      status: row.status || 'failed',
      retry_count: Number(row.retry_count || 0),
      max_retries: Number(row.max_retries || 0),
      error_message: row.error_message || null,
      payload: safeJsonParse(row.payload_json, null),
      result: safeJsonParse(row.result_json, null),
      dead_letter_reason: row.dead_letter_reason || null,
      created_at: row.created_at || null,
    }));

    res.json({ success: true, items });
  } catch (error) {
    console.error('List generation dead letters error:', error);
    res.status(500).json({ error: 'Failed to load generation dead letters' });
  }
});

router.post('/generation-jobs/:id/retry', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid job id' });
    }
    const role = String(req.user?.role || '').toLowerCase();
    const isManager = role === 'management' || role === 'admin';

    const rows = isMySQL()
      ? rowList(await query(
          `SELECT g.id, g.user_id, g.status, g.retry_count, g.max_retries
           FROM generation_jobs g
           WHERE g.id = ?`,
          [id]
        ))
      : rowList(await query(
          `SELECT g.id, g.user_id, g.status, g.retry_count, g.max_retries
           FROM generation_jobs g
           WHERE g.id = $1`,
          [id]
        ));
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Generation job not found' });
    if (!isManager && Number(row.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Not allowed to retry this generation job' });
    }
    if (String(row.status || '') !== 'failed') {
      return res.status(400).json({ error: 'Only failed jobs can be retried' });
    }
    if (Number(row.retry_count || 0) >= Number(row.max_retries || 0)) {
      return res.status(400).json({ error: 'Max retries already exhausted for this job' });
    }

    if (isMySQL()) {
      await query(
        `UPDATE generation_jobs
         SET status = ?, error_message = ?, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        ['scheduled', 'Manual retry scheduled', id]
      );
    } else {
      await query(
        `UPDATE generation_jobs
         SET status = $1, error_message = $2, completed_at = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        ['scheduled', 'Manual retry scheduled', id]
      );
    }

    await recordAuditEvent({
      user_id: req.user.id,
      target_user_id: Number(row.user_id) || null,
      category: 'generation_jobs',
      action: 'manual_retry_scheduled',
      outcome: 'success',
      organisation_id: req.user?.organisation_id ?? null,
      department_id: req.user?.department_id ?? null,
      metadata: getRequestMetadata(req, {
        generation_job_id: id,
        previous_status: row.status,
        retry_count: Number(row.retry_count || 0),
        max_retries: Number(row.max_retries || 0),
        acted_as_manager: isManager,
      }),
    });

    res.json({ success: true, message: 'Generation job retry scheduled' });
  } catch (error) {
    console.error('Retry generation job error:', error);
    res.status(500).json({ error: 'Failed to retry generation job' });
  }
});

router.post(
  '/:id/custom-homework',
  requireAuth,
  requireFeature('content_creation'),
  requireFeature('assessment_creation'),
  async (req, res) => {
    const requestStartedAt = Date.now();
    const projectedCostUsd = 0.2;
    let generationJobId = null;
    let contentPromptTrace = null;
    let assessmentPromptTrace = null;
    const telemetry = {
      user_id: Number(req.user?.id) || null,
      source_module_id: Number(req.params.id) || null,
      student_user_id: Number(req.body?.student_user_id) || null,
      level: String(req.body?.level || '').trim() || null,
      num_sections: parseClampedInt(req.body?.num_sections, 4, 2, 8),
      question_count: parseClampedInt(req.body?.question_count, 8, 4, 20),
      include_diagrams: req.body?.include_diagrams !== false,
      include_images: req.body?.include_images === true,
      assessment_provider: null,
      assessment_model: null,
      assessment_generation_mode: null,
      assessment_generation_warning: null,
      content_generation_ms: null,
      assessment_generation_ms: null,
      submission_rows: null,
      completed_rows: null,
      weak_area_count: null,
      generated_question_count: null,
      assessment_usage: null,
      assessment_estimated_cost_usd: null,
      homework_module_id: null,
    };
    try {
      try {
        await assertWithinBudgetOrThrow({
          userId: req.user.id,
          projectedCostUsd,
          generationType: 'custom homework generation',
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
        job_type: 'custom_homework_generation',
        status: JOB_STATUS.PROCESSING,
        source_route: '/modules/:id/custom-homework',
        payload: {
          module_id: Number(req.params.id) || null,
          student_user_id: Number(req.body?.student_user_id) || null,
          level: String(req.body?.level || '').trim() || null,
          num_sections: parseClampedInt(req.body?.num_sections, 4, 2, 8),
          question_count: parseClampedInt(req.body?.question_count, 8, 4, 20),
        },
      });
      if (generationJobId) {
        await updateGenerationJob(generationJobId, { started_at: new Date() });
      }
      const sourceModuleId = Number(req.params.id);
      const studentUserId = Number(req.body?.student_user_id);
      const requestedLevel = String(req.body?.level || '').trim();
      const numSections = parseClampedInt(req.body?.num_sections, 4, 2, 8);
      const questionCount = parseClampedInt(req.body?.question_count, 8, 4, 20);
      const includeDiagrams = req.body?.include_diagrams !== false;
      const includeImages = req.body?.include_images === true;

      if (!Number.isFinite(sourceModuleId) || sourceModuleId <= 0) {
        return res.status(400).json({ error: 'Invalid module id' });
      }
      if (!Number.isFinite(studentUserId) || studentUserId <= 0) {
        return res.status(400).json({ error: 'student_user_id is required' });
      }

      const sourceModule = await moduleBelongsToUser(sourceModuleId, req.user.id);
      if (!sourceModule) return res.status(404).json({ error: 'Module not found' });

      const sourceMetaQ = isMySQL()
        ? await query('SELECT id, name FROM modules WHERE id = ? AND user_id = ?', [sourceModuleId, req.user.id])
        : await query('SELECT id, name FROM modules WHERE id = $1 AND user_id = $2', [sourceModuleId, req.user.id]);
      const sourceMeta = rowList(sourceMetaQ)[0] || { id: sourceModuleId, name: `Module ${sourceModuleId}` };

      const enrolledQ = isMySQL()
        ? await query('SELECT module_id FROM module_students WHERE module_id = ? AND student_user_id = ?', [sourceModuleId, studentUserId])
        : await query('SELECT module_id FROM module_students WHERE module_id = $1 AND student_user_id = $2', [sourceModuleId, studentUserId]);
      if (!rowList(enrolledQ)[0]) {
        return res.status(400).json({ error: 'Student must be enrolled in this module before generating homework' });
      }

      const student = await getEligibleStudent(studentUserId, req.user);
      if (!student) return res.status(404).json({ error: 'Student not found or not eligible for this module' });

      const assessmentItemsQ = isMySQL()
        ? await query(
            `SELECT item_id
             FROM module_items
             WHERE module_id = ? AND item_type = 'assessment'`,
            [sourceModuleId]
          )
        : await query(
            `SELECT item_id
             FROM module_items
             WHERE module_id = $1 AND item_type = 'assessment'`,
            [sourceModuleId]
          );
      const assessmentIds = rowList(assessmentItemsQ)
        .map((row) => Number(row.item_id))
        .filter((id) => Number.isFinite(id) && id > 0);
      if (assessmentIds.length === 0) {
        return res.status(400).json({ error: 'This module has no assessments to analyze yet' });
      }

      const studentNameCandidates = Array.from(new Set([
        String(req.body?.student_name || '').trim(),
        String(student?.name || '').trim(),
        String(student?.email || '').trim(),
        String(student?.email || '').split('@')[0].trim(),
      ].filter(Boolean).map((v) => v.toLowerCase())));

      const submissionRows = await (async () => {
        if (isMySQL()) {
          const assessmentPlaceholders = assessmentIds.map(() => '?').join(',');
          const params = [
            req.user.id,
            ...assessmentIds,
            studentUserId,
          ];
          let studentMatchClause = 's.student_user_id = ?';
          if (studentNameCandidates.length > 0) {
            const studentPlaceholders = studentNameCandidates.map(() => '?').join(',');
            studentMatchClause = `${studentMatchClause} OR LOWER(TRIM(s.student_name)) IN (${studentPlaceholders})`;
            params.push(...studentNameCandidates);
          }
          const q = await query(
            `SELECT s.id, s.student_name, s.student_user_id, s.status, s.result_id, s.assignment_id, s.submitted_at, s.completed_at,
                    mr.scores, mr.feedback, mr.effective_feedback, mr.total_score, mr.effective_total_score, mr.marked_at
             FROM assessment_submissions s
             INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
             LEFT JOIN marking_results mr
               ON (mr.id = s.result_id OR (s.assignment_id IS NOT NULL AND mr.assignment_id = s.assignment_id AND mr.is_current = 1))
             WHERE pa.user_id = ?
               AND s.published_assessment_id IN (${assessmentPlaceholders})
               AND (${studentMatchClause})
               AND s.status IN ('completed', 'processing', 'queued')
             ORDER BY COALESCE(mr.marked_at, s.completed_at, s.submitted_at) DESC
             LIMIT 80`,
            params
          );
          return rowList(q);
        }

        const includeNameFallback = studentNameCandidates.length > 0;
        const q = await query(
          `SELECT s.id, s.student_name, s.student_user_id, s.status, s.result_id, s.assignment_id, s.submitted_at, s.completed_at,
                  mr.scores, mr.feedback, mr.effective_feedback, mr.total_score, mr.effective_total_score, mr.marked_at
           FROM assessment_submissions s
           INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
           LEFT JOIN marking_results mr
             ON (mr.id = s.result_id OR (s.assignment_id IS NOT NULL AND mr.assignment_id = s.assignment_id AND mr.is_current = TRUE))
           WHERE pa.user_id = $1
             AND s.published_assessment_id = ANY($2::int[])
             AND (s.student_user_id = $3${includeNameFallback ? ' OR LOWER(TRIM(s.student_name)) = ANY($4::text[])' : ''})
             AND s.status IN ('completed', 'processing', 'queued')
           ORDER BY COALESCE(mr.marked_at, s.completed_at, s.submitted_at) DESC
           LIMIT 80`,
          includeNameFallback
            ? [req.user.id, assessmentIds, studentUserId, studentNameCandidates]
            : [req.user.id, assessmentIds, studentUserId]
        );
        return rowList(q);
      })();
      telemetry.submission_rows = submissionRows.length;

      const completedRows = submissionRows.filter((row) => row.status === 'completed');
      telemetry.completed_rows = completedRows.length;
      if (completedRows.length === 0) {
        return res.status(404).json({
          error: 'No completed marked submissions found for this student in the selected module',
        });
      }

      const weaknessSummary = buildWeaknessSummary(completedRows);
      telemetry.weak_area_count = Array.isArray(weaknessSummary.weak_areas) ? weaknessSummary.weak_areas.length : 0;
      const weakAreasText = weaknessSummary.weak_areas
        .map((w) => `${w.criterion_name} (${w.avg_percent}% average)`)
        .join('; ');
      const feedbackThemeText = weaknessSummary.feedback_themes.slice(0, 5).join(' | ');
      const studentLabel = String(student.name || student.email || `Student ${student.id}`).trim();
      const dateTag = new Date().toISOString().slice(0, 10);
      const homeworkReason = buildHomeworkReasonPayload({
        sourceModule: sourceMeta.name,
        studentLabel,
        weaknessSummary,
        completedCount: completedRows.length,
      });

      const homeworkModuleName = `${sourceMeta.name} - Homework for ${studentLabel} (${dateTag})`.slice(0, 255);
      const homeworkModuleId = await createModule(req.user.id, homeworkModuleName);
      if (!homeworkModuleId) {
        throw new Error('Failed to create homework module');
      }
      telemetry.homework_module_id = Number(homeworkModuleId) || null;
      await addStudentToModuleIfMissing(homeworkModuleId, studentUserId);
      await ensureHomeworkWorkflow(
        homeworkModuleId,
        req.user.id,
        'draft',
        null,
        homeworkReason.reason_summary,
        homeworkReason.reason_payload
      );

      const topicsPrompt = [
        `Targeted homework for ${studentLabel}.`,
        `Source module: ${sourceMeta.name}.`,
        `Focus weakness areas: ${weakAreasText}.`,
        feedbackThemeText ? `Feedback themes from marked scripts: ${feedbackThemeText}.` : '',
        'Create practical remedial content with clear examples and short checks.',
      ].filter(Boolean).join(' ');

      const contentGenerationStartedAt = Date.now();
      const contentConfig = aiConfig.getTaskConfig('contentGeneration', 'openai');
      contentPromptTrace = await resolvePromptRegistryVersion({
        user_id: req.user.id,
        generation_type: 'custom_homework_generation',
        prompt_key: 'custom-homework.content.default',
        prompt_text: 'Default custom-homework content generation prompt template.',
        provider: contentConfig.provider,
        model: contentConfig.model,
        temperature: contentConfig.temperature,
        max_tokens: contentConfig.maxTokens,
      });
      let generatedContent = await contentService.generateContentWithAIResilient({
        topics: topicsPrompt,
        level: requestedLevel || 'level_7',
        numSections,
        rubricContext: `Weakness-driven remediation for ${studentLabel}`,
        templateId: 'classroom',
        includeDiagrams,
        includeImages,
        uploadedTheme: null,
      });
      telemetry.content_generation_ms = Date.now() - contentGenerationStartedAt;
      generatedContent = contentService.normalizeGeneratedContent({
        ...generatedContent,
        title: `Custom Homework: ${studentLabel} - ${sourceMeta.name}`.slice(0, 220),
        instructions: generatedContent.instructions || `Complete this homework to strengthen the areas identified from your marked work.`,
      });

      const assessmentConfig = aiConfig.getTaskConfig('assessmentGeneration', 'openai');
      telemetry.assessment_provider = assessmentConfig.provider;
      telemetry.assessment_model = assessmentConfig.model;
      assessmentPromptTrace = await resolvePromptRegistryVersion({
        user_id: req.user.id,
        generation_type: 'custom_homework_generation',
        prompt_key: 'custom-homework.assessment.default',
        prompt_text: 'Default custom-homework assessment generation prompt template.',
        provider: assessmentConfig.provider,
        model: assessmentConfig.model,
        temperature: assessmentConfig.temperature,
        max_tokens: assessmentConfig.maxTokens,
      });
      const assessmentPrompt = `You are an expert educator creating a personalized remedial homework assessment.

Student: ${studentLabel}
Source module: ${sourceMeta.name}
Weakness areas: ${weakAreasText}
Feedback themes: ${feedbackThemeText || 'N/A'}
${buildEducationLevelPromptBlock(requestedLevel || 'level_7')}
Number of questions: ${questionCount}

Use this generated homework lesson summary as context:
Title: ${generatedContent.title}
Instructions: ${generatedContent.instructions || ''}
Sections:
${(generatedContent.sections || []).map((s, i) => `- ${i + 1}. ${String(s.heading || s.title || 'Section').slice(0, 120)}: ${String(s.body || '').replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')}

Return ONLY JSON with this shape:
{
  "title": "string",
  "topic": "string",
  "difficulty_level": "beginner|moderate|advanced",
  "assessment_type": "assignment",
  "instructions": "string",
  "questions": [
    {
      "number": 1,
      "type": "multiple_choice|short_answer|problem|mix_and_match|essay",
      "question": "string",
      "points": 10,
      "options": ["A", "B", "C", "D"],
      "correct_answer": "A",
      "left_column": ["optional"],
      "right_column": ["optional"],
      "correct_pairings": [{"left_index": 1, "right_index": 1}],
      "hints": ["optional"],
      "related_criteria": ["criterion"]
    }
  ],
  "total_points": 100,
  "estimated_time": "45 minutes",
  "rubric_alignment": "string",
  "suggested_rubric_criteria": [
    {"name": "Criterion", "max_points": 20, "description": "How to score"}
  ]
}

Rules:
- Create exactly ${questionCount} questions.
- Ensure every question targets at least one weakness area.
- Include mixed question styles (at least one multiple_choice and one short_answer).
- total_points must equal the sum of question points and suggested_rubric_criteria max_points.`;

      let parsedAssessment;
      let normalizedQuestions = [];
      let assessmentGenerationMode = 'ai';
      let assessmentGenerationWarning = null;
      let assessmentUsage = null;
      const assessmentGenerationStartedAt = Date.now();

      try {
        const completion = await aiService.createCompletionWithRetry({
          provider: assessmentConfig.provider,
          model: assessmentConfig.model,
          messages: [
            {
              role: 'system',
              content: 'You create valid JSON only. Do not include markdown formatting.',
            },
            {
              role: 'user',
              content: assessmentPrompt,
            },
          ],
          temperature: assessmentConfig.temperature,
          maxTokens: assessmentConfig.maxTokens,
        });
        assessmentUsage = completion?.usage || null;
        telemetry.assessment_usage = normalizeUsageMetrics(assessmentUsage);
        telemetry.assessment_estimated_cost_usd = estimateUsageCost(completion?.provider || assessmentConfig.provider, assessmentUsage);

        parsedAssessment = parseJsonFromCompletion(completion);
        if (!parsedAssessment?.title || !Array.isArray(parsedAssessment?.questions) || parsedAssessment.questions.length === 0) {
          throw new Error('Generated assessment is missing required fields');
        }
        normalizedQuestions = normalizeHomeworkQuestions(parsedAssessment.questions, questionCount);
        if (normalizedQuestions.length === 0) {
          throw new Error('Generated assessment questions were empty after normalization');
        }
      } catch (assessmentGenError) {
        assessmentGenerationMode = 'fallback';
        assessmentGenerationWarning = String(assessmentGenError?.message || 'AI assessment generation failed');
        console.warn('[custom-homework] Falling back to deterministic assessment generation:', assessmentGenerationWarning);
        parsedAssessment = buildFallbackHomeworkAssessment({
          studentLabel,
          sourceModuleName: sourceMeta.name,
          questionCount,
          weakAreas: weaknessSummary.weak_areas,
          generatedContent,
        });
        normalizedQuestions = normalizeHomeworkQuestions(parsedAssessment.questions, questionCount);
      }
      telemetry.assessment_generation_ms = Date.now() - assessmentGenerationStartedAt;
      telemetry.assessment_generation_mode = assessmentGenerationMode;
      telemetry.assessment_generation_warning = assessmentGenerationWarning;

      if (normalizedQuestions.length === 0) {
        throw new Error('Could not create assessment questions for custom homework');
      }
      telemetry.generated_question_count = normalizedQuestions.length;

      const suggestedCriteria = Array.isArray(parsedAssessment.suggested_rubric_criteria)
        ? parsedAssessment.suggested_rubric_criteria
        : normalizedQuestions.map((q) => ({
            name: `Question ${q.number}`,
            max_points: q.points,
            description: String(q.question || '').slice(0, 220),
          }));

      const rubric = await createRubricForHomework(
        req.user.id,
        `Rubric: ${String(parsedAssessment.title || `Homework for ${studentLabel}`)}`.slice(0, 255),
        suggestedCriteria
      );

      const assessment = {
        title: String(parsedAssessment.title || `Custom Homework Assessment - ${studentLabel}`).slice(0, 255),
        topic: String(parsedAssessment.topic || `Targeted support for ${studentLabel}`).slice(0, 255),
        difficulty_level: String(parsedAssessment.difficulty_level || 'moderate'),
        assessment_type: 'assignment',
        instructions: String(parsedAssessment.instructions || 'Answer all questions and show your reasoning where needed.'),
        questions: normalizedQuestions,
        total_points: rubric.total_points,
        estimated_time: String(parsedAssessment.estimated_time || '45 minutes'),
        rubric_alignment: String(parsedAssessment.rubric_alignment || 'Questions are aligned to the student weakness areas identified from marked scripts.'),
        suggested_rubric_criteria: rubric.criteria,
      };
      const detailedReason = buildHomeworkReasonPayload({
        sourceModule: sourceMeta.name,
        studentLabel,
        weaknessSummary,
        completedCount: completedRows.length,
        rubricAlignment: assessment.rubric_alignment,
        rubricCriteria: rubric.criteria,
      });
      await ensureHomeworkWorkflow(
        homeworkModuleId,
        req.user.id,
        'draft',
        null,
        detailedReason.reason_summary,
        detailedReason.reason_payload
      );

      const publishedContent = await publishContentForHomework(req.user.id, generatedContent, rubric.id);
      const publishedAssessment = await publishAssessmentForHomework(req.user.id, assessment, rubric.id);

      await addItemToModule(
        homeworkModuleId,
        req.user.id,
        'content',
        publishedContent.id,
        publishedContent.content.title || `Content ${publishedContent.id}`,
        publishedContent.code
      );
      await addItemToModule(
        homeworkModuleId,
        req.user.id,
        'assessment',
        publishedAssessment.id,
        assessment.title || `Assessment ${publishedAssessment.id}`,
        publishedAssessment.code
      );

      const base = process.env.CLIENT_URL || '';
      const contentPath = base ? `${base.replace(/\/$/, '')}/take-content` : '/take-content';
      const assessmentPath = base ? `${base.replace(/\/$/, '')}/take-assessment` : '/take-assessment';
      logCustomHomeworkTelemetry({
        event: 'custom_homework_generation',
        status: 'success',
        duration_ms: Date.now() - requestStartedAt,
        ...telemetry,
      });
      try {
        await persistCustomHomeworkTelemetry({
          status: 'success',
          duration_ms: Date.now() - requestStartedAt,
          ...telemetry,
        });
      } catch (telemetryError) {
        console.warn('[custom-homework] Failed to persist success telemetry:', telemetryError?.message || telemetryError);
      }
      const genericSuccessPayload = {
        event: 'custom_homework_generate',
        generation_type: 'custom_homework_generation',
        status: 'success',
        user_id: req.user.id,
        provider: telemetry.assessment_provider || null,
        model: telemetry.assessment_model || null,
        duration_ms: Date.now() - requestStartedAt,
        usage: telemetry.assessment_usage,
        estimated_cost_usd: telemetry.assessment_estimated_cost_usd,
        metadata: {
          source_module_id: telemetry.source_module_id,
          student_user_id: telemetry.student_user_id,
          level: telemetry.level,
          num_sections: telemetry.num_sections,
          question_count: telemetry.question_count,
          include_diagrams: telemetry.include_diagrams,
          include_images: telemetry.include_images,
          assessment_generation_mode: telemetry.assessment_generation_mode,
          generated_question_count: telemetry.generated_question_count,
          homework_module_id: telemetry.homework_module_id,
          content_prompt_version: contentPromptTrace?.prompt_version || null,
          assessment_prompt_version: assessmentPromptTrace?.prompt_version || null,
        },
      };
      logGenerationTelemetry(genericSuccessPayload);
      try {
        await persistGenerationTelemetryEvent(genericSuccessPayload);
      } catch (telemetryError) {
        console.warn('[custom-homework] Failed to persist generic success telemetry:', telemetryError?.message || telemetryError);
      }
      if (generationJobId) {
        await updateGenerationJob(generationJobId, {
          status: JOB_STATUS.COMPLETED,
          result: {
            success: true,
            homework_module_id: homeworkModuleId,
            content_code: publishedContent.code,
            assessment_code: publishedAssessment.code,
          },
          completed_at: new Date(),
        });
      }
      invalidateHomeworkAnalyticsCacheForUser(req.user.id);

      res.json({
        success: true,
        message: 'Custom homework module generated successfully',
        homework_module: {
          id: homeworkModuleId,
          name: homeworkModuleName,
        },
        source_module: {
          id: sourceMeta.id,
          name: sourceMeta.name,
        },
        student: {
          id: student.id,
          name: student.name || student.email,
          email: student.email,
        },
        analysis: {
          submissions_analyzed: completedRows.length,
          weak_areas: weaknessSummary.weak_areas,
          feedback_themes: weaknessSummary.feedback_themes,
        },
        generated: {
          content: {
            id: publishedContent.id,
            code: publishedContent.code,
            title: publishedContent.content.title,
            link: `${contentPath}?code=${publishedContent.code}`,
          },
          assessment: {
            id: publishedAssessment.id,
            code: publishedAssessment.code,
            title: assessment.title,
            rubric_id: rubric.id,
            generation_mode: assessmentGenerationMode,
            generation_warning: assessmentGenerationWarning,
            link: `${assessmentPath}?code=${publishedAssessment.code}`,
          },
        },
        generation_trace: {
          content: contentPromptTrace,
          assessment: assessmentPromptTrace,
        },
      });
    } catch (error) {
      logCustomHomeworkTelemetry({
        event: 'custom_homework_generation',
        status: 'error',
        duration_ms: Date.now() - requestStartedAt,
        error_message: String(error?.message || 'Unknown error'),
        error_code: error?.code || null,
        ...telemetry,
      });
      try {
        await persistCustomHomeworkTelemetry({
          status: 'error',
          duration_ms: Date.now() - requestStartedAt,
          error_message: String(error?.message || 'Unknown error'),
          ...telemetry,
        });
      } catch (telemetryError) {
        console.warn('[custom-homework] Failed to persist error telemetry:', telemetryError?.message || telemetryError);
      }
      const genericErrorPayload = {
        event: 'custom_homework_generate',
        generation_type: 'custom_homework_generation',
        status: 'error',
        user_id: req.user?.id || null,
        provider: telemetry.assessment_provider || null,
        model: telemetry.assessment_model || null,
        duration_ms: Date.now() - requestStartedAt,
        usage: telemetry.assessment_usage,
        estimated_cost_usd: telemetry.assessment_estimated_cost_usd,
        error_type: inferGenerationErrorType(error),
        error_message: String(error?.message || 'Unknown error'),
        metadata: {
          source_module_id: telemetry.source_module_id,
          student_user_id: telemetry.student_user_id,
          level: telemetry.level,
          num_sections: telemetry.num_sections,
          question_count: telemetry.question_count,
          include_diagrams: telemetry.include_diagrams,
          include_images: telemetry.include_images,
          assessment_generation_mode: telemetry.assessment_generation_mode,
          content_prompt_version: contentPromptTrace?.prompt_version || null,
          assessment_prompt_version: assessmentPromptTrace?.prompt_version || null,
        },
      };
      logGenerationTelemetry(genericErrorPayload);
      try {
        await persistGenerationTelemetryEvent(genericErrorPayload);
      } catch (telemetryError) {
        console.warn('[custom-homework] Failed to persist generic error telemetry:', telemetryError?.message || telemetryError);
      }
      if (generationJobId) {
        await updateGenerationJob(generationJobId, {
          status: JOB_STATUS.FAILED,
          error_message: String(error?.message || 'Unknown error'),
          completed_at: new Date(),
        });
      }
      console.error('Generate custom homework module error:', error);
      res.status(500).json({ error: error.message || 'Failed to generate custom homework module' });
    }
  }
);

module.exports = router;
