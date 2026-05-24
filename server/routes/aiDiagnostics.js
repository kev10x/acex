const express = require('express');
const fs = require('fs');
const path = require('path');
const aiService = require('../services/aiService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const FAILED_DIR = path.join(process.cwd(), 'logs', 'ai_failed_responses');
const REPAIRED_DIR = path.join(process.cwd(), 'logs', 'ai_repaired');

// Ensure directories exist
if (!fs.existsSync(FAILED_DIR)) fs.mkdirSync(FAILED_DIR, { recursive: true });
if (!fs.existsSync(REPAIRED_DIR)) fs.mkdirSync(REPAIRED_DIR, { recursive: true });

// List failed AI responses
router.get('/failed', requireAuth, async (req, res) => {
  try {
    const files = fs.readdirSync(FAILED_DIR).map(name => {
      const stat = fs.statSync(path.join(FAILED_DIR, name));
      return { name, size: stat.size, mtime: stat.mtime };
    }).sort((a,b) => b.mtime - a.mtime);
    res.json({ success: true, files });
  } catch (error) {
    console.error('List failed AI responses error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Simple stats: counts and last failure time
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const failedFiles = fs.readdirSync(FAILED_DIR).map(name => ({ name, mtime: fs.statSync(path.join(FAILED_DIR, name)).mtime }));
    const repairedFiles = fs.readdirSync(REPAIRED_DIR).map(name => ({ name, mtime: fs.statSync(path.join(REPAIRED_DIR, name)).mtime }));
    const lastFailure = failedFiles.length > 0 ? failedFiles.sort((a,b) => b.mtime - a.mtime)[0].mtime : null;
    res.json({ success: true, failed_count: failedFiles.length, repaired_count: repairedFiles.length, last_failure: lastFailure });
  } catch (error) {
    console.error('Stats endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Reparse a single failed file or all files
router.post('/reparse', requireAuth, async (req, res) => {
  try {
    const { filename, all } = req.body || {};
    const toProcess = [];

    if (all) {
      fs.readdirSync(FAILED_DIR).forEach(f => toProcess.push(f));
    } else if (filename) {
      toProcess.push(filename);
    } else {
      return res.status(400).json({ success: false, error: 'Provide filename or set all=true' });
    }

    const summary = [];

    for (const f of toProcess) {
      const p = path.join(FAILED_DIR, f);
      if (!fs.existsSync(p)) {
        summary.push({ file: f, status: 'not_found' });
        continue;
      }

      const raw = fs.readFileSync(p, 'utf8');

      // First try local parse
      try {
        const parsed = JSON.parse(raw);
        const outPath = path.join(REPAIRED_DIR, f.replace(/\.txt$/i, '.json'));
        fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf8');
        summary.push({ file: f, status: 'parsed_locally', out: outPath });
        continue;
      } catch (e) {
        // fall through to AI-assisted extraction
      }

      try {
        const extractionPrompt = `Extract and return ONLY the JSON object or array contained in the text below. Do NOT add commentary. If none, return the single token NONE.\n\nRESPONSE:\n${raw.substring(0, 20000)}`;
        const provider = (process.env.OPENAI_API_KEY) ? 'openai' : (process.env.ANTHROPIC_API_KEY ? 'anthropic' : null);
        if (!provider) {
          summary.push({ file: f, status: 'no_ai_provider_configured' });
          continue;
        }

        const model = provider === 'openai' ? 'gpt-5-mini' : 'claude-3-haiku-20240307';
        const result = await aiService.createCompletionWithRetry({
          provider,
          model,
          messages: [{ role: 'user', content: extractionPrompt }],
          temperature: 0.0,
          maxTokens: 16000
        }, 2);

        const resp = String(result.content || '').trim();
        if (!resp || resp === 'NONE') {
          summary.push({ file: f, status: 'ai_extraction_none' });
          continue;
        }

        const candidate = resp.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        try {
          const parsed = JSON.parse(candidate);
          const outPath = path.join(REPAIRED_DIR, f.replace(/\.txt$/i, '.json'));
          fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf8');
          summary.push({ file: f, status: 'repaired_by_ai', out: outPath });
        } catch (err2) {
          const failPath = path.join(REPAIRED_DIR, f + '.failed.txt');
          fs.writeFileSync(failPath, candidate, 'utf8');
          summary.push({ file: f, status: 'ai_extraction_invalid_json', out: failPath });
        }
      } catch (aiErr) {
        console.error('AI-assisted reparse failed for', f, aiErr.message);
        summary.push({ file: f, status: 'ai_error', error: aiErr.message });
      }
    }

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Reparse endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
