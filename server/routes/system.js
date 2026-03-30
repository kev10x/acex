const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../database/connection');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function checkPath(targetPath) {
  const absolutePath = path.resolve(targetPath);
  const exists = fs.existsSync(absolutePath);
  let writable = false;
  if (exists) {
    try {
      fs.accessSync(absolutePath, fs.constants.W_OK);
      writable = true;
    } catch (_) {
      writable = false;
    }
  }
  return { path: absolutePath, exists, writable };
}

router.get('/health', requireAuth, requireAdmin, async (_req, res) => {
  const checks = {};
  const warnings = [];

  try {
    await query('SELECT 1 as ok');
    checks.database = { ok: true, engine: (process.env.DATABASE_URL || '').split(':')[0] || 'unknown' };
  } catch (error) {
    checks.database = { ok: false, message: error.message };
    warnings.push('Database connectivity check failed.');
  }

  const uploadDir = checkPath(process.env.UPLOAD_DIR || './uploads');
  checks.uploads = { ok: uploadDir.exists && uploadDir.writable, ...uploadDir };
  if (!checks.uploads.ok) warnings.push('Uploads directory is missing or not writable.');

  const feedbackDir = checkPath(path.join(process.env.UPLOAD_DIR || './uploads', 'feedback-videos'));
  checks.feedback_videos = { ok: feedbackDir.exists && feedbackDir.writable, ...feedbackDir };
  if (!checks.feedback_videos.ok) warnings.push('Feedback video directory is missing or not writable.');

  const trainingDir = checkPath('./training_data');
  checks.training_exports = { ok: trainingDir.exists && trainingDir.writable, ...trainingDir };
  if (!checks.training_exports.ok) warnings.push('Training export directory is missing or not writable.');

  const jwtConfigured = !!process.env.JWT_SECRET && process.env.JWT_SECRET !== 'your-secret-key-change-in-production';
  checks.auth = { ok: jwtConfigured, jwt_configured: jwtConfigured };
  if (!jwtConfigured) warnings.push('JWT secret is missing or still using the default placeholder.');

  const emailMode = process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD
    ? 'gmail'
    : process.env.SMTP_HOST && process.env.SMTP_PORT
    ? 'smtp'
    : process.env.SMTP_SERVICE && process.env.SMTP_USER && process.env.SMTP_PASS
    ? 'smtp_service'
    : 'console';
  checks.email = { ok: emailMode !== 'console', mode: emailMode };
  if (emailMode === 'console') warnings.push('Email is not fully configured; verification emails will not be sent via SMTP.');

  const openaiConfigured = !!process.env.OPENAI_API_KEY;
  const anthropicConfigured = !!process.env.ANTHROPIC_API_KEY;
  checks.ai = {
    ok: openaiConfigured || anthropicConfigured,
    openai_configured: openaiConfigured,
    anthropic_configured: anthropicConfigured
  };
  if (!checks.ai.ok) warnings.push('No AI provider API keys are configured.');

  checks.routing = {
    ok: true,
    client_url: process.env.CLIENT_URL || null,
    base_path: process.env.BASE_PATH || null,
    api_public_base: process.env.API_PUBLIC_BASE || null
  };

  checks.environment = {
    ok: true,
    node_env: process.env.NODE_ENV || 'development',
    port: process.env.PORT || '3001'
  };

  const status = warnings.length === 0 ? 'healthy' : (checks.database.ok ? 'degraded' : 'unhealthy');
  res.json({ success: true, status, warnings, checks });
});

module.exports = router;
