const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { query } = require('../database/connection');
const aiConfig = require('../config/ai-config');
const { parseMarkingResponsePayload } = require('../routes/mark');

const POLL_INTERVAL_MS = 30000;
const COMPLETION_WINDOW = '24h';
const TEMP_DIR = path.join(__dirname, '../uploads/temp/openai-batches');

const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const firstRow = (result) => rowsOf(result)[0];

let pollingTimer = null;
let cycleInProgress = false;

function ensureOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

function normalizeContentParts(rawContent) {
  if (Array.isArray(rawContent)) {
    return rawContent
      .filter((part) => part && part.type === 'text' && part.text != null)
      .map((part) => part.text)
      .join('');
  }
  if (rawContent == null) {
    return '';
  }
  return typeof rawContent === 'string' ? rawContent : String(rawContent);
}

function isMemoRubric(rubric) {
  if (rubric?.rubric_type === 'answer_key') {
    return true;
  }

  const rubricText = `${rubric?.name || ''} ${JSON.stringify(rubric?.criteria || [])}`.toLowerCase();
  return /memorandum|marking memo|answer key|model answer|correct answer|marking scheme/.test(rubricText);
}

function getStrictnessGuidance(strictnessLevel) {
  const guidance = {
    very_strict: 'Apply very strict marking. Award marks only when answers fully satisfy the criterion. Penalize omissions and inaccuracies heavily.',
    strict: 'Apply strict academic marking. Award marks only when answers clearly satisfy the criterion.',
    moderate: 'Apply balanced marking. Give credit for partially correct reasoning while still penalizing important gaps.',
    lenient: 'Apply lenient marking. Give reasonable credit for partially correct ideas and near-miss answers.'
  };

  return guidance[strictnessLevel] || guidance.strict;
}

function buildDetailedRubric(criteria) {
  return criteria.map((criterion, index) => {
    const maxPoints = criterion.maxPoints ?? criterion.max_points ?? 0;
    const description = String(criterion.description || '').slice(0, 400);
    return `${index + 1}. ${criterion.name} (${maxPoints} points)\n   ${description}`;
  }).join('\n');
}

function buildBatchMarkingPrompt(assignmentText, rubric, options = {}) {
  const config = aiConfig.getConfig('assignment', 'openai');
  const criteria = Array.isArray(rubric.criteria)
    ? rubric.criteria
    : typeof rubric.criteria === 'string'
    ? JSON.parse(rubric.criteria)
    : [];

  const truncatedText = String(assignmentText || '').slice(0, Math.min(config.maxTextLength, 12000));
  const totalPoints = Number(rubric.total_points || criteria.reduce((sum, criterion) => sum + Number(criterion.max_points || criterion.maxPoints || 0), 0));
  const rubricLabel = isMemoRubric(rubric) ? 'MEMO / ANSWER KEY' : 'RUBRIC';
  const detailedRubric = buildDetailedRubric(criteria);
  const strictnessLevel = options.strictnessLevel || 'strict';

  const prompt = `You are marking a student's academic submission against the provided ${rubricLabel.toLowerCase()}.

STUDENT SUBMISSION:
${truncatedText}

${rubricLabel}:
${detailedRubric}

TOTAL: ${totalPoints} points

MARKING REQUIREMENTS:
- ${getStrictnessGuidance(strictnessLevel)}
- Score each criterion independently.
- Be direct and realistic. Do not inflate marks.
- Give useful feedback with concrete references to the student's work.
- If the rubric is a memo/answer key, compare the student's answer directly against the expected answer.
- Keep per-criterion feedback concise but useful (2-4 sentences).
- Keep overall feedback practical and specific (roughly 120-220 words).
- Include confidence scores from 0 to 100.
- Return ONLY valid JSON.

JSON FORMAT:
{
  "scores": [
    {
      "criterion_name": "Criterion name",
      "points_awarded": number,
      "max_points": number,
      "feedback": "Specific feedback",
      "confidence": number
    }
  ],
  "corrections": [
    {
      "type": "correction" or "suggestion",
      "criterion_name": "Criterion name",
      "location": "Specific location",
      "issue": "What is wrong",
      "correction": "What should change",
      "reason": "Why the change matters"
    }
  ],
  "language_errors": [
    {
      "location": "Specific location",
      "error_text": "Quoted error text",
      "error_type": "grammar" or "spelling" or "reference" or "punctuation" or "style",
      "correction": "Corrected text",
      "explanation": "Why it is wrong"
    }
  ],
  "overall_feedback": "Overall feedback",
  "total_score": number,
  "overall_confidence": number
}`;

  const requestMaxTokens = Math.min(config.maxTokens, 7000);

  return {
    model: config.model,
    temperature: config.temperature,
    max_completion_tokens: requestMaxTokens,
    messages: [{ role: 'user', content: prompt }]
  };
}

