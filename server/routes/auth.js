const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const { query } = require('../database/connection');
const { requireAuth, generateToken } = require('../middleware/auth');

const router = express.Router();

// Register new user
router.post('/register', [
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

    // Create user (account_type and organisation_name columns added via migration)
    const result = await query(
      'INSERT INTO users (email, password_hash, name, account_type, organisation_name) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, account_type, organisation_name, created_at',
      [email, passwordHash, name || null, accountType, orgName]
    );

    const user = result.rows?.[0] || result?.[0];

    // Generate token
    const token = generateToken(user.id);

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        account_type: user.account_type || 'individual',
        organisation_name: user.organisation_name || null
      },
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user' });
  }
});

// Login
router.post('/login', [
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
      'SELECT id, email, password_hash, name, is_active, account_type, organisation_name FROM users WHERE email = $1',
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

    // Update last login
    await query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );

    // Generate token
    const token = generateToken(user.id);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        account_type: user.account_type || 'individual',
        organisation_name: user.organisation_name || null
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Get current user info
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, email, name, created_at, last_login, account_type, organisation_name FROM users WHERE id = $1',
      [req.user.id]
    );

    const user = result.rows?.[0] || result?.[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at,
        last_login: user.last_login,
        account_type: user.account_type || 'individual',
        organisation_name: user.organisation_name || null
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
      RETURNING id, email, name, updated_at
    `;

    const result = await query(updateQuery, values);

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

// Logout (client-side token removal, but we can track it server-side if needed)
router.post('/logout', requireAuth, async (req, res) => {
  // In a JWT system, logout is handled client-side by removing the token
  // We could implement token blacklisting here if needed
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
