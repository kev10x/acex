/**
 * Content generator: create course content, export to PPTX/lecture notes, publish for students.
 * Optional Sora video; optional PowerPoint template upload. Quizzes in content are marked on submit.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const yauzl = require('yauzl');
const { query } = require('../database/connection');
const { requireAuth, requireFeature } = require('../middleware/auth');
const lessonSummaryVideoService = require('../services/lessonSummaryVideoService');
const contentService = require('../services/contentService');
const aiService = require('../services/aiService');
const feedbackVideoService = require('../services/feedbackVideoService');
const { runContentPlannerCycle } = require('../services/contentPlannerService');
const { buildContentScormPackage } = require('../services/contentExport');
const aiConfig = require('../config/ai-config');
const { assertWithinBudgetOrThrow } = require('../services/budgetGuardrailService');
const {
  inferGenerationErrorType,
  logGenerationTelemetry,
  persistGenerationTelemetryEvent,
} = require('../services/generationTelemetryService');
const { createGenerationJob, updateGenerationJob, JOB_STATUS, getGenerationJobById } = require('../services/generationJobService');
const { resolvePromptRegistryVersion } = require('../services/promptRegistryService');
const { JWT_SECRET } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const API_BASE = (process.env.API_PUBLIC_BASE || '').replace(/\/$/, '') || '/api';
const MAX_CONTENT_SECTIONS = Math.max(20, Number.parseInt(process.env.CONTENT_MAX_SECTIONS || '120', 10) || 120);

// Progress percentages reported to the client during POST /content/generate, in pipeline
// order. Each *_START/*_END pair brackets a stage whose progress is interpolated by ratio
// (e.g. sections generated / total sections) between those two bounds.
const GENERATION_PROGRESS = {
  VALIDATING: 6,
  PLAN_BUILT: 12,
  SECTIONS_PLANNING: 16,
  SECTIONS_START: 20,
  SECTIONS_END: 76,
  BEAUTIFY_START: 77,
  BEAUTIFY_END: 84,
  VISUALS_START: 84,
  VISUALS_END: 94,
  MASCOTS_START: 94,
  MASCOTS_END: 97,
  FINALIZING: 98,
};
const GENERATION_PROGRESS_SECTIONS_SPAN = GENERATION_PROGRESS.SECTIONS_END - GENERATION_PROGRESS.SECTIONS_START;
const GENERATION_PROGRESS_BEAUTIFY_SPAN = GENERATION_PROGRESS.BEAUTIFY_END - GENERATION_PROGRESS.BEAUTIFY_START;
const GENERATION_PROGRESS_VISUALS_SPAN = GENERATION_PROGRESS.VISUALS_END - GENERATION_PROGRESS.VISUALS_START;
const GENERATION_PROGRESS_MASCOTS_SPAN = GENERATION_PROGRESS.MASCOTS_END - GENERATION_PROGRESS.MASCOTS_START;
const CONTENT_VIDEOS_DIR = path.join(__dirname, '..', 'uploads', 'content-videos');
const CONTENT_AUDIO_DIR = path.join(__dirname, '..', 'uploads', 'content-audio');
const CONTENT_TTS_VOICES = ['eve', 'ara', 'leo', 'rex', 'sal'];

function streamMp4WithRange(req, res, filePath) {
  const stat = fsSync.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'private, max-age=3600');

  if (!range) {
    res.setHeader('Content-Length', fileSize);
    return fsSync.createReadStream(filePath).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= fileSize) {
    res.setHeader('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  res.setHeader('Content-Length', end - start + 1);
  return fsSync.createReadStream(filePath, { start, end }).pipe(res);
}

function toOrigin(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch (_) {
    return '';
  }
}

function getConfiguredPublicOrigin() {
  return (
    toOrigin(process.env.CLIENT_URL) ||
    toOrigin(process.env.BASE_URL) ||
    toOrigin(process.env.API_PUBLIC_BASE) ||
    ''
  );
}

function getConfiguredPublicBasePath() {
  const fromBasePath = String(process.env.BASE_PATH || '').trim().replace(/\/$/, '');
  if (fromBasePath) return fromBasePath.startsWith('/') ? fromBasePath : `/${fromBasePath}`;
  try {
    const u = new URL(String(process.env.CLIENT_URL || ''));
    const p = String(u.pathname || '').replace(/\/$/, '');
    return p && p !== '/' ? p : '';
  } catch (_) {
    return '';
  }
}

function getRequestBaseUrl(req) {
  const configuredOrigin = getConfiguredPublicOrigin();
  if (configuredOrigin) {
    return configuredOrigin;
  }

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req.get('host') || '').trim();
  const proto = forwardedProto || (req.secure ? 'https' : req.protocol || '');

  if (host && proto) {
    return `${proto}://${host}`;
  }
  return '';
}

try {
  fsSync.mkdirSync(CONTENT_AUDIO_DIR, { recursive: true });
} catch (_) {}

function parseClampedInt(value, fallback, min, max) {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function rowList(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

async function getPublishedContentByCode(code) {
  const q = isMySQL()
    ? await query('SELECT id, code, user_id, content_json, title FROM published_content WHERE code = ?', [code])
    : await query('SELECT id, code, user_id, content_json, title FROM published_content WHERE code = $1', [code]);
  return rowList(q)[0] || null;
}

async function moduleBelongsToUser(moduleId, userId) {
  const row = isMySQL()
    ? await query('SELECT id, user_id FROM modules WHERE id = ? AND user_id = ?', [moduleId, userId])
    : await query('SELECT id, user_id FROM modules WHERE id = $1 AND user_id = $2', [moduleId, userId]);
  return rowList(row)[0] || null;
}

async function getOrCreateModuleId(userId, name) {
  const cleanName = String(name || '').trim().slice(0, 255);
  if (!cleanName) return null;
  const existing = isMySQL()
    ? await query('SELECT id FROM modules WHERE user_id = ? AND name = ?', [userId, cleanName])
    : await query('SELECT id FROM modules WHERE user_id = $1 AND name = $2', [userId, cleanName]);
  const existingRow = rowList(existing)[0];
  if (existingRow) return existingRow.id;
  const inserted = isMySQL()
    ? await query('INSERT INTO modules (user_id, name) VALUES (?, ?)', [userId, cleanName])
    : await query('INSERT INTO modules (user_id, name) VALUES ($1, $2) RETURNING id', [userId, cleanName]);
  const insertedRow = rowList(inserted)[0];
  return insertedRow?.id ?? inserted.insertId ?? inserted.lastID ?? null;
}

async function addItemToModule(moduleId, userId, itemType, itemId, snapshotTitle, snapshotCode) {
  if (!Number.isFinite(moduleId) || moduleId <= 0) return;
  const moduleRow = await moduleBelongsToUser(moduleId, userId);
  if (!moduleRow) return;
  const maxQ = isMySQL()
    ? await query('SELECT COALESCE(MAX(position), -1) AS max_position FROM module_items WHERE module_id = ?', [moduleId])
    : await query('SELECT COALESCE(MAX(position), -1) AS max_position FROM module_items WHERE module_id = $1', [moduleId]);
  const nextPos = Number(rowList(maxQ)[0]?.max_position ?? -1) + 1;
  try {
    if (isMySQL()) {
      await query(
        `INSERT INTO module_items (module_id, item_type, item_id, snapshot_title, snapshot_code, position, section_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [moduleId, itemType, itemId, snapshotTitle, snapshotCode, nextPos, -1]
      );
    } else {
      await query(
        `INSERT INTO module_items (module_id, item_type, item_id, snapshot_title, snapshot_code, position, section_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [moduleId, itemType, itemId, snapshotTitle, snapshotCode, nextPos, -1]
      );
    }
  } catch (err) {
    if (!(err?.code === 'ER_DUP_ENTRY' || String(err?.message || '').toLowerCase().includes('unique'))) {
      throw err;
    }
  }
}

function normalizeClipSeconds(value, fallback = 12) {
  const parsed = parseInt(String(value ?? ''), 10);
  if (parsed === 4 || parsed === 8 || parsed === 12) return parsed;
  return fallback;
}

function buildContentVideoPromptSegments(contentTitle, numSegments = 3) {
  const safeTitle = String(contentTitle || '').slice(0, 120);
  const base =
    'Wide shot of a friendly educator in a modern classroom or office, speaking warmly to camera. Soft lighting. No real people or copyrighted characters. Suitable for all ages.';
  if (numSegments <= 1) {
    return [
      `${base} The educator introduces the lesson "${safeTitle}" and gives a welcoming overview.`
    ];
  }
  const segments = [
    `${base} The educator introduces the lesson "${safeTitle}" and explains what students will learn.`,
    `${base} The educator explains the key ideas from "${safeTitle}" clearly and confidently.`,
    `${base} The educator summarizes "${safeTitle}" and gives encouraging closing guidance for students.`
  ];
  while (segments.length < numSegments) {
    segments.push(`${base} The educator continues explaining "${safeTitle}" in a calm, structured way.`);
  }
  return segments.slice(0, numSegments);
}

function generateCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

function toSafeIsoDateTime(value) {
  const dt = new Date(String(value || ''));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function parseJsonSafe(value, fallback = null) {
  try {
    if (value == null) return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return fallback;
  }
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return '';
  }
}

async function persistPublishedContentRepair(row, normalizedContent, { userId = null } = {}) {
  const normalizedTitle = String(normalizedContent?.title || row?.title || 'Untitled content').slice(0, 500);
  const serialized = JSON.stringify(normalizedContent);
  if (isMySQL()) {
    if (userId != null) {
      await query(
        'UPDATE published_content SET title = ?, content_json = ? WHERE id = ? AND user_id = ?',
        [normalizedTitle, serialized, row.id, userId]
      );
    } else {
      await query(
        'UPDATE published_content SET title = ?, content_json = ? WHERE id = ?',
        [normalizedTitle, serialized, row.id]
      );
    }
  } else if (userId != null) {
    await query(
      'UPDATE published_content SET title = $1, content_json = $2 WHERE id = $3 AND user_id = $4',
      [normalizedTitle, serialized, row.id, userId]
    );
  } else {
    await query(
      'UPDATE published_content SET title = $1, content_json = $2 WHERE id = $3',
      [normalizedTitle, serialized, row.id]
    );
  }
}

async function normalizeAndRepairPublishedContentRow(row, { userId = null, triggerAudio = false } = {}) {
  const parsedContent = typeof row?.content_json === 'string' ? JSON.parse(row.content_json) : (row?.content_json || {});
  const normalizedContent = contentService.normalizeGeneratedContent(parsedContent || {});
  const normalizedTitle = String(normalizedContent?.title || row?.title || 'Untitled content').slice(0, 500);
  const needsRepair = stableJson(parsedContent || {}) !== stableJson(normalizedContent) || String(row?.title || '') !== normalizedTitle;

  if (needsRepair && row?.id) {
    await persistPublishedContentRepair(row, normalizedContent, { userId });
  }
  if (triggerAudio && row?.code) {
    triggerContentAudioPreGeneration(row.code, normalizedContent);
  }

  return {
    ...row,
    title: normalizedTitle,
    content_json: JSON.stringify(normalizedContent),
    content: normalizedContent,
    repaired: needsRepair,
  };
}

function getContentAudioCachePath(code, sectionIndex, voiceId, language, narrationText, scope = 'section') {
  const cacheKey = crypto
    .createHash('sha1')
    .update(JSON.stringify({ code, sectionIndex, voiceId, language, narrationText, scope }))
    .digest('hex');
  return path.join(CONTENT_AUDIO_DIR, `${cacheKey}.mp3`);
}

function buildCheckpointQuestionNarrationText(content, questionIndex) {
  const questions = Array.isArray(content?.quiz?.questions) ? content.quiz.questions : [];
  const question = questions[questionIndex];
  if (!question) return '';

  const number = question.number != null ? question.number : questionIndex + 1;
  const type = String(question.type || 'short_answer').replace(/-/g, '_');
  const parts = [
    content?.title ? `Lesson title: ${content.title}.` : '',
    `Knowledge checkpoint. Question ${number}.`,
    question.question ? String(question.question).trim() : '',
  ];

  if (Array.isArray(question.options) && question.options.length > 0) {
    parts.push('Answer choices:');
    question.options.forEach((option, optionIndex) => {
      const optionLabel = String.fromCharCode(65 + optionIndex);
      parts.push(`Option ${optionLabel}. ${String(option || '').trim()}`);
    });
  }

  if (type === 'mix_and_match') {
    const leftColumn = Array.isArray(question.left_column) ? question.left_column : [];
    const rightColumn = Array.isArray(question.right_column) ? question.right_column : [];
    if (leftColumn.length > 0) {
      parts.push('Prompts to match:');
      leftColumn.forEach((item, itemIndex) => {
        parts.push(`Prompt ${itemIndex + 1}. ${String(item || '').trim()}`);
      });
    }
    if (rightColumn.length > 0) {
      parts.push('Available matches:');
      rightColumn.forEach((item, itemIndex) => {
        const optionLabel = String.fromCharCode(65 + itemIndex);
        parts.push(`Choice ${optionLabel}. ${String(item || '').trim()}`);
      });
    }
  }

  return parts.filter(Boolean).join('\n\n').trim();
}

async function ensureContentAudioCache({ code, content, voices = CONTENT_TTS_VOICES } = {}) {
  if (!process.env.XAI_API_KEY || !code || !content || content?.tts_enabled === false) {
    return;
  }

  const sections = Array.isArray(content.sections) ? content.sections : [];
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const narrationText = contentService.buildSectionNarrationText(content, sectionIndex);
    if (!String(narrationText || '').trim()) continue;

    for (const rawVoiceId of voices) {
      const voiceId = String(rawVoiceId || '').trim().toLowerCase();
      if (!voiceId) continue;
      const audioPath = getContentAudioCachePath(code, sectionIndex, voiceId, 'en', narrationText, 'section');
      if (fsSync.existsSync(audioPath)) continue;

      try {
        const audioBuffer = await contentService.synthesizeSectionSpeech(narrationText, {
          voiceId,
          language: 'en',
        });
        await fs.writeFile(audioPath, audioBuffer);
      } catch (error) {
        console.warn(`Pre-generating content audio failed for ${code} section ${sectionIndex} voice ${voiceId}:`, error?.message || error);
      }
    }
  }
}

function triggerContentAudioPreGeneration(code, content) {
  ensureContentAudioCache({ code, content }).catch((error) => {
    console.warn(`Content audio pre-generation failed for ${code}:`, error?.message || error);
  });
}

async function getUploadedTemplateByToken(userId, templateToken) {
  const token = String(templateToken || '');
  const match = token.match(/^uploaded:(\d+)$/i);
  if (!match) return null;
  const templateId = Number(match[1]);
  if (!Number.isFinite(templateId) || templateId <= 0) return null;
  const q = isMySQL()
    ? await query(
        'SELECT id, name, file_name, created_at FROM uploaded_ppt_templates WHERE id = ? AND user_id = ?',
        [templateId, userId]
      )
    : await query(
        'SELECT id, name, file_name, created_at FROM uploaded_ppt_templates WHERE id = $1 AND user_id = $2',
        [templateId, userId]
      );
  const row = Array.isArray(q) ? q[0] : (q.rows && q.rows[0]);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    file_name: row.file_name,
    created_at: row.created_at,
    token: `uploaded:${row.id}`,
    abs_path: path.join(templateDir, row.file_name),
  };
}

const templateDir = path.join(__dirname, '../uploads/content-templates');
const templateMediaDir = path.join(__dirname, '../uploads/content-template-media');
try {
  require('fs').mkdirSync(templateDir, { recursive: true });
  require('fs').mkdirSync(templateMediaDir, { recursive: true });
} catch (_) {}

function getTemplateMediaDir(templateId) {
  return path.join(templateMediaDir, String(templateId));
}

function listTemplateImageUrls(templateId, baseUrl = '') {
  const dir = getTemplateMediaDir(templateId);
  const publicBasePath = getConfiguredPublicBasePath();
  const uploadPrefix = `${publicBasePath}/uploads/content-template-media/${templateId}`.replace(/\/{2,}/g, '/');
  try {
    return require('fs').readdirSync(dir)
      .filter((f) => (/\.(png|jpe?g|gif|webp|bmp|svg)$/i).test(f))
      .map((f) => `${baseUrl}${uploadPrefix}/${f}`);
  } catch (_) {
    return [];
  }
}

function buildTemplateMediaPublicUrl(req, templateId, filename) {
  const base = getRequestBaseUrl(req);
  const publicBasePath = getConfiguredPublicBasePath();
  const safeFile = encodeURIComponent(String(filename || '').trim());
  const uploadPath = `${publicBasePath}/uploads/content-template-media/${templateId}/${safeFile}`.replace(/\/{2,}/g, '/');
  return `${base}${uploadPath}`;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function inferSuggestedSectionsFromText(rawText) {
  const text = String(rawText || '');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sessionLike = lines.filter((line) =>
    /^(slide|session|lesson|week|module|unit)\s*\d+[\s:.-]/i.test(line) ||
    /^\d+[\).:-]\s+\S+/.test(line)
  );

  const headingLike = lines.filter((line) =>
    /^([A-Z][A-Za-z0-9 ,:'"()/-]{8,}|#+\s+\S.*)$/.test(line) && line.length <= 120
  );

  const enumeratedInBody = (text.match(/\b(slide|session|lesson|week|module|unit)\s+\d+\b/gi) || []).length;
  const uniqueSessionLike = Array.from(new Set(sessionLike.map((s) => s.toLowerCase())));
  const directCount = Math.max(uniqueSessionLike.length, Math.min(enumeratedInBody, MAX_CONTENT_SECTIONS));

  const fallbackByLength = (() => {
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < 250) return 4;
    if (words < 600) return 6;
    if (words < 1000) return 8;
    if (words < 1600) return 10;
    return 12;
  })();

  const headingInfluence = Math.min(headingLike.length, MAX_CONTENT_SECTIONS);
  const suggested = Math.max(
    1,
    Math.min(MAX_CONTENT_SECTIONS, directCount || Math.max(3, Math.min(headingInfluence, fallbackByLength)))
  );

  const note = directCount
    ? `Detected ${directCount} slide/session-like items from uploaded text.`
    : `No explicit session list found. Estimated ${suggested} sections from outline/length.`;

  return {
    suggested_sections: suggested,
    detected_outline_items: directCount || headingInfluence || 0,
    inference_note: note,
    confidence: directCount ? 'high' : 'medium',
    inference_method: 'heuristic',
  };
}

function parseAiJsonObject(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  const jsonCandidate = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonCandidate);
  } catch (_) {
    return null;
  }
}

async function inferSuggestedSectionsWithAI(rawText, heuristicResult = null) {
  const provider = aiService.openai ? 'openai' : aiService.anthropic ? 'anthropic' : null;
  if (!provider) return null;

  const taskCfg = aiConfig.getTaskConfig('contentGeneration', provider);
  const model = taskCfg?.model || (provider === 'openai' ? 'gpt-4o-mini' : 'claude-3-5-haiku-20241022');
  const preview = String(rawText || '').slice(0, 14000);
  if (!preview.trim()) return null;

  const heuristicSummary = heuristicResult
    ? `Heuristic suggestion: ${heuristicResult.suggested_sections} sections; detected outline items: ${heuristicResult.detected_outline_items}.`
    : '';

  try {
    const completion = await aiService.createCompletionWithRetry({
      provider,
      model,
      temperature: 0.1,
      maxTokens: 3000,
      messages: [
        {
          role: 'system',
          content: 'You analyze academic teaching documents and estimate section/session count for lesson generation. Return ONLY a valid JSON object.'
        },
        {
          role: 'user',
          content: `Analyze the uploaded document text and estimate how many sections should be generated.

Rules:
- suggested_sections must be an integer from 1 to ${MAX_CONTENT_SECTIONS}.
- detected_outline_items must be an integer >= 0.
- confidence must be one of: high, medium, low.
- inference_note should briefly explain the evidence from document structure (sessions/modules/numbered outline/headings).
- Prefer explicit document structure over length heuristics.

${heuristicSummary}

Return exactly this JSON shape:
{
  "suggested_sections": 8,
  "detected_outline_items": 8,
  "confidence": "high",
  "inference_note": "Detected 8 explicit modules in the uploaded outline."
}

Document text:
${preview}`
        }
      ],
    }, 2);

    const parsed = parseAiJsonObject(completion?.content);
    if (!parsed || typeof parsed !== 'object') return null;
    const suggested = Math.max(1, Math.min(MAX_CONTENT_SECTIONS, Number(parsed.suggested_sections) || 0));
    if (!suggested) return null;
    const outlineItems = Math.max(0, Number(parsed.detected_outline_items) || 0);
    const confidence = ['high', 'medium', 'low'].includes(String(parsed.confidence).toLowerCase())
      ? String(parsed.confidence).toLowerCase()
      : 'medium';
    const inferenceNote = String(parsed.inference_note || '').trim() || 'AI inferred section count from document structure.';
    return {
      suggested_sections: suggested,
      detected_outline_items: outlineItems,
      confidence,
      inference_note: inferenceNote.slice(0, 260),
      inference_method: 'ai',
    };
  } catch (error) {
    console.warn('AI section inference failed, using heuristic fallback:', error?.message || error);
    return null;
  }
}

async function extractTextFromDocxBuffer(buffer) {
  const xmlFiles = [];
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) return reject(openErr || new Error('Failed to open DOCX'));
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = String(entry.fileName || '');
        const isTextXml = /^word\/(document|header\d+|footer\d+)\.xml$/i.test(name);
        if (!isTextXml) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.readEntry();
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on('end', () => {
            xmlFiles.push(Buffer.concat(chunks).toString('utf8'));
            zipfile.readEntry();
          });
          stream.on('error', () => zipfile.readEntry());
        });
      });
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });

  const joinedXml = xmlFiles.join('\n');
  if (!joinedXml.trim()) return '';

  const plain = decodeXmlEntities(
    joinedXml
      .replace(/<w:p\b[^>]*>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab\/>/g, ' ')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
  );
  return plain.trim();
}

function injectTemplateImages(content, imageUrls) {
  if (!imageUrls || imageUrls.length === 0) return content;
  let idx = 0;
  const sections = (content.sections || []).map((section) => ({
    ...section,
    visuals: (section.visuals || []).map((visual) => {
      if (visual.kind === 'image' && !visual.image_url) {
        return { ...visual, image_url: imageUrls[idx++ % imageUrls.length] };
      }
      return visual;
    }),
  }));
  const existingPool = Array.isArray(content?.template_images) ? content.template_images : [];
  const mergedPool = [...existingPool, ...imageUrls]
    .map((url) => String(url || '').trim())
    .filter(Boolean)
    .filter((url, i, arr) => arr.indexOf(url) === i);
  return { ...content, sections, template_images: mergedPool };
}
const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, templateDir),
  filename: (req, file, cb) => cb(null, `template-${Date.now()}-${(file.originalname || 'slide').replace(/[^a-zA-Z0-9.-]/g, '_')}`),
});
const uploadTemplate = multer({
  storage: templateStorage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || (file.originalname || '').toLowerCase().endsWith('.pptx');
    if (!ok) return cb(new Error('Please upload a .pptx PowerPoint template.'));
    cb(null, true);
  },
}).single('template');

const topicsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');
    const isDocx = mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx');
    cb(null, isPdf || isDocx);
  },
}).single('file');

/**
 * Generate course content with AI. Body: topics, level?, num_sections?, rubric_id?, rubric_context?, include_video? (boolean)
 */