async function markAssignmentsAsFailed(jobId, assignments, message) {
  for (const assignment of assignments) {
    await query(
      'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE id = ? AND user_id = ?',
      ['error', assignment.id, assignment.user_id]
    );
    await query(
      'UPDATE assessment_submissions SET status = ?, failure_reason = ?, completed_at = NOW() WHERE assignment_id = ?',
      ['failed', message, assignment.id]
    );
  }
  await query(
    'UPDATE marking_jobs SET failed_count = failed_count + ?, processed_count = processed_count + ?, last_error = ? WHERE id = ?',
    [assignments.length, assignments.length, message, jobId]
  );
}

async function saveMarkingResult(job, assignment, markingResult, usage = null) {
  const submissionRow = firstRow(await query(
    'SELECT student_name FROM assessment_submissions WHERE assignment_id = ?',
    [assignment.id]
  ));
  const versionRow = firstRow(await query(
    'SELECT COALESCE(MAX(version), 0) AS max_version FROM marking_results WHERE assignment_id = ? AND user_id = ?',
    [assignment.id, job.user_id]
  ));
  const newVersion = Number(versionRow?.max_version || 0) + 1;

  await query(
    'UPDATE marking_results SET is_current = 0 WHERE assignment_id = ? AND user_id = ?',
    [assignment.id, job.user_id]
  );

  const effectiveUsage = usage || markingResult.usage || null;
  const estimatedCostUsd = effectiveUsage
    ? aiConfig.estimateCost(effectiveUsage.prompt_tokens, effectiveUsage.completion_tokens, 'openai')
    : (markingResult.estimated_cost_usd ?? null);

  const insertResult = await query(
    `INSERT INTO marking_results (
      assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current,
      strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence,
      prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      assignment.id,
      job.rubric_id,
      submissionRow?.student_name || assignment.filename.replace(/\.pdf$/i, ''),
      JSON.stringify(markingResult.scores || []),
      markingResult.overall_feedback || '',
      Number(markingResult.total_score || 0),
      newVersion,
      1,
      job.strictness_level || 'strict',
      'openai-batch',
      markingResult.corrections?.length ? JSON.stringify(markingResult.corrections) : null,
      markingResult.language_errors?.length ? JSON.stringify(markingResult.language_errors) : null,
      markingResult.handwriting_recognition_confidence ?? null,
      effectiveUsage?.prompt_tokens ?? null,
      effectiveUsage?.completion_tokens ?? null,
      effectiveUsage?.total_tokens ?? null,
      estimatedCostUsd,
      job.user_id
    ]
  );
  const resultId = insertResult.insertId ?? insertResult.lastID ?? insertResult.rows?.[0]?.id ?? null;

  await query(
    'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE id = ? AND user_id = ?',
    ['completed', assignment.id, job.user_id]
  );
  await query(
    'UPDATE assessment_submissions SET status = ?, failure_reason = NULL, result_id = ?, completed_at = NOW() WHERE assignment_id = ?',
    ['completed', resultId, assignment.id]
  );
}

async function downloadOpenAIFileContent(fileId) {
  if (!fileId || !process.env.OPENAI_API_KEY) {
    return '';
  }

  const response = await fetch(`https://api.openai.com/v1/files/${fileId}/content`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download OpenAI file ${fileId}: ${response.status}`);
  }

  return response.text();
}

