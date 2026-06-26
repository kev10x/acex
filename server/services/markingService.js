const fs = require('fs');
const path = require('path');
const { query } = require('../database/connection');
const aiConfig = require('../config/ai-config');
const aiService = require('./aiService');
const { resolveEducationLevel, buildEducationLevelPromptBlock } = require('./educationLevelService');
const { logger } = require('./logger');

const DOCUMENT_TYPE_DETECTION_PREVIEW_CHARS = Number.parseInt(
  process.env.DOCUMENT_TYPE_DETECTION_PREVIEW_CHARS || '6000',
  10
);

// OpenAI Structured Outputs schema for marking results.
// strict: true guarantees the model produces exactly this shape — no JSON repair needed for OpenAI.
const MARKING_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion_name: { type: 'string' },
          points_awarded: { type: 'number' },
          max_points: { type: 'number' },
          rubric_basis: { type: 'string' },
          feedback: { type: 'string' },
          confidence: { type: 'number' }
        },
        required: ['criterion_name', 'points_awarded', 'max_points', 'rubric_basis', 'feedback', 'confidence'],
        additionalProperties: false
      }
    },
    corrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          criterion_name: { type: 'string' },
          location: { type: 'string' },
          issue: { type: 'string' },
          correction: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['type', 'criterion_name', 'location', 'issue', 'correction', 'reason'],
        additionalProperties: false
      }
    },
    language_errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          error_text: { type: 'string' },
          error_type: { type: 'string' },
          correction: { type: 'string' },
          explanation: { type: 'string' }
        },
        required: ['location', 'error_text', 'error_type', 'correction', 'explanation'],
        additionalProperties: false
      }
    },
    overall_feedback: { type: 'string' },
    total_score: { type: 'number' },
    overall_confidence: { type: 'number' },
    handwriting_recognition_confidence: {
      anyOf: [{ type: 'number' }, { type: 'null' }]
    },
    prescriptive_table: {
      anyOf: [
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string' },
              issue: { type: 'string' },
              location: { type: 'string' },
              fix: { type: 'string' },
              priority: { type: 'string' }
            },
            required: ['criterion', 'issue', 'location', 'fix', 'priority'],
            additionalProperties: false
          }
        },
        { type: 'null' }
      ]
    },
    reflective_questions: {
      anyOf: [
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string' },
              question: { type: 'string' }
            },
            required: ['criterion', 'question'],
            additionalProperties: false
          }
        },
        { type: 'null' }
      ]
    },
    critical_table: {
      anyOf: [
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string' },
              weakness: { type: 'string' },
              impact: { type: 'string' },
              evidence: { type: 'string' },
              severity: { type: 'string' }
            },
            required: ['criterion', 'weakness', 'impact', 'evidence', 'severity'],
            additionalProperties: false
          }
        },
        { type: 'null' }
      ]
    },
    genie_output: {
      anyOf: [
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string' },
              original_excerpt: { type: 'string' },
              corrected_version: { type: 'string' },
              changes_made: { type: 'string' }
            },
            required: ['criterion', 'original_excerpt', 'corrected_version', 'changes_made'],
            additionalProperties: false
          }
        },
        { type: 'null' }
      ]
    },
    improvement_forecast: { type: 'string' }
  },
  required: [
    'scores', 'corrections', 'language_errors',
    'overall_feedback', 'total_score', 'overall_confidence',
    'handwriting_recognition_confidence',
    'prescriptive_table', 'reflective_questions', 'critical_table', 'genie_output',
    'improvement_forecast'
  ],
  additionalProperties: false
};

// ---------------------------------------------------------------------------
// JSON repair utilities
// ---------------------------------------------------------------------------

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
  .replace(/^﻿/, '')
  .replace(/[“”]/g, '"')
  .replace(/[‘’]/g, "'");

const skipJsonWhitespace = (text, index) => {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
};

const findUnescapedQuote = (text, startIndex) => {
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === '"' && !isEscapedQuoteAt(text, i)) return i;
  }
  return -1;
};

const startsJsonValueAt = (text, index) => {
  const cursor = skipJsonWhitespace(text, index);
  const char = text[cursor] || '';
  if (char === '"' || char === "'" || char === '{' || char === '[' || char === '-' || /\d/.test(char)) return true;
  return (
    text.slice(cursor, cursor + 4) === 'true' ||
    text.slice(cursor, cursor + 4) === 'True' ||
    text.slice(cursor, cursor + 5) === 'false' ||
    text.slice(cursor, cursor + 5) === 'False' ||
    text.slice(cursor, cursor + 4) === 'null' ||
    text.slice(cursor, cursor + 4) === 'None'
  );
};

const MARKING_RESPONSE_PROPERTY_NAMES = new Set([
  'scores',
  'criterion_name',
  'points_awarded',
  'max_points',
  'rubric_basis',
  'feedback',
  'confidence',
  'corrections',
  'type',
  'location',
  'issue',
  'correction',
  'language_errors',
  'error_text',
  'error_type',
  'explanation',
  'overall_feedback',
  'total_score',
  'overall_confidence',
  'handwriting_recognition_confidence'
]);

const looksLikeObjectPropertyAfterComma = (text, commaIndex) => {
  const propertyStart = skipJsonWhitespace(text, commaIndex + 1);
  if (text[propertyStart] !== '"') return false;

  const propertyEnd = findUnescapedQuote(text, propertyStart + 1);
  if (propertyEnd < 0) return false;
  const propertyName = text.slice(propertyStart + 1, propertyEnd);
  if (!MARKING_RESPONSE_PROPERTY_NAMES.has(propertyName)) return false;

  const afterProperty = skipJsonWhitespace(text, propertyEnd + 1);
  return text[afterProperty] === ':' && startsJsonValueAt(text, afterProperty + 1);
};

