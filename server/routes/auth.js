const express = require('express');
const { logger } = require('../services/logger');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { query } = require('../database/connection');
const { requireAuth, requireAdmin, generateToken, generateRefreshToken, verifyRefreshToken, normalizeRole, parseUserFeatures, mergeFeatures, normalizeFeatureSet } = require('../middleware/auth');
const emailService = require('../services/emailService');
const { recordAuditEvent, getRequestMetadata } = require('../services/auditEventService');

const router = express.Router();
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'kkativu@gmail.com';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

async function ensureOrganisationIdByName(nameRaw) {
  const name = String(nameRaw || '').trim();
  if (!name) return null;
  const existing = await query('SELECT id FROM organisations WHERE LOWER(name) = LOWER($1)', [name]);
  const ex = existing.rows?.[0] || existing?.[0];
  if (ex?.id) return ex.id;
  const inserted = await query('INSERT INTO organisations (name) VALUES ($1)', [name]);
  return inserted.insertId || inserted.lastID || inserted.rows?.[0]?.id || null;
}

function isSuperAdmin(user) {
  return String(user?.email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL;
}

async function getDepartmentById(departmentId) {
  if (departmentId == null) return null;
  const result = await query(
    `SELECT d.id, d.name, d.organisation_id, o.name as organisation_name
     FROM departments d
     INNER JOIN organisations o ON o.id = d.organisation_id
     WHERE d.id = $1`,
    [departmentId]
  );
  return result.rows?.[0] || result?.[0] || null;
}

function normalizeFeatureFlags(features) {
  const normalized = normalizeFeatureSet(features);
  return {
    assessment_creation: normalized.assessment_creation !== false,
    content_creation: normalized.content_creation !== false,
    download_results: normalized.download_results !== false,
    feedback_video: normalized.feedback_video !== false
  };
}

function buildAuthUserPayload(user, impersonation = null) {
  const features = normalizeFeatureFlags(mergeFeatures(user.user_features, user.organisation_features));
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    account_type: user.account_type || 'individual',
    organisation_name: user.organisation_name || null,
    organisation_id: user.organisation_id || null,
    department_id: user.department_id || null,
    department_name: user.department_name || null,
    role: normalizeRole(user.role),
    features,
    impersonation
  };
}

async function auditAdminAction(req, action, targetUserId, metadata = {}) {
  await recordAuditEvent({
    user_id: req.user?.id || null,
    target_user_id: targetUserId == null ? null : Number(targetUserId),
    category: 'admin_user_management',
    action,
    outcome: 'success',
    organisation_id: req.user?.organisation_id ?? null,
    department_id: req.user?.department_id ?? null,
    metadata: getRequestMetadata(req, metadata),
  });
}

