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
