'use strict';

/**
 * Management is limited to their own organisation's courses; the super admin covers all.
 *
 * Run:  node --test server/routes/courses.organisation-scope.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { loadWithMocks } = require('../test-utils/loadWithMocks');

const USERS = {
  1: { id: 1, role: 'management', name: 'Org A manager', organisation_id: 5 },
  2: { id: 2, role: 'management', name: 'Org B manager', organisation_id: 9 },
  3: { id: 3, role: 'management', name: 'Super admin', organisation_id: 9, is_super_admin: true },
  4: { id: 4, role: 'lecturer', name: 'Org A lecturer', organisation_id: 5 }
};
const COURSES = [
  { id: 30, name: 'Org A course', organisation_id: 5, owner_user_id: 4, created_at: '2026-11-02' },
  { id: 31, name: 'Org B course', organisation_id: 9, owner_user_id: 2, created_at: '2026-11-01' }
];

const ORGANISATIONS = [{ id: 5, name: 'Org A' }, { id: 9, name: 'Org B' }];

function setup() {
  const query = async (sql, params = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT c.id, c.owner_user_id, c.organisation_id, u.organisation_id AS owner_organisation_id')) {
      return COURSES.filter((c) => c.id === params[0]).map((c) => ({ ...c, owner_organisation_id: USERS[c.owner_user_id].organisation_id }));
    }
    if (q.startsWith('SELECT * FROM courses WHERE id')) return COURSES.filter((c) => c.id === params[0]);
    if (q === 'SELECT * FROM courses ORDER BY created_at DESC') return COURSES;
    if (q.startsWith('SELECT DISTINCT c.* FROM courses c LEFT JOIN users owner')) {
      return COURSES.filter((c) => c.organisation_id === params[0] || USERS[c.owner_user_id].organisation_id === params[1] || c.owner_user_id === params[2]);
    }
    if (q.startsWith('SELECT id FROM course_staff')) return [];
    if (q.startsWith('SELECT id FROM course_enrollments')) return [];
    if (q.startsWith('SELECT cs.user_id')) return [];
    if (q.startsWith('SELECT COUNT(*) as count FROM course_enrollments')) return [{ count: 0 }];
    if (q.includes('FROM modules')) return [];
    if (q.startsWith('DELETE FROM courses')) return {};
    if (q.startsWith('SELECT id, name FROM organisations')) return ORGANISATIONS;
    if (q.startsWith('SELECT id FROM organisations WHERE id')) return ORGANISATIONS.filter((o) => o.id === params[0]);
    if (q.startsWith('INSERT INTO courses')) {
      const id = 100 + COURSES.length;
      COURSES.push({ id, organisation_id: params[0], name: params[1], owner_user_id: params[7], created_at: '2026-11-24' });
      return [{ id }];
    }
    if (q.startsWith('UPDATE courses SET organisation_id')) {
      COURSES.find((c) => c.id === params[1]).organisation_id = params[0];
      return {};
    }
    return [];
  };
  for (const service of ['courseScopeService']) {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'services', `${service}.js`))];
  }
  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'courses.js'), {
    '../database/connection': { query },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => { req.user = USERS[Number(req.get('x-test-user'))]; next(); },
      requireRoles: () => (_req, _res, next) => next()
    },
    '../services/emailService': {},
    '../services/accountSetupService': {},
    '../services/gradebookService': { buildGradebook: async () => ({ rows: [] }) },
    '../services/enrollmentService': {}
  });
  const app = express();
  app.use(express.json());
  app.use('/courses', router);
  const as = (userId, method, url) => request(app)[method](url).set('x-test-user', String(userId));
  return { as, restore };
}

test('management sees and opens only their own organisation\'s courses', async (t) => {
  const { as, restore } = setup();
  t.after(restore);
  const list = await as(1, 'get', '/courses');
  assert.deepEqual(list.body.courses.map((c) => c.name), ['Org A course']);
  assert.equal((await as(1, 'get', '/courses/30')).status, 200);
  assert.equal((await as(1, 'get', '/courses/31')).status, 403, 'another organisation\'s course');
  assert.equal((await as(1, 'get', '/courses/31/gradebook')).status, 403, 'another organisation\'s gradebook');
  assert.equal((await as(1, 'delete', '/courses/31')).status, 403);
  assert.equal((await as(1, 'put', '/courses/31').send({ name: 'x' })).status, 403);
});

test('the super admin covers every organisation', async (t) => {
  const { as, restore } = setup();
  t.after(restore);
  const list = await as(3, 'get', '/courses');
  assert.deepEqual(list.body.courses.map((c) => c.name), ['Org A course', 'Org B course']);
  assert.equal((await as(3, 'get', '/courses/30')).status, 200);
  assert.equal((await as(3, 'get', '/courses/31')).status, 200);
});

test('the super admin chooses and changes a course\'s organisation; nobody else can', async (t) => {
  const { as, restore } = setup();
  const original = COURSES.map((c) => ({ ...c }));
  t.after(() => { COURSES.splice(0, COURSES.length, ...original); restore(); });

  assert.deepEqual((await as(3, 'get', '/courses/organisations')).body.organisations.map((o) => o.id), [5, 9]);
  assert.equal((await as(1, 'get', '/courses/organisations')).status, 403);

  // Created in the chosen organisation, not the super admin's own.
  const created = await as(3, 'post', '/courses').send({ name: 'New course', organisation_id: 5 });
  assert.equal(created.status, 200);
  assert.equal(COURSES.at(-1).organisation_id, 5);
  assert.equal((await as(3, 'post', '/courses').send({ name: 'Bad', organisation_id: 77 })).status, 400);
  // Everyone else's courses go to their own organisation, whatever they send.
  await as(1, 'post', '/courses').send({ name: 'Manager course', organisation_id: 9 });
  assert.equal(COURSES.at(-1).organisation_id, 5);

  const moved = await as(3, 'put', '/courses/31/organisation').send({ organisation_id: 5 });
  assert.equal(moved.status, 200);
  assert.equal(COURSES.find((c) => c.id === 31).organisation_id, 5);
  assert.equal((await as(3, 'put', '/courses/31/organisation').send({ organisation_id: 77 })).status, 400);
  assert.equal((await as(3, 'put', '/courses/999/organisation').send({ organisation_id: 5 })).status, 404);
  assert.equal((await as(1, 'put', '/courses/30/organisation').send({ organisation_id: 9 })).status, 403);
});