// Register new user
router.post('/register', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').optional().trim().isLength({ min: 1, max: 255 }),
  body('account_type').optional().isIn(['individual', 'organisation']).withMessage('Account type must be individual or organisation'),
  body('organisation_name').optional().trim().isLength({ min: 1, max: 255 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, account_type, organisation_name } = req.body;
    const accountType = account_type === 'organisation' ? 'organisation' : 'individual';
    const orgName = accountType === 'organisation' && organisation_name ? organisation_name : null;

    // Check if user already exists
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    const userExists = existingUser.rows?.[0] || existingUser?.[0];
    
    if (userExists) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenExpires = new Date();
    verificationTokenExpires.setHours(verificationTokenExpires.getHours() + 24); // 24 hours from now

    const organisationId = orgName ? await ensureOrganisationIdByName(orgName) : null;

    // Create user (account_type, organisation_name, organisation_id and verification columns)
    const result = await query(
      'INSERT INTO users (email, password_hash, name, account_type, organisation_name, organisation_id, email_verified, verification_token, verification_token_expires, role, is_approved) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [email, passwordHash, name || null, accountType, orgName, organisationId, false, verificationToken, verificationTokenExpires, 'lecturer', false]
    );

    // Get the inserted user ID (MySQL uses insertId, PostgreSQL uses RETURNING)
    const userId = result.insertId || result.lastID || (result.rows?.[0]?.id);
    
    if (!userId) {
      throw new Error('Failed to get user ID after insertion');
    }
    
    // Fetch the created user
    const userResult = await query(
      'SELECT id, email, name, created_at, account_type, organisation_name, organisation_id FROM users WHERE id = $1',
      [userId]
    );
    
    const user = userResult.rows?.[0] || userResult?.[0];
    
    if (!user) {
      throw new Error('Failed to retrieve created user');
    }

    // Send verification email
    let emailSent = false;
    const baseUrl = process.env.CLIENT_URL || process.env.BASE_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl}/verify-email?token=${verificationToken}`;
    
    try {
      const emailResult = await emailService.sendVerificationEmail(email, verificationToken, name);
      emailSent = emailResult.success !== false;
      
      // If email wasn't sent (console mode), log the URL
      if (!emailSent) {
        console.log('⚠️  Email service not configured. Verification URL:', verificationUrl);
      }
    } catch (emailError) {
      logger.error({ err: emailError });
      // Continue even if email fails - user can request resend later
      console.log('⚠️  Verification URL (email not sent):', verificationUrl);
    }

    const exposeVerificationUrl = !emailSent || process.env.NODE_ENV !== 'production';
    res.status(201).json({
      message: emailSent 
        ? 'Registration successful! Please check your email to verify your account.'
        : 'Registration successful! Please verify your account using the link below.',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        account_type: user.account_type || 'individual',
        organisation_name: user.organisation_name || null,
        organisation_id: user.organisation_id || null,
        email_verified: false
      },
      requiresVerification: true,
      verificationUrl: exposeVerificationUrl ? verificationUrl : undefined
    });
  } catch (error) {
    logger.error({ err: error });
    // Provide more detailed error message for debugging
    const errorMessage = error.message || 'Failed to register user';
    logger.error({ err: {
      message: errorMessage,
      code: error.code,
      sql: error.sql,
      sqlMessage: error.sqlMessage
    } });
    res.status(500).json({ 
      error: 'Failed to register user',
      details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    });
  }
});

// Login
router.post('/login', authLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Find user
    const result = await query(
      `SELECT u.id, u.email, u.password_hash, u.name, u.is_active, u.email_verified, u.is_approved, u.role,
              u.account_type, COALESCE(o.name, u.organisation_name) as organisation_name, u.organisation_id,
              u.department_id, d.name as department_name, u.features as user_features, o.features as organisation_features
       FROM users u
       LEFT JOIN organisations o ON o.id = u.organisation_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.email = $1`,
      [email]
    );

    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if email is verified
    if (!user.email_verified) {
      return res.status(403).json({ 
        error: 'Please verify your email address before logging in. Check your inbox for the verification email.',
        requiresVerification: true,
        email: user.email
      });
    }

    // Check if account is approved by admin
    if (!user.is_approved) {
      return res.status(403).json({ 
        error: 'Your account is pending admin approval. You will be able to log in once an administrator approves your account.',
        requiresApproval: true
      });
    }

    // Update last login
    await query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Generate token pair
    const token = generateToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    res.json({
      message: 'Login successful',
      user: buildAuthUserPayload(user),
      token,
      refreshToken
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Get current user info
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.email, u.name, u.created_at, u.last_login, u.account_type,
              COALESCE(o.name, u.organisation_name) as organisation_name, u.organisation_id,
              u.department_id, d.name as department_name, u.email_verified, u.is_approved, u.role,
              u.features as user_features, o.features as organisation_features
       FROM users u
       LEFT JOIN organisations o ON o.id = u.organisation_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.id = $1`,
      [req.user.id]
    );

    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        ...buildAuthUserPayload(user, req.user?.impersonation || null),
        created_at: user.created_at,
        last_login: user.last_login,
        email_verified: user.email_verified,
        is_approved: user.is_approved
      }
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Update user profile
router.put('/profile', requireAuth, [
  body('name').optional().trim().isLength({ min: 1, max: 255 }),
  body('email').optional().isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email } = req.body;
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }

    if (email !== undefined) {
      // Check if email is already taken by another user
      const emailCheck = await query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, req.user.id]
      );
      
      const emailTaken = emailCheck.rows?.[0] || emailCheck?.[0];
      
      if (emailTaken) {
        return res.status(400).json({ error: 'Email already in use' });
      }

      updates.push(`email = $${paramCount++}`);
      values.push(email);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(req.user.id);

    const updateQuery = `
      UPDATE users 
      SET ${updates.join(', ')} 
      WHERE id = $${paramCount}
    `;

    await query(updateQuery, values);
    const result = await query(
      'SELECT id, email, name, updated_at FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows?.[0] || result?.[0];

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        updated_at: user.updated_at
      }
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Change password
router.put('/change-password', requireAuth, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    // Get current password hash
    const result = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const passwordMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const saltRounds = 10;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newPasswordHash, req.user.id]
    );

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Verify email
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    // Find user with this token
    const result = await query(
      'SELECT id, email, name, verification_token_expires FROM users WHERE verification_token = $1',
      [token]
    );

    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }

    // Check if token has expired
    const now = new Date();
    const expires = new Date(user.verification_token_expires);
    if (now > expires) {
      return res.status(400).json({ error: 'Verification token has expired. Please request a new one.' });
    }

    // Verify the email
    await query(
      'UPDATE users SET email_verified = $1, verification_token = NULL, verification_token_expires = NULL WHERE id = $2',
      [true, user.id]
    );

    res.json({
      message: 'Email verified successfully! You can now log in.',
      verified: true
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

// Resend verification email
router.post('/resend-verification', authLimiter, [
  body('email').isEmail().normalizeEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email } = req.body;

    // Find user
    const result = await query(
      'SELECT id, email, name, email_verified FROM users WHERE email = $1',
      [email]
    );

    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      // Don't reveal if email exists or not for security
      return res.json({
        message: 'If an account with this email exists and is not verified, a verification email has been sent.'
      });
    }

    if (user.email_verified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    // Generate new verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenExpires = new Date();
    verificationTokenExpires.setHours(verificationTokenExpires.getHours() + 24);

    // Update user with new token
    await query(
      'UPDATE users SET verification_token = $1, verification_token_expires = $2 WHERE id = $3',
      [verificationToken, verificationTokenExpires, user.id]
    );

    // Send verification email
    try {
      await emailService.sendVerificationEmail(user.email, verificationToken, user.name);
      res.json({
        message: 'Verification email sent! Please check your inbox.'
      });
    } catch (emailError) {
      logger.error({ err: emailError });
      res.status(500).json({ error: 'Failed to send verification email' });
    }
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// Normalize DB rows to array (MySQL returns result.rows, pg returns result.rows)
const getRows = (result) => {
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result)) return result;
  return [];
};

// Organisation boundary helper:
// - super admin can manage across organisations
// - regular management users can only manage users inside their own organisation
async function getManageableTargetUser(requester, targetId) {
  const result = await query(
    'SELECT id, role, organisation_id, department_id FROM users WHERE id = $1',
    [targetId]
  );
  const target = result.rows?.[0] || result?.[0];
  if (!target) return { status: 'not_found' };
  if (isSuperAdmin(requester)) {
    return { status: 'ok', target };
  }
  const requesterOrg = requester.organisation_id == null ? null : Number(requester.organisation_id);
  const targetOrg = target.organisation_id == null ? null : Number(target.organisation_id);
  if (requesterOrg == null || requesterOrg !== targetOrg) {
    return { status: 'forbidden' };
  }
  return { status: 'ok', target };
}

// Normalize user row for JSON (MySQL can return 0/1 for booleans)
const mapUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  created_at: u.created_at,
  last_login: u.last_login,
  email_verified: !!u.email_verified,
  is_approved: !!u.is_approved,
  role: normalizeRole(u.role),
  is_active: u.is_active !== undefined ? !!u.is_active : true,
  features: normalizeFeatureFlags(parseUserFeatures(u.features)),
  organisation_id: u.organisation_id || null,
  organisation_name: u.organisation_name || null,
  department_id: u.department_id || null,
  department_name: u.department_name || null
});