router.post('/generate', requireAuth, requireFeature('content_creation'), async (req, res) => {
  const requestStartedAt = Date.now();
  const taskConfig = aiConfig.getTaskConfig('contentGeneration', 'openai');
  const projectedCostUsd = 0.12;
  let promptTrace = null;
  let generationJobId = null;
  let lastProgressPercent = -1;
  let lastProgressEmitMs = 0;
  const telemetryBase = {
    event: 'content_generate',
    generation_type: 'content_generation',
    user_id: req.user.id,
    provider: taskConfig?.provider || null,
    model: taskConfig?.model || null,
    metadata: {
      rubric_id: req.body?.rubric_id || null,
      template_id: req.body?.template_id || 'classroom',
      level: String(req.body?.level || '').trim() || null,
      num_sections: parseClampedInt(req.body?.num_sections, 5, 1, MAX_CONTENT_SECTIONS),
      include_diagrams: req.body?.include_diagrams !== false,
      include_images: req.body?.include_images !== false,
      include_mascot: req.body?.include_mascot === true,
      include_beautify_text: req.body?.include_beautify_text !== false,
      topics_preview: String(req.body?.topics || '').trim().slice(0, 160) || null,
    },
  };
  try {
    try {
      await assertWithinBudgetOrThrow({
        userId: req.user.id,
        projectedCostUsd,
        generationType: 'content generation',
      });
    } catch (budgetError) {
      if (budgetError?.code === 'BUDGET_GUARDRAIL_EXCEEDED') {
        return res.status(budgetError.statusCode || 429).json({
          error: budgetError.message,
          code: budgetError.code,
          budget_status: budgetError.budget_status || null,
        });
      }
      throw budgetError;
    }

    generationJobId = await createGenerationJob({
      user_id: req.user.id,
      job_type: 'content_generation',
      status: JOB_STATUS.PROCESSING,
      source_route: '/content/generate',
      payload: req.body || {},
    });
    if (generationJobId) {
      await updateGenerationJob(generationJobId, { started_at: new Date() });
    }

    const reportJobProgress = (progress = {}) => {
      if (!generationJobId) return;
      const percent = Math.max(0, Math.min(99, Number(progress?.percent || 0)));
      const now = Date.now();
      const allowEmit =
        percent >= 99 ||
        percent >= lastProgressPercent + 2 ||
        (now - lastProgressEmitMs) > 1200;
      if (!allowEmit) return;
      lastProgressPercent = Math.max(lastProgressPercent, percent);
      lastProgressEmitMs = now;
      updateGenerationJob(generationJobId, {
        result: {
          success: false,
          progress: {
            stage: String(progress?.stage || 'content_generation'),
            task: String(progress?.task || 'content'),
            percent,
            label: String(progress?.label || 'Generating content'),
            detail: String(progress?.detail || '').slice(0, 260),
            generated_sections: Number(progress?.generated_sections || 0) || 0,
            total_sections: Number(progress?.total_sections || 0) || 0,
            updated_at: new Date().toISOString(),
          },
        },
      }).catch((err) => {
        console.warn('[content] Failed to persist generation progress:', err?.message || err);
      });
    };

    reportJobProgress({
      stage: 'planning',
      task: 'content',
      percent: GENERATION_PROGRESS.VALIDATING,
      label: 'Preparing generation request',
      detail: 'Validating request and budget.',
    });

    promptTrace = await resolvePromptRegistryVersion({
      user_id: req.user.id,
      generation_type: 'content_generation',
      prompt_key: 'content.generate.default',
      prompt_text: 'Default content generation prompt template used by /content/generate.',
      provider: taskConfig?.provider || null,
      model: taskConfig?.model || null,
      temperature: taskConfig?.temperature ?? null,
      max_tokens: taskConfig?.maxTokens ?? null,
    });
    const { topics, level, num_sections = 5, rubric_id, rubric_context, template_id = 'classroom', include_diagrams = true, include_images = true, include_mascot = false, include_beautify_text = true } = req.body;
    if (!topics || !String(topics).trim()) {
      return res.status(400).json({ error: 'topics is required' });
    }
    const requestedSections = Math.min(Math.max(parseInt(num_sections, 10) || 5, 1), MAX_CONTENT_SECTIONS);
    reportJobProgress({
      stage: 'planning',
      task: 'content',
      percent: GENERATION_PROGRESS.PLAN_BUILT,
      label: 'Building generation plan',
      detail: `Preparing ${requestedSections} section(s).`,
      generated_sections: 0,
      total_sections: requestedSections,
    });
    let rubricContext = rubric_context || '';
    if (rubric_id && !rubric_context) {
      const q = isMySQL()
        ? await query('SELECT name, criteria, total_points FROM rubrics WHERE id = ?', [rubric_id])
        : await query('SELECT name, criteria, total_points FROM rubrics WHERE id = $1', [rubric_id]);
      const row = Array.isArray(q) ? q[0] : (q.rows && q.rows[0]);
      if (row) {
        const crit = typeof row.criteria === 'string' ? JSON.parse(row.criteria) : row.criteria;
        rubricContext = `Rubric: ${row.name}. Criteria: ${Array.isArray(crit) ? crit.map((c) => c.name).join(', ') : ''}`;
      }
    }
    let uploadedTheme = null;
    let templateImageUrls = [];
    let templateContext = '';
    const isUploadedTemplate = (/^uploaded:\d+$/i).test(String(template_id || ''));
    if (isUploadedTemplate) {
      const tmpl = await getUploadedTemplateByToken(req.user.id, template_id);
      if (tmpl?.abs_path) {
        try {
          const pptxTheme = await contentService.extractTemplateTheme(tmpl.abs_path);
          uploadedTheme = contentService.pptxThemeToContentTheme(pptxTheme);
        } catch (_) { /* non-fatal */ }
        try {
          templateContext = await contentService.summarizePptxTemplateForGeneration(tmpl.abs_path);
        } catch (templateError) {
          console.warn('Template generation context extraction failed:', templateError?.message || templateError);
        }
      }
      const dbId = String(template_id).replace(/^uploaded:/i, '');
      templateImageUrls = listTemplateImageUrls(dbId, getRequestBaseUrl(req));
    }
    let content = await contentService.generateContentWithAIResilient({
      topics: String(topics).trim(),
      level: level || '',
      numSections: requestedSections,
      rubricContext,
      templateId: template_id,
      templateContext,
      includeDiagrams: include_diagrams !== false,
      includeImages: include_images !== false,
      includeMascot: include_mascot === true,
      uploadedTheme,
      onProgress: (progress) => {
        const stage = String(progress?.stage || '');
        const totalSections = Number(progress?.total_sections || requestedSections) || requestedSections;
        const generatedSections = Number(progress?.generated_sections || 0) || 0;
        if (stage === 'planning') {
          reportJobProgress({
            stage: 'planning',
            task: 'content',
            percent: GENERATION_PROGRESS.SECTIONS_PLANNING,
            label: 'Planning sections',
            detail: String(progress?.message || 'Structuring the lesson outline.'),
            generated_sections: generatedSections,
            total_sections: totalSections,
          });
          return;
        }
        if (stage === 'text_generation') {
          const ratio = totalSections > 0 ? Math.max(0, Math.min(1, generatedSections / totalSections)) : 0;
          const percent = GENERATION_PROGRESS.SECTIONS_START + ratio * GENERATION_PROGRESS_SECTIONS_SPAN;
          const currentChunk = Number(progress?.current_chunk || 0) || 0;
          const totalChunks = Number(progress?.total_chunks || 0) || 0;
          const chunkRange = String(progress?.chunk_range || '').trim();
          const chunkPrefix = currentChunk > 0 && totalChunks > 0
            ? `Chunk ${currentChunk}/${totalChunks}${chunkRange ? ` (Sections ${chunkRange})` : ''}. `
            : '';
          reportJobProgress({
            stage: 'text_generation',
            task: 'content',
            percent,
            label: 'Generating sections',
            detail: `${chunkPrefix}${String(progress?.message || `Generated ${generatedSections}/${totalSections} sections.`)}`.trim(),
            generated_sections: generatedSections,
            total_sections: totalSections,
          });
          return;
        }
      },
      onChunkComplete: (chunkInfo) => {
        if (!generationJobId) return;
        updateGenerationJob(generationJobId, {
          result: {
            success: false,
            partial_sections: chunkInfo.partial_sections || [],
            progress: {
              stage: 'text_generation',
              task: 'content',
              percent: Math.round(GENERATION_PROGRESS.SECTIONS_START + (chunkInfo.completedChunks / Math.max(1, chunkInfo.totalChunks)) * GENERATION_PROGRESS_SECTIONS_SPAN),
              label: 'Generating sections',
              detail: `Completed chunk ${chunkInfo.completedChunks}/${chunkInfo.totalChunks}`,
              generated_sections: Array.isArray(chunkInfo.partial_sections) ? chunkInfo.partial_sections.length : 0,
              total_sections: requestedSections,
              updated_at: new Date().toISOString(),
            },
          },
        }).catch((err) => {
          console.warn('[content] Failed to persist partial chunk:', err?.message || err);
        });
      },
    });
    if (templateImageUrls.length > 0) {
      content = injectTemplateImages(content, templateImageUrls);
    }
    if (include_beautify_text !== false) {
      reportJobProgress({
        stage: 'text_beautify',
        task: 'content',
        percent: GENERATION_PROGRESS.BEAUTIFY_START,
        label: 'Polishing lesson text',
        detail: 'Applying AI readability pass.',
        generated_sections: requestedSections,
        total_sections: requestedSections,
      });
      content = await contentService.beautifyContentTextWithAI(content, {
        level: level || '',
        onProgress: (progress) => {
          const completed = Number(progress?.completed || 0) || 0;
          const total = Number(progress?.total || requestedSections) || requestedSections;
          const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
          reportJobProgress({
            stage: 'text_beautify',
            task: 'content',
            percent: GENERATION_PROGRESS.BEAUTIFY_START + ratio * GENERATION_PROGRESS_BEAUTIFY_SPAN,
            label: 'Polishing lesson text',
            detail: String(progress?.message || `Polished section text ${completed}/${total}.`),
            generated_sections: requestedSections,
            total_sections: requestedSections,
          });
        },
      });
    }
    if (include_diagrams !== false || include_images !== false || include_mascot === true) {
      reportJobProgress({
        stage: 'visual_generation',
        task: include_mascot === true ? 'mascot' : 'visual',
        percent: GENERATION_PROGRESS.VISUALS_START,
        label: 'Generating visuals',
        detail: 'Creating image assets for sections.',
        generated_sections: requestedSections,
        total_sections: requestedSections,
      });
      content = await contentService.enrichContentWithImages(content, {
        onProgress: (progress) => {
          const stage = String(progress?.stage || '');
          const completed = Number(progress?.completed || 0) || 0;
          const total = Number(progress?.total || 0) || 0;
          const ratio = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0;
          if (stage === 'visual_images') {
            reportJobProgress({
              stage: 'visual_generation',
              task: 'visual',
              percent: GENERATION_PROGRESS.VISUALS_START + ratio * GENERATION_PROGRESS_VISUALS_SPAN,
              label: 'Generating visuals',
              detail: String(progress?.message || `Generated visual assets ${completed}/${total}.`),
              generated_sections: requestedSections,
              total_sections: requestedSections,
            });
            return;
          }
          if (stage === 'mascots') {
            reportJobProgress({
              stage: 'mascot_generation',
              task: 'mascot',
              percent: GENERATION_PROGRESS.MASCOTS_START + ratio * GENERATION_PROGRESS_MASCOTS_SPAN,
              label: 'Generating mascots',
              detail: String(progress?.message || `Generated mascot assets ${completed}/${total}.`),
              generated_sections: requestedSections,
              total_sections: requestedSections,
            });
          }
        },
      });
    }
    reportJobProgress({
      stage: 'finalizing',
      task: 'content',
      percent: GENERATION_PROGRESS.FINALIZING,
      label: 'Finalizing response',
      detail: 'Preparing content payload.',
      generated_sections: Array.isArray(content?.sections) ? content.sections.length : requestedSections,
      total_sections: requestedSections,
    });
    const successPayload = {
      ...telemetryBase,
      status: 'success',
      duration_ms: Date.now() - requestStartedAt,
      metadata: {
        ...telemetryBase.metadata,
        section_count: Array.isArray(content?.sections) ? content.sections.length : 0,
        quiz_question_count: Array.isArray(content?.quiz?.questions) ? content.quiz.questions.length : 0,
        prompt_key: promptTrace?.prompt_key || null,
        prompt_version: promptTrace?.prompt_version || null,
      },
    };
    logGenerationTelemetry(successPayload);
    try {
      await persistGenerationTelemetryEvent(successPayload);
    } catch (telemetryError) {
      console.warn('[content] Failed to persist generation telemetry:', telemetryError?.message || telemetryError);
    }
    if (generationJobId) {
      await updateGenerationJob(generationJobId, {
        status: JOB_STATUS.COMPLETED,
        result: {
          success: true,
          content,
          generation_trace: promptTrace || null,
          title: content?.title || null,
          section_count: Array.isArray(content?.sections) ? content.sections.length : 0,
        },
        completed_at: new Date(),
      });
    }
    res.json({ success: true, content, generation_trace: promptTrace, generation_job_id: generationJobId });
  } catch (error) {
    const errorPayload = {
      ...telemetryBase,
      status: 'error',
      duration_ms: Date.now() - requestStartedAt,
      error_type: inferGenerationErrorType(error),
      error_message: String(error?.message || 'Unknown error'),
      metadata: {
        ...telemetryBase.metadata,
        prompt_key: promptTrace?.prompt_key || null,
        prompt_version: promptTrace?.prompt_version || null,
      },
    };
    logGenerationTelemetry(errorPayload);
    try {
      await persistGenerationTelemetryEvent(errorPayload);
    } catch (telemetryError) {
      console.warn('[content] Failed to persist error telemetry:', telemetryError?.message || telemetryError);
    }
    if (generationJobId) {
      await updateGenerationJob(generationJobId, {
        status: JOB_STATUS.FAILED,
        error_message: String(error?.message || 'Unknown error'),
        completed_at: new Date(),
      });
    }
    console.error('Content generate error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate content' });
  }
});

