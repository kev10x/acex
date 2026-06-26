const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const { initDatabase, query } = require('./database/connection');
const { startOpenAIBatchPolling } = require('./services/openaiBatchMarkingService');
const { startContentPlannerPolling } = require('./services/contentPlannerService');
const { startGenerationJobWorkerPolling } = require('./services/generationJobWorkerService');
const { scheduleFailedResponseCleanup } = require('./services/logger');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const basePath = (process.env.BASE_PATH || '').replace(/\/$/, '');
const isProd = process.env.NODE_ENV === 'production';

// ── Trust proxy ───────────────────────────────────────────────────────────────
function parseTrustProxy(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return asNum;
  return value;
}

const trustProxySetting = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxySetting != null) {
  app.set('trust proxy', trustProxySetting);
} else if (isProd) {
  app.set('trust proxy', 1);
}

// ── Security headers (helmet) ─────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: isProd ? undefined : false, // relax CSP in dev
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  crossOriginEmbedderPolicy: false, // required for PDF.js
}));

// Force HTTPS in production
if (isProd) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

// ── Compression ───────────────────────────────────────────────────────────────
app.use(compression());

// ── Request logging ───────────────────────────────────────────────────────────
const morganFormat = isProd
  ? ':remote-addr - :method :url :status :res[content-length] - :response-time ms'
  : 'dev';
app.use(morgan(morganFormat));

// ── CORS ──────────────────────────────────────────────────────────────────────
const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
];
const envOrigins = (process.env.CLIENT_URLS || process.env.CLIENT_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = [...new Set([...envOrigins, ...defaultOrigins])];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Disposition'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Static files ──────────────────────────────────────────────────────────────
const uploadsPath = path.join(__dirname, 'uploads');
app.use('/uploads', express.static(uploadsPath));
if (basePath) {
  app.use(basePath + '/uploads', express.static(uploadsPath));
}

// ── API router ────────────────────────────────────────────────────────────────
const apiRouter = express.Router();
apiRouter.use('/auth', require('./routes/auth'));
apiRouter.use('/upload', require('./routes/upload'));
apiRouter.use('/rubrics', require('./routes/rubrics'));
apiRouter.use('/mark', require('./routes/mark'));
apiRouter.use('/results', require('./routes/results'));
const batchesRouter = require('./routes/batches');
apiRouter.use('/batches', batchesRouter);
apiRouter.use('/rubric-generator', require('./routes/rubric-generator'));
apiRouter.use('/reports', require('./routes/reports'));
apiRouter.use('/mcq', require('./routes/mcq'));
apiRouter.use('/training', require('./routes/training'));
apiRouter.use('/local-models', require('./routes/local-models'));
apiRouter.use('/assessments', require('./routes/assessments'));
apiRouter.use('/content', require('./routes/content'));
apiRouter.use('/modules', require('./routes/modules'));
apiRouter.use('/moodle', require('./routes/moodle'));
apiRouter.use('/slide-gen', require('./routes/slideGen'));
apiRouter.use('/pptx-jobs', require('./routes/pptxJobs'));
apiRouter.use('/system', require('./routes/system'));
apiRouter.use('/ai-diagnostics', require('./routes/aiDiagnostics'));

// ── Rich health check ─────────────────────────────────────────────────────────
apiRouter.get('/health', async (req, res) => {
  const start = Date.now();
  const checks = { db: 'unknown', ai_provider: process.env.AI_PROVIDER || 'openai' };
  let httpStatus = 200;

  try {
    await query('SELECT 1');
    checks.db = 'ok';
  } catch (err) {
    checks.db = 'error';
    httpStatus = 503;
  }

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  checks.ai_key_configured = hasOpenAI || hasAnthropic;
  if (!checks.ai_key_configured) httpStatus = 503;

  res.status(httpStatus).json({
    status: httpStatus === 200 ? 'OK' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    response_time_ms: Date.now() - start,
    checks,
    version: process.env.npm_package_version || '1.0.0',
  });
});

app.use('/api', apiRouter);
if (basePath) {
  app.use(basePath + '/api', apiRouter);
  console.log(`[acexen] API also mounted at ${basePath}/api`);
}

// ── Error handling ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  // Don't log 4xx client errors as errors
  if (status >= 500) logger.error({ err: err });
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : (err.message || 'Request failed'),
    ...(process.env.NODE_ENV === 'development' && status >= 500 ? { detail: err.message } : {}),
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
let server;

const startServer = async () => {
  try {
    await initDatabase();
    batchesRouter.recoverScheduledJobs();
    startOpenAIBatchPolling();
    startContentPlannerPolling();
    startGenerationJobWorkerPolling();
    scheduleFailedResponseCleanup();
    server = app.listen(PORT, () => {
      console.log(`[acexen] Server running on port ${PORT} (${isProd ? 'production' : 'development'})`);
    });
  } catch (error) {
    logger.error({ err: error });
    process.exit(1);
  }
};

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`\n[acexen] Received ${signal}. Shutting down gracefully…`);
  if (server) {
    server.close(() => {
      logger.info('[acexen] HTTP server closed.');
      process.exit(0);
    });
    // Force exit after 10 s
    setTimeout(() => {
      console.error('[acexen] Forced exit after timeout.');
      process.exit(1);
    }, 10_000).unref();
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();
