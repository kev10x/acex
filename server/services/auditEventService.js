const { query } = require('../database/connection');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');

function toNullableNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toTrimmedString(value, maxLength) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value == null) continue;
    if (typeof value === 'string' && value.length > 3000) {
      safe[key] = `${value.slice(0, 3000)}...`;
      continue;
    }
    safe[key] = value;
  }
  return Object.keys(safe).length ? safe : null;
}

function getRequestMetadata(req, extra = null) {
  const metadata = {
    method: req?.method || null,
    route: req?.originalUrl || req?.url || null,
    ip: req?.ip || req?.socket?.remoteAddress || null,
    user_agent: req?.headers?.['user-agent'] || null,
  };
  if (extra && typeof extra === 'object') {
    Object.assign(metadata, extra);
  }
  return sanitizeMetadata(metadata);
}

async function persistAuditEvent(payload) {
  const params = [
    toNullableNumber(payload?.user_id),
    toNullableNumber(payload?.target_user_id),
    toTrimmedString(payload?.category || 'general', 50),
    toTrimmedString(payload?.action || 'unknown_action', 100),
    toTrimmedString(payload?.outcome || 'success', 30),
    toNullableNumber(payload?.organisation_id),
    toNullableNumber(payload?.department_id),
    payload?.metadata ? JSON.stringify(sanitizeMetadata(payload.metadata)) : null,
  ];

  if (isMySQL()) {
    await query(
      `INSERT INTO audit_events (
        user_id, target_user_id, category, action, outcome, organisation_id, department_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
    return;
  }

  await query(
    `INSERT INTO audit_events (
      user_id, target_user_id, category, action, outcome, organisation_id, department_id, metadata_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    params
  );
}

function logAuditEvent(payload) {
  try {
    console.log('[audit]', JSON.stringify(payload));
  } catch (_) {
    console.log('[audit]', payload);
  }
}

async function recordAuditEvent(payload) {
  const normalized = {
    user_id: toNullableNumber(payload?.user_id),
    target_user_id: toNullableNumber(payload?.target_user_id),
    category: toTrimmedString(payload?.category || 'general', 50),
    action: toTrimmedString(payload?.action || 'unknown_action', 100),
    outcome: toTrimmedString(payload?.outcome || 'success', 30),
    organisation_id: toNullableNumber(payload?.organisation_id),
    department_id: toNullableNumber(payload?.department_id),
    metadata: sanitizeMetadata(payload?.metadata || null),
  };

  logAuditEvent(normalized);
  try {
    await persistAuditEvent(normalized);
  } catch (error) {
    console.warn('[audit] Failed to persist event:', error?.message || error);
  }
}

module.exports = {
  getRequestMetadata,
  persistAuditEvent,
  recordAuditEvent,
};
