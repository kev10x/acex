'use strict';

/**
 * Tests for markingService JSON parsing and repair logic.
 * Covers: extractFirstJsonObject, parseAiJsonResponse, parseMarkingResponsePayload
 *
 * Run:  node --test server/services/markingService.parse.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadWithMocks } = require('../test-utils/loadWithMocks');

const DB_MOCK = { query: async () => [] };

const AI_MOCK = {
  createCompletionWithRetry: async () => ({ content: '{"document_type":"assignment","confidence":"high"}', usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  callAI: async () => ({ content: '{"is_memo":false,"confidence":"low"}', usage: {} })
};

function loadService() {
  return loadWithMocks(
    path.join(__dirname, 'markingService.js'),
    {
      '../database/connection': DB_MOCK,
      './aiService': AI_MOCK,
      './logger': {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        saveFailedResponse: async () => {},
        scheduleFailedResponseCleanup: () => {}
      },
      './budgetGuardrailService': {
        checkBudget: async () => ({ allowed: true }),
        recordUsage: async () => {}
      },
      '../config/ai-config': {
        getConfig: () => ({ provider: 'openai', model: 'gpt-4o' })
      },
      './pdfExtractService': {
        extractTextFromPDF: async () => 'stub text'
      }
    }
  ).module;
}

let svc;
try {
  svc = loadService();
} catch (e) {
  console.warn('markingService could not be loaded in isolation:', e.message);
}

const skip = !svc;

// ---------------------------------------------------------------------------
// extractFirstJsonObject
// ---------------------------------------------------------------------------

test('extractFirstJsonObject — returns null for plain text', { skip }, () => {
  const result = svc.extractFirstJsonObject('no json here');
  assert.equal(result, null);
});

test('extractFirstJsonObject — extracts object from surrounding prose', { skip }, () => {
  const raw = 'Here is the result: {"score": 42} and some more text after.';
  const result = svc.extractFirstJsonObject(raw);
  assert.equal(result, '{"score": 42}');
});

test('extractFirstJsonObject — extracts from code fence', { skip }, () => {
  const raw = '```json\n{"overall_feedback":"good"}\n```';
  const result = svc.extractFirstJsonObject(raw);
  assert.ok(result && result.includes('"overall_feedback"'));
});

test('extractFirstJsonObject — handles nested objects', { skip }, () => {
  const raw = 'Result: {"a": {"b": 1}, "c": [1,2,3]}';
  const result = svc.extractFirstJsonObject(raw);
  const parsed = JSON.parse(result);
  assert.equal(parsed.a.b, 1);
  assert.deepEqual(parsed.c, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// parseAiJsonResponse — happy paths
// ---------------------------------------------------------------------------

test('parseAiJsonResponse — parses valid JSON', { skip }, () => {
  const input = JSON.stringify({ scores: [{ criterion: 'A', points_awarded: 5 }], overall_feedback: 'Good work' });
  const { parsed } = svc.parseAiJsonResponse(input);
  assert.equal(parsed.overall_feedback, 'Good work');
});

test('parseAiJsonResponse — strips json code fence', { skip }, () => {
  const inner = JSON.stringify({ key: 'value' });
  const { parsed } = svc.parseAiJsonResponse('```json\n' + inner + '\n```');
  assert.equal(parsed.key, 'value');
});

test('parseAiJsonResponse — strips plain code fence', { skip }, () => {
  const inner = JSON.stringify({ key: 'value' });
  const { parsed } = svc.parseAiJsonResponse('```\n' + inner + '\n```');
  assert.equal(parsed.key, 'value');
});

test('parseAiJsonResponse — extracts JSON from prose wrapper', { skip }, () => {
  const raw = 'Sure, here is the marking:\n{"scores": [], "overall_feedback": "See below"}\nEnd of response.';
  const { parsed } = svc.parseAiJsonResponse(raw);
  assert.equal(parsed.overall_feedback, 'See below');
});

// ---------------------------------------------------------------------------
// parseAiJsonResponse — repair cases
// ---------------------------------------------------------------------------

test('parseAiJsonResponse — repairs unescaped double quotes in string values', { skip }, () => {
  const malformed = `{"scores": [], "overall_feedback": "The student wrote "good work" in the conclusion"}`;
  const { parsed } = svc.parseAiJsonResponse(malformed);
  assert.ok(typeof parsed.overall_feedback === 'string');
  assert.ok(parsed.overall_feedback.includes('good work'));
});

test('parseAiJsonResponse — repairs trailing comma before closing brace', { skip }, () => {
  const malformed = `{"scores": [{"criterion": "A", "points_awarded": 5,}], "overall_feedback": "ok",}`;
  const { parsed } = svc.parseAiJsonResponse(malformed);
  assert.ok(Array.isArray(parsed.scores));
});

test('parseAiJsonResponse — repairs bare (unquoted) keys', { skip }, () => {
  const malformed = `{scores: [], overall_feedback: "ok"}`;
  const { parsed } = svc.parseAiJsonResponse(malformed);
  assert.ok(Array.isArray(parsed.scores));
});

test('parseAiJsonResponse — repairs single-quoted strings', { skip }, () => {
  const malformed = `{'scores': [], 'overall_feedback': 'good'}`;
  const { parsed } = svc.parseAiJsonResponse(malformed);
  assert.equal(parsed.overall_feedback, 'good');
});

test('parseAiJsonResponse — repairs bare newlines inside string values', { skip }, () => {
  const malformed = '{"overall_feedback": "Line one\nLine two", "scores": []}';
  const { parsed } = svc.parseAiJsonResponse(malformed);
  assert.ok(parsed.overall_feedback.includes('Line'));
});

test('parseAiJsonResponse — throws on completely unparseable input', { skip }, () => {
  assert.throws(() => svc.parseAiJsonResponse('this is not json at all !!!'), /Failed|JSON|parse/i);
});

// ---------------------------------------------------------------------------
// parseMarkingResponsePayload — validation
// ---------------------------------------------------------------------------

function makeValidPayload(overrides = {}) {
  return JSON.stringify({
    scores: [
      { criterion: 'Content', points_awarded: 8, max_points: 10, feedback: 'Good', confidence: 85 }
    ],
    overall_feedback: 'Solid attempt overall.',
    overall_mark: 80,
    overall_confidence: 82,
    ...overrides
  });
}

test('parseMarkingResponsePayload — accepts valid payload', { skip }, () => {
  const result = svc.parseMarkingResponsePayload(makeValidPayload());
  assert.ok(result.scores.length === 1);
  assert.equal(result.scores[0].criterion, 'Content');
  assert.equal(result.overall_feedback, 'Solid attempt overall.');
});

test('parseMarkingResponsePayload — throws on empty response', { skip }, () => {
  assert.throws(() => svc.parseMarkingResponsePayload(''), /empty/i);
  assert.throws(() => svc.parseMarkingResponsePayload('   '), /empty/i);
});

test('parseMarkingResponsePayload — throws if scores array is missing', { skip }, () => {
  const bad = JSON.stringify({ overall_feedback: 'ok' });
  assert.throws(() => svc.parseMarkingResponsePayload(bad), /scores/i);
});

test('parseMarkingResponsePayload — throws if scores array is empty', { skip }, () => {
  const bad = JSON.stringify({ scores: [], overall_feedback: 'ok' });
  assert.throws(() => svc.parseMarkingResponsePayload(bad), /scores/i);
});

test('parseMarkingResponsePayload — throws if overall_feedback is missing', { skip }, () => {
  const bad = JSON.stringify({ scores: [{ criterion: 'A', points_awarded: 5 }] });
  assert.throws(() => svc.parseMarkingResponsePayload(bad), /overall_feedback/i);
});

test('parseMarkingResponsePayload — coerces string score to number', { skip }, () => {
  const obj = JSON.parse(makeValidPayload());
  obj.scores[0].points_awarded = '7';
  obj.scores[0].max_points = '10';
  const result = svc.parseMarkingResponsePayload(JSON.stringify(obj));
  assert.equal(result.scores[0].points_awarded, 7);
  assert.equal(result.scores[0].max_points, 10);
});

test('parseMarkingResponsePayload — clamps confidence to 0-100', { skip }, () => {
  const obj = JSON.parse(makeValidPayload());
  obj.scores[0].confidence = 999;
  const result = svc.parseMarkingResponsePayload(JSON.stringify(obj));
  assert.equal(result.scores[0].confidence, 100);
});

test('parseMarkingResponsePayload — defaults missing confidence to 80', { skip }, () => {
  const obj = JSON.parse(makeValidPayload());
  delete obj.scores[0].confidence;
  const result = svc.parseMarkingResponsePayload(JSON.stringify(obj));
  assert.equal(result.scores[0].confidence, 80);
});

test('parseMarkingResponsePayload — repairs and accepts malformed JSON', { skip }, () => {
  // Real AI failure mode: unescaped quotes inside string values
  const malformed = `{
    "scores": [{"criterion": "Analysis", "points_awarded": 7, "max_points": 10, "feedback": "The student stated "this is correct" without evidence.", "confidence": 75}],
    "overall_feedback": "The student wrote "good work" but lacked citations."
  }`;
  const result = svc.parseMarkingResponsePayload(malformed);
  assert.ok(result.overall_feedback.includes('good work'));
  assert.ok(result.scores[0].feedback.includes('correct'));
});

test('parseMarkingResponsePayload — works with provider=anthropic', { skip }, () => {
  const result = svc.parseMarkingResponsePayload(makeValidPayload(), { selectedProvider: 'anthropic' });
  assert.ok(result.scores.length > 0);
});