/**
 * SSE stream for a specific generation job's progress.
 * Accepts token via ?token= query param because browsers cannot set Authorization headers on EventSource.
 */
router.get('/jobs/:jobId/progress-stream', async (req, res) => {
  // Authenticate via query param token (SSE cannot use Authorization headers in browsers)
  const token = req.query?.token || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Access token required' });
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.userId;
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const jobId = Number(req.params.jobId);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'Invalid job ID' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  const POLL_MS = 800;
  const MAX_POLLS = Math.ceil((20 * 60 * 1000) / POLL_MS); // 20 min ceiling

  let polls = 0;
  let closed = false;

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const cleanup = () => { closed = true; };
  req.on('close', cleanup);
  req.on('aborted', cleanup);

  const tick = async () => {
    if (closed) return;
    polls += 1;
    if (polls > MAX_POLLS) {
      send('error', { message: 'Stream timeout' });
      cleanup();
      res.end();
      return;
    }

    try {
      const job = await getGenerationJobById(jobId, userId);
      if (!job) {
        send('error', { message: 'Job not found' });
        cleanup();
        res.end();
        return;
      }

      let result = null;
      try { result = typeof job.result_json === 'string' ? JSON.parse(job.result_json) : job.result_json; } catch (_) {}

      send('progress', {
        job_id: Number(job.id),
        status: job.status,
        progress: result?.progress || null,
        error_message: job.error_message || null,
      });

      if (TERMINAL.has(String(job.status))) {
        send('done', { status: job.status });
        cleanup();
        res.end();
        return;
      }
    } catch (err) {
      send('error', { message: err?.message || 'Poll error' });
    }

    if (!closed) setTimeout(tick, POLL_MS);
  };

  send('connected', { job_id: jobId });
  tick();
});

