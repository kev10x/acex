const jwt = require('jsonwebtoken');
const { query } = require('../database/connection');

// In-memory throttle: jti → timestamp of last DB last_seen_at update
const lastSeenCache = new Map();
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_JWT_SECRET = 'your-secret-key-change-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const SUPER_ADMIN_EMAIL = 'kkativu@gmail.com';
const ROLE_ALIASES = {
  admin: 'management',
  user: 'lecturer'
};
const FEATURE_KEYS = ['assessment_creation', 'content_creation', 'download_results', 'feedback_video'];
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
      `SELECT u.id, u.email, u.name, u.is_active, u.role, u.is_approved, u.organisation_id,
              u.department_id, COALESCE(o.name, u.organisation_name) as organisation_name,
              d.name as department_name, u.features as user_features, o.features as organisation_features
       FROM users u
       LEFT JOIN organisations o ON o.id = u.organisation_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.id = $1`,
      [decoded.userId]
    );
    
    const user = userResult.rows?.[0] || userResult?.[0];
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    // Check session validity (jti-based revocation) — only for tokens that carry a jti
    if (decoded.jti) {
      const sessionResult = await query(
        'SELECT id, is_active FROM user_sessions WHERE jti = $1',
        [decoded.jti]
      );
      const session = sessionResult.rows?.[0] || sessionResult?.[0];
      if (!session || !session.is_active) {
        return res.status(401).json({ error: 'Session has been revoked' });
      }
      // Throttle last_seen_at updates to avoid a DB write on every request
      const now = Date.now();
      const lastUpdate = lastSeenCache.get(decoded.jti) || 0;
      if (now - lastUpdate > LAST_SEEN_INTERVAL_MS) {
        lastSeenCache.set(decoded.jti, now);
        query(
          'UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE jti = $1',
          [decoded.jti]
        ).catch(() => {});
      }
      req.sessionJti = decoded.jti;
    }

    const features = mergeFeatures(user.user_features, user.organisation_features);

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: normalizeRole(user.role),
      is_approved: user.is_approved,
      organisation_id: user.organisation_id || null,
      organisation_name: user.organisation_name || null,
      department_id: user.department_id || null,
      department_name: user.department_name || null,
      features,
      impersonation: decoded.impersonatedBy
        ? {
            active: true,
            impersonated_by: decoded.impersonatedBy,
            impersonated_by_email: decoded.impersonatedByEmail || null,
            impersonated_by_name: decoded.impersonatedByName || null
          }
        : null
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
        `SELECT u.id, u.email, u.name, u.is_active, u.role, u.is_approved, u.organisation_id,
                u.department_id, COALESCE(o.name, u.organisation_name) as organisation_name,
                d.name as department_name, u.features as user_features, o.features as organisation_features
         FROM users u
         LEFT JOIN organisations o ON o.id = u.organisation_id
         LEFT JOIN departments d ON d.id = u.department_id
         WHERE u.id = $1`,
        [decoded.userId]
      );
      
      const user = userResult.rows?.[0] || userResult?.[0];
      
      if (user && user.is_active) {
        const features = mergeFeatures(user.user_features, user.organisation_features);
        req.user = {
          id: user.id,
          email: user.email,
          name: user.name,
          role: normalizeRole(user.role),
          is_approved: user.is_approved,
          organisation_id: user.organisation_id || null,
          organisation_name: user.organisation_name || null,
          department_id: user.department_id || null,
          department_name: user.department_name || null,
          features,
          impersonation: decoded.impersonatedBy
            ? {
                active: true,
                impersonated_by: decoded.impersonatedBy,
                impersonated_by_email: decoded.impersonatedByEmail || null,
                impersonated_by_name: decoded.impersonatedByName || null
              }
            : null
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
const generateToken = (userId, extras = {}) => {
  return jwt.sign({ userId, ...extras }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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

function normalizeFeatureSet(features) {
  const parsed = parseUserFeatures(features);
  const legacyGenerateAssessments = parsed.generate_assessments;
  const normalized = {
    assessment_creation: parsed.assessment_creation,
    content_creation: parsed.content_creation,
    download_results: parsed.download_results,
    feedback_video: parsed.feedback_video
  };
  if (normalized.assessment_creation === undefined && legacyGenerateAssessments !== undefined) {
    normalized.assessment_creation = legacyGenerateAssessments;
  }
  if (normalized.content_creation === undefined && legacyGenerateAssessments !== undefined) {
    normalized.content_creation = legacyGenerateAssessments;
  }
  return normalized;
}

function mergeFeatures(userFeatures, organisationFeatures) {
  const merged = {};
  const user = normalizeFeatureSet(userFeatures);
  const organisation = normalizeFeatureSet(organisationFeatures);
  FEATURE_KEYS.forEach((key) => {
    if (organisation[key] === false || user[key] === false) {
      merged[key] = false;
    } else if (organisation[key] === true || user[key] === true) {
      merged[key] = true;
    }
  });
  return merged;
}

// Middleware to require a specific user feature (e.g. generate_assessments, download_results). Use after requireAuth. Admins bypass.
const requireFeature = (featureName) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (String(req.user.email || '').trim().toLowerCase() === SUPER_ADMIN_EMAIL) {
        return next();
      }
      const result = await query(
        `SELECT u.features as user_features, o.features as organisation_features
         FROM users u
         LEFT JOIN organisations o ON o.id = u.organisation_id
         WHERE u.id = $1`,
        [req.user.id]
      );
      const row = result.rows?.[0] || result?.[0];
      const features = mergeFeatures(row?.user_features, row?.organisation_features);
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
  JWT_EXPIRES_IN,
  parseUserFeatures,
  mergeFeatures,
  normalizeFeatureSet
};
