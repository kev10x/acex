const fs = require('fs');
const path = require('path');

const FAILED_RESPONSES_DIR = path.join(process.cwd(), 'logs', 'ai_failed_responses');
const FAILED_RESPONSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function formatEntry(level, message, meta) {
  const entry = { ts: new Date().toISOString(), level, msg: message };
  if (meta && typeof meta === 'object') Object.assign(entry, meta);
  return JSON.stringify(entry);
}

const logger = {
  info(message, meta) {
    process.stdout.write(formatEntry('info', message, meta) + '\n');
  },
  warn(message, meta) {
    process.stderr.write(formatEntry('warn', message, meta) + '\n');
  },
  error(message, meta) {
    process.stderr.write(formatEntry('error', message, meta) + '\n');
  },

  saveFailedResponse(response, assignmentId) {
    try {
      if (!fs.existsSync(FAILED_RESPONSES_DIR)) {
        fs.mkdirSync(FAILED_RESPONSES_DIR, { recursive: true });
      }
      const fileName = `${Date.now()}_${assignmentId || 'no_assignment'}.txt`;
      const filePath = path.join(FAILED_RESPONSES_DIR, fileName);
      fs.writeFileSync(filePath, response, 'utf8');
      this.error('Saved raw failed AI response', { filePath });
    } catch (err) {
      this.error('Failed to persist raw AI response', { error: err.message });
    }
  }
};

function cleanupOldFailedResponses() {
  if (!fs.existsSync(FAILED_RESPONSES_DIR)) return;
  const now = Date.now();
  let removed = 0;
  try {
    for (const file of fs.readdirSync(FAILED_RESPONSES_DIR)) {
      const filePath = path.join(FAILED_RESPONSES_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > FAILED_RESPONSE_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info('Cleaned up old failed AI response files', { removed });
    }
  } catch (err) {
    logger.error('Failed response cleanup error', { error: err.message });
  }
}

function scheduleFailedResponseCleanup() {
  cleanupOldFailedResponses();
  setInterval(cleanupOldFailedResponses, CLEANUP_INTERVAL_MS).unref();
}

module.exports = { logger, cleanupOldFailedResponses, scheduleFailedResponseCleanup };