router.post('/regenerate-visual', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const {
      visual,
      content_title = '',
      section_heading = '',
      section_body = '',
    } = req.body || {};

    if (!visual || typeof visual !== 'object') {
      return res.status(400).json({ error: 'visual is required' });
    }

    const updatedVisual = await contentService.regenerateVisualWithGrok({
      visual,
      contentTitle: String(content_title || '').trim(),
      sectionHeading: String(section_heading || '').trim(),
      sectionBody: String(section_body || '').trim(),
    });

    res.json({ success: true, visual: updatedVisual });
  } catch (error) {
    console.error('Content visual regenerate error:', error);
    res.status(500).json({ error: error.message || 'Failed to regenerate visual with Grok' });
  }
});

router.post('/regenerate-mascot', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const {
      mascot,
      content_title = '',
      section_heading = '',
      section_body = '',
    } = req.body || {};

    if (!mascot || typeof mascot !== 'object') {
      return res.status(400).json({ error: 'mascot is required' });
    }

    const updatedMascot = await contentService.regenerateMascotWithGrok({
      mascot,
      contentTitle: String(content_title || '').trim(),
      sectionHeading: String(section_heading || '').trim(),
      sectionBody: String(section_body || '').trim(),
    });

    res.json({ success: true, mascot: updatedMascot });
  } catch (error) {
    console.error('Content mascot regenerate error:', error);
    res.status(500).json({ error: error.message || 'Failed to regenerate mascot with Grok' });
  }
});

router.post('/topics/upload', requireAuth, requireFeature('content_creation'), (req, res) => {
  topicsUpload(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ error: uploadErr.message || 'Failed to upload file' });
    }
    try {
      const file = req.file;
      if (!file || !file.buffer) {
        return res.status(400).json({ error: 'Please choose a PDF or DOCX file' });
      }

      const originalName = String(file.originalname || '');
      const lowerName = originalName.toLowerCase();
      const mime = String(file.mimetype || '').toLowerCase();
      const isPdf = mime === 'application/pdf' || lowerName.endsWith('.pdf');
      const isDocx = mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || lowerName.endsWith('.docx');

      let extracted = '';
      if (isPdf) {
        const parsed = await pdfParse(file.buffer);
        extracted = String(parsed?.text || '').trim();
      } else if (isDocx) {
        extracted = await extractTextFromDocxBuffer(file.buffer);
      } else {
        return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF or DOCX.' });
      }

      if (!extracted) {
        return res.status(400).json({ error: 'No readable text was found in the uploaded file.' });
      }

      const normalized = extracted
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 20000);

      const heuristic = inferSuggestedSectionsFromText(normalized);
      const aiInferred = await inferSuggestedSectionsWithAI(normalized, heuristic);
      const sectionInference = aiInferred || heuristic;

      return res.json({
        success: true,
        topics: normalized,
        file_name: originalName,
        ...sectionInference,
      });
    } catch (error) {
      console.error('Content topics upload parse error:', error);
      return res.status(500).json({ error: error.message || 'Failed to extract topics from file' });
    }
  });
});

router.get('/templates', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const builtIns = Object.values(contentService.CONTENT_TEMPLATES || {}).map((t) => ({
      id: t.id,
      name: t.name,
      theme: t.theme,
      kind: 'builtin',
    }));
    const uploadedQ = isMySQL()
      ? await query(
          'SELECT id, name, file_name, created_at FROM uploaded_ppt_templates WHERE user_id = ? ORDER BY created_at DESC',
          [req.user.id]
        )
      : await query(
          'SELECT id, name, file_name, created_at FROM uploaded_ppt_templates WHERE user_id = $1 ORDER BY created_at DESC',
          [req.user.id]
        );
    const uploadedRows = Array.isArray(uploadedQ) ? uploadedQ : (uploadedQ.rows || []);
    const uploaded = await Promise.all(uploadedRows.map(async (row) => {
      let theme = {};
      try {
        const filePath = path.join(templateDir, row.file_name);
        const pptxTheme = await contentService.extractTemplateTheme(filePath);
        theme = contentService.pptxThemeToContentTheme(pptxTheme) || {};
      } catch (_) { /* file may not exist yet */ }
      const images = listTemplateImageUrls(row.id, getRequestBaseUrl(req));
      return {
        id: `uploaded:${row.id}`,
        name: `${row.name} (uploaded template)`,
        theme,
        images,
        kind: 'uploaded',
        uploaded_template_id: row.id,
        created_at: row.created_at,
      };
    }));
    res.json({ success: true, templates: [...builtIns, ...uploaded] });
  } catch (error) {
    console.error('List templates error:', error);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

/**
 * Publish content (store and get student link). Body: content, rubric_id?; optional: include_video (start Sora job).
 */
/**
 * Queue a summary video for every published lesson the caller owns that does not
 * have one yet (management can pass all=true for every lesson). Videos arrive over
 * the following minutes via the background worker. Body: { retry_failed?, force?, all? } — force regenerates existing ones
 */
router.post('/summary-videos/backfill', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const includeAll = req.body?.all === true && String(req.user.role || '').toLowerCase() === 'management';
    const retryFailed = req.body?.retry_failed === true;
    const force = req.body?.force === true;
    const q = includeAll
      ? await query('SELECT id FROM published_content ORDER BY id ASC')
      : (isMySQL()
          ? await query('SELECT id FROM published_content WHERE user_id = ? ORDER BY id ASC', [req.user.id])
          : await query('SELECT id FROM published_content WHERE user_id = $1 ORDER BY id ASC', [req.user.id]));
    const results = { queued: 0, skipped: 0, errors: [] };
    for (const row of rowList(q)) {
      try {
        const r = await lessonSummaryVideoService.queueSummaryVideo(row.id, { retryFailed, force });
        results.queued += r.queued;
        results.skipped += r.skipped;
      } catch (err) {
        results.errors.push({ content_id: row.id, error: err.message });
      }
    }
    res.json({ success: true, ...results });
  } catch (error) {
    console.error('Summary video backfill error:', error);
    res.status(500).json({ error: 'Failed to queue summary videos' });
  }
});

/** Status of the caller's lesson summary videos. */
router.get('/summary-videos', requireAuth, async (req, res) => {
  try {
    const q = isMySQL()
      ? await query('SELECT s.id, s.published_content_id, s.section_index, s.video_generation_id, s.status, s.error_message, c.title FROM lesson_summary_videos s JOIN published_content c ON c.id = s.published_content_id WHERE c.user_id = ? ORDER BY s.published_content_id ASC, s.section_index ASC', [req.user.id])
      : await query('SELECT s.id, s.published_content_id, s.section_index, s.video_generation_id, s.status, s.error_message, c.title FROM lesson_summary_videos s JOIN published_content c ON c.id = s.published_content_id WHERE c.user_id = $1 ORDER BY s.published_content_id ASC, s.section_index ASC', [req.user.id]);
    res.json({ success: true, items: rowList(q) });
  } catch (error) {
    console.error('Summary video status error:', error);
    res.status(500).json({ error: 'Failed to load summary video status' });
  }
});

router.post('/publish', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content, rubric_id, include_video, module_id, module_name } = req.body;
    if (!content || !content.title) {
      return res.status(400).json({ error: 'content with title is required' });
    }
    const normalizedContent = contentService.normalizeGeneratedContent(content);
    let code;
    for (let i = 0; i < 5; i++) {
      code = generateCode();
      try {
        if (isMySQL()) {
          await query(
            'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES (?, ?, ?, ?, ?)',
            [code, normalizedContent.title, JSON.stringify(normalizedContent), rubric_id || null, req.user.id]
          );
        } else {
          await query(
            'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES ($1, $2, $3, $4, $5)',
            [code, normalizedContent.title, JSON.stringify(normalizedContent), rubric_id || null, req.user.id]
          );
        }
        break;
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY' || e.message?.includes('unique') || e.code === '23505') continue;
        throw e;
      }
    }
    if (!code) return res.status(500).json({ error: 'Could not generate unique code' });

    const idRow = rowList(isMySQL()
      ? await query('SELECT id FROM published_content WHERE code = ?', [code])
      : await query('SELECT id FROM published_content WHERE code = $1', [code]))[0];
    const contentIdForSummary = idRow?.id || null;

    let moduleTargetId = null;
    if (module_name && String(module_name).trim()) {
      moduleTargetId = await getOrCreateModuleId(req.user.id, module_name);
    } else if (module_id) {
      moduleTargetId = Number(module_id);
      const moduleRow = await moduleBelongsToUser(moduleTargetId, req.user.id);
      if (!moduleRow) {
        return res.status(404).json({ error: 'Module not found' });
      }
    }

    if (moduleTargetId) {
      const contentRow = isMySQL()
        ? await query('SELECT id FROM published_content WHERE code = ?', [code])
        : await query('SELECT id FROM published_content WHERE code = $1', [code]);
      const row = rowList(contentRow)[0];
      const contentId = row?.id;
      if (contentId) {
        await addItemToModule(moduleTargetId, req.user.id, 'content', contentId, normalizedContent.title, code);
      }
    }

    // Every lesson gets a ~15s AI summary video (arrives later, via the background worker).
    if (contentIdForSummary) {
      lessonSummaryVideoService.queueSummaryVideo(contentIdForSummary).catch((err) => {
        console.warn('Could not queue lesson summary video:', err.message);
      });
    }

    let videoJobId = null;
    if (include_video && process.env.OPENAI_API_KEY) {
      try {
        const model = process.env.SORA_MODEL || 'sora-2';
        const clips = parseClampedInt(
          process.env.SORA_CONTENT_VIDEO_CLIPS || process.env.SORA_VIDEO_CLIPS || '1',
          1,
          1,
          5
        );
        const secondsPerClip = normalizeClipSeconds(
          process.env.SORA_CONTENT_VIDEO_SECONDS_PER_CLIP ||
            process.env.SORA_VIDEO_SECONDS_PER_CLIP ||
            process.env.SORA_CONTENT_VIDEO_SECONDS ||
            process.env.SORA_VIDEO_SECONDS ||
            '12',
          12
        );
        const prompts = buildContentVideoPromptSegments(normalizedContent.title, clips);
        const jobs = await Promise.all(
          prompts.map((prompt) =>
            feedbackVideoService.createVideoJob(prompt, {
              model,
              seconds: String(secondsPerClip),
              size: '1280x720'
            })
          )
        );
        videoJobId = jobs[0]?.id || null;
        const videoIdsJson = JSON.stringify(jobs.map((job) => job.id).filter(Boolean));
        const ins = isMySQL()
          ? await query('SELECT id FROM published_content WHERE code = ?', [code])
          : await query('SELECT id FROM published_content WHERE code = $1', [code]);
        const row = Array.isArray(ins) ? ins[0] : (ins.rows && ins.rows[0]);
        if (row) {
          const contentId = row.id;
          if (isMySQL()) {
            await query(
              'INSERT INTO content_videos (published_content_id, openai_video_id, openai_video_ids, status) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE openai_video_id = VALUES(openai_video_id), openai_video_ids = VALUES(openai_video_ids), status = VALUES(status)',
              [contentId, videoJobId, videoIdsJson, 'queued']
            );
          } else {
            await query(
              'INSERT INTO content_videos (published_content_id, openai_video_id, openai_video_ids, status) VALUES ($1, $2, $3, $4) ON CONFLICT (published_content_id) DO UPDATE SET openai_video_id = $2, openai_video_ids = $3, status = $4',
              [contentId, videoJobId, videoIdsJson, 'queued']
            );
          }
        }
      } catch (videoErr) {
        console.warn('Content video job creation failed:', videoErr.message);
      }
    }

    const base = process.env.CLIENT_URL || '';
    const takePath = base ? `${base.replace(/\/$/, '')}/take-content` : '/take-content';
    triggerContentAudioPreGeneration(code, normalizedContent);
    res.json({
      success: true,
      code,
      link: `${takePath}?code=${code}`,
      video_job_id: videoJobId,
      message: 'Content published. Share the link with students.',
    });
  } catch (error) {
    console.error('Content publish error:', error);
    res.status(500).json({ error: 'Failed to publish content' });
  }
});

