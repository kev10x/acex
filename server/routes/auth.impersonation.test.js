const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { loadWithMocks } = require('../test-utils/loadWithMocks');

function createApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/auth', router);
  return app;
}

function createMiddlewareMocks(adminUser) {
  return {
    requireAuth: (req, _res, next) => {
      req.user = { ...adminUser };
      next();
    },
    requireAdmin: (_req, _res, next) => next(),
    generateToken: (userId, extras = {}) => `token-${userId}-${extras.impersonatedBy || 'none'}`,
    normalizeRole: (role) => {
      const value = String(role || '').toLowerCase();
      if (value === 'admin') return 'management';
      if (value === 'user') return 'lecturer';
      return value || 'lecturer';
    },
    parseUserFeatures: () => ({}),
    mergeFeatures: () => ({}),
    normalizeFeatureSet: (features) => features || {},
  };
}

test('POST /auth/admin/users/:id/impersonate returns impersonation token for eligible user', async (t) => {
  const adminUser = {
    id: 7,
    email: 'manager@example.com',
    name: 'Manager',
    role: 'management',
    organisation_id: 10,
    department_id: 3,
  };
  const queries = [];
  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'auth.js'), {
    '../database/connection': {
      query: async (sql, params = []) => {
        queries.push({ sql: String(sql), params });
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized.includes('select id, role, organisation_id, department_id from users where id = $1')) {
          return { rows: [{ id: 22, role: 'lecturer', organisation_id: 10, department_id: 5 }] };
        }
        if (normalized.includes('select u.id, u.email, u.name, u.is_active, u.role, u.is_approved')) {
          return {
            rows: [{
              id: 22,
              email: 'lecturer@example.com',
              name: 'Lecturer Demo',
              is_active: true,
              role: 'lecturer',
              is_approved: true,
              account_type: 'individual',
              organisation_name: 'Org A',
              organisation_id: 10,
              department_id: 5,
              department_name: 'Science',
              user_features: null,
              organisation_features: null,
            }]
          };
        }
        return { rows: [] };
      },
    },
    '../middleware/auth': createMiddlewareMocks(adminUser),
    '../services/emailService': {
      sendVerificationEmail: async () => ({ success: true }),
    },
    '../services/auditEventService': {
      recordAuditEvent: async () => {},
      getRequestMetadata: (_req, extra = {}) => ({ ...extra }),
    },
  });
  t.after(restore);

  const response = await request(createApp(router))
    .post('/auth/admin/users/22/impersonate')
    .send({});

  assert.equal(response.status, 200);
  assert.equal(response.body?.success, true);
  assert.equal(response.body?.token, 'token-22-7');
  assert.equal(response.body?.user?.id, 22);
  assert.equal(response.body?.user?.impersonation?.active, true);
  assert.equal(response.body?.user?.impersonation?.impersonated_by, 7);
  assert.ok(queries.length >= 2);
});

test('POST /auth/admin/users/:id/impersonate blocks management target users', async (t) => {
  const adminUser = {
    id: 7,
    email: 'manager@example.com',
    name: 'Manager',
    role: 'management',
    organisation_id: 10,
    department_id: 3,
  };
  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'auth.js'), {
    '../database/connection': {
      query: async (sql) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized.includes('select id, role, organisation_id, department_id from users where id = $1')) {
          return { rows: [{ id: 2, role: 'management', organisation_id: 10, department_id: 1 }] };
        }
        return { rows: [] };
      },
    },
    '../middleware/auth': createMiddlewareMocks(adminUser),
    '../services/emailService': {
      sendVerificationEmail: async () => ({ success: true }),
    },
    '../services/auditEventService': {
      recordAuditEvent: async () => {},
      getRequestMetadata: (_req, extra = {}) => ({ ...extra }),
    },
  });
  t.after(restore);

  const response = await request(createApp(router))
    .post('/auth/admin/users/2/impersonate')
    .send({});

  assert.equal(response.status, 403);
  assert.equal(response.body?.error, 'Management users cannot be impersonated');
});

