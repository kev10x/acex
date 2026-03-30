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

function createAuthMocks() {
  return {
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    generateToken: () => 'test-token',
    normalizeRole: (role) => role || 'lecturer'
  };
}

function withEnv(overrides, run) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

test('POST /auth/register hides verificationUrl in production when email sends successfully', async (t) => {
  const responses = [
    [],
    { insertId: 42 },
    [{
      id: 42,
      email: 'lecturer@example.com',
      name: 'Lecturer',
      account_type: 'individual',
      organisation_name: null,
      organisation_id: null
    }]
  ];

  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'auth.js'), {
    '../database/connection': {
      query: async () => responses.shift()
    },
    '../middleware/auth': createAuthMocks(),
    '../services/emailService': {
      sendVerificationEmail: async () => ({ success: true, messageId: 'sent' })
    }
  });
  t.after(restore);

  await withEnv(
    {
      NODE_ENV: 'production',
      CLIENT_URL: 'https://markmate.example'
    },
    async () => {
      const response = await request(createApp(router))
        .post('/auth/register')
        .send({
          email: 'lecturer@example.com',
          password: 'strong-password',
          name: 'Lecturer'
        });

      assert.equal(response.status, 201);
      assert.equal(response.body.requiresVerification, true);
      assert.equal(response.body.user.email_verified, false);
      assert.equal(response.body.verificationUrl, undefined);
    }
  );
});

test('POST /auth/register exposes verificationUrl in production when email delivery is unavailable', async (t) => {
  const responses = [
    [],
    { insertId: 84 },
    [{
      id: 84,
      email: 'fallback@example.com',
      name: 'Fallback User',
      account_type: 'individual',
      organisation_name: null,
      organisation_id: null
    }]
  ];

  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'auth.js'), {
    '../database/connection': {
      query: async () => responses.shift()
    },
    '../middleware/auth': createAuthMocks(),
    '../services/emailService': {
      sendVerificationEmail: async () => ({ success: false, messageId: null })
    }
  });
  t.after(restore);

  await withEnv(
    {
      NODE_ENV: 'production',
      CLIENT_URL: 'https://markmate.example'
    },
    async () => {
      const response = await request(createApp(router))
        .post('/auth/register')
        .send({
          email: 'fallback@example.com',
          password: 'strong-password',
          name: 'Fallback User'
        });

      assert.equal(response.status, 201);
      assert.equal(response.body.requiresVerification, true);
      assert.match(
        response.body.verificationUrl,
        /^https:\/\/markmate\.example\/verify-email\?token=/
      );
    }
  );
});