/**
 * List current user's published content (for reusability).
 */
router.get('/my', requireAuth, async (req, res) => {
  try {
    const q = isMySQL()
      ? await query('SELECT id, code, title, content_json, created_at FROM published_content WHERE user_id = ? ORDER BY created_at DESC', [req.user.id])
      : await query('SELECT id, code, title, content_json, created_at FROM published_content WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const rows = Array.isArray(q) ? q : (q.rows || []);
    let repairedCount = 0;
    const repairedRows = await Promise.all(rows.map((r) => normalizeAndRepairPublishedContentRow(r, { userId: req.user.id })));
    const items = repairedRows.map((r) => {
      const parsed = r.content || parseJsonSafe(r.content_json, {});
      const sections = Array.isArray(parsed?.sections)
        ? parsed.sections.map((s, idx) => ({
            index: idx,
            heading: s.heading || s.title || `Section ${idx + 1}`,
            preview: typeof s.body === 'string' ? s.body.slice(0, 150) : '',
          }))
        : [];
      if (r.repaired) repairedCount += 1;
      return { id: r.id, code: r.code, title: r.title, sections, created_at: r.created_at };
    });
    res.json({ success: true, items, repaired_count: repairedCount });
  } catch (error) {
    console.error('Content list error:', error);
    res.status(500).json({ error: 'Failed to list content' });
  }
});

/**
 * Get one of the current user's published content items for editing.
 */
router.get('/my/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }

    const q = isMySQL()
      ? await query(
          'SELECT id, code, title, content_json, rubric_id, created_at FROM published_content WHERE id = ? AND user_id = ?',
          [id, req.user.id]
        )
      : await query(
          'SELECT id, code, title, content_json, rubric_id, created_at FROM published_content WHERE id = $1 AND user_id = $2',
          [id, req.user.id]
        );
    const row = rowList(q)[0];
    if (!row) {
      return res.status(404).json({ error: 'Published content not found' });
    }

    const repairedRow = await normalizeAndRepairPublishedContentRow(row, { userId: req.user.id });
    const content = repairedRow.content;
    res.json({
      success: true,
      item: {
        id: repairedRow.id,
        code: repairedRow.code,
        title: repairedRow.title,
        rubric_id: repairedRow.rubric_id ?? null,
        content,
        created_at: repairedRow.created_at,
      }
    });
  } catch (error) {
    console.error('Content get-my-item error:', error);
    res.status(500).json({ error: 'Failed to load published content' });
  }
});

/**
 * Update one of the current user's published content items.
 */
router.put('/my/:id', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }

    const { content, rubric_id } = req.body || {};
    if (!content || !content.title) {
      return res.status(400).json({ error: 'content with title is required' });
    }

    const normalizedContent = contentService.normalizeGeneratedContent(content);
    const title = String(normalizedContent.title || 'Untitled content').slice(0, 500);
    let updated;

    if (isMySQL()) {
      updated = await query(
        'UPDATE published_content SET title = ?, content_json = ?, rubric_id = ? WHERE id = ? AND user_id = ?',
        [title, JSON.stringify(normalizedContent), rubric_id ?? null, id, req.user.id]
      );
    } else {
      updated = await query(
        'UPDATE published_content SET title = $1, content_json = $2, rubric_id = $3 WHERE id = $4 AND user_id = $5',
        [title, JSON.stringify(normalizedContent), rubric_id ?? null, id, req.user.id]
      );
    }

    const affected = updated?.affectedRows ?? updated?.rowCount ?? updated?.changes ?? 0;
    if (!affected) {
      return res.status(404).json({ error: 'Published content not found' });
    }

    const rowResult = isMySQL()
      ? await query(
          'SELECT id, code, title, content_json, rubric_id, created_at FROM published_content WHERE id = ? AND user_id = ?',
          [id, req.user.id]
        )
      : await query(
          'SELECT id, code, title, content_json, rubric_id, created_at FROM published_content WHERE id = $1 AND user_id = $2',
          [id, req.user.id]
        );
    const row = rowList(rowResult)[0];
    const parsedContent = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
    const refreshedContent = contentService.normalizeGeneratedContent(parsedContent || {});
    triggerContentAudioPreGeneration(row.code, refreshedContent);

    res.json({
      success: true,
      item: {
        id: row.id,
        code: row.code,
        title: row.title,
        rubric_id: row.rubric_id ?? null,
        content: refreshedContent,
        created_at: row.created_at,
      }
    });
  } catch (error) {
    console.error('Content update-my-item error:', error);
    res.status(500).json({ error: 'Failed to update published content' });
  }
});

/**
 * Store generated content history item for current user.
 */
router.post('/history', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content, input } = req.body || {};
    if (!content || !content.title) {
      return res.status(400).json({ error: 'content with title is required' });
    }

    const title = String(content.title || 'Untitled content').slice(0, 500);
    const normalized = contentService.normalizeGeneratedContent(content);
    let inserted;
    if (isMySQL()) {
      inserted = await query(
        `INSERT INTO content_generation_history (user_id, title, generated_content_json, input_json)
         VALUES (?, ?, ?, ?)`,
        [req.user.id, title, JSON.stringify(normalized), input ? JSON.stringify(input) : null]
      );
      const id = inserted.insertId ?? inserted.lastID;
      const rowResult = await query(
        'SELECT id, title, generated_content_json, input_json, created_at FROM content_generation_history WHERE id = ? AND user_id = ?',
        [id, req.user.id]
      );
      const row = Array.isArray(rowResult) ? rowResult[0] : (rowResult.rows && rowResult.rows[0]);
      return res.json({
        success: true,
        item: {
          id: row.id,
          title: row.title,
          content: parseJsonSafe(row.generated_content_json, null),
          input: parseJsonSafe(row.input_json, null),
          generation_trace: parseJsonSafe(row.input_json, null)?.generation_trace || null,
          created_at: row.created_at,
        }
      });
    }

    inserted = await query(
      `INSERT INTO content_generation_history (user_id, title, generated_content_json, input_json)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, generated_content_json, input_json, created_at`,
      [req.user.id, title, JSON.stringify(normalized), input ? JSON.stringify(input) : null]
    );
    const row = inserted.rows?.[0] || inserted?.[0];
    return res.json({
      success: true,
      item: {
        id: row.id,
        title: row.title,
        content: parseJsonSafe(row.generated_content_json, null),
        input: parseJsonSafe(row.input_json, null),
        generation_trace: parseJsonSafe(row.input_json, null)?.generation_trace || null,
        created_at: row.created_at,
      }
    });
  } catch (error) {
    console.error('Save content history error:', error);
    res.status(500).json({ error: 'Failed to save content history' });
  }
});

/**
 * Update one generated content history item for current user.
 */
router.put('/history/:id', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid history id' });
    }

    const { content, input } = req.body || {};
    if (!content || !content.title) {
      return res.status(400).json({ error: 'content with title is required' });
    }

    const title = String(content.title || 'Untitled content').slice(0, 500);
    const normalized = contentService.normalizeGeneratedContent(content);

    if (isMySQL()) {
      const updated = await query(
        `UPDATE content_generation_history
         SET title = ?, generated_content_json = ?, input_json = ?
         WHERE id = ? AND user_id = ?`,
        [title, JSON.stringify(normalized), input ? JSON.stringify(input) : null, id, req.user.id]
      );
      const affected = updated?.affectedRows ?? updated?.rowCount ?? updated?.changes ?? 0;
      if (!affected) {
        return res.status(404).json({ error: 'History item not found' });
      }
      const rowResult = await query(
        'SELECT id, title, generated_content_json, input_json, created_at FROM content_generation_history WHERE id = ? AND user_id = ?',
        [id, req.user.id]
      );
      const row = Array.isArray(rowResult) ? rowResult[0] : (rowResult.rows && rowResult.rows[0]);
      return res.json({
        success: true,
        item: {
          id: row.id,
          title: row.title,
          content: parseJsonSafe(row.generated_content_json, null),
          input: parseJsonSafe(row.input_json, null),
          generation_trace: parseJsonSafe(row.input_json, null)?.generation_trace || null,
          created_at: row.created_at,
        }
      });
    }

    const updated = await query(
      `UPDATE content_generation_history
       SET title = $1, generated_content_json = $2, input_json = $3
       WHERE id = $4 AND user_id = $5
       RETURNING id, title, generated_content_json, input_json, created_at`,
      [title, JSON.stringify(normalized), input ? JSON.stringify(input) : null, id, req.user.id]
    );
    const row = updated.rows?.[0] || updated?.[0];
    if (!row) {
      return res.status(404).json({ error: 'History item not found' });
    }
    return res.json({
      success: true,
      item: {
        id: row.id,
        title: row.title,
        content: parseJsonSafe(row.generated_content_json, null),
        input: parseJsonSafe(row.input_json, null),
        generation_trace: parseJsonSafe(row.input_json, null)?.generation_trace || null,
        created_at: row.created_at,
      }
    });
  } catch (error) {
    console.error('Update content history error:', error);
    res.status(500).json({ error: 'Failed to update content history' });
  }
});

/**
 * List generated content history for current user.
 */
router.get('/history', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const q = isMySQL()
      ? await query(
          `SELECT id, title, input_json, created_at
           FROM content_generation_history
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT 100`,
          [req.user.id]
        )
      : await query(
          `SELECT id, title, input_json, created_at
           FROM content_generation_history
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 100`,
          [req.user.id]
        );
    const rows = Array.isArray(q) ? q : (q.rows || []);
    const items = rows.map((row) => ({
      id: row.id,
      title: row.title,
      content: null,
      input: parseJsonSafe(row.input_json, null),
      generation_trace: parseJsonSafe(row.input_json, null)?.generation_trace || null,
      created_at: row.created_at,
    }));
    res.json({ success: true, items });
  } catch (error) {
    console.error('List content history error:', error);
    res.status(500).json({ error: 'Failed to fetch content history' });
  }
});

/**
 * Get one generated content history item for current user.
 */
router.get('/history/:id', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid history id' });
    }
    const q = isMySQL()
      ? await query(
          `SELECT id, title, generated_content_json, input_json, created_at
           FROM content_generation_history
           WHERE id = ? AND user_id = ?
           LIMIT 1`,
          [id, req.user.id]
        )
      : await query(
          `SELECT id, title, generated_content_json, input_json, created_at
           FROM content_generation_history
           WHERE id = $1 AND user_id = $2
           LIMIT 1`,
          [id, req.user.id]
        );
    const row = rowList(q)[0];
    if (!row) return res.status(404).json({ error: 'Content history item not found' });
    const input = parseJsonSafe(row.input_json, null);
    res.json({
      success: true,
      item: {
        id: row.id,
        title: row.title,
        content: parseJsonSafe(row.generated_content_json, null),
        input,
        generation_trace: input?.generation_trace || null,
        created_at: row.created_at,
      },
    });
  } catch (error) {
    console.error('Get content history item error:', error);
    res.status(500).json({ error: 'Failed to fetch content history item' });
  }
});

/**
 * Delete one content history item for current user.
 */
router.delete('/history/:id', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid history id' });
    }
    const deleted = isMySQL()
      ? await query('DELETE FROM content_generation_history WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('DELETE FROM content_generation_history WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'History item not found' });
    res.json({ success: true, message: 'History item removed' });
  } catch (error) {
    console.error('Delete content history error:', error);
    res.status(500).json({ error: 'Failed to delete history item' });
  }
});

/**
 * Clear all content history items for current user.
 */