const isLikelyJsonStringTerminator = (text, quoteIndex, { stringRole = 'unknown', container = null } = {}) => {
  const nextIndex = skipJsonWhitespace(text, quoteIndex + 1);
  const next = text[nextIndex] || '';

  if (stringRole === 'key') {
    return next === ':';
  }

  if (stringRole === 'value' && next === ':') {
    return false;
  }

  if (next === '' || next === ':' || next === '}' || next === ']') {
    return true;
  }

  if (next !== ',') {
    return false;
  }

  if (container === 'array') {
    return true;
  }

  const afterComma = skipJsonWhitespace(text, nextIndex + 1);
  const afterCommaChar = text[afterComma] || '';

  if (afterCommaChar === '' || afterCommaChar === '}' || afterCommaChar === ']') {
    return true;
  }

  // For object string values, a real closing quote followed by a comma should
  // lead into the next quoted property name. A comma followed by prose is part
  // of the string and the quote must be escaped.
  return looksLikeObjectPropertyAfterComma(text, nextIndex);
};

const unescapeJsonStringTerminators = (text) => {
  let result = '';
  let inStr = false;
  let esc = false;
  let stringRole = 'unknown';
  const containerStack = [];

  const getCurrentContainer = () => containerStack[containerStack.length - 1] || null;
  const getPreviousSignificantChar = (index) => {
    for (let cursor = index; cursor >= 0; cursor--) {
      if (!/\s/.test(text[cursor])) return text[cursor];
    }
    return '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      if (esc) {
        result += ch;
        esc = false;
        continue;
      }

      if (ch === '\\') {
        if (text[i + 1] === '"' && isLikelyJsonStringTerminator(text, i + 1, { stringRole, container: getCurrentContainer() })) {
          result += '"';
          inStr = false;
          stringRole = 'unknown';
          i += 1;
          continue;
        }

        result += ch;
        esc = true;
        continue;
      }

      if (ch === '"') {
        inStr = false;
        stringRole = 'unknown';
      }

      result += ch;
      continue;
    }

    if (ch === '{') {
      containerStack.push('object');
    } else if (ch === '[') {
      containerStack.push('array');
    } else if (ch === '}' || ch === ']') {
      containerStack.pop();
    } else if (ch === '"') {
      const previous = getPreviousSignificantChar(i - 1);
      stringRole = previous === ':' || getCurrentContainer() === 'array' ? 'value' : 'key';
      inStr = true;
    }

    result += ch;
  }

  return result;
};

const isValidJsonEscapeAt = (text, backslashIndex) => {
  const next = text[backslashIndex + 1];
  if (!next) return false;
  if (/["\\/bfnrt]/.test(next)) return true;
  if (next !== 'u') return false;

  return /^[0-9a-fA-F]{4}$/.test(text.slice(backslashIndex + 2, backslashIndex + 6));
};

const shouldDropInvalidJsonEscape = (next) => Boolean(next) && !/[A-Za-z0-9]/.test(next);

const repairBareJsonLiterals = (text) => {
  let result = '';
  let inStr = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      result += ch;
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') {
      inStr = true;
      result += ch;
      continue;
    }

    const rest = text.slice(i);
    const literalMatch = rest.match(/^(True|False|None)\b/);
    if (literalMatch) {
      const replacement = literalMatch[1] === 'True'
        ? 'true'
        : literalMatch[1] === 'False'
        ? 'false'
        : 'null';
      result += replacement;
      i += literalMatch[1].length - 1;
      continue;
    }

    result += ch;
  }

  return result;
};

const getPreviousSignificantChar = (text, index) => {
  for (let cursor = index; cursor >= 0; cursor--) {
    if (!/\s/.test(text[cursor])) return text[cursor];
  }
  return '';
};

const repairSingleQuotedJsonStrings = (text) => {
  let result = '';
  let inDoubleString = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inDoubleString) {
      result += ch;
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inDoubleString = false;
      }
      continue;
    }

    if (ch === '"') {
      inDoubleString = true;
      result += ch;
      continue;
    }

    if (ch !== "'") {
      result += ch;
      continue;
    }

    const previous = getPreviousSignificantChar(text, i - 1);
    if (previous !== ':' && previous !== '{' && previous !== '[' && previous !== ',') {
      result += ch;
      continue;
    }

    const expectedTerminators = previous === ':' || previous === '[' ? new Set([',', '}', ']']) : new Set([':']);
    let content = '';
    let closingIndex = -1;

    for (let cursor = i + 1; cursor < text.length; cursor++) {
      const current = text[cursor];

      if (current === '\\' && text[cursor + 1] === "'") {
        content += "'";
        cursor += 1;
        continue;
      }

      if (current === "'") {
        const afterQuote = skipJsonWhitespace(text, cursor + 1);
        if (expectedTerminators.has(text[afterQuote] || '')) {
          closingIndex = cursor;
          break;
        }
      }

      content += current;
    }

    if (closingIndex < 0) {
      result += ch;
      continue;
    }

    result += JSON.stringify(content);
    i = closingIndex;
  }

  return result;
};

// Escape literal control characters (bare newlines, tabs, CRs), unescaped
// double-quotes, and invalid backslash escapes inside JSON string values.
const sanitizeJsonControlChars = (str) => {
  let out = '';
  let inStr = false;
  let esc = false;
  let stringRole = 'unknown';
  const containerStack = [];

  const getCurrentContainer = () => containerStack[containerStack.length - 1] || null;
  const getPreviousSignificantCharLocal = (index) => {
    for (let cursor = index; cursor >= 0; cursor--) {
      if (!/\s/.test(str[cursor])) return str[cursor];
    }
    return '';
  };

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; }
      else if (ch === '\\') {
        const next = str[i + 1] || '';
        if (isValidJsonEscapeAt(str, i)) {
          out += ch;
          esc = true;
        } else if (shouldDropInvalidJsonEscape(next)) {
          // Markdown-style escapes such as \_ or \: become plain text.
        } else {
          // Preserve likely literal backslashes, e.g. C:\Users
          out += '\\\\';
        }
      }
      else if (ch === '"') {
        if (isLikelyJsonStringTerminator(str, i, { stringRole, container: getCurrentContainer() })) {
          out += ch;
          inStr = false;
          stringRole = 'unknown';
        } else {
          out += '\\"';
        }
      }
      else if (ch === '\n') { out += '\\n'; }
      else if (ch === '\r') { out += '\\r'; }
      else if (ch === '\t') { out += '\\t'; }
      else { out += ch; }
    } else {
      if (ch === '{') {
        containerStack.push('object');
      } else if (ch === '[') {
        containerStack.push('array');
      } else if (ch === '}' || ch === ']') {
        containerStack.pop();
      }

      if (ch === '"') {
        const previous = getPreviousSignificantCharLocal(i - 1);
        stringRole = previous === ':' || getCurrentContainer() === 'array' ? 'value' : 'key';
        inStr = true;
      }
      out += ch;
    }
  }
  return out;
};