// Admin routes - Get pending users
router.get('/admin/pending-users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const requesterOrg = req.user.organisation_id == null ? null : Number(req.user.organisation_id);
    const requesterIsSuperAdmin = isSuperAdmin(req.user);
    let result;
    if (requesterIsSuperAdmin) {
      result = await query(`
        SELECT u.id, u.email, u.name, u.created_at, u.email_verified, u.is_approved, u.role, u.features,
               u.organisation_id, COALESCE(o.name, u.organisation_name) as organisation_name,
               u.department_id, d.name as department_name
        FROM users u
        LEFT JOIN organisations o ON o.id = u.organisation_id
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE email_verified = 1 AND is_approved = 0
        ORDER BY u.created_at DESC
      `);
    } else if (requesterOrg != null) {
      result = await query(`
        SELECT u.id, u.email, u.name, u.created_at, u.email_verified, u.is_approved, u.role, u.features,
               u.organisation_id, COALESCE(o.name, u.organisation_name) as organisation_name,
               u.department_id, d.name as department_name
        FROM users u
        LEFT JOIN organisations o ON o.id = u.organisation_id
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE email_verified = 1 AND is_approved = 0 AND u.organisation_id = $1
        ORDER BY u.created_at DESC
      `, [requesterOrg]);
    } else {
      result = { rows: [] };
    }

    const rows = getRows(result);
    const users = rows.map(u => ({
      ...mapUser(u),
      last_login: undefined,
      is_active: undefined
    }));

    res.json({ users });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to get pending users' });
  }
});

