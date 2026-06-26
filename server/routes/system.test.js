const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const { loadWithMocks } = require('../test-utils/loadWithMocks');

function createApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/system', router);
  return app;
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

test('GET /system/health reports healthy when infrastructure checks pass', async (t) => {
  const uploadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acexen-health-'));
  fs.mkdirSync(path.join(uploadRoot, 'feedback-videos'), { recursive: true });
  fs.mkdirSync(path.resolve('training_data'), { recursive: true });
  t.after(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));

  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'system.js'), {
    '../database/connection': {
      query: async () => [{ ok: 1 }]
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { id: 1, role: 'management' };
        next();
      },
      requireAdmin: (_req, _res, next) => next()
    }
  });
  t.after(restore);

  await withEnv(
    {
      DATABASE_URL: 'mysql://user:pass@localhost:3306/acexen',
      UPLOAD_DIR: uploadRoot,
      JWT_SECRET: 'super-secret',
      GMAIL_USER: 'lecturer@example.com',
      GMAIL_APP_PASSWORD: 'app-password',
      OPENAI_API_KEY: 'sk-test',
      CLIENT_URL: 'https://acexen.example',
      NODE_ENV: 'production'
    },
    async () => {
      const response = await request(createApp(router)).get('/system/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'healthy');
      assert.deepEqual(response.body.warnings, []);
      assert.equal(response.body.checks.database.engine, 'mysql');
      assert.equal(response.body.checks.email.mode, 'gmail');
      assert.equal(response.body.checks.ai.ok, true);
    }
  );
});

test('GET /system/health reports unhealthy with warnings when critical checks fail', async (t) => {
  const missingUploadDir = path.join(os.tmpdir(), `acexen-missing-${Date.now()}`);

  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'system.js'), {
    '../database/connection': {
      query: async () => {
        throw new Error('db offline');
      }
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { id: 1, role: 'management' };
        next();
      },
      requireAdmin: (_req, _res, next) => next()
    }
  });
  t.after(restore);

  await withEnv(
    {
      DATABASE_URL: 'mysql://user:pass@localhost:3306/acexen',
      UPLOAD_DIR: missingUploadDir,
      JWT_SECRET: 'your-secret-key-change-in-production',
      GMAIL_USER: undefined,
      GMAIL_APP_PASSWORD: undefined,
      SMTP_HOST: undefined,
      SMTP_PORT: undefined,
      SMTP_SERVICE: undefined,
      SMTP_USER: undefined,
      SMTP_PASS: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined
    },
    async () => {
      const response = await request(createApp(router)).get('/system/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'unhealthy');
      assert.equal(response.body.checks.database.ok, false);
      assert.equal(response.body.checks.uploads.ok, false);
      assert.equal(response.body.checks.email.ok, false);
      assert.equal(response.body.checks.ai.ok, false);
      assert.ok(response.body.warnings.includes('Database connectivity check failed.'));
      assert.ok(response.body.warnings.includes('Uploads directory is missing or not writable.'));
      assert.ok(response.body.warnings.includes('JWT secret is missing or still using the default placeholder.'));
    }
  );
});
