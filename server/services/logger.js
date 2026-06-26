const fs = require('fs');
const path = require('path');
const pino = require('pino');

// ── Pino instance ─────────────────────────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  ...(isProd
    ? {}                          // plain JSON in production (pipe to log shipper)
    : {
        transport: {
          target: 'pino-pretty',  // coloured human-readable output in dev
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' }
        }
      }
  )
});

// ── Failed AI response persistence ───────────────────────────────────────────
const FAILED_RESPONSES_DIR = path.join(process.cwd(), 'logs', 'ai_failed_responses');
const FAILED_RESPONSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;            // 24 hours

logger.saveFailedResponse = function saveFailedResponse(response, assignmentId) {
  try {
    if (!fs.existsSync(FAILED_RESPONSES_DIR)) {
      fs.mkdirSync(FAILED_RESPONSES_DIR, { recursive: true });
    }
    const fileName = `${Date.now()}_${assignmentId || 'no_assignment'}.txt`;
    const filePath = path.join(FAILED_RESPONSES_DIR, fileName);
    fs.writeFileSync(filePath, response, 'utf8');
    logger.error({ filePath }, 'Saved raw failed AI response');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to persist raw AI response');
  }
};

// ── Cleanup job ───────────────────────────────────────────────────────────────
function cleanupOldFailedResponses() {
  if (!fs.existsSync(FAILED_RESPONSES_DIR)) return;
  const now = Date.now();
  let removed = 0;
  try {
    for (const file of fs.readdirSync(FAILED_RESPONSES_DIR)) {
      const filePath = path.join(FAILED_RESPONSES_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > FAILED_RESPONSE_MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch (_) {}
    }
    if (removed > 0) logger.info({ removed }, 'Cleaned up old failed AI response files');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed response cleanup error');
  }
}

function scheduleFailedResponseCleanup() {
  cleanupOldFailedResponses();
  setInterval(cleanupOldFailedResponses, CLEANUP_INTERVAL_MS);
}

module.exports = { logger, scheduleFailedResponseCleanup };
