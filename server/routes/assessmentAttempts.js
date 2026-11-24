'use strict';

/**
 * Monitored assessment attempts (mounted at /assessments/attempts).
 *
 * Students opt in with /start, which is the only way to receive the questions of a
 * monitored assessment. The browser then sends batches of integrity events (and a draft
 * of the answers) every few seconds, and the attempt ends only through an explicit
 * submit or exit. Lecturers who own the assessment, and management in the same
 * organisation, can read the integrity reports.
 */

const express = require('express');
const crypto = require('crypto');
const { query } = require('../database/connection');
const { requireAuth } = require('../middleware/auth');
const integrity = require('../services/assessmentIntegrityService');
const coursePolicy = require('../services/courseIntegrityPolicyService');
const { userCanUseCourse } = require('../services/courseScopeService');
const webcam = require('../services/webcamPolicyService');
const { recordAuditEvent, getRequestMetadata } = require('../services/auditEventService');

// Another browser session sending events within this window counts as a second session.
const ACTIVE_SESSION_MS = 45000;
const MAX_DRAFT_ANSWERS = 500;
const MAX_ANSWER_CHARS = 20000;

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowsOf = (result) => {
  const value = result?.rows || result;
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};
const firstRow = (result) => rowsOf(result)[0] || null;
const parseJson = (value, fallback = null) => {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
};
const insertReturningId = async (sql, params) => {
  if (isMySQL()) {
    const result = await query(sql, params);
    return result?.insertId ?? result?.lastID ?? null;
  }
  return firstRow(await query(`${sql} RETURNING id`, params))?.id ?? null;
};
const normalizeRole = (role) => String(role || '').trim().toLowerCase();
const sessionIdOf = (value) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;
const clientIp = (req) => integrity.normalizeIp(req.ip || req.socket?.remoteAddress || '');

const stripAnswerKey = (question) => {
  const { correct_answer, correct_pairings, ...rest } = question;
  return rest;
};

const sanitizeDraftAnswers = (answers) => {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const draft = {};
  for (const [key, value] of Object.entries(answers).slice(0, MAX_DRAFT_ANSWERS)) {
    if (!/^\d{1,4}$/.test(key)) continue;
    draft[key] = String(value ?? '').slice(0, MAX_ANSWER_CHARS);
  }
  return draft;
};

const loadPublishedByCode = async (code) => firstRow(await query(
  'SELECT id, code, assessment_json, rubric_id, batch_id, user_id, integrity_settings FROM published_assessments WHERE code = $1',
  [String(code || '').slice(0, 32)]
));

const loadPublishedById = async (id) => firstRow(await query(
  `SELECT pa.id, pa.code, pa.assessment_json, pa.rubric_id, pa.batch_id, pa.user_id, pa.integrity_settings, pa.course_id,
          u.organisation_id AS owner_organisation_id
   FROM published_assessments pa LEFT JOIN users u ON u.id = pa.user_id
   WHERE pa.id = $1`,
  [id]
));

const findInProgressAttempt = async (token, userId) => {
  if (!token || !userId) return null;
  const attempt = firstRow(await query(
    'SELECT * FROM assessment_attempts WHERE attempt_token = $1 AND student_user_id = $2',
    [String(token).slice(0, 64), userId]
  ));
  return attempt && attempt.status === 'in_progress' ? attempt : null;
};

const canViewReports = (user, pub) => {
  if (!user || !pub) return false;
  if (Number(pub.user_id) === Number(user.id)) return true;
  return normalizeRole(user.role) === 'management'
    && user.organisation_id != null
    && Number(user.organisation_id) === Number(pub.owner_organisation_id);
};

// Stored settings limited by the owner's organisation webcam policy (revoking it turns webcam off).
const effectiveSettings = async (pub) => {
  const settings = integrity.parseStoredSettings(pub?.integrity_settings);
  if (!settings) return null;
  return webcam.clampSettings(settings, await webcam.getOrganisationPolicy(pub.owner_organisation_id));
};

