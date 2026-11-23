'use strict';

/**
 * Tests for the marking order option on POST /mark/multiple.
 *
 * Run:  node --test server/routes/mark.marking-order.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { loadWithMocks } = require('../test-utils/loadWithMocks');

const RUBRIC = {
  id: 9,
  name: 'Memo',
  rubric_type: 'answer_key',
  total_points: 5,
  criteria: [{ name: 'Q1', max_points: 2 }, { name: 'Q2', max_points: 3 }]
};

const scriptResult = (total) => ({
  scores: [
    { criterion_name: 'Q1', points_awarded: 2, max_points: 2, feedback: 'ok', rubric_basis: 'b', confidence: 90 },
    { criterion_name: 'Q2', points_awarded: total - 2, max_points: 3, feedback: 'ok', rubric_basis: 'b', confidence: 90 }
  ],
  overall_feedback: 'Overall',
  total_score: total,
  overall_confidence: 90,
  confidence_level: 'high',
  needs_review: false,
  min_criterion_confidence: 90,
  has_low_criterion_confidence: false,
  corrections: [],
  language_errors: [],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  estimated_cost_usd: 0.001
});

function setup({ markByQuestion, generateMarking } = {}) {
  const calls = { inserts: [], items: [], statuses: [], markerArgs: null, generateMarking: 0 };
  const assignments = {
    1: { id: 1, filename: 'a.pdf', file_path: '/tmp/a.pdf', status: 'uploaded', extracted_text: 'Q1: x Q2: y' },
    2: { id: 2, filename: 'b.pdf', file_path: '/tmp/b.pdf', status: 'uploaded', extracted_text: 'Q1: x Q2: y' },
    3: { id: 3, filename: 'c.pdf', file_path: '/tmp/c.pdf', status: 'completed', extracted_text: 'done' }
  };
  let nextId = 100;

  const query = async (sql, params) => {
    if (sql.startsWith('SELECT * FROM rubrics')) return [RUBRIC];
    if (sql.startsWith('SELECT * FROM assignments')) return assignments[params[0]] ? [assignments[params[0]]] : [];
    if (sql.startsWith('SELECT COALESCE(MAX(version)')) return [{ max_version: 0 }];
    if (sql.startsWith('UPDATE assignments SET status')) {
      calls.statuses.push(params);
      return [];
    }
    if (sql.startsWith('INSERT INTO marking_results')) {
      calls.inserts.push({ sql, params });
      nextId += 1;
      return { lastID: nextId };
    }
    if (sql.startsWith('INSERT INTO marking_result_items')) {
      calls.items.push(params);
      return {};
    }
    return [];
  };

  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'mark.js'), {
    '../database/connection': { query },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { id: 7, role: 'lecturer' };
        next();
      }
    },
    '../services/pdfReportGenerator': class {
      async generateAssignmentReport() {
        return { fileName: 'r.pdf', filePath: '/tmp/r.pdf' };
      }
    },
    '../services/markingService': {
      generateMarking: async () => {
        calls.generateMarking += 1;
        return generateMarking ? generateMarking() : scriptResult(4);
      },
      parseMarkingResponsePayload: () => ({}),
      parseAiJsonResponse: () => ({}),
      detectMemo: async () => false
    },
    '../services/questionMarkingService': {
      createQuestionMarker: (options) => ({
        markByQuestion: async (args) => {
          calls.markerArgs = { options, args };
          return markByQuestion(args);
        }
      })
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/mark', router);
  return { app, calls, restore };
}

test('question order marks the batch with the question marker and stores per-question items', async (t) => {
  const { app, calls, restore } = setup({
    markByQuestion: async () => ({
      results: new Map([[1, {
        ...scriptResult(5),
        items: [
          { criterion_index: 0, criterion_name: 'Q1', answer_text: 'x', answer_found: true, points_awarded: 2, max_points: 2, feedback: 'ok', rubric_basis: 'b', confidence: 90 },
          { criterion_index: 1, criterion_name: 'Q2', answer_text: '', answer_found: false, points_awarded: 3, max_points: 3, feedback: 'ok', rubric_basis: 'b', confidence: 50 }
        ]
      }]]),
      errors: [{ assignment_id: 2, error: 'Marking Q2 failed' }],
      cancelled: false
    })
  });
  t.after(restore);

  const response = await request(app).post('/mark/multiple').send({
    assignment_ids: [1, 2, 3],
    rubric_id: 9,
    marking_order: 'question',
    output_type: 'report',
    strictness_level: 'moderate',
    feedback_type: 'critical'
  });

  assert.equal(response.status, 200);
  assert.equal(calls.generateMarking, 0, 'script-by-script marking is not used');
  assert.equal(calls.markerArgs.args.isMemo, true);
  assert.equal(calls.markerArgs.options.documentType, 'memo');
  assert.equal(calls.markerArgs.args.strictnessLevel, 'moderate');
  assert.deepEqual(calls.markerArgs.args.scripts.map((s) => s.assignment_id), [1, 2]);

  assert.equal(response.body.summary.successful, 1);
  assert.equal(response.body.summary.failed, 1);
  assert.deepEqual(response.body.failed_assignment_ids, [2]);
  assert.equal(response.body.skipped[0].assignment_id, 3);
  assert.equal(response.body.results[0].marking_order, 'question');
  assert.equal(response.body.results[0].items.length, 2);

  assert.equal(calls.inserts.length, 1);
  const insertParams = calls.inserts[0].params;
  assert.equal(insertParams[insertParams.length - 1], 'question');
  assert.equal(insertParams[18], 'standard', 'feedback type is standard in question order');

  assert.equal(calls.items.length, 2);
  assert.equal(calls.items[0][0], 101, 'items reference the saved result');
  assert.equal(calls.items[1][5], 0, 'missing answer stored as not found');

  // Marked script ends completed; the failed one goes back to uploaded for retry.
  assert.deepEqual(calls.statuses.filter(([, id]) => id === 1).map(([s]) => s), ['processing', 'completed']);
  assert.deepEqual(calls.statuses.filter(([, id]) => id === 2).map(([s]) => s), ['processing', 'uploaded']);
});

test('question order rejects mark-as-image', async (t) => {
  const { app, calls, restore } = setup({ markByQuestion: async () => { throw new Error('should not run'); } });
  t.after(restore);

  const response = await request(app).post('/mark/multiple').send({
    assignment_ids: [1],
    rubric_id: 9,
    marking_order: 'question',
    mark_as_image: true
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Mark as image/);
  assert.equal(calls.statuses.length, 0);
});

test('script order (default) still marks each script with generateMarking', async (t) => {
  const { app, calls, restore } = setup();
  t.after(restore);

  const response = await request(app).post('/mark/multiple').send({
    assignment_ids: [1, 2],
    rubric_id: 9,
    output_type: 'report'
  });

  assert.equal(response.status, 200);
  assert.equal(calls.generateMarking, 2);
  assert.equal(calls.markerArgs, null);
  assert.equal(response.body.summary.successful, 2);
  assert.equal(calls.inserts.length, 2);
  assert.ok(calls.inserts.every(({ params }) => params[params.length - 1] === 'script'));
  assert.equal(calls.items.length, 0);
  assert.ok(response.body.results.every((r) => r.comparative_insight), 'batch comparison still applied');
});
