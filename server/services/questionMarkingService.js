'use strict';

/**
 * Question-by-question ("horizontal") marking.
 *
 * Instead of marking each script against the whole rubric in one call, this marks one
 * question/criterion at a time across every script in the batch, so the same standard is
 * applied to all answers to that question. Steps:
 *
 *   1. Split each script into its answers per question (memo/answer-key rubrics only;
 *      criterion rubrics are holistic, so every criterion sees the whole script).
 *   2. For each question, mark the anonymised answers from several scripts side by side.
 *   3. Write overall feedback per script from its per-question results.
 *
 * The output for each script has the same shape as generateMarking() so results,
 * exports and the review queue work unchanged.
 */

const aiConfig = require('../config/ai-config');
const aiService = require('./aiService');
const { resolveEducationLevel, buildEducationLevelPromptBlock } = require('./educationLevelService');
const { parseAiJsonResponse, getStrictnessGuidelines } = require('./markingService');

const CONFIDENCE_THRESHOLD = 70;
// Character budget for the answers packed into one question call, and a cap on scripts per call.
const DEFAULT_CHUNK_CHAR_BUDGET = 24000;
const DEFAULT_MAX_SCRIPTS_PER_CALL = 10;
// Per-script text budget for segmentation and holistic criterion marking.
const DEFAULT_SCRIPT_CHAR_LIMIT = 60000;
// Answers flagged as missing by segmentation get this confidence so they land in the review queue.
const MISSING_ANSWER_CONFIDENCE = 50;

const VERBOSITY_GUIDANCE = {
  brief: '1-2 sentences of feedback per answer.',
  standard: '3-5 sentences of feedback per answer, referring to what the student actually wrote.',
  comprehensive: '6-10 sentences of feedback per answer, covering strengths, errors and how to improve.'
};

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const parseCriteria = (rubric) => {
  let criteria = rubric?.criteria;
  if (typeof criteria === 'string') {
    try {
      criteria = JSON.parse(criteria);
    } catch (e) {
      criteria = null;
    }
  }
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error('Rubric has no criteria to mark against. Please edit this rubric.');
  }
  return criteria.map((criterion, index) => {
    let maxPoints = 0;
    if (criterion.maxPoints != null && criterion.maxPoints !== '') {
      maxPoints = toNumber(criterion.maxPoints);
    } else if (criterion.max_points != null && criterion.max_points !== '') {
      maxPoints = toNumber(criterion.max_points);
    } else if (Array.isArray(criterion.levels) && criterion.levels.length > 0) {
      maxPoints = Math.max(...criterion.levels.map((level) => toNumber(level.points)));
    }
    return {
      index,
      name: String(criterion.name || `Question ${index + 1}`),
      description: criterion.description || '',
      levels: Array.isArray(criterion.levels) ? criterion.levels : [],
      max_points: maxPoints
    };
  });
};

const describeCriterion = (criterion) => {
  let text = `${criterion.name} (${criterion.max_points} points)\n${criterion.description || ''}\n`;
  if (criterion.levels.length > 0) {
    text += 'Performance levels:\n';
    criterion.levels.forEach((level) => {
      text += `- ${level.level} (${level.points} points): ${level.description}\n`;
    });
  }
  return text;
};

// Same rounding and clamping as parseMarkingResponsePayload, so totals match the other mode.
const normalisePoints = (points, maxPoints) => {
  let value = toNumber(points, 0);
  value = maxPoints > 0 && Number.isInteger(maxPoints)
    ? Math.round(value * 2) / 2
    : Math.round(value * 10) / 10;
  return Math.min(Math.max(value, 0), maxPoints);
};

const truncate = (text, limit) => {
  const value = String(text || '');
  return value.length > limit ? `${value.substring(0, limit)}...[truncated for processing]` : value;
};

const addUsage = (target, usage) => {
  if (!usage) return;
  target.prompt_tokens += toNumber(usage.prompt_tokens);
  target.completion_tokens += toNumber(usage.completion_tokens);
};

const emptyUsage = () => ({ prompt_tokens: 0, completion_tokens: 0 });

/**
 * Pack answers into calls: each call holds as many answers as fit the character budget,
 * up to maxPerCall. A single oversized answer still gets its own call.
 */
