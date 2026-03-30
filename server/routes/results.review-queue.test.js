const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { loadWithMocks } = require('../test-utils/loadWithMocks');

function createApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/results', router);
  return app;
}

test('GET /results/review-queue returns only queued items and summarizes review reasons', async (t) => {
  const mockRows = [
    {
      id: 1,
      assignment_id: 100,
      student_name: 'Flagged Student',
      scores: '[]',
      corrections: '[]',
      language_errors: '[]',
      feedback: 'Needs lecturer review',
      total_score: 55,
      flagged_for_moderation: 1,
      moderation_reason: 'Borderline script',
      custom_feedback: null,
      override_total_score: null,
      needs_review: 0,
      has_low_criterion_confidence: 0,
      review_status: 'queued'
    },
    {
      id: 2,
      assignment_id: 101,
      student_name: 'AI Review',
      scores: '[]',
      corrections: '[]',
      language_errors: '[]',
      feedback: 'Low confidence overall',
      total_score: 61,
      flagged_for_moderation: 0,
      moderation_reason: null,
      custom_feedback: null,
      override_total_score: null,
      needs_review: 1,
      has_low_criterion_confidence: 0,
      review_status: 'queued'
    },
    {
      id: 3,
      assignment_id: 102,
      student_name: 'Criterion Review',
      scores: '[]',
      corrections: '[]',
      language_errors: '[]',
      feedback: 'One criterion needs attention',
      total_score: 72,
      flagged_for_moderation: 0,
      moderation_reason: null,
      custom_feedback: null,
      override_total_score: null,
      needs_review: 0,
      has_low_criterion_confidence: 1,
      review_status: 'queued'
    },
    {
      id: 4,
      assignment_id: 103,
      student_name: 'Reviewed Student',
      scores: '[]',
      corrections: '[]',
      language_errors: '[]',
      feedback: 'Original feedback',
      total_score: 79,
      flagged_for_moderation: 0,
      moderation_reason: 'Adjusted after moderation',
      custom_feedback: 'Lecturer reviewed this.',
      override_total_score: 81,
      needs_review: 0,
      has_low_criterion_confidence: 0,
      review_status: 'reviewed'
    },
    {
      id: 5,
      assignment_id: 104,
      student_name: 'No Review Needed',
      scores: '[]',
      corrections: '[]',
      language_errors: '[]',
      feedback: 'All good',
      total_score: 88,
      flagged_for_moderation: 0,
      moderation_reason: null,
      custom_feedback: null,
      override_total_score: null,
      needs_review: 0,
      has_low_criterion_confidence: 0,
      review_status: 'none'
    }
  ];

  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'results.js'), {
    '../database/connection': {
      query: async () => mockRows
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { id: 7, role: 'lecturer' };
        next();
      },
      requireRoles: () => (_req, _res, next) => next(),
      requireFeature: () => (_req, _res, next) => next()
    },
    '../services/feedbackVideoService': {}
  });
  t.after(restore);

  const response = await request(createApp(router)).get('/results/review-queue');

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.deepEqual(response.body.summary, {
    totalQueued: 3,
    flagged: 1,
    aiSuggested: 1,
    lowConfidence: 1,
    reviewed: 1
  });
  assert.equal(response.body.results.length, 3);
  assert.ok(response.body.results.every((item) => item.review_status === 'queued'));
  assert.deepEqual(response.body.results[0].review_reasons, ['moderation_flag', 'lecturer_note']);
});
