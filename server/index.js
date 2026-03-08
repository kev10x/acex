const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./database/connection');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
// Robust CORS: allow multiple frontend origins via CLIENT_URL or CLIENT_URLS (comma-separated)
const defaultOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
];
const envOrigins = (process.env.CLIENT_URLS || process.env.CLIENT_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...envOrigins, ...defaultOrigins])];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow non-browser or same-origin
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  exposedHeaders: ['Content-Disposition']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API router (mount at /api and optionally at BASE_PATH + /api when proxy forwards full path e.g. /tools/api)
const apiRouter = express.Router();
apiRouter.use('/auth', require('./routes/auth'));
apiRouter.use('/upload', require('./routes/upload'));
apiRouter.use('/rubrics', require('./routes/rubrics'));
apiRouter.use('/mark', require('./routes/mark'));
apiRouter.use('/results', require('./routes/results'));
apiRouter.use('/batches', require('./routes/batches'));
apiRouter.use('/rubric-generator', require('./routes/rubric-generator'));
apiRouter.use('/reports', require('./routes/reports'));
apiRouter.use('/mcq', require('./routes/mcq'));
apiRouter.use('/training', require('./routes/training'));
apiRouter.use('/local-models', require('./routes/local-models'));
apiRouter.use('/assessments', require('./routes/assessments'));
apiRouter.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.use('/api', apiRouter);
const basePath = (process.env.BASE_PATH || '').replace(/\/$/, '');
if (basePath) {
  app.use(basePath + '/api', apiRouter);
  console.log('API also mounted at', basePath + '/api');
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Initialize database and start server
const startServer = async () => {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