const chunkAnswers = (answers, { charBudget = DEFAULT_CHUNK_CHAR_BUDGET, maxPerCall = DEFAULT_MAX_SCRIPTS_PER_CALL } = {}) => {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const answer of answers) {
    const length = String(answer.text || '').length;
    if (current.length > 0 && (size + length > charBudget || current.length >= maxPerCall)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(answer);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const createQuestionMarker = ({
  provider = null,
  documentType = 'assignment',
  callAI = (params) => aiService.createCompletionWithRetry(params, 3),
  chunkCharBudget = DEFAULT_CHUNK_CHAR_BUDGET,
  maxScriptsPerCall = DEFAULT_MAX_SCRIPTS_PER_CALL,
  scriptCharLimit = DEFAULT_SCRIPT_CHAR_LIMIT
} = {}) => {
  const config = aiConfig.getConfig(documentType, provider);
  const selectedProvider = config.provider;
  const responseFormat = (selectedProvider === 'openai' || selectedProvider === 'ollama') ? { type: 'json_object' } : null;

  const requestJson = async (prompt, maxTokens) => {
    const result = await callAI({
      provider: selectedProvider,
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: Math.min(config.maxTokens || maxTokens, maxTokens),
      response_format: responseFormat
    });
    const parsed = parseAiJsonResponse(String(result?.content || '').trim()).parsed;
    return { parsed, usage: result?.usage || null };
  };

  const segmentScript = async (scriptText, criteria) => {
    const questionList = criteria
      .map((criterion) => `Q${criterion.index + 1}. ${criterion.name}${criterion.description ? ` - ${criterion.description}` : ''}`)
      .join('\n');
    const prompt = `You are preparing a student's script for marking. Split it into the student's answer to each question listed below.

QUESTIONS:
${questionList}

RULES:
- Copy the student's own words for each answer verbatim. Do not correct, summarise or judge them.
- Students may answer out of order, use their own numbering, or answer several questions together. Use the content to decide which question each part answers.
- If an answer serves more than one question, include it under each of them.
- If you cannot find an answer to a question, set "found" to false and "answer_text" to "".
- Ignore cover pages, instructions and the question text itself.

STUDENT SCRIPT:
${truncate(scriptText, scriptCharLimit)}

Return ONLY this JSON:
{"answers": [{"question": 1, "found": true, "answer_text": "..."}]}`;

    const { parsed, usage } = await requestJson(prompt, 16000);
    if (!parsed || !Array.isArray(parsed.answers)) {
      throw new Error('Could not split this script into answers per question.');
    }
    const byIndex = new Map();
    for (const answer of parsed.answers) {
      const index = Math.round(toNumber(answer?.question, 0)) - 1;
      if (index < 0 || index >= criteria.length) continue;
      const text = String(answer.answer_text || '').trim();
      const found = answer.found !== false && text.length > 0;
      const existing = byIndex.get(index);
      if (existing && existing.found) {
        if (found) existing.text = `${existing.text}\n\n${text}`;
      } else {
        byIndex.set(index, { found, text: found ? text : '' });
      }
    }
    return {
      segments: criteria.map((criterion) => byIndex.get(criterion.index) || { found: false, text: '' }),
      usage
    };
  };

  const markQuestionChunk = async (criterion, chunk, context) => {
    const labelled = chunk.map((answer, i) => ({ ...answer, label: `S${i + 1}` }));
    const answersBlock = labelled
      .map((answer) => `=== ${answer.label} ===\n${answer.text}`)
      .join('\n\n');
    const prompt = `${context.intro}

You are marking ONE ${context.isMemo ? 'question' : 'rubric criterion'} across ${labelled.length} anonymised student ${context.isMemo ? 'answers' : 'scripts'}, labelled S1 to S${labelled.length}.
Apply exactly the same standard to every one of them: equivalent work must receive equivalent marks. Mark each on its own merits against the ${context.isMemo ? 'memo' : 'rubric'}, not by ranking them against each other.

${context.levelBlock}

${context.strictness}
${context.policyBlock}
${context.isMemo ? 'QUESTION AND MEMO' : 'CRITERION'}:
${describeCriterion(criterion)}

${context.isMemo ? 'STUDENT ANSWERS' : 'STUDENT SCRIPTS (assess only this criterion)'}:
${answersBlock}

For every label, award points between 0 and ${criterion.max_points}. Feedback is written to the student ("you", "your"), ${VERBOSITY_GUIDANCE[context.feedbackVerbosity] || VERBOSITY_GUIDANCE.standard}
"rubric_basis" names the ${context.isMemo ? 'memo points' : 'rubric descriptor'} that decided the mark. "confidence" is 0-100: how sure you are of the mark.

Return ONLY this JSON, with one entry per label:
{"marks": [{"label": "S1", "points_awarded": 0, "rubric_basis": "...", "feedback": "...", "confidence": 85}]}`;

    const { parsed, usage } = await requestJson(prompt, 16000);
    const marks = new Map();
    for (const mark of (Array.isArray(parsed?.marks) ? parsed.marks : [])) {
      const label = String(mark?.label || '').trim().toUpperCase();
      if (label) marks.set(label, mark);
    }
    return {
      marks: labelled.map((answer) => ({ answer, mark: marks.get(answer.label) || null })),
      usage
    };
  };

  const synthesiseOverall = async (scores, totalScore, totalPoints, context) => {
    const breakdown = scores
      .map((score) => `- ${score.criterion_name}: ${score.points_awarded}/${score.max_points}. ${score.feedback}`)
      .join('\n');
    const prompt = `${context.intro}

A student's work has been marked ${context.isMemo ? 'question by question' : 'criterion by criterion'}. Their total is ${totalScore}/${totalPoints}. Here is the mark and feedback for each part:
${breakdown}

Write to the student ("you", "your"):
- "overall_feedback": a coherent overall comment (150-250 words) that synthesises the strengths and the most important things to improve across all parts. Do not repeat each part's feedback.
- "improvement_forecast": 2-4 sentences in the form "By addressing [top 2-3 specific issues], you could potentially gain approximately [X] additional marks, bringing your score from ${totalScore} to approximately [projected]/${totalPoints}." Only forecast marks the parts above could realistically recover.

Return ONLY this JSON:
{"overall_feedback": "...", "improvement_forecast": "..."}`;

    const { parsed, usage } = await requestJson(prompt, 4000);
    if (!parsed || typeof parsed.overall_feedback !== 'string' || !parsed.overall_feedback.trim()) {
      throw new Error('Could not write overall feedback.');
    }
    return { overall_feedback: parsed.overall_feedback.trim(), improvement_forecast: parsed.improvement_forecast || null, usage };
  };

  /**
   * @param {object} params
   * @param {Array<{assignment_id:number, text:string}>} params.scripts
   * @param {object} params.rubric
   * @param {boolean} params.isMemo
   * @param {string} [params.level]
   * @param {string} [params.strictnessLevel]
   * @param {string} [params.feedbackVerbosity]
   * @param {string} [params.policyText] judgement guidance from a marking policy, if any
   * @param {() => boolean} [params.isCancelled]
   * @param {(event: object) => void} [params.onProgress]
   * @returns {Promise<{results: Map<number, object>, errors: Array<{assignment_id:number, error:string}>, cancelled: boolean}>}
   */
  const markByQuestion = async ({
    scripts,
    rubric,
    isMemo,
    level = null,
    strictnessLevel = 'strict',
    feedbackVerbosity = 'standard',
    policyText = null,
    isCancelled = () => false,
    onProgress = () => {}
  }) => {
    const criteria = parseCriteria(rubric);
    const totalPoints = toNumber(rubric.total_points) || criteria.reduce((sum, c) => sum + c.max_points, 0);
    const resolvedLevel = resolveEducationLevel(level || 'level_4');
    const context = {
      isMemo,
      feedbackVerbosity,
      intro: `You are an experienced ${resolvedLevel.label || ''} examiner marking student work fairly and consistently.`.replace(/\s+/g, ' '),
      levelBlock: buildEducationLevelPromptBlock(resolvedLevel.id) || '',
      strictness: getStrictnessGuidelines(strictnessLevel),
      policyBlock: policyText ? `\nMARKING POLICY (apply when deciding marks):\n${policyText}\n` : ''
    };

    const errors = [];
    const failed = new Set();
    const fail = (assignmentId, error) => {
      if (failed.has(assignmentId)) return;
      failed.add(assignmentId);
      errors.push({ assignment_id: assignmentId, error });
    };
    const state = new Map(scripts.map((script) => [script.assignment_id, {
      script,
      segments: null,
      scores: new Array(criteria.length).fill(null),
      usage: emptyUsage()
    }]));
    const active = () => [...state.values()].filter((entry) => !failed.has(entry.script.assignment_id));

    // 1. Split scripts into answers. Criterion rubrics are holistic: every criterion sees the whole script.
    for (const entry of state.values()) {
      if (isCancelled()) return { results: new Map(), errors, cancelled: true };
      if (!isMemo) {
        const whole = truncate(entry.script.text, scriptCharLimit);
        entry.segments = criteria.map(() => ({ found: true, text: whole }));
        continue;
      }
      try {
        const { segments, usage } = await segmentScript(entry.script.text, criteria);
        entry.segments = segments;
        addUsage(entry.usage, usage);
        onProgress({ stage: 'segment', assignment_id: entry.script.assignment_id });
      } catch (error) {
        fail(entry.script.assignment_id, `Splitting into answers failed: ${error.message}`);
      }
    }

    // 2. Mark each question across all scripts.
    for (const criterion of criteria) {
      const answers = [];
      for (const entry of active()) {
        const segment = entry.segments[criterion.index];
        if (!segment.found) {
          entry.scores[criterion.index] = {
            criterion_name: criterion.name,
            points_awarded: 0,
            max_points: criterion.max_points,
            rubric_basis: 'No answer to this question was found in the script.',
            feedback: 'No answer to this question was found in your script. If you did answer it, ask your lecturer to check this mark.',
            confidence: MISSING_ANSWER_CONFIDENCE,
            answer_text: '',
            answer_found: false
          };
          continue;
        }
        answers.push({ assignment_id: entry.script.assignment_id, text: segment.text });
      }

      for (const chunk of chunkAnswers(answers, { charBudget: chunkCharBudget, maxPerCall: maxScriptsPerCall })) {
        if (isCancelled()) return { results: new Map(), errors, cancelled: true };
        let outcome;
        try {
          outcome = await markQuestionChunk(criterion, chunk, context);
        } catch (error) {
          outcome = { marks: chunk.map((answer) => ({ answer, mark: null })), usage: null, error };
        }
        const share = outcome.usage
          ? { prompt_tokens: toNumber(outcome.usage.prompt_tokens) / chunk.length, completion_tokens: toNumber(outcome.usage.completion_tokens) / chunk.length }
          : null;

        for (const { answer, mark: firstMark } of outcome.marks) {
          const entry = state.get(answer.assignment_id);
          addUsage(entry.usage, share);
          let mark = firstMark;
          // A label the model skipped (or a failed call) gets one retry on its own.
          if (!mark && chunk.length > 1) {
            try {
              const retry = await markQuestionChunk(criterion, [answer], context);
              addUsage(entry.usage, retry.usage);
              mark = retry.marks[0]?.mark || null;
            } catch (error) {
              mark = null;
            }
          }
          if (!mark) {
            fail(answer.assignment_id, `Marking ${criterion.name} failed${outcome.error ? `: ${outcome.error.message}` : ''}`);
            continue;
          }
          entry.scores[criterion.index] = {
            criterion_name: criterion.name,
            points_awarded: normalisePoints(mark.points_awarded, criterion.max_points),
            max_points: criterion.max_points,
            rubric_basis: String(mark.rubric_basis || ''),
            feedback: String(mark.feedback || ''),
            confidence: Math.max(0, Math.min(100, toNumber(mark.confidence, 80))),
            answer_text: isMemo ? answer.text : null,
            answer_found: true
          };
        }
        onProgress({ stage: 'question', criterion_index: criterion.index, marked: chunk.length });
      }
    }

    // 3. Overall feedback per script, then assemble a generateMarking()-shaped result.
    const results = new Map();
    for (const entry of active()) {
      if (isCancelled()) return { results, errors, cancelled: true };
      const scores = entry.scores;
      const totalScore = Math.round(scores.reduce((sum, score) => sum + score.points_awarded, 0) * 100) / 100;
      let overall;
      try {
        overall = await synthesiseOverall(scores, totalScore, totalPoints, context);
        addUsage(entry.usage, overall.usage);
      } catch (error) {
        fail(entry.script.assignment_id, `Writing overall feedback failed: ${error.message}`);
        continue;
      }

      const confidences = scores.map((score) => score.confidence);
      const overallConfidence = Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length);
      const minConfidence = Math.min(...confidences);
      const promptTokens = Math.round(entry.usage.prompt_tokens);
      const completionTokens = Math.round(entry.usage.completion_tokens);

      results.set(entry.script.assignment_id, {
        scores: scores.map(({ answer_text, answer_found, ...score }) => score),
        items: scores.map((score, index) => ({
          criterion_index: index,
          criterion_name: score.criterion_name,
          answer_text: score.answer_text,
          answer_found: score.answer_found,
          points_awarded: score.points_awarded,
          max_points: score.max_points,
          feedback: score.feedback,
          rubric_basis: score.rubric_basis,
          confidence: score.confidence
        })),
        overall_feedback: overall.overall_feedback,
        improvement_forecast: overall.improvement_forecast,
        total_score: totalScore,
        overall_confidence: overallConfidence,
        confidence_level: overallConfidence >= 80 ? 'high' : overallConfidence >= 60 ? 'medium' : 'low',
        needs_review: overallConfidence < CONFIDENCE_THRESHOLD,
        min_criterion_confidence: minConfidence,
        has_low_criterion_confidence: minConfidence < CONFIDENCE_THRESHOLD,
        handwriting_recognition_confidence: null,
        corrections: [],
        language_errors: [],
        prescriptive_table: null,
        reflective_questions: null,
        critical_table: null,
        genie_output: null,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens
        },
        estimated_cost_usd: aiConfig.estimateCost(promptTokens, completionTokens, selectedProvider)
      });
    }

    return { results, errors, cancelled: false };
  };

  return { markByQuestion };
};

module.exports = {
  createQuestionMarker,
  chunkAnswers,
  parseCriteria,
  normalisePoints
};
