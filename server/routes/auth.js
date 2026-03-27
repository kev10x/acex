const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { query } = require('../database/connection');
const { requireAuth, requireAdmin, generateToken, normalizeRole } = require('../middleware/auth');
const emailService = require('../services/emailService');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

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

    // Create user (account_type, organisation_name, and verification columns)
    const result = await query(
      'INSERT INTO users (email, password_hash, name, account_type, organisation_name, email_verified, verification_token, verification_token_expires, role, is_approved) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [email, passwordHash, name || null, accountType, orgName, false, verificationToken, verificationTokenExpires, 'lecturer', false]
    );

    // Get the inserted user ID (MySQL uses insertId, PostgreSQL uses RETURNING)
    const userId = result.insertId || result.lastID || (result.rows?.[0]?.id);
    
    if (!userId) {
      throw new Error('Failed to get user ID after insertion');
    }
    
    // Fetch the created user
    const userResult = await query(
      'SELECT id, email, name, created_at, account_type, organisation_name FROM users WHERE id = $1',
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
      console.error('Failed to send verification email:', emailError);
      // Continue even if email fails - user can request resend later
      console.log('⚠️  Verification URL (email not sent):', verificationUrl);
    }

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
        email_verified: false
      },
      requiresVerification: true,
      verificationUrl: verificationUrl // Include verification URL if email wasn't sent or in dev mode
    });
  } catch (error) {
    console.error('Registration error:', error);
    // Provide more detailed error message for debugging
    const errorMessage = error.message || 'Failed to register user';
    console.error('Registration error details:', {
      message: errorMessage,
      code: error.code,
      sql: error.sql,
      sqlMessage: error.sqlMessage
    });
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
      'SELECT id, email, password_hash, name, is_active, email_verified, is_approved, role, account_type, organisation_name, features FROM users WHERE email = $1',
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

    // Generate token
    const token = generateToken(user.id);

    const features = parseUserFeatures(user.features);
    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        account_type: user.account_type || 'individual',
        organisation_name: user.organisation_name || null,
        role: normalizeRole(user.role),
        features
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Parse features from DB (JSON string or object). Null/undefined => {} so missing keys mean "allowed".
function parseUserFeatures(features) {
  if (features == null) return {};
  if (typeof features === 'string') {
    try {
      return JSON.parse(features) || {};
    } catch (_) {
      return {};
    }
  }
  return typeof features === 'object' ? features : {};
}

// Get current user info
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, name, created_at, last_login, account_type, organisation_name, email_verified, is_approved, role, features FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const features = parseUserFeatures(user.features);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at,
        last_login: user.last_login,
        account_type: user.account_type || 'individual',
        organisation_name: user.organisation_name || null,
        email_verified: user.email_verified,
        is_approved: user.is_approved,
        role: normalizeRole(user.role),
        features
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
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
    console.error('Update profile error:', error);
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
    console.error('Change password error:', error);
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
    console.error('Email verification error:', error);
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
      console.error('Failed to send verification email:', emailError);
      res.status(500).json({ error: 'Failed to send verification email' });
    }
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

// Normalize DB rows to array (MySQL returns result.rows, pg returns result.rows)
const getRows = (result) => {
  if (Array.isArray(result.rows)) return result.rows;
  if (Array.isArray(result)) return result;
  return [];
};

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
  features: parseUserFeatures(u.features)
});

// Admin routes - Get pending users
router.get('/admin/pending-users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, email, name, created_at, email_verified, is_approved, role, features
      FROM users 
      WHERE email_verified = 1 AND is_approved = 0
      ORDER BY created_at DESC
    `);

    const rows = getRows(result);
    const users = rows.map(u => ({
      ...mapUser(u),
      last_login: undefined,
      is_active: undefined
    }));

    res.json({ users });
  } catch (error) {
    console.error('Get pending users error:', error);
    res.status(500).json({ error: 'Failed to get pending users' });
  }
});

// Admin routes - Get all users
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, email, name, created_at, last_login, email_verified, is_approved, role, is_active, features
      FROM users 
      ORDER BY created_at DESC
    `);

    const rows = getRows(result);
    const users = rows.map(mapUser);

    res.json({ users });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Admin routes - Approve user
router.post('/admin/users/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await query('UPDATE users SET is_approved = 1 WHERE id = $1', [id]);
    const result = await query(
      'SELECT id, email, name, is_approved FROM users WHERE id = $1',
      [id]
    );
    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

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
    console.error('Approve user error:', error);
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
    console.error('Reject user error:', error);
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
    console.error('Lock user error:', error);
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

    const target = await query(
      'SELECT id, role FROM users WHERE id = $1',
      [targetId]
    );
    const targetUser = target.rows?.[0] || target?.[0];
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

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

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Admin routes - Update user features (e.g. generate_assessments, download_results, feedback_video)
// Support both PUT and PATCH so the route is found regardless of client or proxy behavior
const updateUserFeaturesHandler = [
  requireAuth,
  requireAdmin,
  body('features').optional().isObject(),
  body('features.generate_assessments').optional().isBoolean(),
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
      if (!features || typeof features !== 'object') {
        return res.status(400).json({ error: 'features object required' });
      }
      const allowed = {
        generate_assessments: !!features.generate_assessments,
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
      res.json({
        message: 'User features updated',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          features: parseUserFeatures(user.features)
        }
      });
    } catch (error) {
      console.error('Update user features error:', error);
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
    console.error('Update user role error:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Logout (client-side token removal, but we can track it server-side if needed)
router.post('/logout', requireAuth, async (req, res) => {
  // In a JWT system, logout is handled client-side by removing the token
  // We could implement token blacklisting here if needed
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