// Admin routes - Get all users
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const requesterOrg = req.user.organisation_id == null ? null : Number(req.user.organisation_id);
    const requesterIsSuperAdmin = isSuperAdmin(req.user);
    let result;
    if (requesterIsSuperAdmin) {
      result = await query(`
        SELECT u.id, u.email, u.name, u.created_at, u.last_login, u.email_verified, u.is_approved, u.role, u.is_active, u.features,
               u.organisation_id, COALESCE(o.name, u.organisation_name) as organisation_name,
               u.department_id, d.name as department_name
        FROM users u
        LEFT JOIN organisations o ON o.id = u.organisation_id
        LEFT JOIN departments d ON d.id = u.department_id
        ORDER BY created_at DESC
      `);
    } else if (requesterOrg != null) {
      result = await query(`
        SELECT u.id, u.email, u.name, u.created_at, u.last_login, u.email_verified, u.is_approved, u.role, u.is_active, u.features,
               u.organisation_id, COALESCE(o.name, u.organisation_name) as organisation_name,
               u.department_id, d.name as department_name
        FROM users u
        LEFT JOIN organisations o ON o.id = u.organisation_id
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.organisation_id = $1
        ORDER BY created_at DESC
      `, [requesterOrg]);
    } else {
      result = { rows: [] };
    }

    const rows = getRows(result);
    const users = rows.map(mapUser);

    res.json({ users });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to get users' });
  }
});

router.post('/admin/users/:id/impersonate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'You are already signed in as this user' });
    }

    const guard = await getManageableTargetUser(req.user, targetId);
    if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
    if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });
    if (normalizeRole(guard.target.role) === 'management') {
      return res.status(403).json({ error: 'Management users cannot be impersonated' });
    }

    const result = await query(
      `SELECT u.id, u.email, u.name, u.is_active, u.role, u.is_approved,
              u.account_type, COALESCE(o.name, u.organisation_name) as organisation_name, u.organisation_id,
              u.department_id, d.name as department_name, u.features as user_features, o.features as organisation_features
       FROM users u
       LEFT JOIN organisations o ON o.id = u.organisation_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.id = $1`,
      [targetId]
    );
    const targetUser = result.rows?.[0] || result?.[0];
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!targetUser.is_active) {
      return res.status(400).json({ error: 'Cannot impersonate an inactive user' });
    }
    if (!targetUser.is_approved) {
      return res.status(400).json({ error: 'Cannot impersonate an unapproved user' });
    }

    const impersonation = {
      active: true,
      impersonated_by: req.user.id,
      impersonated_by_email: req.user.email,
      impersonated_by_name: req.user.name || null
    };
    const token = generateToken(targetUser.id, {
      impersonatedBy: req.user.id,
      impersonatedByEmail: req.user.email,
      impersonatedByName: req.user.name || null
    });

    await auditAdminAction(req, 'impersonate_user', targetUser.id, {
      target_email: targetUser.email,
      target_role: normalizeRole(targetUser.role),
    });

    res.json({
      success: true,
      message: `Now impersonating ${targetUser.name || targetUser.email}`,
      token,
      user: buildAuthUserPayload(targetUser, impersonation)
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to impersonate user' });
  }
});

// Admin routes - Approve user
router.post('/admin/users/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const guard = await getManageableTargetUser(req.user, Number(id));
    if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
    if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });

    await query('UPDATE users SET is_approved = 1 WHERE id = $1', [id]);
    const result = await query(
      'SELECT id, email, name, is_approved FROM users WHERE id = $1',
      [id]
    );
    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await auditAdminAction(req, 'approve_user', id, {
      target_email: user.email,
      target_role: normalizeRole(guard.target?.role),
    });

    res.json({
      message: 'User approved successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_approved: user.is_approved
      }
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to approve user' });
  }
});

// Admin routes - Reject user (set is_approved to false and optionally deactivate)
router.post('/admin/users/:id/reject', requireAuth, requireAdmin, [
  body('deactivate').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { deactivate } = req.body;
    const guard = await getManageableTargetUser(req.user, Number(id));
    if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
    if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });

    let updateQuery = 'UPDATE users SET is_approved = 0';
    const values = [];
    let paramCount = 1;

    if (deactivate) {
      updateQuery += `, is_active = 0`;
    }

    updateQuery += ` WHERE id = $${paramCount}`;
    values.push(id);

    await query(updateQuery, values);
    const result = await query(
      'SELECT id, email, name, is_approved, is_active FROM users WHERE id = $1',
      [id]
    );
    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await auditAdminAction(req, deactivate ? 'reject_and_deactivate_user' : 'reject_user', id, {
      deactivate: !!deactivate,
      target_email: user.email,
      target_role: normalizeRole(guard.target?.role),
    });

    res.json({
      message: deactivate ? 'User rejected and deactivated' : 'User rejected',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_approved: user.is_approved,
        is_active: user.is_active
      }
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to reject user' });
  }
});