router.delete('/history', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    if (isMySQL()) {
      await query('DELETE FROM content_generation_history WHERE user_id = ?', [req.user.id]);
    } else {
      await query('DELETE FROM content_generation_history WHERE user_id = $1', [req.user.id]);
    }
    res.json({ success: true, message: 'History cleared' });
  } catch (error) {
    console.error('Clear content history error:', error);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

/**
 * Schedule planner-based content generation and publishing.
 */
router.post('/planner/schedule', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const {
      topics,
      level,
      num_sections = 5,
      rubric_id,
      rubric_context,
      template_id = 'classroom',
      include_diagrams = true,
      include_images = true,
      include_mascot = false,
      scheduled_for,
    } = req.body || {};

    const cleanedTopics = String(topics || '').trim();
    if (!cleanedTopics) {
      return res.status(400).json({ error: 'topics is required' });
    }
    const scheduleTime = toSafeIsoDateTime(scheduled_for);
    if (!scheduleTime) {
      return res.status(400).json({ error: 'scheduled_for must be a valid datetime' });
    }
    if (scheduleTime.getTime() < Date.now() - 60 * 1000) {
      return res.status(400).json({ error: 'scheduled_for must be now or a future datetime' });
    }

    const maxSections = Math.min(Math.max(parseInt(num_sections, 10) || 5, 1), MAX_CONTENT_SECTIONS);
    const dbScheduled = scheduleTime.toISOString().slice(0, 19).replace('T', ' ');

    let insert;
    try {
      if (isMySQL()) {
        insert = await query(
          `INSERT INTO content_planner_jobs
            (user_id, topics, level, num_sections, template_id, rubric_id, rubric_context, include_diagrams, include_images, include_mascot, scheduled_for, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            req.user.id,
            cleanedTopics,
            level || null,
            maxSections,
            template_id || 'classroom',
            rubric_id || null,
            rubric_context || null,
            include_diagrams !== false ? 1 : 0,
            include_images !== false ? 1 : 0,
            include_mascot === true ? 1 : 0,
            dbScheduled,
            'scheduled',
          ]
        );
      } else {
        insert = await query(
          `INSERT INTO content_planner_jobs
            (user_id, topics, level, num_sections, template_id, rubric_id, rubric_context, include_diagrams, include_images, include_mascot, scheduled_for, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            req.user.id,
            cleanedTopics,
            level || null,
            maxSections,
            template_id || 'classroom',
            rubric_id || null,
            rubric_context || null,
            include_diagrams !== false,
            include_images !== false,
            include_mascot === true,
            dbScheduled,
            'scheduled',
          ]
        );
      }
    } catch (insertErr) {
      const msg = String(insertErr?.message || '').toLowerCase();
      const missingColumnError = msg.includes('unknown column') || msg.includes('does not exist');
      const includeColumnMissing = missingColumnError
        && (msg.includes('include_diagrams') || msg.includes('include_images') || msg.includes('include_mascot'));
      const templateColumnMissing = missingColumnError && msg.includes('template_id');
      if (!includeColumnMissing && !templateColumnMissing) throw insertErr;
      try {
        if (isMySQL()) {
          insert = await query(
            `INSERT INTO content_planner_jobs
              (user_id, topics, level, num_sections, template_id, rubric_id, rubric_context, scheduled_for, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, cleanedTopics, level || null, maxSections, template_id || 'classroom', rubric_id || null, rubric_context || null, dbScheduled, 'scheduled']
          );
        } else {
          insert = await query(
            `INSERT INTO content_planner_jobs
              (user_id, topics, level, num_sections, template_id, rubric_id, rubric_context, scheduled_for, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [req.user.id, cleanedTopics, level || null, maxSections, template_id || 'classroom', rubric_id || null, rubric_context || null, dbScheduled, 'scheduled']
          );
        }
      } catch (templateFallbackErr) {
        const fallbackMsg = String(templateFallbackErr?.message || '').toLowerCase();
        const fallbackTemplateMissing = (fallbackMsg.includes('template_id') && (fallbackMsg.includes('unknown column') || fallbackMsg.includes('does not exist')));
        if (!fallbackTemplateMissing) throw templateFallbackErr;
        if (isMySQL()) {
          insert = await query(
            `INSERT INTO content_planner_jobs
              (user_id, topics, level, num_sections, rubric_id, rubric_context, scheduled_for, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.id, cleanedTopics, level || null, maxSections, rubric_id || null, rubric_context || null, dbScheduled, 'scheduled']
          );
        } else {
          insert = await query(
            `INSERT INTO content_planner_jobs
              (user_id, topics, level, num_sections, rubric_id, rubric_context, scheduled_for, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [req.user.id, cleanedTopics, level || null, maxSections, rubric_id || null, rubric_context || null, dbScheduled, 'scheduled']
          );
        }
      }
    }
    const id = insert?.insertId ?? insert?.lastID ?? insert?.rows?.[0]?.id ?? null;
    runContentPlannerCycle().catch((err) => {
      console.error('Planner cycle kick-off failed:', err);
    });

    res.json({
      success: true,
      job: {
        id,
        status: 'scheduled',
        scheduled_for: scheduleTime.toISOString(),
        topics: cleanedTopics,
        level: level || null,
        num_sections: maxSections,
        template_id: template_id || 'classroom',
        include_diagrams: include_diagrams !== false,
        include_images: include_images !== false,
        include_mascot: include_mascot === true,
      },
    });
  } catch (error) {
    console.error('Schedule content planner error:', error);
    res.status(500).json({ error: 'Failed to schedule planner content' });
  }
});

/**
 * List current user's planner jobs.
 */
router.get('/planner/jobs', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    let q;
    try {
      q = isMySQL()
        ? await query(
            `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                    template_id, include_diagrams, include_images, include_mascot,
                    published_content_id, published_code, created_at, updated_at
             FROM content_planner_jobs
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT 200`,
            [req.user.id]
          )
        : await query(
            `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                    template_id, include_diagrams, include_images, include_mascot,
                    published_content_id, published_code, created_at, updated_at
             FROM content_planner_jobs
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 200`,
            [req.user.id]
          );
    } catch (selectErr) {
      const msg = String(selectErr?.message || '').toLowerCase();
      const missingColumnError = msg.includes('unknown column') || msg.includes('does not exist');
      const includeColumnMissing = missingColumnError
        && (msg.includes('include_diagrams') || msg.includes('include_images') || msg.includes('include_mascot'));
      const templateColumnMissing = missingColumnError && msg.includes('template_id');
      if (!includeColumnMissing && !templateColumnMissing) throw selectErr;
      try {
        q = isMySQL()
          ? await query(
              `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                      template_id, published_content_id, published_code, created_at, updated_at
               FROM content_planner_jobs
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT 200`,
              [req.user.id]
            )
          : await query(
              `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                      template_id, published_content_id, published_code, created_at, updated_at
               FROM content_planner_jobs
               WHERE user_id = $1
               ORDER BY created_at DESC
               LIMIT 200`,
              [req.user.id]
            );
      } catch (templateFallbackErr) {
        const fallbackMsg = String(templateFallbackErr?.message || '').toLowerCase();
        const fallbackTemplateMissing = fallbackMsg.includes('template_id')
          && (fallbackMsg.includes('unknown column') || fallbackMsg.includes('does not exist'));
        if (!fallbackTemplateMissing) throw templateFallbackErr;
        q = isMySQL()
          ? await query(
              `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                      published_content_id, published_code, created_at, updated_at
               FROM content_planner_jobs
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT 200`,
              [req.user.id]
            )
          : await query(
              `SELECT id, topics, level, num_sections, rubric_id, scheduled_for, status, error_message,
                      published_content_id, published_code, created_at, updated_at
               FROM content_planner_jobs
               WHERE user_id = $1
               ORDER BY created_at DESC
               LIMIT 200`,
              [req.user.id]
            );
      }
    }
    const rows = Array.isArray(q) ? q : (q.rows || []);
    res.json({ success: true, jobs: rows });
  } catch (error) {
    console.error('List content planner jobs error:', error);
    res.status(500).json({ error: 'Failed to fetch planner jobs' });
  }
});

/**
 * Cancel a scheduled planner job (before processing starts).
 */
router.post('/planner/:id/cancel', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid planner job id' });
    }

    const existing = isMySQL()
      ? await query('SELECT id, status FROM content_planner_jobs WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('SELECT id, status FROM content_planner_jobs WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const row = Array.isArray(existing) ? existing[0] : (existing.rows && existing.rows[0]);
    if (!row) return res.status(404).json({ error: 'Planner job not found' });
    if (row.status !== 'scheduled') {
      return res.status(400).json({ error: 'Only scheduled jobs can be cancelled' });
    }

    if (isMySQL()) {
      await query('UPDATE content_planner_jobs SET status = ?, updated_at = NOW() WHERE id = ? AND user_id = ?', ['cancelled', id, req.user.id]);
    } else {
      await query('UPDATE content_planner_jobs SET status = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', ['cancelled', id, req.user.id]);
    }
    res.json({ success: true, message: 'Planner job cancelled' });
  } catch (error) {
    console.error('Cancel content planner job error:', error);
    res.status(500).json({ error: 'Failed to cancel planner job' });
  }
});

/**
 * Delete one of the current user's published content items.
 */
router.delete(['/my/:id', '/:id'], requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid content id' });
    }

    const existing = isMySQL()
      ? await query(
          `SELECT pc.id, cv.file_path
           FROM published_content pc
           LEFT JOIN content_videos cv ON cv.published_content_id = pc.id
           WHERE pc.id = ? AND pc.user_id = ?`,
          [id, req.user.id]
        )
      : await query(
          `SELECT pc.id, cv.file_path
           FROM published_content pc
           LEFT JOIN content_videos cv ON cv.published_content_id = pc.id
           WHERE pc.id = $1 AND pc.user_id = $2`,
          [id, req.user.id]
        );
    const existingRows = Array.isArray(existing) ? existing : (existing.rows || []);
    const row = existingRows[0];
    if (!row) {
      return res.status(404).json({ error: 'Published content not found' });
    }

    const deleted = isMySQL()
      ? await query('DELETE FROM published_content WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('DELETE FROM published_content WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) {
      return res.status(404).json({ error: 'Published content not found' });
    }

    if (row.file_path) {
      try {
        if (fsSync.existsSync(row.file_path)) {
          await fs.unlink(row.file_path);
        }
      } catch (_) {}
    }

    res.json({ success: true, message: 'Published content deleted' });
  } catch (error) {
    console.error('Content delete error:', error);
    res.status(500).json({ error: 'Failed to delete published content' });
  }
});

/**
 * Get content by code (public) for students. Strips answer key from quiz.
 */
router.get('/take/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const row = await getPublishedContentByCode(code);
    if (!row) return res.status(404).json({ error: 'Content not found or link expired' });
    const repairedRow = await normalizeAndRepairPublishedContentRow(row, { triggerAudio: true });
    const content = repairedRow.content;
    if (content.quiz && content.quiz.questions) {
      content.quiz.questions = content.quiz.questions.map((q) => {
        const { correct_answer, ...rest } = q;
        return rest;
      });
    }
    const videoRow = isMySQL()
      ? await query('SELECT openai_video_id, openai_video_ids, status, file_path FROM content_videos WHERE published_content_id = (SELECT id FROM published_content WHERE code = ? LIMIT 1)', [code])
      : await query('SELECT cv.openai_video_id, cv.openai_video_ids, cv.status, cv.file_path FROM content_videos cv JOIN published_content pc ON pc.id = cv.published_content_id WHERE pc.code = $1', [code]);
    const vr = Array.isArray(videoRow) ? videoRow[0] : (videoRow.rows && videoRow.rows[0]);
    const video = vr ? { status: vr.status, file_path: vr.file_path } : null;
    res.json({ success: true, content, video });
  } catch (error) {
    console.error('Content take error:', error);
    res.status(500).json({ error: 'Failed to load content' });
  }
});

router.get('/audio/:code/:sectionIndex', async (req, res) => {
  try {
    const { code } = req.params;
    const sectionIndex = Number(req.params.sectionIndex);
    if (!Number.isFinite(sectionIndex) || sectionIndex < 0) {
      return res.status(400).json({ error: 'Invalid section index' });
    }

    const row = await getPublishedContentByCode(code);
    if (!row) return res.status(404).json({ error: 'Content not found or link expired' });

    const repairedRow = await normalizeAndRepairPublishedContentRow(row, { triggerAudio: true });
    const content = repairedRow.content;
    const sections = Array.isArray(content.sections) ? content.sections : [];
    if (!sections[sectionIndex]) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const voiceId = String(req.query.voice_id || 'eve').trim().toLowerCase() || 'eve';
    const language = String(req.query.language || 'en').trim().toLowerCase() || 'en';
    const narrationText = contentService.buildSectionNarrationText(content, sectionIndex);
    const audioPath = getContentAudioCachePath(code, sectionIndex, voiceId, language, narrationText, 'section');

    if (!fsSync.existsSync(audioPath)) {
      const audioBuffer = await contentService.synthesizeSectionSpeech(narrationText, {
        voiceId,
        language,
      });
      await fs.writeFile(audioPath, audioBuffer);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(audioPath);
  } catch (error) {
    console.error('Content TTS audio error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate section audio' });
  }
});