function parseJsonl(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getAssignmentIdFromCustomId(customId) {
  const match = String(customId || '').match(/assignment-(\d+)/);
  return match ? Number(match[1]) : null;
}

async function submitOpenAIBatchJob(job) {
  const client = ensureOpenAIClient();
  if (!client) {
    throw new Error('OPENAI_API_KEY is not configured for batch marking');
  }

  const assignments = rowsOf(await query(
    `SELECT id, filename, extracted_text, user_id
     FROM assignments
     WHERE batch_id = ? AND user_id = ? AND status = ?
     ORDER BY uploaded_at ASC`,
    [job.batch_id, job.user_id, 'uploaded']
  ));
  const rubric = firstRow(await query(
    'SELECT id, name, criteria, total_points, rubric_type FROM rubrics WHERE id = ? AND user_id = ?',
    [job.rubric_id, job.user_id]
  ));

  if (assignments.length === 0) {
    await query(
      'UPDATE marking_jobs SET status = ?, completed_at = NOW(), total_count = 0, processed_count = 0, success_count = 0, failed_count = 0, last_error = NULL WHERE id = ?',
      ['completed', job.id]
    );
    return;
  }

  if (!rubric) {
    await query(
      'UPDATE marking_jobs SET status = ?, completed_at = NOW(), last_error = ? WHERE id = ?',
      ['failed', 'Rubric not found for this user', job.id]
    );
    return;
  }

  const validAssignments = [];
  const invalidAssignments = [];

  for (const assignment of assignments) {
    if (String(assignment.extracted_text || '').trim().length < 20) {
      invalidAssignments.push(assignment);
    } else {
      validAssignments.push(assignment);
    }
  }

  await query(
    'UPDATE marking_jobs SET total_count = ?, processed_count = 0, success_count = 0, failed_count = 0, request_count = ?, last_error = NULL WHERE id = ?',
    [assignments.length, validAssignments.length, job.id]
  );

  if (invalidAssignments.length > 0) {
    await markAssignmentsAsFailed(job.id, invalidAssignments, 'No extracted text available for batch marking');
  }

  if (validAssignments.length === 0) {
    await query(
      'UPDATE marking_jobs SET status = ?, completed_at = NOW(), last_error = ? WHERE id = ?',
      ['failed', 'No assignments had extracted text available for batch marking', job.id]
    );
    return;
  }

  if (validAssignments.length > 0) {
    for (const assignment of validAssignments) {
      await query(
        'UPDATE assignments SET status = ?, processing_job_id = ? WHERE id = ? AND user_id = ?',
        ['processing', job.id, assignment.id, job.user_id]
      );
      await query(
        'UPDATE assessment_submissions SET status = ?, failure_reason = NULL, completed_at = NULL WHERE assignment_id = ?',
        ['processing', assignment.id]
      );
    }
  }

  ensureTempDir();
  const tempFilePath = path.join(TEMP_DIR, `marking-job-${job.id}.jsonl`);

  const jsonl = validAssignments.map((assignment) => {
    const body = buildBatchMarkingPrompt(assignment.extracted_text, rubric, {
      strictnessLevel: job.strictness_level || 'strict'
    });

    return JSON.stringify({
      custom_id: `job-${job.id}-assignment-${assignment.id}`,
      method: 'POST',
      url: '/v1/chat/completions',
      body
    });
  }).join('\n');

  fs.writeFileSync(tempFilePath, jsonl, 'utf8');

  try {
    const uploadedFile = await client.files.create({
      file: fs.createReadStream(tempFilePath),
      purpose: 'batch'
    });

    const batch = await client.batches.create({
      input_file_id: uploadedFile.id,
      endpoint: '/v1/chat/completions',
      completion_window: COMPLETION_WINDOW,
      metadata: {
        marking_job_id: String(job.id),
        batch_id: String(job.batch_id)
      }
    });

    await query(
      `UPDATE marking_jobs
       SET status = ?, started_at = COALESCE(started_at, NOW()), completed_at = NULL,
           provider = ?, processing_mode = ?, openai_batch_id = ?, openai_input_file_id = ?, completion_window = ?
       WHERE id = ?`,
      ['submitted', 'openai', 'openai_batch', batch.id, uploadedFile.id, COMPLETION_WINDOW, job.id]
    );
  } finally {
    try {
      fs.unlinkSync(tempFilePath);
    } catch (_) {
      // ignore temp cleanup errors
    }
  }
}

async function finalizeOpenAIBatchJob(job, batchRecord) {
  const assignments = rowsOf(await query(
    'SELECT id, filename, user_id, extracted_text FROM assignments WHERE processing_job_id = ? AND user_id = ?',
    [job.id, job.user_id]
  )).filter((assignment) => String(assignment.extracted_text || '').trim().length >= 20);
  const assignmentMap = new Map(assignments.map((assignment) => [assignment.id, assignment]));

  const outputText = batchRecord.output_file_id ? await downloadOpenAIFileContent(batchRecord.output_file_id) : '';
  const errorText = batchRecord.error_file_id ? await downloadOpenAIFileContent(batchRecord.error_file_id) : '';

  const outputLines = parseJsonl(outputText);
  const errorLines = parseJsonl(errorText);

  let success = Number(job.success_count || 0);
  let failed = Number(job.failed_count || 0);
  let processed = Number(job.processed_count || 0);
  let lastError = job.last_error || null;
  const handledAssignmentIds = new Set();

  for (const line of outputLines) {
    const assignmentId = getAssignmentIdFromCustomId(line.custom_id);
    const assignment = assignmentMap.get(assignmentId);
    if (!assignment) {
      continue;
    }

    handledAssignmentIds.add(assignmentId);
    processed += 1;

    try {
      const body = line?.response?.body || {};
      const responseText = normalizeContentParts(body?.choices?.[0]?.message?.content);
      const usage = body?.usage || null;
      const markingResult = parseMarkingResponsePayload(responseText, {
        selectedProvider: 'openai',
        usage,
        imageBased: false
      });
      await saveMarkingResult(job, assignment, markingResult, usage);
      success += 1;
    } catch (error) {
      failed += 1;
      lastError = error.message;
      await query(
        'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE id = ? AND user_id = ?',
        ['error', assignment.id, job.user_id]
      );
      await query(
        'UPDATE assessment_submissions SET status = ?, failure_reason = ?, completed_at = NOW() WHERE assignment_id = ?',
        ['failed', error.message, assignment.id]
      );
    }
  }

  for (const line of errorLines) {
    const assignmentId = getAssignmentIdFromCustomId(line.custom_id);
    const assignment = assignmentMap.get(assignmentId);
    if (!assignment || handledAssignmentIds.has(assignmentId)) {
      continue;
    }

    handledAssignmentIds.add(assignmentId);
    processed += 1;
    failed += 1;
    lastError = line?.error?.message || batchRecord.errors?.[0]?.message || batchRecord.status;
    await query(
      'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE id = ? AND user_id = ?',
      ['error', assignment.id, job.user_id]
    );
    await query(
      'UPDATE assessment_submissions SET status = ?, failure_reason = ?, completed_at = NOW() WHERE assignment_id = ?',
      ['failed', lastError, assignment.id]
    );
  }

  for (const assignment of assignments) {
    if (handledAssignmentIds.has(assignment.id)) {
      continue;
    }

    processed += 1;
    failed += 1;
    lastError = batchRecord.errors?.[0]?.message || `Batch finished with status ${batchRecord.status}`;
    await query(
      'UPDATE assignments SET status = ?, processing_job_id = NULL WHERE id = ? AND user_id = ?',
      ['error', assignment.id, job.user_id]
    );
    await query(
      'UPDATE assessment_submissions SET status = ?, failure_reason = ?, completed_at = NOW() WHERE assignment_id = ?',
      ['failed', lastError, assignment.id]
    );
  }

  const finalStatus = failed > 0 && success === 0 ? 'failed' : failed > 0 ? 'completed_with_errors' : 'completed';

  await query(
    `UPDATE marking_jobs
     SET status = ?, completed_at = NOW(), processed_count = ?, success_count = ?, failed_count = ?,
         last_error = ?, openai_output_file_id = ?, openai_error_file_id = ?
     WHERE id = ?`,
    [finalStatus, processed, success, failed, lastError, batchRecord.output_file_id || null, batchRecord.error_file_id || null, job.id]
  );
}

async function refreshActiveOpenAIBatchJobs() {
  const client = ensureOpenAIClient();
  if (!client) {
    return;
  }

  const jobs = rowsOf(await query(
    `SELECT *
     FROM marking_jobs
     WHERE processing_mode = ? AND provider = ? AND openai_batch_id IS NOT NULL
       AND status IN (?, ?, ?)
     ORDER BY created_at ASC`,
    ['openai_batch', 'openai', 'submitted', 'running', 'finalizing']
  ));

  for (const job of jobs) {
    const batchRecord = await client.batches.retrieve(job.openai_batch_id);
    const status = batchRecord.status;

    if (status === 'completed' || status === 'failed' || status === 'expired' || status === 'cancelled') {
      await finalizeOpenAIBatchJob(job, batchRecord);
      continue;
    }

    const normalizedStatus = status === 'validating'
      ? 'submitted'
      : status === 'in_progress'
      ? 'running'
      : status;

    await query(
      'UPDATE marking_jobs SET status = ?, openai_output_file_id = ?, openai_error_file_id = ? WHERE id = ?',
      [normalizedStatus, batchRecord.output_file_id || null, batchRecord.error_file_id || null, job.id]
    );
  }
}

async function processPendingOpenAIBatchJobs() {
  const client = ensureOpenAIClient();
  if (!client) {
    return;
  }

  const dueJobs = rowsOf(await query(
    `SELECT *
     FROM marking_jobs
     WHERE processing_mode = ? AND provider = ? AND status = ?
       AND openai_batch_id IS NULL
       AND (scheduled_for IS NULL OR scheduled_for <= NOW())
     ORDER BY scheduled_for ASC, created_at ASC`,
    ['openai_batch', 'openai', 'scheduled']
  ));

  for (const job of dueJobs) {
    await submitOpenAIBatchJob(job);
  }
}

async function runOpenAIBatchPollingCycle() {
  if (cycleInProgress) {
    return;
  }

  cycleInProgress = true;
  try {
    await processPendingOpenAIBatchJobs();
    await refreshActiveOpenAIBatchJobs();
  } catch (error) {
    console.error('OpenAI batch polling cycle failed:', error);
  } finally {
    cycleInProgress = false;
  }
}

function startOpenAIBatchPolling() {
  if (pollingTimer || !process.env.OPENAI_API_KEY) {
    return;
  }

  pollingTimer = setInterval(() => {
    runOpenAIBatchPollingCycle().catch((error) => {
      console.error('OpenAI batch polling tick failed:', error);
    });
  }, POLL_INTERVAL_MS);

  runOpenAIBatchPollingCycle().catch((error) => {
    console.error('Initial OpenAI batch polling run failed:', error);
  });
}

module.exports = {
  startOpenAIBatchPolling,
  runOpenAIBatchPollingCycle,
  processPendingOpenAIBatchJobs
};
