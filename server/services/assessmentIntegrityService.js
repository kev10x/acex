'use strict';

/**
 * Exam integrity for monitored assessments: settings, event checks and attempt scoring.
 *
 * The browser reports what happened during an attempt (leaving the exam, pastes, text
 * appearing faster than typing, ...). The server never trusts client-side severities:
 * it re-classifies every event here, then scores the attempt on patterns rather than
 * single events, so one notification or a short paste does not get a student flagged.
 */

const PRESETS = {
  quiz: {
    require_fullscreen: false,
    hide_questions_on_leave: false,
    copy_paste: 'log',
    right_click: 'log',
    shuffle_questions: false
  },
  test: {
    require_fullscreen: true,
    hide_questions_on_leave: true,
    copy_paste: 'log',
    right_click: 'log',
    shuffle_questions: true
  },
  exam: {
    require_fullscreen: true,
    hide_questions_on_leave: true,
    copy_paste: 'block',
    right_click: 'block',
    shuffle_questions: true
  }
};

const DEFAULT_PRESET = 'test';

// Thresholds that keep ordinary behaviour out of the report.
const THRESHOLDS = {
  briefLeaveMs: 2000, // notifications, OS pop-ups
  longLeaveMs: 5000, // long enough to look something up
  smallPasteChars: 30, // a word, a formula, a name
  largePasteChars: 200,
  copyChars: 20, // copying a whole question, not a word
  burstChars: 50, // characters arriving in one input event without a paste
  returnWindowMs: 15000, // paste/burst this soon after coming back counts as a pattern
  copyThenLeaveMs: 10000,
  connectionGapMs: 90000 // no heartbeat for this long counts as time away (background tabs tick once a minute)
};

const STATUS_THRESHOLDS = { reviewSuggested: 3, reviewNeeded: 8 };

const CLIENT_EVENT_TYPES = new Set([
  'focus_lost',
  'fullscreen_exit',
  'fullscreen_unsupported',
  'paste',
  'copy',
  'cut',
  'context_menu',
  'text_burst',
  'print_attempt',
  'extension_injected',
  'second_tab'
]);

const SERVER_EVENT_TYPES = new Set([
  'attempt_started',
  'attempt_resumed',
  'ip_changed',
  'ip_outside_range',
  'duplicate_session',
  'connection_gap',
  'submitted',
  'exited',
  'reopened'
]);

const MAX_EVENTS_PER_BATCH = 200;

const toInt = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
};

const cleanText = (value, max = 120) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

/**
 * Normalise lecturer settings. Returns null when monitoring is off.
 * Unknown keys are dropped; missing keys come from the preset.
 */
const normalizeSettings = (input) => {
  if (!input || input.enabled === false) return null;
  const preset = PRESETS[input.preset] ? input.preset : (input.preset === 'custom' ? 'custom' : DEFAULT_PRESET);
  const base = PRESETS[preset] || PRESETS[DEFAULT_PRESET];
  const pick = (key, allowed) => (allowed.includes(input[key]) ? input[key] : base[key]);
  const bool = (key) => (typeof input[key] === 'boolean' ? input[key] : base[key]);
  const ranges = Array.isArray(input.allowed_ip_ranges)
    ? input.allowed_ip_ranges.map((range) => cleanText(range, 64)).filter((range) => range && parseIpRange(range))
    : [];

  return {
    enabled: true,
    preset,
    require_fullscreen: bool('require_fullscreen'),
    hide_questions_on_leave: bool('hide_questions_on_leave'),
    copy_paste: pick('copy_paste', ['log', 'block']),
    right_click: pick('right_click', ['log', 'block']),
    shuffle_questions: bool('shuffle_questions'),
    allowed_ip_ranges: [...new Set(ranges)].slice(0, 20)
  };
};

const parseStoredSettings = (value) => {
  if (!value) return null;
  try {
    return normalizeSettings(typeof value === 'string' ? JSON.parse(value) : value);
  } catch (e) {
    return null;
  }
};

// ---------------------------------------------------------------------------
// IP helpers (IPv4 CIDR ranges; IPv6 addresses match exactly)
// ---------------------------------------------------------------------------

const normalizeIp = (ip) => {
  const value = String(ip || '').trim();
  return value.startsWith('::ffff:') && value.includes('.') ? value.slice(7) : value;
};

const ipv4ToInt = (ip) => {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = result * 256 + n;
  }
  return result;
};

