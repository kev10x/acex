'use strict';

/**
 * Monitored assessments must not be reachable through the open take/submit routes.
 *
 * Run:  node --test server/routes/assessments.monitored.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { loadWithMocks } = require('../test-utils/loadWithMocks');

const PUB = {
  id: 10,
  code: 'EXAM1',
  rubric_id: 1,
  user_id: 2,
  integrity_settings: JSON.stringify({ enabled: true, preset: 'exam' }),
  assessment_json: JSON.stringify({
    title: 'Biology exam',
    instructions: 'Answer all questions',
    questions: [{ number: 1, question: 'Secret question', correct_answer: 'A' }]
  })
};

function setup() {
  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'assessments.js'), {
    '../database/connection': { query: async () => [PUB] },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => next(),
      optionalAuth: (req, _res, next) => next(),
      requireFeature: () => (_req, _res, next) => next(),
      requireRoles: () => (_req, _res, next) => next()
    }
  });
  const app = express();
  app.use(express.json());
  app.use('/assessments', router);
  return { app, restore };
}

test('take: monitored assessment returns details but no questions', async (t) => {
  const { app, restore } = setup();
  t.after(restore);
  const res = await request(app).get('/assessments/take/EXAM1');
  assert.equal(res.status, 200);
  assert.equal(res.body.monitored, true);
  assert.equal(res.body.integrity.copy_paste, 'block');
  assert.equal(res.body.assessment.question_count, 1);
  assert.deepEqual(res.body.assessment.questions, []);
  assert.ok(!JSON.stringify(res.body).includes('Secret question'));
});

test('submit and audio: monitored assessment cannot bypass the attempt', async (t) => {
  const { app, restore } = setup();
  t.after(restore);
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => { process.env.OPENAI_API_KEY = previousKey; });

  const submit = await request(app).post('/assessments/submit').send({ code: 'EXAM1', student_name: 'X', answers: [] });
  assert.equal(submit.status, 409);

  const audio = await request(app).get('/assessments/audio/EXAM1/0');
  assert.equal(audio.status, 403);
});

test('publish with replace_published_id updates the existing link in place', async (t) => {
  const calls = [];
  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'assessments.js'), {
    '../database/connection': {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT id, code FROM published_assessments')) {
          return params[0] === 10 && params[1] === 2 ? [{ id: 10, code: 'EXAM1' }] : [];
        }
        return [];
      }
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => { req.user = { id: 2, role: 'lecturer' }; next(); },
      optionalAuth: (req, _res, next) => next(),
      requireFeature: () => (_req, _res, next) => next(),
      requireRoles: () => (_req, _res, next) => next()
    }
  });
  t.after(restore);
  const app = express();
  app.use(express.json());
  app.use('/assessments', router);

  const assessment = { title: 'Biology exam', questions: [{ number: 1, question: 'New wording' }] };
  const res = await request(app).post('/assessments/publish').send({ assessment, rubric_id: 3, replace_published_id: 10 });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, true);
  assert.equal(res.body.code, 'EXAM1');
  const update = calls.find((c) => c.sql.startsWith('UPDATE published_assessments SET assessment_json'));
  assert.deepEqual(update.params, [JSON.stringify(assessment), 3, 10]);
  assert.ok(!calls.some((c) => c.sql.startsWith('INSERT INTO published_assessments')), 'no new copy');

  const missing = await request(app).post('/assessments/publish').send({ assessment, rubric_id: 3, replace_published_id: 99 });
  assert.equal(missing.status, 404, 'cannot update someone else\'s link');
});
