'use strict';

/**
 * Webcam proctoring policy per organisation, and storage of the images/video it produces.
 *
 * Webcam images are biometric information, which POPIA treats as special personal
 * information (sections 26-27; children's information in sections 34-35). Webcam
 * monitoring is therefore off unless management for the organisation has accepted every
 * acknowledgement below. Assessment settings are clamped to this policy whenever they are
 * saved or used, so revoking the policy switches webcam capture off everywhere.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../database/connection');

const MEDIA_ROOT = path.join(__dirname, '..', 'uploads', 'proctoring');
const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 90;

// Each must be confirmed by management before webcam monitoring can be allowed.
const ACKNOWLEDGEMENTS = [
  'lawful_basis',
  'explicit_consent',
  'minors',
  'retention',
  'access',
  'information_officer'
];

const rowsOf = (result) => {
  const value = result?.rows || result;
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};

const clampRetention = (days) => {
  const n = Math.round(Number(days));
  if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, n));
};

const parsePolicy = (value) => {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      raw = null;
    }
  }
  const allowed = raw?.allowed === true;
  return {
    allowed,
    allow_video: allowed && raw?.allow_video === true,
    retention_days: clampRetention(raw?.retention_days ?? DEFAULT_RETENTION_DAYS),
    accepted_by: allowed ? (raw?.accepted_by || null) : null,
    accepted_at: allowed ? (raw?.accepted_at || null) : null
  };
};

/**
 * Validate management's input. Allowing webcam monitoring requires every acknowledgement.
 * Returns { policy } or { error }.
 */
const buildPolicy = (input, user, now = new Date()) => {
  const allowed = input?.allowed === true;
  if (allowed) {
    const acknowledged = input?.acknowledgements || {};
    const missing = ACKNOWLEDGEMENTS.filter((key) => acknowledged[key] !== true);
    if (missing.length) {
      return { error: 'Confirm every POPIA acknowledgement before allowing webcam monitoring.', missing };
    }
  }
  return {
    policy: {
      allowed,
      allow_video: allowed && input?.allow_video === true,
      retention_days: clampRetention(input?.retention_days),
      accepted_by: allowed ? { id: user.id, name: user.name || user.email || `User ${user.id}` } : null,
      accepted_at: allowed ? now.toISOString() : null
    }
  };
};

const getOrganisationPolicy = async (organisationId) => {
  if (organisationId == null) return parsePolicy(null);
  const row = rowsOf(await query('SELECT webcam_policy FROM organisations WHERE id = $1', [organisationId]))[0];
  return parsePolicy(row?.webcam_policy);
};

/** Limit an assessment's webcam settings to what the organisation allows. */
const clampSettings = (settings, policy) => {
  if (!settings) return settings;
  let webcam = settings.webcam || 'off';
  if (!policy?.allowed) webcam = 'off';
  else if (webcam === 'video' && !policy.allow_video) webcam = 'snapshots';
  return { ...settings, webcam, webcam_required: webcam !== 'off' && settings.webcam_required === true };
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const MEDIA_TYPES = {
  snapshot: { mime: 'image/jpeg', ext: '.jpg', maxBytes: 300 * 1024 },
  video: { mime: 'video/webm', ext: '.webm', maxBytes: 6 * 1024 * 1024 }
};

const saveMedia = async ({ attemptId, kind, reason, buffer, clientTime, retentionDays }) => {
  const type = MEDIA_TYPES[kind];
  const dir = path.join(MEDIA_ROOT, String(attemptId));
  await fs.promises.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${type.ext}`);
  await fs.promises.writeFile(filePath, buffer);
  const expiresAt = new Date(Date.now() + clampRetention(retentionDays) * 86400000);
  await query(
    `INSERT INTO assessment_attempt_media (attempt_id, kind, reason, file_path, mime_type, bytes, client_time, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [attemptId, kind, reason, filePath, type.mime, buffer.length, clientTime, expiresAt]
  );
};

const removeFiles = async (rows) => {
  for (const row of rows) {
    // Only ever delete inside the proctoring folder.
    const resolved = path.resolve(row.file_path);
    if (!resolved.startsWith(path.resolve(MEDIA_ROOT) + path.sep)) continue;
    await fs.promises.unlink(resolved).catch(() => {});
  }
};

const deleteAttemptMedia = async (attemptId) => {
  const rows = rowsOf(await query('SELECT id, file_path FROM assessment_attempt_media WHERE attempt_id = $1', [attemptId]));
  await removeFiles(rows);
  await query('DELETE FROM assessment_attempt_media WHERE attempt_id = $1', [attemptId]);
  await fs.promises.rmdir(path.join(MEDIA_ROOT, String(attemptId))).catch(() => {});
  return rows.length;
};

/** Delete images and video past their retention date. */
const purgeExpiredMedia = async (now = new Date()) => {
  const rows = rowsOf(await query('SELECT id, attempt_id, file_path FROM assessment_attempt_media WHERE expires_at IS NOT NULL AND expires_at < $1', [now]));
  if (!rows.length) return 0;
  await removeFiles(rows);
  for (const row of rows) {
    await query('DELETE FROM assessment_attempt_media WHERE id = $1', [row.id]);
  }
  return rows.length;
};

let purgeTimer = null;
const startMediaRetentionPurge = (intervalMs = 60 * 60 * 1000) => {
  if (purgeTimer) return;
  const run = () => purgeExpiredMedia()
    .then((count) => { if (count) console.log(`[webcam] Deleted ${count} expired webcam file(s)`); })
    .catch((error) => console.warn('[webcam] Retention purge failed:', error.message));
  run();
  purgeTimer = setInterval(run, intervalMs);
  if (purgeTimer.unref) purgeTimer.unref();
};

module.exports = {
  ACKNOWLEDGEMENTS,
  MEDIA_ROOT,
  MEDIA_TYPES,
  DEFAULT_RETENTION_DAYS,
  parsePolicy,
  buildPolicy,
  getOrganisationPolicy,
  clampSettings,
  saveMedia,
  deleteAttemptMedia,
  purgeExpiredMedia,
  startMediaRetentionPurge
};