const recordEvent = async (attemptId, event, ip) => {
  await query(
    `INSERT INTO assessment_attempt_events
      (attempt_id, event_type, severity, question_number, duration_ms, details, ip_address, client_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      attemptId,
      event.type,
      integrity.classifyEvent(event),
      event.question_number ?? null,
      event.duration_ms ?? null,
      event.details && Object.keys(event.details).length ? JSON.stringify(event.details) : null,
      ip || null,
      event.client_time ?? null
    ]
  );
};

const loadEvents = async (attemptId) => rowsOf(await query(
  'SELECT id, event_type, severity, question_number, duration_ms, details, ip_address, client_time, created_at FROM assessment_attempt_events WHERE attempt_id = $1 ORDER BY id',
  [attemptId]
)).map((row) => ({
  id: row.id,
  type: row.event_type,
  severity: row.severity,
  question_number: row.question_number,
  duration_ms: row.duration_ms,
  details: parseJson(row.details, {}) || {},
  ip_address: row.ip_address,
  client_time: row.client_time != null ? Number(row.client_time) : null,
  created_at: row.created_at
}));

/**
 * Record a heartbeat from the browser: server-side checks (IP, second session,
 * connection gaps), the client's events, the draft answers, and a fresh score.
 */
const processHeartbeat = async ({ attempt, settings, ip, sessionId, clientEvents = [], answers = null, clientAway = false, takeOver = false, now = Date.now() }) => {
  const serverEvents = [];
  const ipList = parseJson(attempt.ip_addresses, []) || [];
  const lastIp = ipList.length ? ipList[ipList.length - 1].ip : null;

  if (ip && lastIp && ip !== lastIp) {
    serverEvents.push({ type: 'ip_changed', client_time: now, details: { from: lastIp, to: ip } });
  }
  if (ip && !ipList.some((entry) => entry.ip === ip)) {
    if (!integrity.ipInRanges(ip, settings.allowed_ip_ranges)) {
      serverEvents.push({ type: 'ip_outside_range', client_time: now, details: { ip } });
    }
  }
  const updatedIps = ipList.filter((entry) => entry.ip !== ip);
  if (ip) {
    const existing = ipList.find((entry) => entry.ip === ip);
    updatedIps.push({ ip, first_seen: existing?.first_seen || new Date(now).toISOString(), last_seen: new Date(now).toISOString() });
  }

  const lastSeen = attempt.last_seen_at ? new Date(attempt.last_seen_at).getTime() : null;
  let activeSessionId = attempt.active_session_id;
  if (sessionId && sessionId !== activeSessionId) {
    // Reopening the assessment (/start) takes over: after a crash the old session is gone.
    // If the old session is still alive, its next heartbeat arrives here and is flagged.
    if (!takeOver && lastSeen && now - lastSeen < ACTIVE_SESSION_MS) {
      // The original session is still sending heartbeats: keep it active and flag the newcomer.
      serverEvents.push({ type: 'duplicate_session', client_time: now, details: {} });
    } else {
      activeSessionId = sessionId;
    }
  }

  // A long silence (closed tab, lost connection) counts as time away, unless the browser
  // already reported that time as having left the exam.
  if (lastSeen && sessionId === activeSessionId && !clientAway) {
    const gap = now - lastSeen;
    const reportedAway = clientEvents
      .filter((event) => event.type === 'focus_lost' || event.type === 'fullscreen_exit')
      .reduce((max, event) => Math.max(max, event.duration_ms || 0), 0);
    if (gap >= integrity.THRESHOLDS.connectionGapMs && reportedAway < gap / 2) {
      serverEvents.push({ type: 'connection_gap', duration_ms: gap, client_time: now, details: {} });
    }
  }

  for (const event of [...serverEvents, ...clientEvents]) {
    await recordEvent(attempt.id, event, ip);
  }

  const summary = integrity.summarizeAttempt(await loadEvents(attempt.id));
  const draft = sanitizeDraftAnswers(answers);
  const saveDraft = Boolean(draft) && (sessionId === activeSessionId || !sessionId);
  // Placeholders must stay in textual order: MySQL replaces $n with ? positionally.
  await query(
    `UPDATE assessment_attempts SET
       ip_addresses = $1, active_session_id = $2, integrity_score = $3, integrity_status = $4,
       integrity_summary = $5, last_seen_at = CURRENT_TIMESTAMP${saveDraft ? ', draft_answers = $6' : ''}
     WHERE id = ${saveDraft ? '$7' : '$6'}`,
    [
      JSON.stringify(updatedIps.slice(-20)),
      activeSessionId,
      summary.score,
      summary.status,
      JSON.stringify(summary),
      ...(saveDraft ? [JSON.stringify(draft)] : []),
      attempt.id
    ]
  );
  return summary;
};

const studentQuestionsFor = (assessment, order) => {
  const questions = Array.isArray(assessment.questions) ? assessment.questions : [];
  const indices = Array.isArray(order) && order.length === questions.length ? order : questions.map((_, i) => i);
  return indices.map((sourceIndex) => ({ ...stripAnswerKey(questions[sourceIndex]), source_index: sourceIndex }));
};

const attemptReportRow = (row) => ({
  id: row.id,
  student_user_id: row.student_user_id,
  student_name: row.student_name || row.student_email || `Student ${row.student_user_id}`,
  student_email: row.student_email || null,
  status: row.status,
  exit_reason: row.exit_reason,
  started_at: row.started_at,
  last_seen_at: row.last_seen_at,
  ended_at: row.ended_at,
  integrity_score: Number(row.integrity_score || 0),
  integrity_status: row.integrity_status || 'clean',
  summary: parseJson(row.integrity_summary, null),
  ip_addresses: parseJson(row.ip_addresses, []) || [],
  user_agent: row.user_agent,
  submission_code: row.submission_code || null,
  media_count: Number(row.media_count || 0)
});

// Students on the same network share a public IP: note it, so remote exams can be checked.
const addSharedIpNotes = (attempts) => {
  const byIp = new Map();
  for (const attempt of attempts) {
    for (const { ip } of attempt.ip_addresses) {
      if (!byIp.has(ip)) byIp.set(ip, new Set());
      byIp.get(ip).add(attempt.id);
    }
  }
  return attempts.map((attempt) => {
    const others = new Set();
    for (const { ip } of attempt.ip_addresses) {
      for (const id of byIp.get(ip) || []) if (id !== attempt.id) others.add(id);
    }
    return {
      ...attempt,
      shared_ip_with: attempts.filter((other) => others.has(other.id)).map((other) => other.student_name)
    };
  });
};

const csvCell = (value) => {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const createAttemptsRouter = ({ createSubmission }) => {
  const router = express.Router();

  // ---------------------------------------------------------------- students

  router.post('/start', requireAuth, async (req, res) => {
    try {
      const byCode = await loadPublishedByCode(req.body?.code);
      const pub = byCode ? await loadPublishedById(byCode.id) : null;
      if (!pub) return res.status(404).json({ error: 'Assessment not found or link expired' });
      const settings = await effectiveSettings(pub);
      if (!settings) return res.status(400).json({ error: 'This assessment is not monitored.' });

      const assessment = parseJson(pub.assessment_json, {}) || {};
      const ip = clientIp(req);
      const sessionId = sessionIdOf(req.body?.session_id);
      let attempt = firstRow(await query(
        'SELECT * FROM assessment_attempts WHERE published_assessment_id = $1 AND student_user_id = $2 ORDER BY id DESC LIMIT 1',
        [pub.id, req.user.id]
      ));

      if (attempt && attempt.status !== 'in_progress') {
        return res.status(409).json({
          error: attempt.status === 'submitted'
            ? 'You have already submitted this assessment.'
            : 'You exited this assessment. Ask your lecturer to reopen it if you need to continue.',
          status: attempt.status
        });
      }

      if (attempt) {
        await recordEvent(attempt.id, { type: 'attempt_resumed', client_time: Date.now(), details: {} }, ip);
        await processHeartbeat({ attempt, settings, ip, sessionId, takeOver: true });
      } else {
        if (!integrity.ipInRanges(ip, settings.allowed_ip_ranges)) {
          return res.status(403).json({ error: 'This assessment can only be started from the exam venue network.' });
        }
        const questionCount = Array.isArray(assessment.questions) ? assessment.questions.length : 0;
        const order = settings.shuffle_questions ? integrity.shuffledOrder(questionCount) : null;
        const now = new Date().toISOString();
        const attemptId = await insertReturningId(
          `INSERT INTO assessment_attempts
            (attempt_token, published_assessment_id, student_user_id, status, question_order, ip_addresses, user_agent, active_session_id, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
          [
            crypto.randomBytes(24).toString('hex'),
            pub.id,
            req.user.id,
            'in_progress',
            order ? JSON.stringify(order) : null,
            JSON.stringify(ip ? [{ ip, first_seen: now, last_seen: now }] : []),
            String(req.get('user-agent') || '').slice(0, 500),
            sessionId
          ]
        );
        await recordEvent(attemptId, { type: 'attempt_started', client_time: Date.now(), details: {} }, ip);
      }

      attempt = firstRow(await query(
        'SELECT * FROM assessment_attempts WHERE published_assessment_id = $1 AND student_user_id = $2 ORDER BY id DESC LIMIT 1',
        [pub.id, req.user.id]
      ));

      res.json({
        success: true,
        attempt: {
          token: attempt.attempt_token,
          status: attempt.status,
          started_at: attempt.started_at
        },
        settings,
        assessment: {
          title: assessment.title,
          topic: assessment.topic,
          instructions: assessment.instructions,
          estimated_time: assessment.estimated_time,
          questions: studentQuestionsFor(assessment, parseJson(attempt.question_order, null))
        },
        draft_answers: parseJson(attempt.draft_answers, {}) || {}
      });
    } catch (error) {
      console.error('Start monitored attempt error:', error);
      res.status(500).json({ error: 'Could not start the assessment' });
    }
  });

  const withAttempt = (handler) => async (req, res) => {
    try {
      const attempt = firstRow(await query(
        'SELECT * FROM assessment_attempts WHERE attempt_token = $1 AND student_user_id = $2',
        [String(req.params.token || '').slice(0, 64), req.user.id]
      ));
      if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
      if (attempt.status !== 'in_progress') {
        return res.status(409).json({ error: 'This attempt has already ended.', status: attempt.status });
      }
      const pub = await loadPublishedById(attempt.published_assessment_id);
      const settings = (await effectiveSettings(pub)) || integrity.normalizeSettings({ enabled: true });
      return await handler(req, res, { attempt, pub, settings });
    } catch (error) {
      console.error('Monitored attempt error:', error);
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong saving your attempt' });
    }
  };

  router.post('/session/:token/events', requireAuth, withAttempt(async (req, res, { attempt, settings }) => {
    const summary = await processHeartbeat({
      attempt,
      settings,
      ip: clientIp(req),
      sessionId: sessionIdOf(req.body?.session_id),
      clientEvents: integrity.sanitizeClientEvents(req.body?.events),
      answers: req.body?.answers,
      clientAway: req.body?.away === true
    });
    res.json({ success: true, status: 'in_progress', integrity_status: summary.status });
  }));

  router.post('/session/:token/submit', requireAuth, withAttempt(async (req, res, { attempt, pub, settings }) => {
    if (!Array.isArray(req.body?.answers)) {
      return res.status(400).json({ error: 'answers array is required' });
    }
    await processHeartbeat({
      attempt,
      settings,
      ip: clientIp(req),
      sessionId: sessionIdOf(req.body?.session_id),
      clientEvents: integrity.sanitizeClientEvents(req.body?.events)
    });
    const assessment = parseJson(pub.assessment_json, {}) || {};
    const studentUserId = normalizeRole(req.user.role) === 'student' ? Number(req.user.id) : null;
    const { id: submissionId, ...submission } = await createSubmission({
      pub,
      assessment,
      studentName: String(req.user.name || req.user.email || `Student ${req.user.id}`).trim().slice(0, 200),
      studentUserId,
      answers: req.body.answers
    });
    await recordEvent(attempt.id, { type: 'submitted', client_time: Date.now(), details: {} }, clientIp(req));
    await query(
      `UPDATE assessment_attempts SET status = 'submitted', exit_reason = 'submitted', ended_at = CURRENT_TIMESTAMP, submission_id = $1 WHERE id = $2`,
      [submissionId ?? null, attempt.id]
    );
    res.status(202).json({ success: true, submission });
  }));

  router.post('/session/:token/exit', requireAuth, withAttempt(async (req, res, { attempt, settings }) => {
    await processHeartbeat({
      attempt,
      settings,
      ip: clientIp(req),
      sessionId: sessionIdOf(req.body?.session_id),
      clientEvents: integrity.sanitizeClientEvents(req.body?.events),
      answers: req.body?.answers
    });
    await recordEvent(attempt.id, { type: 'exited', client_time: Date.now(), details: {} }, clientIp(req));
    await query(
      `UPDATE assessment_attempts SET status = 'exited', exit_reason = 'exited_without_submitting', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [attempt.id]
    );
    res.json({ success: true, status: 'exited' });
  }));

  // Webcam snapshot or video chunk from the student's browser. Raw body: image/jpeg or video/webm.
  router.post(
    '/session/:token/media',
    requireAuth,
    express.raw({ type: ['image/jpeg', 'video/webm'], limit: '7mb' }),
    withAttempt(async (req, res, { attempt, pub, settings }) => {
      const kind = req.query.kind === 'video' ? 'video' : 'snapshot';
      const type = webcam.MEDIA_TYPES[kind];
      if (settings.webcam === 'off' || (kind === 'video' && settings.webcam !== 'video')) {
        return res.status(403).json({ error: 'Webcam capture is not enabled for this assessment.' });
      }
      const buffer = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buffer || !buffer.length || req.get('content-type') !== type.mime || buffer.length > type.maxBytes) {
        return res.status(400).json({ error: 'Invalid webcam upload' });
      }
      // Snapshots arrive every 30 s plus on flags: refuse floods.
      const recent = Number(firstRow(await query(
        `SELECT COUNT(*) AS n FROM assessment_attempt_media WHERE attempt_id = $1 AND created_at > $2`,
        [attempt.id, new Date(Date.now() - 60000)]
      ))?.n || 0);
      if (recent >= 12) return res.status(429).json({ error: 'Too many webcam uploads' });

      const policy = await webcam.getOrganisationPolicy(pub.owner_organisation_id);
      await webcam.saveMedia({
        attemptId: attempt.id,
        kind,
        reason: req.query.reason === 'flag' ? 'flag' : 'interval',
        buffer,
        clientTime: Number.isFinite(Number(req.query.client_time)) ? Number(req.query.client_time) : null,
        retentionDays: policy.retention_days
      });
      res.status(201).json({ success: true });
    })
  );

  // ------------------------------------------------------- lecturers / management

  const requireStaff = (req, res, next) => {
    const role = normalizeRole(req.user?.role);
    if (role !== 'lecturer' && role !== 'management') {
      return res.status(403).json({ error: 'Only lecturers and management can view integrity reports' });
    }
    return next();
  };

  const withViewablePublished = (handler) => async (req, res) => {
    try {
      const pub = await loadPublishedById(Number(req.params.publishedId));
      if (!pub || !canViewReports(req.user, pub)) {
        return res.status(404).json({ error: 'Assessment not found' });
      }
      return await handler(req, res, pub);
    } catch (error) {
      console.error('Integrity report error:', error);
      return res.status(500).json({ error: 'Failed to load integrity report' });
    }
  };

  router.get('/presets', requireAuth, requireStaff, (req, res) => {
    res.json({ success: true, presets: integrity.PRESETS });
  });

  // Staff preview of the student view: questions without answer keys, and nothing recorded.
  router.get('/preview/:code', requireAuth, requireStaff, async (req, res) => {
    try {
      const byCode = await loadPublishedByCode(req.params.code);
      const pub = byCode ? await loadPublishedById(byCode.id) : null;
      if (!pub || !canViewReports(req.user, pub)) return res.status(404).json({ error: 'Assessment not found' });
      const settings = await effectiveSettings(pub);
      const assessment = parseJson(pub.assessment_json, {}) || {};
      const count = Array.isArray(assessment.questions) ? assessment.questions.length : 0;
      res.json({
        success: true,
        settings,
        assessment: {
          title: assessment.title,
          topic: assessment.topic,
          instructions: assessment.instructions,
          estimated_time: assessment.estimated_time,
          questions: studentQuestionsFor(assessment, settings?.shuffle_questions ? integrity.shuffledOrder(count) : null)
        }
      });
    } catch (error) {
      console.error('Integrity preview error:', error);
      res.status(500).json({ error: 'Failed to load preview' });
    }
  });

  const loadAttemptRows = (publishedId) => query(
    `SELECT aa.*, u.name AS student_name, u.email AS student_email, s.submission_code,
            (SELECT COUNT(*) FROM assessment_attempt_media m WHERE m.attempt_id = aa.id) AS media_count
     FROM assessment_attempts aa
     LEFT JOIN users u ON u.id = aa.student_user_id
     LEFT JOIN assessment_submissions s ON s.id = aa.submission_id
     WHERE aa.published_assessment_id = $1
     ORDER BY aa.integrity_score DESC, aa.started_at ASC`,
    [publishedId]
  );

  // Assessments this user can report on: their own, plus their organisation's for management.
  router.get('/monitored', requireAuth, requireStaff, async (req, res) => {
    try {
      const isManagement = normalizeRole(req.user.role) === 'management' && req.user.organisation_id != null;
      const result = await query(
        `SELECT pa.id, pa.code, pa.assessment_json, pa.integrity_settings, pa.created_at, pa.user_id,
                u.name AS owner_name, u.email AS owner_email
         FROM published_assessments pa LEFT JOIN users u ON u.id = pa.user_id
         WHERE ${isManagement ? '(pa.user_id = $1 OR u.organisation_id = $2)' : 'pa.user_id = $1'}
         ORDER BY pa.created_at DESC`,
        isManagement ? [req.user.id, req.user.organisation_id] : [req.user.id]
      );
      const publishedRows = rowsOf(result);
      const counts = new Map();
      if (publishedRows.length) {
        const ids = publishedRows.map((row) => Number(row.id));
        const countRows = rowsOf(await query(
          `SELECT published_assessment_id, status, integrity_status, COUNT(*) AS n
           FROM assessment_attempts WHERE published_assessment_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})
           GROUP BY published_assessment_id, status, integrity_status`,
          ids
        ));
        for (const row of countRows) {
          const key = Number(row.published_assessment_id);
          const entry = counts.get(key) || { total: 0, in_progress: 0, submitted: 0, exited: 0, review_suggested: 0, review_needed: 0 };
          const n = Number(row.n || 0);
          entry.total += n;
          if (entry[row.status] != null) entry[row.status] += n;
          if (entry[row.integrity_status] != null) entry[row.integrity_status] += n;
          counts.set(key, entry);
        }
      }
      const items = publishedRows.map((row) => {
        const assessment = parseJson(row.assessment_json, {}) || {};
        return {
          id: row.id,
          code: row.code,
          title: assessment.title || `Assessment ${row.id}`,
          created_at: row.created_at,
          owner_name: Number(row.user_id) === Number(req.user.id) ? null : (row.owner_name || row.owner_email),
          settings: integrity.parseStoredSettings(row.integrity_settings),
          attempts: counts.get(Number(row.id)) || { total: 0, in_progress: 0, submitted: 0, exited: 0, review_suggested: 0, review_needed: 0 }
        };
      });
      res.json({ success: true, items, presets: integrity.PRESETS });
    } catch (error) {
      console.error('Monitored assessments list error:', error);
      res.status(500).json({ error: 'Failed to list monitored assessments' });
    }
  });

  router.get('/assessment/:publishedId', requireAuth, requireStaff, withViewablePublished(async (req, res, pub) => {
    const assessment = parseJson(pub.assessment_json, {}) || {};
    const attempts = addSharedIpNotes(rowsOf(await loadAttemptRows(pub.id)).map(attemptReportRow));
    res.json({
      success: true,
      assessment: { id: pub.id, code: pub.code, title: assessment.title || `Assessment ${pub.id}` },
      settings: integrity.parseStoredSettings(pub.integrity_settings),
      attempts
    });
  }));

  router.get('/assessment/:publishedId/export.csv', requireAuth, requireStaff, withViewablePublished(async (req, res, pub) => {
    const attempts = addSharedIpNotes(rowsOf(await loadAttemptRows(pub.id)).map(attemptReportRow));
    const header = ['Student', 'Email', 'Status', 'Integrity', 'Score', 'Reasons', 'Started', 'Ended', 'IP addresses', 'Shared IP with', 'Submission'];
    const lines = [header.map(csvCell).join(',')];
    for (const attempt of attempts) {
      lines.push([
        attempt.student_name,
        attempt.student_email,
        attempt.status,
        attempt.integrity_status,
        attempt.integrity_score,
        (attempt.summary?.reasons || []).map((reason) => reason.text).join('; '),
        attempt.started_at,
        attempt.ended_at,
        attempt.ip_addresses.map((entry) => entry.ip).join(' '),
        attempt.shared_ip_with.join('; '),
        attempt.submission_code
      ].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="integrity-${pub.code}.csv"`);
    res.send(lines.join('\n'));
  }));

  router.put('/assessment/:publishedId/settings', requireAuth, requireStaff, withViewablePublished(async (req, res, pub) => {
    // Webcam options only where the organisation has accepted the POPIA terms.
    const settings = webcam.clampSettings(
      integrity.normalizeSettings(req.body?.settings),
      await webcam.getOrganisationPolicy(pub.owner_organisation_id)
    );
    const policy = await coursePolicy.getCoursePolicy(pub.course_id);
    if (!settings && policy?.required) {
      const course = firstRow(await query('SELECT name FROM courses WHERE id = $1', [pub.course_id]));
      return res.status(409).json({
        error: `Monitoring is required for assessments in ${course?.name ? `"${course.name}"` : 'this course'}. Management sets this under Exam Integrity → Course rules.`
      });
    }
    const wasMonitored = Boolean(integrity.parseStoredSettings(pub.integrity_settings));
    await query('UPDATE published_assessments SET integrity_settings = $1 WHERE id = $2', [settings ? JSON.stringify(settings) : null, pub.id]);

    // What the change means for students right now.
    const statusRows = rowsOf(await query(
      'SELECT status, COUNT(*) AS n FROM assessment_attempts WHERE published_assessment_id = $1 GROUP BY status',
      [pub.id]
    ));
    const attemptsWith = (status) => Number(statusRows.find((row) => row.status === status)?.n || 0);
    const submissions = Number(firstRow(await query(
      'SELECT COUNT(*) AS n FROM assessment_submissions WHERE published_assessment_id = $1',
      [pub.id]
    ))?.n || 0);
    res.json({
      success: true,
      settings,
      impact: {
        was_monitored: wasMonitored,
        now_monitored: Boolean(settings),
        in_progress_attempts: attemptsWith('in_progress'),
        submissions
      }
    });
  }));

  // ------------------------------------------------------------ course rules

  const requireManagement = (req, res, next) => {
    if (normalizeRole(req.user?.role) !== 'management') {
      return res.status(403).json({ error: 'Only management can set course rules' });
    }
    return next();
  };

  const loadOrgCourse = async (user, courseId) => firstRow(await query(
    `SELECT c.id, c.name, c.organisation_id, c.integrity_policy, u.organisation_id AS owner_organisation_id
     FROM courses c LEFT JOIN users u ON u.id = c.owner_user_id WHERE c.id = $1`,
    [courseId]
  ));
  const inUserOrganisation = (user, course) => Boolean(course) && user.organisation_id != null && (
    Number(course.organisation_id) === Number(user.organisation_id)
    || Number(course.owner_organisation_id) === Number(user.organisation_id)
  );

  router.get('/course-rules', requireAuth, requireManagement, async (req, res) => {
    try {
      if (req.user.organisation_id == null) return res.json({ success: true, courses: [] });
      const courses = rowsOf(await query(
        `SELECT c.id, c.name, c.code, c.integrity_policy,
                (SELECT COUNT(*) FROM published_assessments pa WHERE pa.course_id = c.id) AS assessment_count,
                (SELECT COUNT(*) FROM published_assessments pa WHERE pa.course_id = c.id AND pa.integrity_settings IS NULL) AS unmonitored_count
         FROM courses c LEFT JOIN users u ON u.id = c.owner_user_id
         WHERE c.organisation_id = $1 OR u.organisation_id = $2
         ORDER BY c.name`,
        [req.user.organisation_id, req.user.organisation_id]
      ));
      res.json({
        success: true,
        courses: courses.map((course) => ({
          id: course.id,
          name: course.name,
          code: course.code,
          policy: coursePolicy.parsePolicy(course.integrity_policy),
          assessment_count: Number(course.assessment_count || 0),
          unmonitored_count: Number(course.unmonitored_count || 0)
        }))
      });
    } catch (error) {
      console.error('Course rules list error:', error);
      res.status(500).json({ error: 'Failed to load course rules' });
    }
  });

  router.put('/course-rules/:courseId', requireAuth, requireManagement, async (req, res) => {
    try {
      const course = await loadOrgCourse(req.user, Number(req.params.courseId));
      if (!inUserOrganisation(req.user, course)) return res.status(404).json({ error: 'Course not found' });
      const policy = coursePolicy.normalizePolicyInput(req.body);
      await query('UPDATE courses SET integrity_policy = $1 WHERE id = $2', [policy ? JSON.stringify(policy) : null, course.id]);
      const applied = policy && (policy.required || req.body?.apply_to_existing === true)
        ? await coursePolicy.applyToUnmonitored(course.id, policy)
        : 0;
      res.json({ success: true, policy, applied_to_existing: applied });
    } catch (error) {
      console.error('Course rule save error:', error);
      res.status(500).json({ error: 'Failed to save course rule' });
    }
  });

  // Read-only: the rule for a course a lecturer can publish to (shown on the publish form).
  router.get('/course-rules/:courseId', requireAuth, requireStaff, async (req, res) => {
    try {
      const courseId = Number(req.params.courseId);
      if (!(await userCanUseCourse(req.user, courseId))) return res.status(404).json({ error: 'Course not found' });
      res.json({ success: true, policy: await coursePolicy.getCoursePolicy(courseId) });
    } catch (error) {
      console.error('Course rule read error:', error);
      res.status(500).json({ error: 'Failed to load course rule' });
    }
  });

  const withViewableAttempt = (handler) => async (req, res) => {
    try {
      const row = firstRow(await query(
        `SELECT aa.*, u.name AS student_name, u.email AS student_email, s.submission_code,
                (SELECT COUNT(*) FROM assessment_attempt_media m WHERE m.attempt_id = aa.id) AS media_count
         FROM assessment_attempts aa
         LEFT JOIN users u ON u.id = aa.student_user_id
         LEFT JOIN assessment_submissions s ON s.id = aa.submission_id
         WHERE aa.id = $1`,
        [Number(req.params.attemptId)]
      ));
      const pub = row ? await loadPublishedById(row.published_assessment_id) : null;
      if (!row || !canViewReports(req.user, pub)) return res.status(404).json({ error: 'Attempt not found' });
      return await handler(req, res, { row, pub });
    } catch (error) {
      console.error('Integrity attempt error:', error);
      return res.status(500).json({ error: 'Failed to load attempt' });
    }
  };

  router.get('/attempt/:attemptId', requireAuth, requireStaff, withViewableAttempt(async (req, res, { row }) => {
    res.json({ success: true, attempt: attemptReportRow(row), events: await loadEvents(row.id) });
  }));

  router.post('/attempt/:attemptId/reopen', requireAuth, requireStaff, withViewableAttempt(async (req, res, { row }) => {
    if (row.status !== 'exited') {
      return res.status(409).json({ error: 'Only attempts that were exited without submitting can be reopened.' });
    }
    await query(`UPDATE assessment_attempts SET status = 'in_progress', exit_reason = NULL, ended_at = NULL WHERE id = $1`, [row.id]);
    await recordEvent(row.id, { type: 'reopened', client_time: Date.now(), details: { by_user_id: req.user.id } }, null);
    res.json({ success: true, status: 'in_progress' });
  }));

  // ------------------------------------------------------------ webcam media

  const audit = (req, action, metadata) => recordAuditEvent({
    user_id: req.user.id,
    organisation_id: req.user.organisation_id,
    category: 'exam_integrity',
    action,
    metadata: getRequestMetadata(req, metadata)
  });

  // Listing an attempt's webcam images counts as viewing them, and is audit-logged.
  router.get('/attempt/:attemptId/media', requireAuth, requireStaff, withViewableAttempt(async (req, res, { row }) => {
    const media = rowsOf(await query(
      'SELECT id, kind, reason, mime_type, bytes, client_time, created_at, expires_at FROM assessment_attempt_media WHERE attempt_id = $1 ORDER BY id',
      [row.id]
    ));
    await audit(req, 'webcam_media_viewed', { attempt_id: row.id, student_user_id: row.student_user_id, items: media.length });
    res.json({ success: true, media });
  }));

  router.get('/media/:mediaId', requireAuth, requireStaff, async (req, res) => {
    try {
      const media = firstRow(await query(
        'SELECT m.id, m.file_path, m.mime_type, a.published_assessment_id FROM assessment_attempt_media m JOIN assessment_attempts a ON a.id = m.attempt_id WHERE m.id = $1',
        [Number(req.params.mediaId)]
      ));
      const pub = media ? await loadPublishedById(media.published_assessment_id) : null;
      if (!media || !canViewReports(req.user, pub)) return res.status(404).json({ error: 'Not found' });
      res.setHeader('Content-Type', media.mime_type);
      res.setHeader('Cache-Control', 'private, no-store');
      res.sendFile(media.file_path, (error) => {
        if (error && !res.headersSent) res.status(404).json({ error: 'File no longer available' });
      });
    } catch (error) {
      console.error('Webcam media error:', error);
      res.status(500).json({ error: 'Failed to load webcam media' });
    }
  });

  router.delete('/attempt/:attemptId/media', requireAuth, requireStaff, withViewableAttempt(async (req, res, { row }) => {
    const deleted = await webcam.deleteAttemptMedia(row.id);
    await audit(req, 'webcam_media_deleted', { attempt_id: row.id, student_user_id: row.student_user_id, items: deleted });
    res.json({ success: true, deleted });
  }));

  // Organisation webcam policy: readable by staff, changed by management after the POPIA acknowledgements.
  router.get('/webcam-policy', requireAuth, requireStaff, async (req, res) => {
    try {
      res.json({ success: true, policy: await webcam.getOrganisationPolicy(req.user.organisation_id), acknowledgements: webcam.ACKNOWLEDGEMENTS });
    } catch (error) {
      console.error('Webcam policy read error:', error);
      res.status(500).json({ error: 'Failed to load webcam policy' });
    }
  });

  router.put('/webcam-policy', requireAuth, requireManagement, async (req, res) => {
    try {
      if (req.user.organisation_id == null) {
        return res.status(400).json({ error: 'Your account is not linked to an organisation.' });
      }
      const result = webcam.buildPolicy(req.body, req.user);
      if (result.error) return res.status(400).json({ error: result.error, missing: result.missing });
      await query('UPDATE organisations SET webcam_policy = $1 WHERE id = $2', [JSON.stringify(result.policy), req.user.organisation_id]);
      await audit(req, result.policy.allowed ? 'webcam_policy_accepted' : 'webcam_policy_disabled', {
        allow_video: result.policy.allow_video,
        retention_days: result.policy.retention_days
      });
      res.json({ success: true, policy: result.policy });
    } catch (error) {
      console.error('Webcam policy save error:', error);
      res.status(500).json({ error: 'Failed to save webcam policy' });
    }
  });

  return router;
};

module.exports = {
  createAttemptsRouter,
  findInProgressAttempt,
  canViewReports
};