function parseIpRange(range) {
  const [address, bitsText] = String(range).trim().split('/');
  const base = ipv4ToInt(address);
  if (base === null) {
    return address.includes(':') && bitsText === undefined ? { exact: address.toLowerCase() } : null;
  }
  const bits = bitsText === undefined ? 32 : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

const ipInRanges = (ip, ranges) => {
  if (!Array.isArray(ranges) || ranges.length === 0) return true;
  const address = normalizeIp(ip);
  const value = ipv4ToInt(address);
  return ranges.some((range) => {
    const parsed = parseIpRange(range);
    if (!parsed) return false;
    if (parsed.exact) return parsed.exact === address.toLowerCase();
    return value !== null && value >= parsed.start && value <= parsed.end;
  });
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Validate a batch of client events: unknown types are dropped and only expected
 * fields are kept, so nothing the student types is ever stored.
 */
const sanitizeClientEvents = (events) => {
  if (!Array.isArray(events)) return [];
  return events.slice(0, MAX_EVENTS_PER_BATCH).flatMap((event) => {
    const type = String(event?.type || '');
    if (!CLIENT_EVENT_TYPES.has(type)) return [];
    const details = {};
    const chars = toInt(event.chars);
    if (chars !== null) details.chars = Math.min(chars, 1000000);
    if (event.blocked === true) details.blocked = true;
    if (event.source === 'drop') details.source = 'drop';
    if (type === 'extension_injected') details.signature = cleanText(event.signature, 80);
    return [{
      type,
      question_number: toInt(event.question_number),
      duration_ms: toInt(event.duration_ms),
      client_time: toInt(event.client_time),
      details
    }];
  });
};

/** Severity is decided here, never by the browser. */
const classifyEvent = (event) => {
  const chars = event.details?.chars || 0;
  switch (event.type) {
    case 'focus_lost':
    case 'fullscreen_exit':
      return (event.duration_ms || 0) < THRESHOLDS.briefLeaveMs ? 'info' : 'notice';
    case 'paste':
      return chars < THRESHOLDS.smallPasteChars ? 'info' : 'notice';
    case 'copy':
    case 'cut':
      return chars < THRESHOLDS.copyChars ? 'info' : 'notice';
    case 'text_burst':
    case 'duplicate_session':
    case 'second_tab':
    case 'ip_outside_range':
      return 'flag';
    case 'ip_changed':
    case 'extension_injected':
    case 'print_attempt':
    case 'connection_gap':
      return 'notice';
    default:
      return 'info';
  }
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const formatDuration = (ms) => {
  const totalSeconds = Math.round((ms || 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const questionList = (events) => {
  const numbers = [...new Set(events.map((e) => e.question_number).filter((n) => n != null))].sort((a, b) => a - b);
  return numbers.length ? ` (${numbers.map((n) => `Q${n}`).join(', ')})` : '';
};

/**
 * Score an attempt from its events. Returns a status, a numeric score and a short
 * plain-language list of reasons, ordered by weight.
 */
const summarizeAttempt = (events) => {
  const list = (events || []).map((event) => ({
    ...event,
    details: typeof event.details === 'string' ? safeJson(event.details) : (event.details || {})
  }));
  const byType = (type) => list.filter((event) => event.type === type);
  const chars = (event) => event.details?.chars || 0;
  const reasons = [];
  const add = (code, weight, text) => {
    if (weight > 0) reasons.push({ code, weight, text });
  };

  // Time away: focus losses plus connection gaps (closed tab, lost connection).
  const leaves = byType('focus_lost').filter((event) => (event.duration_ms || 0) >= THRESHOLDS.briefLeaveMs);
  const gaps = byType('connection_gap');
  const awayMs = [...leaves, ...gaps].reduce((sum, event) => sum + (event.duration_ms || 0), 0);
  if (leaves.length > 0 || gaps.length > 0) {
    const countWeight = Math.min(5, Math.max(0, leaves.length - 1));
    const timeWeight = awayMs >= 300000 ? 4 : awayMs >= 60000 ? 2 : 0;
    const parts = [];
    if (leaves.length) parts.push(`Left the exam ${plural(leaves.length, 'time')}`);
    if (gaps.length) parts.push(`${plural(gaps.length, 'connection gap')}`);
    add('time_away', countWeight + timeWeight, `${parts.join(' and ')} (${formatDuration(awayMs)} away in total)`);
  }

  const fullscreenExits = byType('fullscreen_exit').filter((event) => (event.duration_ms || 0) >= THRESHOLDS.briefLeaveMs);
  add('fullscreen', Math.min(3, Math.max(0, fullscreenExits.length - 1)), `Left full screen ${plural(fullscreenExits.length, 'time')}`);

  const pastes = byType('paste').filter((event) => !event.details?.blocked && chars(event) >= THRESHOLDS.smallPasteChars);
  if (pastes.length) {
    const weight = Math.min(8, pastes.reduce((sum, event) => sum + (chars(event) >= THRESHOLDS.largePasteChars ? 3 : 2), 0));
    const largest = Math.max(...pastes.map(chars));
    add('paste', weight, `${plural(pastes.length, 'paste')} of ${THRESHOLDS.smallPasteChars}+ characters${questionList(pastes)}, largest ${largest} characters`);
  }

  const blockedPastes = byType('paste').filter((event) => event.details?.blocked);
  add('blocked_paste', Math.min(3, blockedPastes.length), `Tried to paste ${plural(blockedPastes.length, 'time')} while pasting was blocked`);

  const bursts = byType('text_burst');
  add('text_burst', Math.min(9, bursts.length * 3), `Text appeared faster than typing ${plural(bursts.length, 'time')}${questionList(bursts)}`);

  // Patterns: coming back to the exam and immediately pasting or bursting text.
  const sorted = [...list].filter((event) => event.client_time != null).sort((a, b) => a.client_time - b.client_time);
  const longReturns = sorted.filter((event) => event.type === 'focus_lost' && (event.duration_ms || 0) >= THRESHOLDS.longLeaveMs);
  const inserts = sorted.filter((event) => event.type === 'text_burst' || (event.type === 'paste' && !event.details?.blocked && chars(event) >= THRESHOLDS.smallPasteChars));
  const returnThenInsert = inserts.filter((insert) => longReturns.some((leave) => {
    const delta = insert.client_time - leave.client_time;
    return delta >= 0 && delta <= THRESHOLDS.returnWindowMs;
  }));
  add('return_then_insert', Math.min(8, returnThenInsert.length * 4), `Pasted or inserted text right after returning to the exam${questionList(returnThenInsert)}`);

  // Copying question text and leaving straight away is the usual route to an AI tool.
  const copies = sorted.filter((event) => (event.type === 'copy' || event.type === 'cut') && !event.details?.blocked && chars(event) >= THRESHOLDS.copyChars);
  const copyThenLeave = copies.filter((copy) => sorted.some((event) => {
    if (event.type !== 'focus_lost' || (event.duration_ms || 0) < THRESHOLDS.longLeaveMs) return false;
    const leftAt = event.client_time - event.duration_ms;
    return leftAt >= copy.client_time && leftAt - copy.client_time <= THRESHOLDS.copyThenLeaveMs;
  }));
  if (copyThenLeave.length) {
    add('copy_then_leave', Math.min(6, copyThenLeave.length * 3), `Copied text and then left the exam ${plural(copyThenLeave.length, 'time')}${questionList(copyThenLeave)}`);
  } else if (copies.length) {
    add('copy', Math.min(4, copies.length * 2), `Copied ${plural(copies.length, 'block')} of text${questionList(copies)}`);
  }

  if (byType('duplicate_session').length || byType('second_tab').length) {
    add('second_session', 5, 'The exam was open in a second tab or on another device');
  }
  if (byType('ip_outside_range').length) {
    add('ip_outside_range', 5, 'Connected from outside the allowed network');
  }
  const ipChanges = byType('ip_changed');
  add('ip_changed', Math.min(2, ipChanges.length), `IP address changed ${plural(ipChanges.length, 'time')} during the attempt`);

  const extensions = byType('extension_injected');
  if (extensions.length) {
    const names = [...new Set(extensions.map((event) => event.details?.signature).filter(Boolean))].slice(0, 3);
    add('extension', 2, `A browser extension added content to the exam page${names.length ? ` (${names.join(', ')})` : ''}`);
  }
  add('print', byType('print_attempt').length ? 1 : 0, 'Tried to print the exam');

  reasons.sort((a, b) => b.weight - a.weight);
  const score = reasons.reduce((sum, reason) => sum + reason.weight, 0);
  const status = score >= STATUS_THRESHOLDS.reviewNeeded
    ? 'review_needed'
    : score >= STATUS_THRESHOLDS.reviewSuggested
    ? 'review_suggested'
    : 'clean';

  return {
    score,
    status,
    reasons,
    counts: {
      leaves: leaves.length,
      away_ms: awayMs,
      fullscreen_exits: fullscreenExits.length,
      pastes: pastes.length,
      text_bursts: bursts.length,
      copies: copies.length
    }
  };
};

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch (e) {
    return {};
  }
}

/** Shuffled question order for one attempt (Fisher-Yates). */
const shuffledOrder = (count, random = Math.random) => {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
};

module.exports = {
  PRESETS,
  THRESHOLDS,
  CLIENT_EVENT_TYPES,
  SERVER_EVENT_TYPES,
  normalizeSettings,
  parseStoredSettings,
  normalizeIp,
  ipInRanges,
  sanitizeClientEvents,
  classifyEvent,
  summarizeAttempt,
  formatDuration,
  shuffledOrder
};
