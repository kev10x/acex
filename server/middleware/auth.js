const jwt = require('jsonwebtoken');
const { query } = require('../database/connection');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// Middleware to authenticate JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Verify user still exists and is active
    const userResult = await query(
      'SELECT id, email, name, is_active, role, is_approved FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    const user = userResult.rows?.[0] || userResult?.[0];
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      is_approved: user.is_approved
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('Auth middleware error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
};

// Middleware to require authentication (returns 401 if not authenticated)
const requireAuth = authenticateToken;

// Middleware for optional authentication (doesn't fail if no token)
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userResult = await query(
        'SELECT id, email, name, is_active, role, is_approved FROM users WHERE id = $1',
        [decoded.userId]
      );
      
      const user = userResult.rows?.[0] || userResult?.[0];
      
      if (user && user.is_active) {
        req.user = {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          is_approved: user.is_approved
        };
      }
    }
    
    next();
  } catch (error) {
    // Ignore auth errors for optional auth
    next();
  }
};

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
};

// Middleware to require admin role
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    return res.status(500).json({ error: 'Authorization error' });
  }
};

// Parse user features from DB (JSON string or object)
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

// Middleware to require a specific user feature (e.g. generate_assessments, download_results). Use after requireAuth. Admins bypass.
const requireFeature = (featureName) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (req.user.role === 'admin') {
        return next();
      }
      const result = await query('SELECT features FROM users WHERE id = $1', [req.user.id]);
      const row = result.rows?.[0] || result?.[0];
      const features = parseUserFeatures(row?.features);
      const allowed = features[featureName] !== false;
      if (!allowed) {
        return res.status(403).json({ error: 'This feature is not enabled for your account. Contact an administrator.' });
      }
      next();
    } catch (error) {
      console.error('Feature check error:', error);
      return res.status(500).json({ error: 'Authorization error' });
    }
  };
};

module.exports = {
  authenticateToken,
  requireAuth,
  requireAdmin,
  requireFeature,
  optionalAuth,
  generateToken,
  JWT_SECRET,
  JWT_EXPIRES_IN
};