const getJsonErrorPosition = (error) => {
  const match = String(error?.message || '').match(/position\s+(\d+)/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const isEscapedQuoteAt = (text, index) => {
  let slashCount = 0;
  let cursor = index - 1;
  while (cursor >= 0 && text[cursor] === '\\') {
    slashCount += 1;
    cursor -= 1;
  }
  return slashCount % 2 === 1;
};

const findLikelyUnescapedQuoteIndex = (text, parseErrorPosition, maxLookback = 5000) => {
  const start = Math.max(0, parseErrorPosition - maxLookback);

  for (let i = parseErrorPosition - 1; i >= start; i--) {
    if (text[i] !== '"' || isEscapedQuoteAt(text, i)) continue;
    if (isLikelyJsonStringTerminator(text, i)) continue;
    return i;
  }

  return -1;
};

const repairJsonByParsePosition = (value, maxAttempts = 30) => {
  let candidate = value;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch (error) {
      lastError = error;
      const errorPos = getJsonErrorPosition(error);
      if (errorPos == null) break;

      // When the unexpected token is a `"`, a missing comma before the next
      // property/value is more likely than an unescaped quote — an unescaped
      // quote causes the parser to swallow the string early and then report the
      // error on the prose text that follows (e.g. a letter), not on a `"`.
      if (errorPos > 0 && errorPos < candidate.length && candidate[errorPos] === '"') {
        candidate = `${candidate.slice(0, errorPos)},${candidate.slice(errorPos)}`;
        continue;
      }

      const quoteIndex = findLikelyUnescapedQuoteIndex(candidate, errorPos);
      if (quoteIndex < 0) break;

      candidate = `${candidate.slice(0, quoteIndex)}\\${candidate.slice(quoteIndex)}`;
    }
  }

  throw lastError || new Error('Failed to repair JSON from parse position');
};

const repairJsonCandidate = (value) => {
  const normalized = normalizeJsonCandidate(value);
  const sanitized = sanitizeJsonControlChars(normalized);
  return repairBareJsonLiterals(repairSingleQuotedJsonStrings(unescapeJsonStringTerminators(sanitized
    .replace(/":\s*\\"/g, '": "')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
    .replace(/([{,]\s*)'([^']+?)'(\s*:)/g, '$1"$2"$3'))));
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

  // Position-guided quote repair fallback for malformed strings like:
  // "feedback": "The learner wrote "important point", but ..."
  // Note: seeds intentionally bypass `seen` — repairJsonByParsePosition applies
  // additional position-guided escaping on top of repairJsonCandidate, so the
  // resulting repaired string will differ from anything already in `seen`.
  for (const candidate of baseCandidates) {
    if (!candidate) continue;

    for (const seed of [repairJsonCandidate(candidate), candidate]) {
      if (!seed) continue;

      try {
        const repaired = repairJsonByParsePosition(seed);
        if (!repaired || seen.has(repaired)) continue;
        seen.add(repaired);
        return {
          parsed: JSON.parse(repaired),
          cleanedText: repaired
        };
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error('Failed to parse AI response as JSON');
};

const coerceFiniteNumber = (value, fallback = null) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

// ---------------------------------------------------------------------------
// Memo and document-type detection
// ---------------------------------------------------------------------------

const detectMemo = async (rubricText) => {
  try {
    const memoIndicators = [
      'memo', 'memorandum', 'answer key', 'answer sheet', 'marking memo',
      'model answer', 'sample answer', 'expected answer', 'correct answer',
      'solution', 'marking scheme', 'marking guide', 'examiner\'s guide'
    ];

    const textLower = rubricText.toLowerCase();
    const hasMemoKeywords = memoIndicators.some(indicator => textLower.includes(indicator));

    const rubricIndicators = [
      'performance level', 'evaluation criteria', 'assessment rubric',
      'grading scale', 'rubric', 'criteria', 'performance descriptor'
    ];
    const hasRubricKeywords = rubricIndicators.some(indicator => textLower.includes(indicator));

    if (hasRubricKeywords && !hasMemoKeywords && rubricText.length > 200) {
      return false;
    }

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

    const config = aiConfig.getConfig('default');
    const aiResult = await aiService.createCompletionWithRetry({
      provider: config.provider,
      model: config.provider === 'openai' ? 'gpt-5-mini' : 'claude-3-haiku-20240307',
      messages: [{ role: "user", content: detectionPrompt }],
      temperature: 0.1,
      maxTokens: 1500
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
    return result.is_memo === true && (result.confidence === 'high' || result.confidence === 'medium');
  } catch (error) {
    console.warn('Memo detection failed, assuming not a memo:', error.message);
    return false;
  }
};

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
${documentText.substring(0, Number.isFinite(DOCUMENT_TYPE_DETECTION_PREVIEW_CHARS) && DOCUMENT_TYPE_DETECTION_PREVIEW_CHARS > 0 ? DOCUMENT_TYPE_DETECTION_PREVIEW_CHARS : 6000)}

Respond with ONLY a JSON object:
{
  "document_type": "question_paper" or "treatise" or "assignment" or "thesis" or "report" or "proposal",
  "confidence": "high" or "medium" or "low"
}`;

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

// ---------------------------------------------------------------------------
// Marking response parser
// ---------------------------------------------------------------------------

const parseMarkingResponsePayload = (response, { selectedProvider = 'openai', usage = null, imageBased = false } = {}) => {
  const trimmedResponse = String(response || '').trim();
  if (!trimmedResponse) {
    throw new Error('The AI returned an empty response. This can happen with content filters, rate limits, or token limits. Please try again or use a shorter submission.');
  }

  const markingResult = parseAiJsonResponse(trimmedResponse).parsed;

  if (!markingResult.scores || !Array.isArray(markingResult.scores) || markingResult.scores.length === 0) {
    throw new Error('Invalid response structure: missing scores array');
  }
  if (!markingResult.overall_feedback || typeof markingResult.overall_feedback !== 'string') {
    throw new Error('Invalid response structure: missing overall_feedback');
  }

  const confidenceThreshold = 70;

  markingResult.scores = markingResult.scores.map((score) => ({
    ...score,
    points_awarded: coerceFiniteNumber(score.points_awarded, 0),
    max_points: coerceFiniteNumber(score.max_points, 0),
    confidence: Math.max(0, Math.min(100, coerceFiniteNumber(score.confidence, 80)))
  }));

  const overallConfidence = coerceFiniteNumber(markingResult.overall_confidence, null);
  if (overallConfidence === null) {
    const avgConfidence = markingResult.scores.length > 0
      ? markingResult.scores.reduce((sum, score) => sum + (score.confidence || 80), 0) / markingResult.scores.length
      : 80;
    markingResult.overall_confidence = Math.round(avgConfidence);
  } else {
    markingResult.overall_confidence = Math.max(0, Math.min(100, overallConfidence));
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

// ---------------------------------------------------------------------------
// Core marking function
// ---------------------------------------------------------------------------

const getFeedbackVerbosityPromptBlock = (feedbackVerbosity) => {
  switch (feedbackVerbosity) {
    case 'brief':
      return `FEEDBACK VERBOSITY: BRIEF
- Per-criterion feedback: 1-2 sentences maximum. Identify the single most important point only.
- Overall feedback: 2-4 sentences. Focus on the top strength and top area for improvement.
- Corrections: list only the most critical issues (maximum 5 total).
- Language errors: flag only the most impactful errors (maximum 5).
- Keep all text tightly focused — no elaboration, no examples, no learning context.`;
    case 'comprehensive':
      return `FEEDBACK VERBOSITY: COMPREHENSIVE
- Per-criterion feedback: 6-10 sentences minimum. Cover every observable dimension of the work for that criterion.
- Include: exact quotes from the submission, connections to wider academic discourse, comparison to the highest possible standard, step-by-step improvement roadmap.
- Overall feedback: 400-600 words minimum. Leave no significant aspect unaddressed.
- Corrections: be exhaustive — every correction and suggestion warranted.
- Language errors: report every identifiable error.
- Prioritise depth and completeness over conciseness.`;
    default:
      return '';
  }
};

const FEEDBACK_TYPE_DESCRIPTIONS = {
  prescriptive: 'Populate prescriptive_table for this criterion: issue, location, fix, priority (high/medium/low).',
  reflective: 'Populate reflective_questions for this criterion: 2-3 open thought-provoking questions (no answers/hints).',
  critical: 'Populate critical_table for this criterion: weakness, impact, evidence (direct quote), severity (fundamental/major/minor).',
  genie: 'Populate genie_output for this criterion: original_excerpt (verbatim from submission), corrected_version (rewritten to expected standard), changes_made.',
  standard: 'Use the standard narrative feedback field only (scores[].feedback). No special table or structured output needed for this criterion.'
};

const normalizeDocumentType = (documentType) => {
  const value = String(documentType || '').trim().toLowerCase();
  if (value === 'project_proposal' || value === 'project proposal' || value === 'proposal') return 'project_proposal';
  if (value === 'exam' || value === 'examination') return 'exam';
  if (value === 'code' || value === 'source_code' || value === 'programming') return 'code';
  return documentType;
};

const getFeedbackTypePromptBlock = (feedbackType, criterionFeedbackTypes = null) => {
  // Per-criterion mixing mode
  if (criterionFeedbackTypes && typeof criterionFeedbackTypes === 'object' && Object.keys(criterionFeedbackTypes).length > 0) {
    const overrideLines = Object.entries(criterionFeedbackTypes)
      .map(([name, type]) => `  - "${name}": ${FEEDBACK_TYPE_DESCRIPTIONS[type] || FEEDBACK_TYPE_DESCRIPTIONS.standard}`)
      .join('\n');

    // Determine which schema fields to populate
    const activeTypes = new Set(Object.values(criterionFeedbackTypes));
    const needsPrescriptive = activeTypes.has('prescriptive');
    const needsReflective = activeTypes.has('reflective');
    const needsCritical = activeTypes.has('critical');
    const needsGenie = activeTypes.has('genie');

    return `FEEDBACK TYPE: PER-CRITERION MIXING
Each criterion has its own feedback type override. For each criterion, follow the instruction below:
${overrideLines}

SCHEMA FIELD RULES:
- prescriptive_table: ${needsPrescriptive ? 'Populate rows ONLY for criteria assigned "prescriptive" type.' : 'Set to null.'}
- reflective_questions: ${needsReflective ? 'Populate rows ONLY for criteria assigned "reflective" type.' : 'Set to null.'}
- critical_table: ${needsCritical ? 'Populate rows ONLY for criteria assigned "critical" type.' : 'Set to null.'}
- genie_output: ${needsGenie ? 'Populate rows ONLY for criteria assigned "genie" type.' : 'Set to null.'}
For criteria assigned "standard", include only the normal narrative scores[].feedback field.`;
  }
  switch (feedbackType) {
    case 'prescriptive':
      return `FEEDBACK TYPE: PRESCRIPTIVE
You must populate the "prescriptive_table" field. For EVERY criterion, produce one or more rows that tell the student exactly what to fix. Rules:
- "issue": state the specific problem concisely (1-2 sentences)
- "location": pinpoint where in the document (section name, paragraph, page reference)
- "fix": give a concrete, actionable instruction — what specifically must the student do? No vague advice.
- "priority": "high" (affects grade significantly), "medium" (notable gap), or "low" (minor polish)
Produce multiple rows per criterion when there are multiple distinct issues.
Set "reflective_questions", "critical_table", and "genie_output" to null.`;

    case 'reflective':
      return `FEEDBACK TYPE: REFLECTIVE
You must populate the "reflective_questions" field. For EVERY criterion, produce 2-3 open questions that prompt the student to think critically about their own work. Rules:
- Questions must be genuinely thought-provoking — not yes/no questions, not rhetorical.
- Questions should probe assumptions, ask for evidence, invite comparison, or push for deeper analysis.
- Phrase as if speaking directly to the student: "How did you arrive at...?", "What evidence would strengthen...?", "If you were to reconsider X, what would change?"
- Do NOT provide answers or hints — the goal is to trigger self-reflection.
Set "prescriptive_table", "critical_table", and "genie_output" to null.`;

    case 'critical':
      return `FEEDBACK TYPE: CRITICAL ANALYSIS
You must populate the "critical_table" field. For EVERY criterion, identify and catalogue the weaknesses with scholarly rigour. Rules:
- "weakness": name the specific flaw or gap directly and precisely (no softening)
- "impact": explain the academic or practical consequence of this weakness on the work's quality or argument
- "evidence": quote or specifically reference the exact text, section, or passage that demonstrates this weakness
- "severity": "fundamental" (undermines the entire criterion), "major" (significantly reduces quality), or "minor" (limited scope)
Be critical and direct — this mode is not for encouragement, it is for rigorous academic critique.
Set "prescriptive_table", "reflective_questions", and "genie_output" to null.`;

    case 'genie':
      return `FEEDBACK TYPE: GENIE (AI-CORRECTED ALTERNATIVE)
You must populate the "genie_output" field. For EVERY criterion where the student's work has room for improvement, provide a corrected rewrite. Rules:
- "original_excerpt": copy verbatim the specific passage, sentence, or section from the student's submission that needs improvement (keep it focused — a paragraph or less)
- "corrected_version": rewrite that excerpt to the standard expected at this level — improved argument, corrected structure, proper academic language, added depth
- "changes_made": list the specific changes made and the academic reason behind each (e.g. "Added methodological justification — the rubric requires evidence of process rationale")
Produce one entry per criterion. If a criterion is already excellent, produce an entry with original_excerpt set to the strongest excerpt and corrected_version matching it, with changes_made noting it meets the standard.
Set "prescriptive_table", "reflective_questions", and "critical_table" to null.`;

    default:
      return `Set "prescriptive_table", "reflective_questions", "critical_table", and "genie_output" all to null — standard feedback mode is active.`;
  }
};

// Generate AI marking using OpenAI or Anthropic.
// When assignmentImages (array of base64 strings) is provided, the PDF is marked from images instead of extracted text (vision-based).
const generateMarking = async (assignmentText, rubric, documentType = null, level = null, provider = null, strictnessLevel = 'strict', assignmentId = null, assignmentImages = null, feedbackType = 'standard', feedbackVerbosity = 'standard', criterionFeedbackTypes = null) => {
  const imageBased = Array.isArray(assignmentImages) && assignmentImages.length > 0;
  try {
    const resolvedLevel = resolveEducationLevel(level || 'level_4');
    const levelCategory = resolvedLevel.marking_category;
    const levelBandLabel = resolvedLevel.label;
    const levelPromptBlock = buildEducationLevelPromptBlock(resolvedLevel.id);
    // Auto-detect document type if not provided (only when we have text; for image-based use provided or default)
    if (!documentType) {
      if (imageBased) {
        documentType = documentType || 'assignment';
        console.log('📝 Using document type (image-based):', documentType);
      } else {
        logger.info('🔍 Auto-detecting document type...');
        documentType = await detectDocumentType(assignmentText);
        console.log('📝 Detected document type:', documentType);
      }
    }
    documentType = normalizeDocumentType(documentType);

    // Check if rubric is actually a memo (answer key)
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
      logger.info('📋 Rubric detected as MEMO (answer key/marking memorandum)');
      documentType = 'memo';
    }

    const config = aiConfig.getConfig(documentType, provider);
    const selectedProvider = config.provider;

    let previousMarkingExamples = null;

    if (assignmentId) {
      try {
        const previousResults = await query(
          'SELECT scores, total_score FROM marking_results WHERE assignment_id = ? AND is_current = 1 ORDER BY marked_at DESC LIMIT 1',
          [assignmentId]
        );

        let previousResult;
        if (Array.isArray(previousResults)) {
          previousResult = previousResults[0];
        } else if (previousResults.rows && Array.isArray(previousResults.rows)) {
          previousResult = previousResults.rows[0];
        }

        if (previousResult) {
          let scores = previousResult.scores;
          if (typeof scores === 'string') {
            scores = JSON.parse(scores);
          }

          if (scores && Array.isArray(scores) && scores.length > 0) {
            previousMarkingExamples = {
              total_score: previousResult.total_score,
              scores: scores
            };
            console.log('📚 Found previous marking for this assignment:', previousMarkingExamples);
          } else {
            logger.warn('Previous marking result has invalid or null scores, skipping');
          }
        }
      } catch (error) {
        console.warn('Could not fetch previous marking examples:', error.message);
      }
    }

    logger.info('🤖 Starting AI marking process...');
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
    const modelToUse = imageBased
      ? (selectedProvider === 'openai' ? 'gpt-5.2' : 'claude-3-haiku-20240307')
      : config.model;
    console.log('Using model:', modelToUse);
    console.log('Max tokens:', config.maxTokens);
    console.log('Rubric:', JSON.stringify(rubric, null, 2));

    let criteria = rubric.criteria;
    if (typeof criteria === 'string') {
      try {
        criteria = JSON.parse(criteria);
      } catch (e) {
        logger.error({ err: e });
      }
    }
    if (!Array.isArray(criteria)) {
      logger.error({ err: criteria });
      throw new Error('Rubric has an invalid criteria format. Please recreate or edit this rubric.');
    }

    const totalPoints = rubric.total_points;
    console.log('Criteria count:', criteria?.length || 0);

    const simpleCriteria = criteria.map(criterion => {
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

    const estimateTokens = (text) => Math.ceil((text?.length || 0) / 4);
    const contextWindowTokens = selectedProvider === 'anthropic' ? 200000 : 128000;
    const requestMaxTokens = Math.min(config.maxTokens, 16000);
    const promptBudgetTokens = Math.max(1000, contextWindowTokens - requestMaxTokens - 1000);
    const maxPromptCharsByContextWindow = promptBudgetTokens * 4;

    const maxAllowedChars = Math.min(config.maxTextLength, maxPromptCharsByContextWindow);
    const truncatedText = imageBased
      ? `The submission is provided as ${assignmentImages.length} page image(s) below (in order). Assess the work from these images—including any handwritten or typed content—and apply the rubric. Handwriting may be messy or partially legible; assess the content and ideas, and be fair about legibility. Return only the JSON.`
      : (assignmentText.length > maxAllowedChars
          ? assignmentText.substring(0, maxAllowedChars) + '...[truncated for processing]'
          : assignmentText);

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
          : `You are an expert educator evaluating a Treatise. Apply STRICT academic standards for ${levelBandLabel} work. Be critical and precise in your evaluation. Be very direct about the issues you identify: state problems and weaknesses clearly—do not soften or hedge.`,
        thesis: level === 'postgraduate'
          ? `You are an expert examiner evaluating a Thesis. Apply STRICT and rigorous postgraduate standards. Be demanding and critical - this represents the culmination of significant research and must meet the highest standards. Be very direct about the issues you identify: state problems, gaps, and weaknesses clearly and explicitly—do not soften or hedge. Use advanced academic terminology.`
          : `You are an expert examiner evaluating a Thesis at ${levelBandLabel}. Apply STRICT academic standards. Be critical and precise in your assessment. Be very direct about the issues you identify: state problems and weaknesses clearly—do not soften or hedge.`,
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
        project_proposal: level === 'undergraduate' || level === 'postgraduate'
          ? `You are a supervisor evaluating a Project Proposal. Emphasize clarity of the problem or project aim, significance, feasibility, scope, implementation plan, risk management, and methodology/design plan. Be very direct about the issues you identify: state problems, gaps, and weaknesses clearly and explicitly—do not soften or hedge. Provide ${terms.feedback} feedback appropriate for ${levelBandLabel}.`
          : `You are evaluating a Project Proposal. Emphasize clarity of the project aim, significance, feasibility, scope, and plan. Be very direct about the issues you identify: state problems and weaknesses clearly—do not soften or hedge.`,
        exam: `You are an examiner marking an Exam. Focus on accuracy of answers, completeness, clarity of explanations, adherence to instructions, and correct allocation of marks according to the rubric or memo.`,
        code: `You are an expert programming instructor marking source code. Evaluate functional correctness, algorithmic approach, syntax, readability, maintainability, error handling, security where relevant, and how well the code satisfies the rubric or task requirements.`,
        question_paper: `You are an examiner evaluating a Question Paper/Exam. Focus on accuracy of answers, completeness, clarity of explanations, and adherence to expected responses.`,
        memo: `You are an examiner using a MEMO (Marking Memorandum/Answer Key) to evaluate student responses. Compare student answers against the model answers and marking scheme in the memo.`
      };

      return introMap[assessmentType] || introMap.assignment;
    };

    const intro = getIntro(documentType, levelCategory);

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

      if (assessmentType === 'question_paper' || assessmentType === 'exam') {
        return `EVALUATION GUIDELINES FOR ${assessmentType === 'exam' ? 'EXAM' : 'QUESTION PAPER'}:
- This is an exam/question-paper style submission that needs to be marked
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

      if (assessmentType === 'project_proposal' || assessmentType === 'proposal') {
        return `EVALUATION GUIDELINES FOR PROJECT PROPOSAL:
- This is a project proposal requiring rigorous evaluation of problem or project aim, significance, feasibility, scope, and methodology/design plan
- Apply STRICT standards - be critical and demanding in your evaluation
- BE VERY DIRECT ABOUT ISSUES: State every problem, gap, and weakness clearly and explicitly. Do not soften, hedge, or use euphemisms. Name the issue directly (e.g., "The problem statement fails to identify a clear gap", "The implementation plan lacks detail on...", "Significance is not justified because...", "This section is missing..."). Candidates need unambiguous feedback on what is wrong.
- Focus on: clarity of project aim/problem and gap, justification of significance, feasibility (resources, timeline, scope), risk awareness, and quality of methodology/design/implementation plan
- Provide comprehensive feedback for each criterion (3-5 sentences minimum)
- Reference specific sections and arguments from the proposal
- BALANCED EVALUATION: For each criterion, identify and praise strengths where present, then state issues directly. When something is wrong or missing, say so plainly (e.g., "The project aim does not establish a clear gap", "The implementation plan omits...", "Significance is weak because...").
- Be critical - identify missing elements, weak justification, unclear methodology/design, and unrealistic or vague plans; state each one directly
- CRITICAL: Provide specific, actionable improvement suggestions; state what is wrong before suggesting fixes
- Identify ALL missing elements, weak arguments, or areas needing more detail - name them explicitly
- ${guidance.tone}
- ${guidance.terminology}
- Award points STRICTLY based on the performance levels described in the rubric - do not be generous`;
      }

      if (assessmentType === 'code') {
        return `EVALUATION GUIDELINES FOR CODE:
- This is a source-code submission. Mark it against the rubric and the task requirements, not as a prose essay.
- Apply STRICT programming assessment standards - be precise about defects and do not infer functionality that is not present in the code.
- Evaluate functional correctness: does the code solve the stated problem, produce the expected outputs, handle required inputs, and meet all specified constraints?
- Evaluate code structure: decomposition, naming, control flow, data structures, modularity, and avoidance of unnecessary duplication.
- Evaluate syntax and runtime risk: identify syntax errors, missing imports, undefined variables, type issues, likely exceptions, and logic errors.
- Evaluate robustness: input validation, error handling, edge cases, resource cleanup, security concerns, and performance where relevant.
- Reference specific functions, variables, statements, or code blocks from the submission when giving feedback.
- When code is wrong, say exactly what is wrong and why it would fail. Do not soften errors or call broken code "partially correct" unless the rubric supports partial credit.
- Recognize correct, efficient, readable code when present, then state gaps and improvements directly.
- Provide actionable fixes: name what to change, where to change it, and what behavior the fix should produce.
- ${guidance.tone}
- ${guidance.feedback}
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
    } else if (documentType === 'project_proposal' || documentType === 'proposal') {
      contentLabel = 'PROJECT PROPOSAL CONTENT:';
    } else if (documentType === 'exam') {
      contentLabel = 'EXAM SUBMISSION:';
    } else if (documentType === 'code') {
      contentLabel = 'SOURCE CODE SUBMISSION:';
    }

    const evaluationGuidelines = getEvaluationGuidelines(documentType, levelCategory, isMemo);

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

${levelPromptBlock}

${evaluationGuidelines}

${getStrictnessGuidelines(strictnessLevel)}

IMPORTANT (OUTPUT FORMAT): Return ONLY a valid JSON object matching the required marking schema. Do NOT include any commentary, markdown fences, or extra characters. Return raw JSON only.

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

${getFeedbackTypePromptBlock(feedbackType, criterionFeedbackTypes)}
${getFeedbackVerbosityPromptBlock(feedbackVerbosity)}

IMPROVEMENT FORECAST (always required):
Populate the "improvement_forecast" field with a concise 2-4 sentence statement estimating how many marks the student could recover and which specific issues to address. Format: "By addressing [top 2-3 specific issues], you could potentially gain approximately [X] additional marks, bringing your score from [current] to approximately [projected]/[total]." Be realistic — only forecast marks that the rubric criteria could plausibly award if the issues were resolved.

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
      "confidence": number
    }
  ],
  "corrections": [
    {
      "type": "correction" or "suggestion",
      "criterion_name": "name of the criterion this relates to",
      "location": "specific location in the document",
      "issue": "what is wrong or what needs to be addressed",
      "correction": "what should be changed or added",
      "reason": "why this correction/suggestion is needed"
    }
  ],
  "language_errors": [
    {
      "location": "exact location in the document",
      "error_text": "exact text containing the error",
      "error_type": "grammar" or "spelling" or "reference" or "punctuation" or "style",
      "correction": "the corrected version of the text",
      "explanation": "brief explanation of why it's an error and how to fix it"
    }
  ],
  "overall_feedback": "EXTENSIVE, COMPREHENSIVE feedback (minimum 200-300 words) written as if you are a real teacher speaking directly to the student. Use 'you' and 'your' throughout.",
  "total_score": number,
  "overall_confidence": number${imageBased ? ',\n  "handwriting_recognition_confidence": number' : ''},
  "prescriptive_table": ${feedbackType === 'prescriptive' ? '[{"criterion": "criterion name", "issue": "specific problem to fix", "location": "where in the document", "fix": "exactly what to do to fix it", "priority": "high|medium|low"}]' : 'null'},
  "reflective_questions": ${feedbackType === 'reflective' ? '[{"criterion": "criterion name", "question": "Thought-provoking question to prompt self-reflection and deeper thinking?"}]' : 'null'},
  "critical_table": ${feedbackType === 'critical' ? '[{"criterion": "criterion name", "weakness": "specific weakness identified", "impact": "how this weakness affects the work or grade", "evidence": "direct quote or specific reference from the submission", "severity": "fundamental|major|minor"}]' : 'null'},
  "genie_output": ${feedbackType === 'genie' ? '[{"criterion": "criterion name", "original_excerpt": "verbatim excerpt from the submission that needs improvement", "corrected_version": "AI-rewritten, corrected version of that excerpt", "changes_made": "concise explanation of what was changed and why"}]' : 'null'},
  "improvement_forecast": "By addressing [specific issues], you could potentially gain approximately X additional marks, bringing your score from [current] to approximately [projected]/[total]."
}`;

    console.log(`📤 Sending request to ${selectedProvider === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI'}...`);

    // --- STRUCTURE-CHECK: lightweight, low-cost JSON-only verification to avoid
    // wasting money on a long expensive call when the model can't produce
    // valid JSON. If this check fails, we abort the expensive generation.
    try {
      const skeletonPrompt = `Return ONLY a compact JSON object that matches the final schema used for marking. Do NOT include any extra commentary or markdown. Use the same criterion names in the rubric and for each criterion return numeric fields only (points_awarded set to 0 is acceptable placeholder). The object must include: scores (array of {criterion_name, points_awarded, max_points}), overall_feedback (short string), overall_confidence (number). Return JSON only.`;

      const skeletonMessages = [{ role: 'user', content: `${skeletonPrompt}\n\nRubric:\n${detailedRubric}\n\nTOTAL: ${totalPoints}` }];

      const skeletonModel = selectedProvider === 'openai' ? 'gpt-5-mini' : 'claude-3-haiku-20240307';
      const skeletonResult = await aiService.createCompletionWithRetry({
        provider: selectedProvider,
        model: skeletonModel,
        messages: skeletonMessages,
        temperature: 0.0,
        maxTokens: 2500
      }, 1);

      const skeletonResponse = String(skeletonResult.content || '').trim();
      try {
        const parsedSkeleton = parseAiJsonResponse(skeletonResponse).parsed;
        if (!parsedSkeleton || !Array.isArray(parsedSkeleton.scores) || parsedSkeleton.scores.length === 0) {
          logger.warn('Structure check: parsed skeleton missing scores array, aborting full generation to avoid cost');
          throw new Error('Structure check failed');
        }
        const skeletonNames = parsedSkeleton.scores.map(s => String(s.criterion_name || '').trim().toLowerCase()).filter(Boolean);
        const rubricNames = simpleCriteria.map(c => String(c.name || '').trim().toLowerCase());

        const tokenize = (str) => (str || '').split(/[^a-z0-9]+/i).filter(t => t.length >= 3);

        let matches = 0;
        for (const r of rubricNames) {
          const rTokens = new Set(tokenize(r));
          for (const s of skeletonNames) {
            const sTokens = new Set(tokenize(s));
            const common = [...rTokens].filter(t => sTokens.has(t));
            if (common.length > 0 || s.includes(r) || r.includes(s)) {
              matches += 1;
              break;
            }
          }
        }

        const required = Math.max(1, Math.floor(rubricNames.length / 3));
        if (matches < required) {
          console.warn('Structure check: criterion name match low, aborting full generation to avoid cost', { matches, required, skeletonPreview: JSON.stringify(skeletonNames).substring(0,200) });
          throw new Error('Structure check failed: poor name match');
        }
        logger.info('Structure check passed — proceeding to full generation');
      } catch (sErr) {
        console.warn('Structure check could not be parsed reliably:', sErr.message);
        throw new Error('AI structural JSON check failed — aborting to avoid wasted cost');
      }
    } catch (structureError) {
      logger.error({ err: structureError.message });
      throw structureError;
    }

    let messages;
    if (imageBased) {
      const imageParts = selectedProvider === 'openai'
        ? assignmentImages.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }))
        : assignmentImages.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }));
      messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, ...imageParts] }];
    } else {
      messages = [{ role: 'user', content: prompt }];
    }

    // Use OpenAI Structured Outputs (json_schema + strict: true) to guarantee the model
    // produces valid JSON matching MARKING_SCHEMA exactly — eliminates malformed JSON for OpenAI.
    // Anthropic does not support json_schema; fall back to no response_format constraint.
    const responseFormat = selectedProvider === 'openai'
      ? { type: 'json_schema', json_schema: { name: 'marking_result', strict: true, schema: MARKING_SCHEMA } }
      : null;

    const result = await aiService.createCompletionWithRetry({
      provider: selectedProvider,
      model: modelToUse,
      messages,
      temperature: config.temperature,
      maxTokens: requestMaxTokens,
      response_format: responseFormat
    }, 5);

    console.log(`📥 Received response from ${selectedProvider === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI'}`);
    const response = (result.content != null ? String(result.content) : '');
    console.log('Response length:', response.length);
    console.log('Response preview:', response.substring(0, 200) + (response.length > 200 ? '...' : ''));

    if (!response || response.trim().length === 0) {
      console.error('Empty AI response. finish_reason or content_filter may have truncated output.');
      throw new Error('The AI returned an empty response. This can happen with content filters, rate limits, or token limits. Please try again or use a shorter submission.');
    }

    if (result.usage) {
      logger.info('🔢 Token Usage:');
      console.log(`   Prompt tokens: ${result.usage.prompt_tokens}`);
      console.log(`   Completion tokens: ${result.usage.completion_tokens}`);
      console.log(`   Total tokens: ${result.usage.total_tokens}`);

      const totalCost = aiConfig.estimateCost(result.usage.prompt_tokens, result.usage.completion_tokens, selectedProvider);
      console.log(`   Estimated cost: $${totalCost.toFixed(6)}`);
      console.log(`   Cost per ${documentType}: $${totalCost.toFixed(4)}`);
    }

    try {
      return parseMarkingResponsePayload(response, {
        selectedProvider,
        usage: result?.usage || null,
        imageBased
      });
    } catch (parseError) {
      logger.error({ err: parseError.message });
      logger.error({ err: parseError.stack });
      logger.error({ err: response.substring(0, 1000) });
      logger.error({ err: response.length });

      const extractedJson = extractFirstJsonObject(response);
      if (extractedJson && extractedJson !== response) {
        try {
          return parseMarkingResponsePayload(extractedJson, {
            selectedProvider,
            usage: result?.usage || null,
            imageBased
          });
        } catch (extractError) {
          logger.error({ err: extractError.message });
        }
      }

      // AI-assisted JSON extraction fallback
      try {
        logger.info('Attempting AI-assisted JSON extraction fallback...');
        const extractionPrompt = `The JSON below may have syntax errors such as unescaped double-quote characters inside string values.\nFix all JSON syntax errors and return ONLY the corrected JSON object. Do NOT add any commentary, explanation, or extra characters — return raw JSON only.\n\nRESPONSE:\n${response.substring(0, 20000)}`;

        const repairResult = await aiService.createCompletionWithRetry({
          provider: selectedProvider,
          model: selectedProvider === 'openai' ? 'gpt-5-mini' : 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: extractionPrompt }],
          temperature: 0.0,
          maxTokens: 16000,
          response_format: selectedProvider === 'openai' ? { type: 'json_object' } : null
        }, 2);

        const repairedText = String(repairResult.content || '').trim();
        if (repairedText && repairedText !== 'NONE') {
          let candidate = repairedText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
          try {
            return parseMarkingResponsePayload(candidate, {
              selectedProvider,
              usage: result?.usage || null,
              imageBased
            });
          } catch (err2) {
            logger.error({ err: err2.message });
          }
        } else {
          logger.warn('AI-assisted extraction returned NONE or empty');
        }
      } catch (aiExtractError) {
        logger.error({ err: aiExtractError.message });
      }

      // Persist raw response for offline analysis
      logger.saveFailedResponse(response, assignmentId);

      throw new Error('Failed to parse AI response as JSON: ' + parseError.message);
    }
  } catch (error) {
    console.error(`❌ ${error.provider || 'AI'} API error:`, error);
    logger.error({ err: {
      message: error.message,
      status: error.status || error.statusCode,
      type: error.type,
      code: error.code
    } });
    throw new Error('Failed to generate marking with AI');
  }
};

module.exports = {
  generateMarking,
  parseMarkingResponsePayload,
  parseAiJsonResponse,
  extractFirstJsonObject,
  detectMemo,
  detectDocumentType,
  MARKING_SCHEMA
};