router.get('/checkpoint-audio/:code/:questionIndex', async (req, res) => {
  try {
    const { code } = req.params;
    const questionIndex = Number(req.params.questionIndex);
    if (!Number.isFinite(questionIndex) || questionIndex < 0) {
      return res.status(400).json({ error: 'Invalid question index' });
    }

    const row = await getPublishedContentByCode(code);
    if (!row) return res.status(404).json({ error: 'Content not found or link expired' });

    const repairedRow = await normalizeAndRepairPublishedContentRow(row, { triggerAudio: true });
    const content = repairedRow.content;
    if (content?.tts_enabled === false) {
      return res.status(403).json({ error: 'Text-to-speech is disabled for this content.' });
    }

    const narrationText = buildCheckpointQuestionNarrationText(content, questionIndex);
    if (!narrationText) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const voiceId = String(req.query.voice_id || 'eve').trim().toLowerCase() || 'eve';
    const language = String(req.query.language || 'en').trim().toLowerCase() || 'en';
    const audioPath = getContentAudioCachePath(code, questionIndex, voiceId, language, narrationText, 'checkpoint-question');

    if (!fsSync.existsSync(audioPath)) {
      const audioBuffer = await contentService.synthesizeSectionSpeech(narrationText, {
        voiceId,
        language,
      });
      await fs.writeFile(audioPath, audioBuffer);
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.sendFile(audioPath);
  } catch (error) {
    console.error('Checkpoint TTS audio error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate question audio' });
  }
});

/**
 * Submit quiz answers for content. Body: code, student_name, answers: [{ question_number, value }].
 * Runs marking and returns result (reuse assessment marking with synthetic rubric from quiz).
 */
router.post('/submit-quiz', async (req, res) => {
  try {
    const { code, student_name, answers } = req.body;
    if (!code || !student_name || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'code, student_name, and answers array are required' });
    }
    if (String(code).length > 32) return res.status(400).json({ error: 'code too long' });
    if (String(student_name).length > 200) return res.status(400).json({ error: 'student_name too long' });
    const pub = await getPublishedContentByCode(code);
    if (!pub) return res.status(404).json({ error: 'Content not found or link expired' });
    const content = typeof pub.content_json === 'string' ? JSON.parse(pub.content_json) : pub.content_json;
    const questions = (content.quiz && content.quiz.questions) || [];
    if (questions.length === 0) {
      return res.json({ success: true, result: { total_score: 0, feedback: 'No quiz in this content.', scores: [] } });
    }
    const answerMap = new Map(answers.map((a) => [a.question_number, a.value]));
    const scriptLines = questions.map((q) => {
      const num = q.number != null ? q.number : 0;
      const ans = answerMap.get(num) ?? answerMap.get(Number(num)) ?? '';
      return `Question ${num}: ${ans}`;
    });
    const scriptText = scriptLines.join('\n\n');
    const criteria = questions.map((q, i) => ({
      name: `Q${q.number != null ? q.number : i + 1}`,
      max_points: q.points != null ? q.points : 1,
      description: (q.question || '').slice(0, 200),
    }));
    const totalPoints = criteria.reduce((s, c) => s + (c.max_points || 0), 0);
    const rubricData = {
      id: null,
      name: 'Content quiz',
      total_points: totalPoints,
      criteria,
      rubric_type: 'rubric',
    };
    const { generateMarking } = require('./mark');
    const markingResult = await generateMarking(scriptText, rubricData, 'assignment', null, null, 'strict', null, null);
    const studentName = String(student_name).trim();
    const feedbackText = String(markingResult.overall_feedback || markingResult.feedback || '').trim();
    const contentTitle = String(content?.title || pub.title || 'Content knowledge check').trim();
    const assignmentFilename = `Knowledge Check - ${contentTitle} - ${studentName}`.slice(0, 255);
    let assignmentId = null;

    if (isMySQL()) {
      const insertAssignment = await query(
        'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text, user_id) VALUES (?, ?, ?, ?, ?, ?)',
        [assignmentFilename, '', 0, 'completed', scriptText, pub.user_id]
      );
      assignmentId = insertAssignment.insertId ?? insertAssignment.lastID ?? null;
    } else {
      const insertAssignment = await query(
        'INSERT INTO assignments (filename, file_path, file_size, status, extracted_text, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [assignmentFilename, '', 0, 'completed', scriptText, pub.user_id]
      );
      assignmentId = rowList(insertAssignment)[0]?.id ?? null;
    }

    if (assignmentId) {
      const versionQ = isMySQL()
        ? await query('SELECT COALESCE(MAX(version), 0) AS max_version FROM marking_results WHERE assignment_id = ? AND user_id = ?', [assignmentId, pub.user_id])
        : await query('SELECT COALESCE(MAX(version), 0) AS max_version FROM marking_results WHERE assignment_id = $1 AND user_id = $2', [assignmentId, pub.user_id]);
      const newVersion = Number(rowList(versionQ)[0]?.max_version || 0) + 1;

      if (isMySQL()) {
        await query(
          'UPDATE marking_results SET is_current = 0 WHERE assignment_id = ? AND user_id = ?',
          [assignmentId, pub.user_id]
        );
        await query(
          `INSERT INTO marking_results (
            assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current,
            strictness_level, provider, user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            assignmentId,
            null,
            studentName,
            JSON.stringify(markingResult.scores || []),
            feedbackText,
            Number(markingResult.total_score || 0),
            newVersion,
            1,
            'strict',
            'content-quiz',
            pub.user_id,
          ]
        );
      } else {
        await query(
          'UPDATE marking_results SET is_current = 0 WHERE assignment_id = $1 AND user_id = $2',
          [assignmentId, pub.user_id]
        );
        await query(
          `INSERT INTO marking_results (
            assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current,
            strictness_level, provider, user_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            assignmentId,
            null,
            studentName,
            JSON.stringify(markingResult.scores || []),
            feedbackText,
            Number(markingResult.total_score || 0),
            newVersion,
            true,
            'strict',
            'content-quiz',
            pub.user_id,
          ]
        );
      }
    }

    const answerPayload = JSON.stringify(Array.isArray(answers) ? answers : []);
    if (isMySQL()) {
      await query(
        `INSERT INTO content_progress
         (published_content_id, student_name, current_section, checkpoint_answers_json, completed, score, progress_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           checkpoint_answers_json = VALUES(checkpoint_answers_json),
           completed = VALUES(completed),
           score = VALUES(score),
           progress_json = VALUES(progress_json)`,
        [pub.id, studentName, 9999, answerPayload, 1, Number(markingResult.total_score || 0), answerPayload]
      );
    } else {
      await query(
        `INSERT INTO content_progress
         (published_content_id, student_name, current_section, checkpoint_answers_json, completed, score, progress_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (published_content_id, student_name) DO UPDATE
         SET checkpoint_answers_json = EXCLUDED.checkpoint_answers_json,
             completed = EXCLUDED.completed,
             score = EXCLUDED.score,
             progress_json = EXCLUDED.progress_json,
             updated_at = NOW()`,
        [pub.id, studentName, 9999, answerPayload, true, Number(markingResult.total_score || 0), answerPayload]
      );
    }
    res.json({
      success: true,
      result: {
        total_score: markingResult.total_score,
        feedback: feedbackText,
        scores: markingResult.scores,
      },
    });
  } catch (error) {
    console.error('Content submit-quiz error:', error);
    res.status(500).json({ error: 'Failed to mark quiz' });
  }
});

/**
 * Save learner progress/checkpoint state for content.
 */
router.post('/progress', async (req, res) => {
  try {
    const { code, student_name, current_section = 0, checkpoint_answers = null, progress = null, completed = false, score = null } = req.body || {};
    if (!code || !student_name) {
      return res.status(400).json({ error: 'code and student_name are required' });
    }
    const pubQ = isMySQL()
      ? await query('SELECT id FROM published_content WHERE code = ?', [code])
      : await query('SELECT id FROM published_content WHERE code = $1', [code]);
    const pub = Array.isArray(pubQ) ? pubQ[0] : (pubQ.rows && pubQ.rows[0]);
    if (!pub) return res.status(404).json({ error: 'Content not found or link expired' });
    const student = String(student_name).trim().slice(0, 255);
    const section = Number.isFinite(Number(current_section)) ? Number(current_section) : 0;
    const checkpointJson = checkpoint_answers != null ? JSON.stringify(checkpoint_answers) : null;
    const progressJson = progress != null ? JSON.stringify(progress) : null;
    const numericScore = score == null ? null : Number(score);

    if (isMySQL()) {
      await query(
        `INSERT INTO content_progress
         (published_content_id, student_name, current_section, checkpoint_answers_json, completed, score, progress_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          current_section = VALUES(current_section),
          checkpoint_answers_json = COALESCE(VALUES(checkpoint_answers_json), checkpoint_answers_json),
          completed = VALUES(completed),
          score = COALESCE(VALUES(score), score),
          progress_json = COALESCE(VALUES(progress_json), progress_json)`,
        [pub.id, student, section, checkpointJson, completed ? 1 : 0, Number.isFinite(numericScore) ? numericScore : null, progressJson]
      );
    } else {
      await query(
        `INSERT INTO content_progress
         (published_content_id, student_name, current_section, checkpoint_answers_json, completed, score, progress_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (published_content_id, student_name) DO UPDATE
         SET current_section = EXCLUDED.current_section,
             checkpoint_answers_json = COALESCE(EXCLUDED.checkpoint_answers_json, content_progress.checkpoint_answers_json),
             completed = EXCLUDED.completed,
             score = COALESCE(EXCLUDED.score, content_progress.score),
             progress_json = COALESCE(EXCLUDED.progress_json, content_progress.progress_json),
             updated_at = NOW()`,
        [pub.id, student, section, checkpointJson, !!completed, Number.isFinite(numericScore) ? numericScore : null, progressJson]
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Content progress save error:', error);
    res.status(500).json({ error: 'Failed to save content progress' });
  }
});

/**
 * Load learner progress/checkpoint state for content.
 */
router.get('/progress/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const studentName = String(req.query.student_name || '').trim();
    if (!studentName) return res.status(400).json({ error: 'student_name query is required' });

    const q = isMySQL()
      ? await query(
          `SELECT cp.current_section, cp.checkpoint_answers_json, cp.completed, cp.score, cp.progress_json
           FROM content_progress cp
           JOIN published_content pc ON pc.id = cp.published_content_id
           WHERE pc.code = ? AND cp.student_name = ?
           LIMIT 1`,
          [code, studentName]
        )
      : await query(
          `SELECT cp.current_section, cp.checkpoint_answers_json, cp.completed, cp.score, cp.progress_json
           FROM content_progress cp
           JOIN published_content pc ON pc.id = cp.published_content_id
           WHERE pc.code = $1 AND cp.student_name = $2
           LIMIT 1`,
          [code, studentName]
        );
    const row = Array.isArray(q) ? q[0] : (q.rows && q.rows[0]);
    if (!row) return res.json({ success: true, progress: null });

    let checkpointAnswers = null;
    let progress = null;
    try { checkpointAnswers = row.checkpoint_answers_json ? JSON.parse(row.checkpoint_answers_json) : null; } catch (_) {}
    try { progress = row.progress_json ? JSON.parse(row.progress_json) : null; } catch (_) {}

    res.json({
      success: true,
      progress: {
        current_section: Number(row.current_section || 0),
        checkpoint_answers: checkpointAnswers,
        completed: !!row.completed,
        score: row.score == null ? null : Number(row.score),
        progress,
      },
    });
  } catch (error) {
    console.error('Content progress load error:', error);
    res.status(500).json({ error: 'Failed to load content progress' });
  }
});

/**
 * Export content as PowerPoint. Body: { content }.
 */
