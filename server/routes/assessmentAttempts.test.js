'use strict';

/**
 * Tests for monitored assessment attempts and integrity reports.
 *
 * Run:  node --test server/routes/assessmentAttempts.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { loadWithMocks } = require('../test-utils/loadWithMocks');

const USERS = {
  1: { id: 1, role: 'student', name: 'Sam Student', email: 'sam@uni.test', organisation_id: 5 },
  2: { id: 2, role: 'lecturer', name: 'Owner Lecturer', email: 'owner@uni.test', organisation_id: 5 },
  3: { id: 3, role: 'lecturer', name: 'Other Lecturer', email: 'other@uni.test', organisation_id: 5 },
  4: { id: 4, role: 'management', name: 'Manager', email: 'boss@uni.test', organisation_id: 5 },
  5: { id: 5, role: 'management', name: 'Other Org Manager', email: 'x@other.test', organisation_id: 9 },
  6: { id: 6, role: 'student', name: 'Pat Student', email: 'pat@uni.test', organisation_id: 5 }
};

// Minimal in-memory stand-in for the SQL this router issues.
function createFakeDb({ settings }) {
  const db = {
    published: [{
      id: 10,
      code: 'EXAM1',
      user_id: 2,
      rubric_id: 1,
      batch_id: null,
      integrity_settings: settings ? JSON.stringify(settings) : null,
      assessment_json: JSON.stringify({
        title: 'Biology exam',
        questions: [
          { number: 1, question: 'Q one', correct_answer: 'A' },
          { number: 2, question: 'Q two', correct_answer: 'B' },
          { number: 3, question: 'Q three', correct_pairings: { 1: 'A' } }
        ]
      }),
      created_at: '2026-11-01',
      course_id: 30
    }, {
      id: 11,
      code: 'OPEN1',
      user_id: 2,
      rubric_id: 1,
      batch_id: null,
      integrity_settings: null,
      assessment_json: JSON.stringify({ title: 'Practice quiz', questions: [] }),
      created_at: '2026-11-02',
      course_id: 30
    }],
    courses: [
      { id: 30, name: 'Biology 101', code: 'BIO101', organisation_id: 5, owner_user_id: 2, integrity_policy: null },
      { id: 31, name: 'Other org course', code: 'X1', organisation_id: 9, owner_user_id: 5, integrity_policy: null }
    ],
    attempts: [],
    events: [],
    submissions: []
  };
  let nextId = 1;
  const withOwnerOrg = (pub) => pub && { ...pub, owner_organisation_id: USERS[pub.user_id]?.organisation_id };
  const attemptJoin = (a) => ({
    ...a,
    student_name: USERS[a.student_user_id]?.name,
    student_email: USERS[a.student_user_id]?.email,
    submission_code: db.submissions.find((s) => s.id === a.submission_id)?.submission_code || null
  });

  const query = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT id, code, assessment_json, rubric_id, batch_id, user_id, integrity_settings FROM published_assessments WHERE code')) {
      return db.published.filter((p) => p.code === params[0]);
    }
    if (q.includes('FROM published_assessments pa LEFT JOIN users u ON u.id = pa.user_id WHERE pa.id =')) {
      return [withOwnerOrg(db.published.find((p) => p.id === Number(params[0])))].filter(Boolean);
    }
    if (q.includes('FROM published_assessments pa LEFT JOIN users u ON u.id = pa.user_id WHERE')) {
      return db.published
        .filter((p) => p.user_id === params[0] || (params[1] != null && USERS[p.user_id].organisation_id === params[1]))
        .map((p) => ({ ...p, owner_name: USERS[p.user_id].name, owner_email: USERS[p.user_id].email }));
    }
    if (q.startsWith('SELECT * FROM assessment_attempts WHERE published_assessment_id')) {
      return db.attempts.filter((a) => a.published_assessment_id === params[0] && a.student_user_id === params[1]).slice(-1);
    }
    if (q.startsWith('SELECT * FROM assessment_attempts WHERE attempt_token')) {
      return db.attempts.filter((a) => a.attempt_token === params[0] && a.student_user_id === params[1]);
    }
    if (q.startsWith('INSERT INTO assessment_attempts')) {
      const [attempt_token, published_assessment_id, student_user_id, status, question_order, ip_addresses, user_agent, active_session_id] = params;
      const row = {
        id: nextId++, attempt_token, published_assessment_id, student_user_id, status, question_order, ip_addresses,
        user_agent, active_session_id, last_seen_at: new Date().toISOString(), started_at: new Date().toISOString(),
        draft_answers: null, integrity_score: 0, integrity_status: 'clean', integrity_summary: null, submission_id: null
      };
      db.attempts.push(row);
      return { insertId: row.id };
    }
    if (q.startsWith('INSERT INTO assessment_attempt_events')) {
      const [attempt_id, event_type, severity, question_number, duration_ms, details, ip_address, client_time] = params;
      db.events.push({ id: nextId++, attempt_id, event_type, severity, question_number, duration_ms, details, ip_address, client_time });
      return { insertId: nextId };
    }
    if (q.startsWith('SELECT id, event_type')) {
      return db.events.filter((e) => e.attempt_id === params[0]);
    }
    if (q.startsWith('UPDATE assessment_attempts SET ip_addresses')) {
      const id = params[params.length - 1];
      const attempt = db.attempts.find((a) => a.id === id);
      Object.assign(attempt, {
        ip_addresses: params[0], active_session_id: params[1], integrity_score: params[2],
        integrity_status: params[3], integrity_summary: params[4], last_seen_at: new Date().toISOString()
      });
      if (q.includes('draft_answers')) attempt.draft_answers = params[5];
      return {};
    }
    if (q.startsWith("UPDATE assessment_attempts SET status = 'submitted'")) {
      Object.assign(db.attempts.find((a) => a.id === params[1]), { status: 'submitted', submission_id: params[0] });
      return {};
    }
    if (q.startsWith("UPDATE assessment_attempts SET status = 'exited'")) {
      Object.assign(db.attempts.find((a) => a.id === params[0]), { status: 'exited' });
      return {};
    }
    if (q.startsWith("UPDATE assessment_attempts SET status = 'in_progress'")) {
      Object.assign(db.attempts.find((a) => a.id === params[0]), { status: 'in_progress' });
      return {};
    }
    if (q.startsWith('UPDATE published_assessments SET integrity_settings')) {
      db.published.find((p) => p.id === params[1]).integrity_settings = params[0];
      return {};
    }
    if (q.includes('FROM assessment_attempts aa') && q.includes('WHERE aa.published_assessment_id')) {
      return db.attempts.filter((a) => a.published_assessment_id === params[0]).map(attemptJoin);
    }
    if (q.includes('FROM assessment_attempts aa') && q.includes('WHERE aa.id')) {
      return db.attempts.filter((a) => a.id === params[0]).map(attemptJoin);
    }
    if (q.startsWith('SELECT published_assessment_id, status, integrity_status, COUNT(*)')) {
      return [];
    }
    if (q.startsWith('SELECT status, COUNT(*) AS n FROM assessment_attempts')) {
      const counts = {};
      db.attempts.filter((a) => a.published_assessment_id === params[0]).forEach((a) => { counts[a.status] = (counts[a.status] || 0) + 1; });
      return Object.entries(counts).map(([status, n]) => ({ status, n }));
    }
    if (q.startsWith('SELECT COUNT(*) AS n FROM assessment_submissions')) {
      return [{ n: db.submissions.length }];
    }
    if (q.startsWith('SELECT integrity_policy FROM courses')) {
      return db.courses.filter((c) => c.id === params[0]);
    }
    if (q.startsWith('SELECT name FROM courses')) {
      return db.courses.filter((c) => c.id === params[0]);
    }
    if (q.startsWith('SELECT c.id, c.name, c.organisation_id, c.integrity_policy')) {
      return db.courses.filter((c) => c.id === params[0]).map((c) => ({ ...c, owner_organisation_id: USERS[c.owner_user_id]?.organisation_id }));
    }
    if (q.startsWith('SELECT c.id, c.name, c.code, c.integrity_policy')) {
      return db.courses
        .filter((c) => c.organisation_id === params[0] || USERS[c.owner_user_id]?.organisation_id === params[1])
        .map((c) => ({
          ...c,
          assessment_count: db.published.filter((p) => p.course_id === c.id).length,
          unmonitored_count: db.published.filter((p) => p.course_id === c.id && !p.integrity_settings).length
        }));
    }
    if (q.startsWith('UPDATE courses SET integrity_policy')) {
      db.courses.find((c) => c.id === params[1]).integrity_policy = params[0];
      return {};
    }
    if (q.startsWith('SELECT id, integrity_settings FROM published_assessments WHERE course_id')) {
      return db.published.filter((p) => p.course_id === params[0]);
    }
    if (q.startsWith('UPDATE published_assessments SET integrity_settings') && q.includes('WHERE id')) {
      db.published.find((p) => p.id === params[1]).integrity_settings = params[0];
      return {};
    }
    if (q.startsWith('SELECT id, owner_user_id FROM courses')) {
      return db.courses.filter((c) => c.id === params[0]);
    }
    if (q.startsWith('SELECT id FROM course_staff')) {
      return [];
    }
    throw new Error(`Unexpected SQL in test: ${q}`);
  };
  return { db, query };
}

function setup({ settings = { enabled: true, preset: 'test' }, ip = '10.0.0.5' } = {}) {
  const fake = createFakeDb({ settings });
  const submissions = [];
  // Services that query the database must load fresh so they use this test's fake.
  for (const service of ['courseIntegrityPolicyService', 'courseScopeService']) {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'services', `${service}.js`))];
  }
  const { module: attemptsModule, restore } = loadWithMocks(path.join(__dirname, 'assessmentAttempts.js'), {
    '../database/connection': { query: fake.query },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        const user = USERS[Number(req.get('x-test-user'))];
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        req.user = user;
        return next();
      }
    }
  });
  const router = attemptsModule.createAttemptsRouter({
    createSubmission: async (args) => {
      submissions.push(args);
      fake.db.submissions.push({ id: 77, submission_code: 'SUB123' });
      return { id: 77, submission_code: 'SUB123', status: 'queued' };
    }
  });
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/attempts', router);
  const as = (userId, method, url) => request(app)[method](url).set('x-test-user', String(userId)).set('x-forwarded-for', ip);
  return { app, as, db: fake.db, submissions, restore };
}

test('start: questions only after opting in, without answer keys, shuffled with source index', async (t) => {
  const { as, db, restore } = setup();
  t.after(restore);

  const res = await as(1, 'post', '/attempts/start').send({ code: 'EXAM1', session_id: 'tab-a' });
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.require_fullscreen, true);
  const questions = res.body.assessment.questions;
  assert.equal(questions.length, 3);
  assert.ok(questions.every((q) => q.correct_answer === undefined && q.correct_pairings === undefined));
  assert.deepEqual(questions.map((q) => q.source_index).sort(), [0, 1, 2]);
  assert.equal(db.attempts.length, 1);
  assert.deepEqual(db.events.map((e) => e.event_type), ['attempt_started']);

  const unauthenticated = await as(99, 'post', '/attempts/start').send({ code: 'EXAM1' });
  assert.equal(unauthenticated.status, 401);
});

test('start: unmonitored assessment refused; outside allowed network refused', async (t) => {
  const open = setup({ settings: null });
  t.after(open.restore);
  assert.equal((await open.as(1, 'post', '/attempts/start').send({ code: 'EXAM1' })).status, 400);

  const venue = setup({ settings: { enabled: true, preset: 'exam', allowed_ip_ranges: ['196.21.0.0/16'] }, ip: '41.1.2.3' });
  t.after(venue.restore);
  const res = await venue.as(1, 'post', '/attempts/start').send({ code: 'EXAM1' });
  assert.equal(res.status, 403);
  assert.equal(venue.db.attempts.length, 0);
});

test('events: severity from the server, draft saved, a still-running old tab is flagged after a takeover', async (t) => {
  const { as, db, restore } = setup();
  t.after(restore);
  const start = await as(1, 'post', '/attempts/start').send({ code: 'EXAM1', session_id: 'tab-a' });
  const token = start.body.attempt.token;

  const res = await as(1, 'post', `/attempts/session/${token}/events`).send({
    session_id: 'tab-a',
    events: [
      { type: 'focus_lost', duration_ms: 700, client_time: 1000, severity: 'flag' },
      { type: 'paste', chars: 450, question_number: 2, client_time: 2000, text: 'never stored' },
      { type: 'not_a_real_event' }
    ],
    answers: { 1: 'my answer', bogus: 'x' }
  });
  assert.equal(res.status, 200);
  const stored = db.events.filter((e) => e.event_type !== 'attempt_started');
  assert.deepEqual(stored.map((e) => [e.event_type, e.severity]), [['focus_lost', 'info'], ['paste', 'notice']]);
  assert.ok(!JSON.stringify(stored).includes('never stored'));
  assert.deepEqual(JSON.parse(db.attempts[0].draft_answers), { 1: 'my answer' });

  // Reopening on another device takes over without a flag (e.g. after a crash)...
  await as(1, 'post', '/attempts/start').send({ code: 'EXAM1', session_id: 'tab-b' });
  assert.ok(!db.events.some((e) => e.event_type === 'duplicate_session'));
  // ...but the first tab is still alive and sends another heartbeat: that is flagged.
  await as(1, 'post', `/attempts/session/${token}/events`).send({ session_id: 'tab-a', events: [] });
  assert.ok(db.events.some((e) => e.event_type === 'duplicate_session' && e.severity === 'flag'));
  assert.equal(db.attempts[0].integrity_status, 'review_needed', 'large paste (3) + second live session (5)');
});

test('submit: creates the submission, ends the attempt, and blocks a second attempt', async (t) => {
  const { as, db, submissions, restore } = setup();
  t.after(restore);
  const token = (await as(1, 'post', '/attempts/start').send({ code: 'EXAM1', session_id: 'tab-a' })).body.attempt.token;

  const res = await as(1, 'post', `/attempts/session/${token}/submit`).send({
    session_id: 'tab-a',
    answers: [{ question_number: 1, value: 'A' }]
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.submission.submission_code, 'SUB123');
  assert.equal(submissions[0].studentName, 'Sam Student');
  assert.equal(submissions[0].studentUserId, 1);
  assert.equal(db.attempts[0].status, 'submitted');

  assert.equal((await as(1, 'post', `/attempts/session/${token}/events`).send({ events: [] })).status, 409);
  const again = await as(1, 'post', '/attempts/start').send({ code: 'EXAM1' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already submitted/);

  // Another student cannot use this token.
  assert.equal((await as(6, 'post', `/attempts/session/${token}/exit`).send({})).status, 404);
});

test('reports: owner and same-organisation management only; exit and reopen', async (t) => {
  const { as, db, restore } = setup();
  t.after(restore);
  const token = (await as(1, 'post', '/attempts/start').send({ code: 'EXAM1', session_id: 'tab-a' })).body.attempt.token;
  await as(6, 'post', '/attempts/start').send({ code: 'EXAM1', session_id: 'tab-p' });
  assert.equal((await as(1, 'post', `/attempts/session/${token}/exit`).send({ session_id: 'tab-a' })).status, 200);
  assert.equal(db.attempts[0].status, 'exited');

  assert.equal((await as(1, 'get', '/attempts/assessment/10')).status, 403, 'students cannot read reports');
  assert.equal((await as(3, 'get', '/attempts/assessment/10')).status, 404, 'other lecturers cannot');
  assert.equal((await as(5, 'get', '/attempts/assessment/10')).status, 404, 'management from another organisation cannot');

  const report = await as(4, 'get', '/attempts/assessment/10');
  assert.equal(report.status, 200);
  assert.equal(report.body.attempts.length, 2);
  const sam = report.body.attempts.find((a) => a.student_name === 'Sam Student');
  assert.equal(sam.status, 'exited');
  assert.deepEqual(sam.shared_ip_with, ['Pat Student'], 'same public IP is noted');

  const detail = await as(2, 'get', `/attempts/attempt/${db.attempts[0].id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.events.some((e) => e.type === 'exited'));

  const csv = await as(2, 'get', '/attempts/assessment/10/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^Student,Email,Status/);
  assert.match(csv.text, /Sam Student/);

  assert.equal((await as(2, 'post', `/attempts/attempt/${db.attempts[1].id}/reopen`)).status, 409, 'in-progress attempts cannot be reopened');
  assert.equal((await as(2, 'post', `/attempts/attempt/${db.attempts[0].id}/reopen`)).status, 200);
  assert.equal(db.attempts[0].status, 'in_progress');

  const list = await as(4, 'get', '/attempts/monitored');
  assert.equal(list.status, 200);
  assert.equal(list.body.items[0].owner_name, 'Owner Lecturer');
});

test('settings: owner can switch monitoring off and on', async (t) => {
  const { as, db, restore } = setup();
  t.after(restore);
  const off = await as(2, 'put', '/attempts/assessment/10/settings').send({ settings: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(db.published[0].integrity_settings, null);
  const on = await as(2, 'put', '/attempts/assessment/10/settings').send({ settings: { enabled: true, preset: 'exam' } });
  assert.equal(on.body.settings.copy_paste, 'block');
  assert.equal((await as(3, 'put', '/attempts/assessment/10/settings').send({ settings: { enabled: false } })).status, 404);
});

test('preview: staff see the student view without answer keys, and nothing is recorded', async (t) => {
  const { as, db, restore } = setup();
  t.after(restore);
  const res = await as(2, 'get', '/attempts/preview/EXAM1');
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.preset, 'test');
  assert.equal(res.body.assessment.questions.length, 3);
  assert.ok(res.body.assessment.questions.every((q) => q.correct_answer === undefined && q.correct_pairings === undefined));
  assert.equal(db.attempts.length, 0);
  assert.equal(db.events.length, 0);

  assert.equal((await as(4, 'get', '/attempts/preview/EXAM1')).status, 200, 'same-organisation management');
  assert.equal((await as(3, 'get', '/attempts/preview/EXAM1')).status, 404, 'other lecturers');
  assert.equal((await as(1, 'get', '/attempts/preview/EXAM1')).status, 403, 'students');
  assert.equal((await as(2, 'get', '/attempts/presets')).body.presets.exam.copy_paste, 'block');
});

test('settings: saving reports what changed for students', async (t) => {
  const { as, restore } = setup();
  t.after(restore);
  await as(1, 'post', '/attempts/start').send({ code: 'EXAM1', session_id: 'tab-a' });
  const res = await as(2, 'put', '/attempts/assessment/10/settings').send({ settings: { enabled: true, preset: 'quiz' } });
  assert.deepEqual(res.body.impact, { was_monitored: true, now_monitored: true, in_progress_attempts: 1, submissions: 0 });
});

test('course rules: management sets a required rule, existing assessments follow, monitoring cannot be switched off', async (t) => {
  const { as, db, restore } = setup();
  t.after(restore);

  assert.equal((await as(2, 'get', '/attempts/course-rules')).status, 403, 'lecturers cannot manage course rules');
  const list = await as(4, 'get', '/attempts/course-rules');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.courses.map((c) => c.name), ['Biology 101'], 'only courses in the manager\'s organisation');
  assert.equal(list.body.courses[0].unmonitored_count, 1);

  assert.equal((await as(5, 'put', '/attempts/course-rules/30').send({ settings: { enabled: true, preset: 'exam' }, required: true })).status, 404);
  const saved = await as(4, 'put', '/attempts/course-rules/30').send({ settings: { enabled: true, preset: 'exam' }, required: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.applied_to_existing, 1, 'required rule applies to the unmonitored assessment');
  assert.equal(JSON.parse(db.published[1].integrity_settings).preset, 'exam');

  const off = await as(2, 'put', '/attempts/assessment/10/settings').send({ settings: { enabled: false } });
  assert.equal(off.status, 409);
  assert.match(off.body.error, /required for assessments in "Biology 101"/);
  const stricter = await as(2, 'put', '/attempts/assessment/10/settings').send({ settings: { enabled: true, preset: 'quiz' } });
  assert.equal(stricter.status, 200, 'lecturers can still pick another preset');

  const rule = await as(2, 'get', '/attempts/course-rules/30');
  assert.equal(rule.body.policy.required, true);

  const removed = await as(4, 'put', '/attempts/course-rules/30').send({ settings: { enabled: false } });
  assert.equal(removed.body.policy, null);
  assert.equal(db.courses[0].integrity_policy, null);
});