// Admin routes - Lock/unlock user (toggle is_active)
router.put('/admin/users/:id/lock', requireAuth, requireAdmin, [
  body('locked').isBoolean().withMessage('locked must be true or false')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { locked } = req.body;
    const guard = await getManageableTargetUser(req.user, Number(id));
    if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
    if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });

    if (Number(id) === req.user.id) {
      return res.status(400).json({ error: 'You cannot lock your own account' });
    }

    const isActive = !locked;

    await query(
      'UPDATE users SET is_active = $1 WHERE id = $2',
      [isActive, id]
    );

    const result = await query(
      'SELECT id, email, name, is_active FROM users WHERE id = $1',
      [id]
    );
    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await auditAdminAction(req, locked ? 'lock_user' : 'unlock_user', id, {
      target_email: user.email,
      target_role: normalizeRole(guard.target?.role),
    });

    res.json({
      message: locked ? 'User locked' : 'User unlocked',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_active: !!user.is_active
      }
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to update user lock status' });
  }
});

// Admin routes - Delete user
router.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = Number(id);

    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const guard = await getManageableTargetUser(req.user, targetId);
    if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
    if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });
    const targetUser = guard.target;

    if (normalizeRole(targetUser.role) === 'management') {
      const adminCount = await query(
        'SELECT COUNT(*) as count FROM users WHERE LOWER(role) = $1 OR LOWER(role) = $2',
        ['management', 'admin']
      );
      const count = Number(adminCount.rows?.[0]?.count ?? adminCount?.[0]?.count ?? 0);
      if (count <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last management user' });
      }
    }

    await query('DELETE FROM users WHERE id = $1', [targetId]);
    await auditAdminAction(req, 'delete_user', targetId, {
      target_email: targetUser.email,
      target_role: normalizeRole(targetUser.role),
    });

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Admin routes - Update user features (e.g. assessment_creation, content_creation, download_results, feedback_video)
// Support both PUT and PATCH so the route is found regardless of client or proxy behavior
const updateUserFeaturesHandler = [
  requireAuth,
  requireAdmin,
  body('features').optional().isObject(),
  body('features.assessment_creation').optional().isBoolean(),
  body('features.content_creation').optional().isBoolean(),
  body('features.download_results').optional().isBoolean(),
  body('features.feedback_video').optional().isBoolean(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { id } = req.params;
      const { features } = req.body;
      const guard = await getManageableTargetUser(req.user, Number(id));
      if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
      if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });
      if (!features || typeof features !== 'object') {
        return res.status(400).json({ error: 'features object required' });
      }
      const allowed = {
        assessment_creation: features.assessment_creation !== false,
        content_creation: features.content_creation !== false,
        download_results: !!features.download_results,
        feedback_video: !!features.feedback_video
      };
      const featuresJson = JSON.stringify(allowed);
      await query('UPDATE users SET features = $1 WHERE id = $2', [featuresJson, id]);
      const result = await query(
        'SELECT id, email, name, features FROM users WHERE id = $1',
        [id]
      );
      const user = result.rows?.[0] || result?.[0];
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      await auditAdminAction(req, 'update_user_features', id, {
        target_email: user.email,
        features: allowed,
      });
      res.json({
        message: 'User features updated',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          features: normalizeFeatureFlags(parseUserFeatures(user.features))
        }
      });
    } catch (error) {
      logger.error({ err: error });
      res.status(500).json({ error: 'Failed to update user features' });
    }
  }
];
router.put('/admin/users/:id/features', updateUserFeaturesHandler);
router.patch('/admin/users/:id/features', updateUserFeaturesHandler);

// Admin routes - Update user role
router.put('/admin/users/:id/role', requireAuth, requireAdmin, [
  body('role').isIn(['management', 'lecturer', 'student']).withMessage('Role must be management, lecturer, or student')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { role } = req.body;
    const guard = await getManageableTargetUser(req.user, Number(id));
    if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
    if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });

    // Prevent removing the last admin
    if (role !== 'management') {
      const adminCount = await query(
        'SELECT COUNT(*) as count FROM users WHERE (LOWER(role) = $1 OR LOWER(role) = $2) AND id != $3',
        ['management', 'admin', id]
      );
      const count = adminCount.rows?.[0]?.count || adminCount?.[0]?.count || 0;
      if (count === 0) {
        return res.status(400).json({ error: 'Cannot remove the last management user' });
      }
    }

    await query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    const result = await query(
      'SELECT id, email, name, role FROM users WHERE id = $1',
      [id]
    );
    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await auditAdminAction(req, 'update_user_role', id, {
      target_email: user.email,
      previous_role: normalizeRole(guard.target?.role),
      new_role: normalizeRole(role),
    });

    res.json({
      message: 'User role updated successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: normalizeRole(user.role)
      }
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Admin routes - list organisations
router.get('/admin/organisations', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const requesterOrg = _req.user.organisation_id == null ? null : Number(_req.user.organisation_id);
    const result = isSuperAdmin(_req.user)
      ? await query('SELECT id, name, features, created_at FROM organisations ORDER BY name ASC')
      : requesterOrg == null
        ? { rows: [] }
        : await query('SELECT id, name, features, created_at FROM organisations WHERE id = $1 ORDER BY name ASC', [requesterOrg]);
    const rows = getRows(result).map((row) => ({
      ...row,
      features: normalizeFeatureFlags(parseUserFeatures(row.features))
    }));
    res.json({ organisations: rows });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to fetch organisations' });
  }
});

