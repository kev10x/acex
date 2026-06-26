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

// ── Token / cost usage analytics ─────────────────────────────────────────────
// GET /api/system/usage?days=30
// Returns aggregated token usage from marking_results for the admin dashboard.
router.get('/usage', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const orgId = req.user.organisation_id || null;
    const isSuperAdmin = (req.user.email || '').toLowerCase() === (process.env.SUPER_ADMIN_EMAIL || 'kkativu@gmail.com');

    // Per-day totals
    const dailyResult = await query(
      `SELECT
         DATE(mr.marked_at) AS day,
         SUM(COALESCE(mr.prompt_tokens, 0))     AS prompt_tokens,
         SUM(COALESCE(mr.completion_tokens, 0)) AS completion_tokens,
         COUNT(*)                                AS submissions,
         mr.provider
       FROM marking_results mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.marked_at >= NOW() - INTERVAL '${days} days'
         AND mr.is_current = true
         ${orgId && !isSuperAdmin ? 'AND u.organisation_id = $1' : ''}
       GROUP BY DATE(mr.marked_at), mr.provider
       ORDER BY day DESC`,
      orgId && !isSuperAdmin ? [orgId] : []
    );

    // Per-document-type breakdown
    const docTypeResult = await query(
      `SELECT
         COALESCE(a.document_type, 'unknown') AS doc_type,
         SUM(COALESCE(mr.prompt_tokens, 0))     AS prompt_tokens,
         SUM(COALESCE(mr.completion_tokens, 0)) AS completion_tokens,
         COUNT(*)                                AS submissions
       FROM marking_results mr
       JOIN users u ON u.id = mr.user_id
       LEFT JOIN assignments a ON a.id = mr.assignment_id
       WHERE mr.marked_at >= NOW() - INTERVAL '${days} days'
         AND mr.is_current = true
         ${orgId && !isSuperAdmin ? 'AND u.organisation_id = $1' : ''}
       GROUP BY COALESCE(a.document_type, 'unknown')
       ORDER BY submissions DESC`,
      orgId && !isSuperAdmin ? [orgId] : []
    );

    // Per-user top consumers
    const userResult = await query(
      `SELECT
         u.name, u.email,
         SUM(COALESCE(mr.prompt_tokens, 0))     AS prompt_tokens,
         SUM(COALESCE(mr.completion_tokens, 0)) AS completion_tokens,
         COUNT(*)                                AS submissions
       FROM marking_results mr
       JOIN users u ON u.id = mr.user_id
       WHERE mr.marked_at >= NOW() - INTERVAL '${days} days'
         AND mr.is_current = true
         ${orgId && !isSuperAdmin ? 'AND u.organisation_id = $1' : ''}
       GROUP BY u.id, u.name, u.email
       ORDER BY (prompt_tokens + completion_tokens) DESC
       LIMIT 10`,
      orgId && !isSuperAdmin ? [orgId] : []
    );

    const daily = dailyResult.rows || dailyResult || [];
    const byDocType = docTypeResult.rows || docTypeResult || [];
    const topUsers = userResult.rows || userResult || [];

    // Totals
    const totals = daily.reduce((acc, row) => ({
      prompt_tokens: acc.prompt_tokens + Number(row.prompt_tokens || 0),
      completion_tokens: acc.completion_tokens + Number(row.completion_tokens || 0),
      submissions: acc.submissions + Number(row.submissions || 0),
    }), { prompt_tokens: 0, completion_tokens: 0, submissions: 0 });

    // Rough cost estimates (USD) — GPT-4o pricing as baseline
    const COST_PER_1K_PROMPT = 0.0025;
    const COST_PER_1K_COMPLETION = 0.01;
    totals.estimated_cost_usd = (
      (totals.prompt_tokens / 1000) * COST_PER_1K_PROMPT +
      (totals.completion_tokens / 1000) * COST_PER_1K_COMPLETION
    );

    res.json({ days, totals, daily, byDocType, topUsers });
  } catch (error) {
    console.error('Usage endpoint error:', error);
    res.status(500).json({ error: 'Failed to fetch usage data' });
  }
});