router.post('/export/pptx', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content, provider = 'anthropic' } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const pptxProvider = String(provider || 'anthropic').toLowerCase() === 'openai' ? 'openai' : 'anthropic';
    const uploadedTemplate = await getUploadedTemplateByToken(req.user.id, content?.template_id);
    const templatePath = uploadedTemplate?.abs_path || null;

    const forceLocalExport = String(process.env.CONTENT_EXPORT_PPTX_FORCE_LOCAL || '').trim() === '1';
    const allowFallback = String(process.env.CONTENT_EXPORT_PPTX_ALLOW_FALLBACK || '').trim() === '1';
    const providerTimeoutMsRaw = Number(process.env.CONTENT_EXPORT_PPTX_PROVIDER_TIMEOUT_MS || 0);
    const providerTimeoutMs = Number.isFinite(providerTimeoutMsRaw)
      ? Math.max(0, Math.min(120000, providerTimeoutMsRaw))
      : 0;

    const withTimeout = (promise, timeoutMs, onTimeoutMessage) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(onTimeoutMessage)), timeoutMs);
      Promise.resolve(promise)
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

    let buffer;
    let usedFallback = false;
    if (templatePath && !forceLocalExport) {
      try {
        const exportPromise = contentService.buildPptx(content, { templatePath, provider: pptxProvider });
        buffer = providerTimeoutMs > 0
          ? await withTimeout(
              exportPromise,
              providerTimeoutMs,
              `Timed out waiting for ${pptxProvider.toUpperCase()} template export after ${providerTimeoutMs} ms`
            )
          : await exportPromise;
      } catch (providerErr) {
        if (!allowFallback) {
          throw providerErr;
        }
        usedFallback = true;
        console.warn('[content/export/pptx] Provider template export failed or timed out, falling back to local exporter:', providerErr?.message || providerErr);
        buffer = await contentService.buildPptx(content, { templatePath, forceLocal: true });
      }
    } else {
      buffer = await contentService.buildPptx(content, {
        templatePath,
        forceLocal: forceLocalExport,
        provider: pptxProvider,
      });
    }

    const filename = `${(content.title || 'content').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pptx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (usedFallback) {
      res.setHeader('X-MarkMate-Export-Fallback', 'local');
    }
    res.send(buffer);
  } catch (error) {
    console.error('Content PPTX export error:', error);
    const message = error?.message || 'Failed to export PPTX';
    const isUserFixable = /template|Anthropic API key|OpenAI API key|required|30 MB|\.pptx/i.test(message);
    res.status(isUserFixable ? 400 : 500).json({ error: isUserFixable ? message : 'Failed to export PPTX' });
  }
});

/**
 * Export content as lecture notes (HTML, includes answer key).
 */
router.post('/export/lecture-notes', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const html = contentService.buildLectureNotesHtml(content, true);
    const filename = `${(content.title || 'lecture-notes').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.html`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(html);
  } catch (error) {
    console.error('Content lecture notes export error:', error);
    res.status(500).json({ error: 'Failed to export lecture notes' });
  }
});

/**
 * Export content as SCORM 1.2 package ZIP (includes sections, visuals, checkpoint, SCORM runtime updates).
 */
router.post('/export/scorm', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });
    const normalized = contentService.normalizeGeneratedContent(content);
    const zipBuffer = await buildContentScormPackage(normalized);
    const filename = `${(normalized.title || 'content').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_scorm.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (error) {
    console.error('Content SCORM export error:', error);
    res.status(500).json({ error: 'Failed to export SCORM package' });
  }
});

/**
 * Upload PowerPoint template (stored for future use / slide styling).
 */
router.post('/template', requireAuth, requireFeature('content_creation'), (req, res) => {
  uploadTemplate(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'PowerPoint templates must be 30 MB or smaller.'
        : (err.message || 'Template upload failed');
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const baseName = String(req.file.originalname || 'Template').replace(/\.[^.]+$/, '').slice(0, 255) || 'Template';
      let inserted;
      if (isMySQL()) {
        inserted = await query(
          'INSERT INTO uploaded_ppt_templates (user_id, name, file_name) VALUES (?, ?, ?)',
          [req.user.id, baseName, req.file.filename]
        );
      } else {
        inserted = await query(
          'INSERT INTO uploaded_ppt_templates (user_id, name, file_name) VALUES ($1, $2, $3) RETURNING id',
          [req.user.id, baseName, req.file.filename]
        );
      }
      const templateId = inserted?.insertId ?? inserted?.lastID ?? inserted?.rows?.[0]?.id ?? null;
      const tmplFilePath = path.join(templateDir, req.file.filename);
      let extractedImages = [];
      let theme = {};
      try {
        const pptxTheme = await contentService.extractTemplateTheme(tmplFilePath);
        theme = contentService.pptxThemeToContentTheme(pptxTheme) || {};
        if (templateId) {
          const mediaDir = getTemplateMediaDir(templateId);
          const filenames = await contentService.extractTemplateImages(tmplFilePath, mediaDir);
          extractedImages = filenames.map((f) => buildTemplateMediaPublicUrl(req, templateId, f));
        }
      } catch (_) { /* non-fatal */ }
      res.json({
        success: true,
        template: {
          id: `uploaded:${templateId}`,
          name: `${baseName} (uploaded template)`,
          kind: 'uploaded',
          theme,
          images: extractedImages,
        },
        template_path: req.file.filename,
        original_name: req.file.originalname,
        message: `Template stored. Extracted ${extractedImages.length} image(s) from slides.`,
      });
    } catch (dbError) {
      console.error('Template metadata save error:', dbError);
      res.status(500).json({ error: 'Template upload succeeded, but metadata save failed' });
    }
  });
});

router.delete('/template/:templateId', requireAuth, requireFeature('content_creation'), async (req, res) => {
  try {
    const rawId = String(req.params.templateId || '').replace(/^uploaded:/i, '');
    const templateId = Number(rawId);
    if (!Number.isFinite(templateId) || templateId <= 0) {
      return res.status(400).json({ error: 'Only uploaded templates can be deleted.' });
    }

    const existingQ = isMySQL()
      ? await query(
          'SELECT id, file_name FROM uploaded_ppt_templates WHERE id = ? AND user_id = ?',
          [templateId, req.user.id]
        )
      : await query(
          'SELECT id, file_name FROM uploaded_ppt_templates WHERE id = $1 AND user_id = $2',
          [templateId, req.user.id]
        );
    const existing = Array.isArray(existingQ) ? existingQ[0] : (existingQ.rows && existingQ.rows[0]);
    if (!existing) {
      return res.status(404).json({ error: 'Uploaded template not found.' });
    }

    if (isMySQL()) {
      await query('DELETE FROM uploaded_ppt_templates WHERE id = ? AND user_id = ?', [templateId, req.user.id]);
    } else {
      await query('DELETE FROM uploaded_ppt_templates WHERE id = $1 AND user_id = $2', [templateId, req.user.id]);
    }

    if (existing.file_name) {
      await fs.unlink(path.join(templateDir, existing.file_name)).catch((unlinkError) => {
        console.warn('Uploaded template file delete failed:', unlinkError?.message || unlinkError);
      });
      await fs.rm(getTemplateMediaDir(templateId), { recursive: true, force: true }).catch((rmError) => {
        console.warn('Uploaded template media delete failed:', rmError?.message || rmError);
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

/**
 * Video status for published content (poll from take-content page).
 */
router.get('/video-status/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const pc = isMySQL()
      ? await query('SELECT id FROM published_content WHERE code = ?', [code])
      : await query('SELECT id FROM published_content WHERE code = $1', [code]);
    const pcRow = Array.isArray(pc) ? pc[0] : (pc.rows && pc.rows[0]);
    if (!pcRow) return res.status(404).json({ error: 'Not found' });
    const cv = isMySQL()
      ? await query('SELECT openai_video_id, openai_video_ids, status, file_path FROM content_videos WHERE published_content_id = ?', [pcRow.id])
      : await query('SELECT openai_video_id, openai_video_ids, status, file_path FROM content_videos WHERE published_content_id = $1', [pcRow.id]);
    const cvRow = Array.isArray(cv) ? cv[0] : (cv.rows && cv.rows[0]);
    if (!cvRow) return res.json({ status: null, video_url: null });
    if (cvRow.status === 'completed' && cvRow.file_path) {
      return res.json({ status: 'completed', video_url: `${API_BASE}/content/video/${code}/content` });
    }

    let videoIds = [];
    try {
      if (cvRow.openai_video_ids) {
        videoIds = typeof cvRow.openai_video_ids === 'string'
          ? JSON.parse(cvRow.openai_video_ids)
          : cvRow.openai_video_ids;
      }
    } catch (_) {}

    if (Array.isArray(videoIds) && videoIds.length > 1) {
      const statuses = await Promise.all(videoIds.map((id) => feedbackVideoService.getVideoStatus(id)));
      const failed = statuses.find((s) => s.status === 'failed');
      if (failed) {
        if (isMySQL()) {
          await query('UPDATE content_videos SET status = ?, openai_video_ids = ? WHERE published_content_id = ?', ['failed', null, pcRow.id]);
        } else {
          await query('UPDATE content_videos SET status = $1, openai_video_ids = $2 WHERE published_content_id = $3', ['failed', null, pcRow.id]);
        }
        return res.json({ status: 'failed', error: failed.error || 'One or more clips failed' });
      }

      const allDone = statuses.every((s) => s.status === 'completed');
      if (!allDone) {
        const progress = Math.round((statuses.filter((s) => s.status === 'completed').length / statuses.length) * 100);
        return res.json({ status: 'in_progress', progress });
      }

      const filePath = path.join(CONTENT_VIDEOS_DIR, `${pcRow.id}.mp4`);
      const tempDir = path.join(CONTENT_VIDEOS_DIR, 'temp', String(pcRow.id));
      const tempPaths = [];
      try {
        if (!fsSync.existsSync(tempDir)) fsSync.mkdirSync(tempDir, { recursive: true });
        if (!fsSync.existsSync(CONTENT_VIDEOS_DIR)) fsSync.mkdirSync(CONTENT_VIDEOS_DIR, { recursive: true });
        for (let i = 0; i < videoIds.length; i++) {
          const buf = await feedbackVideoService.getVideoContent(videoIds[i]);
          const clipPath = path.join(tempDir, `clip-${i}.mp4`);
          fsSync.writeFileSync(clipPath, buf);
          tempPaths.push(clipPath);
        }
        await feedbackVideoService.stitchVideos(tempPaths, filePath);
      } catch (stitchErr) {
        if (isMySQL()) {
          await query('UPDATE content_videos SET status = ? WHERE published_content_id = ?', ['failed', pcRow.id]);
        } else {
          await query('UPDATE content_videos SET status = $1 WHERE published_content_id = $2', ['failed', pcRow.id]);
        }
        return res.json({ status: 'failed', error: stitchErr.message || 'Failed to stitch clips. Ensure ffmpeg is installed.' });
      } finally {
        for (const clipPath of tempPaths) {
          try {
            if (fsSync.existsSync(clipPath)) fsSync.unlinkSync(clipPath);
          } catch (_) {}
        }
        try {
          if (fsSync.existsSync(tempDir)) fsSync.rmdirSync(tempDir);
        } catch (_) {}
      }

      if (isMySQL()) {
        await query('UPDATE content_videos SET status = ?, file_path = ?, openai_video_ids = ? WHERE published_content_id = ?', ['completed', filePath, null, pcRow.id]);
      } else {
        await query('UPDATE content_videos SET status = $1, file_path = $2, openai_video_ids = $3 WHERE published_content_id = $4', ['completed', filePath, null, pcRow.id]);
      }
      return res.json({ status: 'completed', video_url: `${API_BASE}/content/video/${code}/content` });
    }

    const { status, progress, error } = await feedbackVideoService.getVideoStatus(cvRow.openai_video_id);
    if (status === 'completed') {
      const filePath = path.join(CONTENT_VIDEOS_DIR, `${pcRow.id}.mp4`);
      if (!fsSync.existsSync(CONTENT_VIDEOS_DIR)) {
        fsSync.mkdirSync(CONTENT_VIDEOS_DIR, { recursive: true });
      }
      const buffer = await feedbackVideoService.getVideoContent(cvRow.openai_video_id);
      await fs.writeFile(filePath, buffer);
      if (isMySQL()) {
        await query('UPDATE content_videos SET status = ?, file_path = ? WHERE published_content_id = ?', ['completed', filePath, pcRow.id]);
      } else {
        await query('UPDATE content_videos SET status = $1, file_path = $2 WHERE published_content_id = $3', ['completed', filePath, pcRow.id]);
      }
      return res.json({ status: 'completed', video_url: `${API_BASE}/content/video/${code}/content` });
    }
    res.json({ status: status || cvRow.status, progress, error });
  } catch (error) {
    console.error('Content video status error:', error);
    res.status(500).json({ error: 'Failed to get video status' });
  }
});

/**
 * Serve content video file (for take-content page).
 */
router.get('/video/:code/content', async (req, res) => {
  try {
    const { code } = req.params;
    const pc = isMySQL()
      ? await query('SELECT id FROM published_content WHERE code = ?', [code])
      : await query('SELECT id FROM published_content WHERE code = $1', [code]);
    const pcRow = Array.isArray(pc) ? pc[0] : (pc.rows && pc.rows[0]);
    if (!pcRow) return res.status(404).end();
    const cv = isMySQL()
      ? await query('SELECT file_path FROM content_videos WHERE published_content_id = ? AND status = ?', [pcRow.id, 'completed'])
      : await query('SELECT file_path FROM content_videos WHERE published_content_id = $1 AND status = $2', [pcRow.id, 'completed']);
    const cvRow = Array.isArray(cv) ? cv[0] : (cv.rows && cv.rows[0]);
    if (!cvRow || !cvRow.file_path) return res.status(404).end();
    if (!fsSync.existsSync(cvRow.file_path)) return res.status(404).end();
    streamMp4WithRange(req, res, path.resolve(cvRow.file_path));
  } catch (error) {
    console.error('Content video serve error:', error);
    res.status(500).end();
  }
});

module.exports = router;
