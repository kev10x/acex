/**
 * POPIA endpoints: policy status/acceptance, self-service data export,
 * and erasure/correction requests (handled by an administrator).
 */

const express = require('express');
const { query } = require('../database/connection');
const { requireAuth, requireRoles } = require('../middleware/auth');
const { recordAuditEvent, getRequestMetadata } = require('../services/auditEventService');
const privacy = require('../services/privacyService');
const emailService = require('../services/emailService');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

privacy.ensureSchema().catch((err) => console.error('Privacy schema setup failed:', err.message));

// Public: which notice version is current.
router.get('/policy', (req, res) => {
  res.json({ success: true, version: privacy.POLICY_VERSION });
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, ...(await privacy.getStatus(req.user.id)) });
  } catch (error) {
    console.error('Privacy status error:', error);
    res.status(500).json({ error: 'Failed to load privacy status' });
  }
});

router.post('/accept', requireAuth, async (req, res) => {
  try {
    await privacy.recordAcceptance(req.user.id);
    await recordAuditEvent({
      user_id: req.user.id,
      category: 'privacy',
      action: 'policy_accepted',
      outcome: 'success',
      organisation_id: req.user?.organisation_id ?? null,
      metadata: getRequestMetadata(req, { version: privacy.POLICY_VERSION }),
    });
    res.json({ success: true, ...(await privacy.getStatus(req.user.id)) });
  } catch (error) {
    console.error('Privacy accept error:', error);
    res.status(500).json({ error: 'Failed to record acceptance' });
  }
});

// Right of access: everything held about the signed-in person, as a download.
router.get('/my-data', requireAuth, async (req, res) => {
  try {
    const data = await privacy.collectUserData(req.user.id);
    await recordAuditEvent({
      user_id: req.user.id,
      category: 'privacy',
      action: 'data_exported',
      outcome: 'success',
      organisation_id: req.user?.organisation_id ?? null,
      metadata: getRequestMetadata(req),
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Privacy export error:', error);
    res.status(500).json({ error: 'Failed to export your data' });
  }
});

// Right to correction/deletion: logged for an administrator to action, and the
// administrator is emailed. Erasure is not automatic because marks and results
// may need to be kept for the institution's own record-keeping duties.
router.post('/requests', requireAuth, async (req, res) => {
  try {
    const type = String(req.body?.type || '').toLowerCase();
    if (!['erasure', 'correction', 'objection'].includes(type)) {
      return res.status(400).json({ error: 'type must be erasure, correction or objection' });
    }
    const details = String(req.body?.details || '').trim().slice(0, 2000);
    await recordAuditEvent({
      user_id: req.user.id,
      target_user_id: req.user.id,
      category: 'privacy',
      action: `request_${type}`,
      outcome: 'pending',
      organisation_id: req.user?.organisation_id ?? null,
      metadata: getRequestMetadata(req, { details, email: req.user.email }),
    });

    const officer = process.env.INFORMATION_OFFICER_EMAIL || process.env.SUPER_ADMIN_EMAIL;
    if (officer) {
      emailService.transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.GMAIL_USER || process.env.SMTP_USER || 'noreply@markmate.com',
        to: officer,
        subject: `[POPIA] ${type} request from ${req.user.email}`,
        text: `${req.user.name || req.user.email} (${req.user.email}, user #${req.user.id}) submitted a ${type} request.\n\nDetails: ${details || '(none given)'}\n\nPOPIA expects a response within a reasonable time (aim for 30 days).`,
      }).catch((err) => console.warn('[privacy] Could not email information officer:', err?.message || err));
    }
    res.json({ success: true, message: 'Your request has been recorded. The information officer will respond to you by email.' });
  } catch (error) {
    console.error('Privacy request error:', error);
    res.status(500).json({ error: 'Failed to record your request' });
  }
});

// Administrators: outstanding and past requests.
router.get('/requests', requireAuth, requireRoles(['management']), async (req, res) => {
  try {
    const q = isMySQL()
      ? await query(`SELECT a.id, a.user_id, u.email, u.name, a.action, a.outcome, a.metadata_json, a.created_at
                     FROM audit_events a LEFT JOIN users u ON u.id = a.user_id
                     WHERE a.category = 'privacy' AND a.action LIKE 'request_%'
                     ORDER BY a.created_at DESC LIMIT 200`, [])
      : await query(`SELECT a.id, a.user_id, u.email, u.name, a.action, a.outcome, a.metadata_json, a.created_at
                     FROM audit_events a LEFT JOIN users u ON u.id = a.user_id
                     WHERE a.category = 'privacy' AND a.action LIKE 'request_%'
                     ORDER BY a.created_at DESC LIMIT 200`, []);
    res.json({ success: true, requests: rowList(q) });
  } catch (error) {
    console.error('Privacy requests list error:', error);
    res.status(500).json({ error: 'Failed to load requests' });
  }
});

module.exports = router;
