const jwt = require('jsonwebtoken');
const { query } = require('../database/connection');

const DEFAULT_JWT_SECRET = 'your-secret-key-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const ROLE_ALIASES = {
  admin: 'management',
  user: 'lecturer'
};
const normalizeRole = (role) => ROLE_ALIASES[String(role || '').toLowerCase()] || String(role || 'lecturer').toLowerCase();

if (JWT_SECRET === DEFAULT_JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is not set. Set the JWT_SECRET environment variable before running in production.');
    process.exit(1);
  } else {
    console.warn('WARNING: JWT_SECRET is using the insecure default. Set JWT_SECRET in your .env file.');
  }
}

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
      role: normalizeRole(user.role),
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
          role: normalizeRole(user.role),
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

    if (req.user.role !== 'management') {
      return res.status(403).json({ error: 'Management access required' });
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    return res.status(500).json({ error: 'Authorization error' });
  }
};

// Middleware to require one of the allowed roles (normalized roles)
const requireRoles = (allowedRoles = []) => {
  const allowed = new Set((Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]).map((r) => String(r).toLowerCase()));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const role = normalizeRole(req.user.role);
    if (!allowed.has(role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    next();
  };
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
      if (req.user.role === 'management') {
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
  requireRoles,
  normalizeRole,
  requireFeature,
  optionalAuth,
  generateToken,
  JWT_SECRET,
  JWT_EXPIRES_IN
};
