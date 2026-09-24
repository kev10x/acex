/**
 * One-time links that let a person set (or reset) their name and password:
 *  - 'invite': a student enrolled by a lecturer, who may not have an account yet
 *  - 'reset' : a forgotten-password request
 * Only a SHA-256 hash of the token is stored, so a database leak does not expose
 * usable links; the raw token exists only in the emailed URL.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { query } = require('../database/connection');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

const INVITE_TTL_HOURS = 24 * 7;
const RESET_TTL_HOURS = 1;

const hashToken = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');

// Links always point at the SPA, which is served under /tools.
function getAppUrl() {
  const raw = process.env.APP_URL || process.env.CLIENT_URL || process.env.BASE_URL || 'http://localhost:3000';
  try {
    return `${new URL(raw).origin}/tools`;
  } catch (_) {
    return `${String(raw).replace(/\/+$/, '').replace(/\/tools$/, '')}/tools`;
  }
}

async function issueSetupToken(userId, purpose) {
  const token = crypto.randomBytes(32).toString('hex');
  const hours = purpose === 'invite' ? INVITE_TTL_HOURS : RESET_TTL_HOURS;
  const expires = new Date(Date.now() + hours * 60 * 60 * 1000);
  if (isMySQL()) {
    await query('UPDATE users SET setup_token_hash = ?, setup_token_expires = ?, setup_token_purpose = ? WHERE id = ?', [hashToken(token), expires, purpose, userId]);
  } else {
    await query('UPDATE users SET setup_token_hash = $1, setup_token_expires = $2, setup_token_purpose = $3 WHERE id = $4', [hashToken(token), expires, purpose, userId]);
  }
  return token;
}

// Returns the user for a valid, unexpired token, else null.
async function findUserBySetupToken(token) {
  if (!token || String(token).length < 20) return null;
  const q = isMySQL()
    ? await query('SELECT id, email, name, role, setup_token_purpose FROM users WHERE setup_token_hash = ? AND setup_token_expires > CURRENT_TIMESTAMP', [hashToken(token)])
    : await query('SELECT id, email, name, role, setup_token_purpose FROM users WHERE setup_token_hash = $1 AND setup_token_expires > CURRENT_TIMESTAMP', [hashToken(token)]);
  return rowList(q)[0] || null;
}

async function completeSetup(user, { password, name }) {
  const passwordHash = await bcrypt.hash(password, 10);
  const cleanName = String(name || '').trim().slice(0, 255) || user.name || null;
  // Setting a password from an emailed link proves control of the address, so the
  // account is also marked verified (and approved, for a lecturer-invited student).
  const approve = user.setup_token_purpose === 'invite';
  if (isMySQL()) {
    await query(
      `UPDATE users SET password_hash = ?, name = ?, email_verified = 1${approve ? ', is_approved = 1' : ''},
         setup_token_hash = NULL, setup_token_expires = NULL, setup_token_purpose = NULL WHERE id = ?`,
      [passwordHash, cleanName, user.id]
    );
  } else {
    await query(
      `UPDATE users SET password_hash = $1, name = $2, email_verified = TRUE${approve ? ', is_approved = TRUE' : ''},
         setup_token_hash = NULL, setup_token_expires = NULL, setup_token_purpose = NULL WHERE id = $3`,
      [passwordHash, cleanName, user.id]
    );
  }
}

// Creates a placeholder student account for someone enrolled before they have registered.
async function createInvitedStudent({ email, organisationId }) {
  const placeholder = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const cleanEmail = String(email).trim().toLowerCase();
  let id;
  if (isMySQL()) {
    const ins = await query(
      `INSERT INTO users (email, password_hash, name, account_type, organisation_name, organisation_id, email_verified, role, is_approved)
       VALUES (?, ?, NULL, 'individual', NULL, ?, 1, 'student', 1)`,
      [cleanEmail, placeholder, organisationId || null]
    );
    id = ins.insertId;
  } else {
    const ins = await query(
      `INSERT INTO users (email, password_hash, name, account_type, organisation_name, organisation_id, email_verified, role, is_approved)
       VALUES ($1, $2, NULL, 'individual', NULL, $3, TRUE, 'student', TRUE) RETURNING id`,
      [cleanEmail, placeholder, organisationId || null]
    );
    id = rowList(ins)[0]?.id;
  }
  return { id, email: cleanEmail, name: null, role: 'student' };
}

module.exports = { issueSetupToken, findUserBySetupToken, completeSetup, createInvitedStudent, getAppUrl, hashToken };