// Admin routes - create organisation
router.post('/admin/organisations', requireAuth, requireAdmin, [
  body('name').trim().isLength({ min: 2, max: 255 }).withMessage('Organisation name is required')
], async (req, res) => {
  try {
    if (!isSuperAdmin(req.user)) {
      return res.status(403).json({ error: 'Only the super admin can create organisations' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const name = String(req.body.name || '').trim();
    const existing = await query('SELECT id, name FROM organisations WHERE LOWER(name) = LOWER($1)', [name]);
    const ex = existing.rows?.[0] || existing?.[0];
    if (ex) return res.status(400).json({ error: 'Organisation already exists' });
    const ins = await query('INSERT INTO organisations (name) VALUES ($1)', [name]);
    const id = ins.insertId || ins.lastID || ins.rows?.[0]?.id;

    await recordAuditEvent({
      user_id: req.user?.id || null,
      category: 'admin_organisation_management',
      action: 'create_organisation',
      outcome: 'success',
      organisation_id: req.user?.organisation_id ?? null,
      department_id: req.user?.department_id ?? null,
      metadata: getRequestMetadata(req, {
        created_organisation_id: id || null,
        created_organisation_name: name,
      }),
    });

    res.json({ success: true, organisation: { id, name } });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to create organisation' });
  }
});

router.put('/admin/organisations/:id/features', requireAuth, requireAdmin, [
  body('features').isObject().withMessage('features object required'),
  body('features.assessment_creation').optional().isBoolean(),
  body('features.content_creation').optional().isBoolean(),
  body('features.download_results').optional().isBoolean(),
  body('features.feedback_video').optional().isBoolean()
], async (req, res) => {
  try {
    if (!isSuperAdmin(req.user)) {
      return res.status(403).json({ error: 'Only the super admin can update organisation features' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const organisationId = Number(req.params.id);
    const features = normalizeFeatureFlags(req.body.features || {});
    const featuresJson = JSON.stringify(features);
    const existing = await query('SELECT id, name FROM organisations WHERE id = $1', [organisationId]);
    const organisation = existing.rows?.[0] || existing?.[0];
    if (!organisation) return res.status(404).json({ error: 'Organisation not found' });

    await query('UPDATE organisations SET features = $1 WHERE id = $2', [featuresJson, organisationId]);
    await recordAuditEvent({
      user_id: req.user?.id || null,
      category: 'admin_organisation_management',
      action: 'update_organisation_features',
      outcome: 'success',
      organisation_id: req.user?.organisation_id ?? null,
      department_id: req.user?.department_id ?? null,
      metadata: getRequestMetadata(req, {
        target_organisation_id: organisationId,
        target_organisation_name: organisation.name,
        features,
      }),
    });

    res.json({
      success: true,
      organisation: {
        id: organisationId,
        name: organisation.name,
        features
      }
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to update organisation features' });
  }
});

// Admin routes - list departments
router.get('/admin/departments', requireAuth, requireAdmin, async (req, res) => {
  try {
    const requesterOrg = req.user.organisation_id == null ? null : Number(req.user.organisation_id);
    const requestedOrg = req.query.organisation_id == null ? null : Number(req.query.organisation_id);
    let result;

    if (isSuperAdmin(req.user)) {
      if (requestedOrg != null && Number.isFinite(requestedOrg)) {
        result = await query(
          `SELECT d.id, d.name, d.organisation_id, o.name as organisation_name, d.created_at
           FROM departments d
           INNER JOIN organisations o ON o.id = d.organisation_id
           WHERE d.organisation_id = $1
           ORDER BY o.name ASC, d.name ASC`,
          [requestedOrg]
        );
      } else {
        result = await query(
          `SELECT d.id, d.name, d.organisation_id, o.name as organisation_name, d.created_at
           FROM departments d
           INNER JOIN organisations o ON o.id = d.organisation_id
           ORDER BY o.name ASC, d.name ASC`
        );
      }
    } else if (requesterOrg != null) {
      result = await query(
        `SELECT d.id, d.name, d.organisation_id, o.name as organisation_name, d.created_at
         FROM departments d
         INNER JOIN organisations o ON o.id = d.organisation_id
         WHERE d.organisation_id = $1
         ORDER BY d.name ASC`,
        [requesterOrg]
      );
    } else {
      result = { rows: [] };
    }

    res.json({ departments: getRows(result) });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to fetch departments' });
  }
});

// Admin routes - create department
router.post('/admin/departments', requireAuth, requireAdmin, [
  body('name').trim().isLength({ min: 2, max: 255 }).withMessage('Department name is required'),
  body('organisation_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('organisation_id must be a positive integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const requesterOrg = req.user.organisation_id == null ? null : Number(req.user.organisation_id);
    const requesterIsSuperAdmin = isSuperAdmin(req.user);
    const requestedOrgId = req.body.organisation_id == null ? null : Number(req.body.organisation_id);
    const organisationId = requesterIsSuperAdmin ? requestedOrgId : requesterOrg;

    if (organisationId == null) {
      return res.status(400).json({ error: 'An organisation is required to create a department' });
    }

    if (!requesterIsSuperAdmin && requestedOrgId != null && requestedOrgId !== requesterOrg) {
      return res.status(403).json({ error: 'You can only create departments in your own organisation' });
    }

    const organisationResult = await query('SELECT id, name FROM organisations WHERE id = $1', [organisationId]);
    const organisation = organisationResult.rows?.[0] || organisationResult?.[0];
    if (!organisation) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    const name = String(req.body.name || '').trim();
    const existing = await query(
      'SELECT id FROM departments WHERE organisation_id = $1 AND LOWER(name) = LOWER($2)',
      [organisationId, name]
    );
    if ((existing.rows?.[0] || existing?.[0])?.id) {
      return res.status(400).json({ error: 'Department already exists in this organisation' });
    }

    const inserted = await query(
      'INSERT INTO departments (organisation_id, name) VALUES ($1, $2)',
      [organisationId, name]
    );
    const departmentId = inserted.insertId || inserted.lastID || inserted.rows?.[0]?.id;

    await recordAuditEvent({
      user_id: req.user?.id || null,
      category: 'admin_department_management',
      action: 'create_department',
      outcome: 'success',
      organisation_id: Number(organisation.id) || null,
      department_id: null,
      metadata: getRequestMetadata(req, {
        department_id: departmentId || null,
        department_name: name,
        organisation_name: organisation.name,
      }),
    });

    res.json({
      success: true,
      department: {
        id: departmentId,
        name,
        organisation_id: Number(organisation.id),
        organisation_name: organisation.name
      }
    });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to create department' });
  }
});

// Admin routes - assign user to organisation
router.put('/admin/users/:id/organisation', requireAuth, requireAdmin, [
  body('organisation_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('organisation_id must be a positive integer')
], async (req, res) => {
  try {
    if (!isSuperAdmin(req.user)) {
      return res.status(403).json({ error: 'Only the super admin can change organisation assignments' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const { id } = req.params;
    const orgId = req.body.organisation_id ?? null;
    const guard = await getManageableTargetUser(req.user, Number(id));
    if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
    if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });

    if (orgId != null) {
      const orgCheck = await query('SELECT id, name FROM organisations WHERE id = $1', [orgId]);
      const org = orgCheck.rows?.[0] || orgCheck?.[0];
      if (!org) return res.status(404).json({ error: 'Organisation not found' });
      await query(
        `UPDATE users
         SET organisation_id = $1,
             organisation_name = $2,
             department_id = CASE
               WHEN department_id IN (SELECT id FROM departments WHERE organisation_id = $1) THEN department_id
               ELSE NULL
             END
         WHERE id = $3`,
        [orgId, org.name, id]
      );
    } else {
      await query('UPDATE users SET organisation_id = NULL, organisation_name = NULL, department_id = NULL WHERE id = $1', [id]);
    }

    const result = await query(
      `SELECT u.id, u.email, u.name, u.organisation_id, COALESCE(o.name, u.organisation_name) as organisation_name,
              u.department_id, d.name as department_name
       FROM users u
       LEFT JOIN organisations o ON o.id = u.organisation_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.id = $1`,
      [id]
    );
    const user = result.rows?.[0] || result?.[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    await auditAdminAction(req, 'assign_user_organisation', id, {
      target_email: user.email,
      organisation_id: user.organisation_id == null ? null : Number(user.organisation_id),
      organisation_name: user.organisation_name || null,
    });

    res.json({ success: true, user });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to assign organisation' });
  }
});

// Admin routes - assign user to department
router.put('/admin/users/:id/department', requireAuth, requireAdmin, [
  body('department_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('department_id must be a positive integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { id } = req.params;
    const departmentId = req.body.department_id ?? null;
    const guard = await getManageableTargetUser(req.user, Number(id));
    if (guard.status === 'not_found') return res.status(404).json({ error: 'User not found' });
    if (guard.status === 'forbidden') return res.status(403).json({ error: 'Cannot manage users outside your organisation' });

    const requesterOrg = req.user.organisation_id == null ? null : Number(req.user.organisation_id);
    const targetOrg = guard.target.organisation_id == null ? null : Number(guard.target.organisation_id);
    const requesterIsSuperAdmin = isSuperAdmin(req.user);

    if (departmentId == null) {
      await query('UPDATE users SET department_id = NULL WHERE id = $1', [id]);
    } else {
      const department = await getDepartmentById(Number(departmentId));
      if (!department) return res.status(404).json({ error: 'Department not found' });

      if (!requesterIsSuperAdmin && requesterOrg !== Number(department.organisation_id)) {
        return res.status(403).json({ error: 'You can only assign departments in your own organisation' });
      }

      if (targetOrg != null && targetOrg !== Number(department.organisation_id)) {
        return res.status(400).json({ error: 'The selected department belongs to a different organisation' });
      }

      await query(
        `UPDATE users
         SET organisation_id = $1,
             organisation_name = $2,
             department_id = $3
         WHERE id = $4`,
        [department.organisation_id, department.organisation_name, department.id, id]
      );
    }

    const result = await query(
      `SELECT u.id, u.email, u.name, u.organisation_id, COALESCE(o.name, u.organisation_name) as organisation_name,
              u.department_id, d.name as department_name
       FROM users u
       LEFT JOIN organisations o ON o.id = u.organisation_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.id = $1`,
      [id]
    );
    const user = result.rows?.[0] || result?.[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    await auditAdminAction(req, 'assign_user_department', id, {
      target_email: user.email,
      organisation_id: user.organisation_id == null ? null : Number(user.organisation_id),
      organisation_name: user.organisation_name || null,
      department_id: user.department_id == null ? null : Number(user.department_id),
      department_name: user.department_name || null,
    });

    res.json({ success: true, user });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Failed to assign department' });
  }
});

// Logout (client-side token removal, but we can track it server-side if needed)
router.post('/logout', requireAuth, async (req, res) => {
  // In a JWT system, logout is handled client-side by removing the token
  // We could implement token blacklisting here if needed
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;

// ── Token refresh ─────────────────────────────────────────────────────────────
// POST /api/auth/refresh  — exchange a valid refresh token for a new access + refresh pair
router.post('/refresh', authLimiter, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const result = await query(
      `SELECT u.id, u.email, u.name, u.role, u.is_active, u.is_approved, u.organisation_id,
              u.department_id, u.features, o.features as organisation_features
       FROM users u
       LEFT JOIN organisations o ON o.id = u.organisation_id
       WHERE u.id = $1`,
      [decoded.userId]
    );
    const user = result.rows?.[0] || result?.[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'User account not found or inactive' });
    if (!user.is_approved) return res.status(403).json({ error: 'Account pending approval' });

    const token = generateToken(user.id);
    const newRefreshToken = generateRefreshToken(user.id);
    res.json({ token, refreshToken: newRefreshToken });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ── Forgot password ───────────────────────────────────────────────────────────
// POST /api/auth/forgot-password  — send a password reset email
router.post('/forgot-password', authLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { email } = req.body;

    // Always return success to prevent email enumeration
    const result = await query(
      'SELECT id, name, is_active FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows?.[0] || result?.[0];

    if (user && user.is_active) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await query(
        `UPDATE users SET verification_token = $1, token_expires_at = $2 WHERE id = $3`,
        [token, expiresAt.toISOString(), user.id]
      );

      try {
        await emailService.sendPasswordResetEmail(email, token, user.name);
      } catch (emailErr) {
        logger.error({ err: emailErr });
        // Don't expose email failure to client
      }
    }

    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Password reset request failed' });
  }
});

// POST /api/auth/reset-password  — apply new password using a reset token
router.post('/reset-password', authLimiter, [
  body('token').notEmpty().withMessage('Reset token required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  try {
    const { token, password } = req.body;

    const result = await query(
      `SELECT id, email FROM users
       WHERE verification_token = $1
         AND token_expires_at > NOW()
         AND is_active = true`,
      [token]
    );
    const user = result.rows?.[0] || result?.[0];
    if (!user) return res.status(400).json({ error: 'Reset token is invalid or has expired' });

    const hashedPassword = await bcrypt.hash(password, 12);

    await query(
      `UPDATE users
       SET password_hash = $1, verification_token = NULL, token_expires_at = NULL
       WHERE id = $2`,
      [hashedPassword, user.id]
    );

    res.json({ message: 'Password reset successfully. You can now sign in.' });
  } catch (error) {
    logger.error({ err: error });
    res.status(500).json({ error: 'Password reset failed' });
  }
});
