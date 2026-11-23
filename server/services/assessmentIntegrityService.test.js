'use strict';

/**
 * Tests for exam integrity settings, event checks and attempt scoring.
 *
 * Run:  node --test server/services/assessmentIntegrityService.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('./assessmentIntegrityService');

const at = (seconds) => 1_700_000_000_000 + seconds * 1000;

test('settings: off when disabled, preset defaults, custom overrides, bad values dropped', () => {
  assert.equal(svc.normalizeSettings(null), null);
  assert.equal(svc.normalizeSettings({ enabled: false }), null);

  const exam = svc.normalizeSettings({ enabled: true, preset: 'exam' });
  assert.equal(exam.copy_paste, 'block');
  assert.equal(exam.require_fullscreen, true);

  const custom = svc.normalizeSettings({
    enabled: true,
    preset: 'custom',
    copy_paste: 'block',
    right_click: 'nonsense',
    shuffle_questions: false,
    allowed_ip_ranges: ['10.0.0.0/8', 'not an ip', '10.0.0.0/8'],
    extra: 'ignored'
  });
  assert.equal(custom.copy_paste, 'block');
  assert.equal(custom.right_click, 'log', 'falls back to the default preset');
  assert.equal(custom.shuffle_questions, false);
  assert.deepEqual(custom.allowed_ip_ranges, ['10.0.0.0/8']);
  assert.equal(custom.extra, undefined);

  assert.equal(svc.normalizeSettings({ enabled: true }).preset, 'test');
});

test('IP ranges: CIDR, single address, IPv4-mapped IPv6, no ranges means allowed', () => {
  assert.equal(svc.ipInRanges('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(svc.ipInRanges('::ffff:10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(svc.ipInRanges('11.0.0.1', ['10.0.0.0/8']), false);
  assert.equal(svc.ipInRanges('196.21.5.9', ['196.21.5.9']), true);
  assert.equal(svc.ipInRanges('2001:db8::1', ['2001:db8::1']), true);
  assert.equal(svc.ipInRanges('1.2.3.4', []), true);
});

test('client events: unknown types dropped, only expected fields kept', () => {
  const events = svc.sanitizeClientEvents([
    { type: 'paste', chars: 40, question_number: 2, text: 'secret answer', client_time: at(1) },
    { type: 'drop_table', chars: 1 },
    { type: 'extension_injected', signature: 'sider-root'.padEnd(200, 'x') }
  ]);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].details, { chars: 40 });
  assert.equal(events[0].text, undefined, 'typed or pasted text is never stored');
  assert.equal(events[1].details.signature.length, 80);
});

test('severity is decided by the server', () => {
  assert.equal(svc.classifyEvent({ type: 'focus_lost', duration_ms: 800 }), 'info');
  assert.equal(svc.classifyEvent({ type: 'focus_lost', duration_ms: 9000 }), 'notice');
  assert.equal(svc.classifyEvent({ type: 'paste', details: { chars: 8 } }), 'info');
  assert.equal(svc.classifyEvent({ type: 'paste', details: { chars: 300 } }), 'notice');
  assert.equal(svc.classifyEvent({ type: 'text_burst', details: { chars: 90 } }), 'flag');
});

test('ordinary behaviour stays clean: brief blurs, one short absence, small pastes, one fullscreen slip', () => {
  const summary = svc.summarizeAttempt([
    { type: 'focus_lost', duration_ms: 900, client_time: at(10) },
    { type: 'focus_lost', duration_ms: 1500, client_time: at(50) },
    { type: 'focus_lost', duration_ms: 20000, client_time: at(200) },
    { type: 'fullscreen_exit', duration_ms: 3000, client_time: at(300) },
    { type: 'paste', details: { chars: 12 }, question_number: 3, client_time: at(400) },
    { type: 'copy', details: { chars: 6 }, client_time: at(410) },
    { type: 'context_menu', client_time: at(420) }
  ]);
  assert.equal(summary.status, 'clean');
  assert.equal(summary.score, 0);
});

test('leaving and pasting straight back in is flagged as a pattern', () => {
  const summary = svc.summarizeAttempt([
    { type: 'focus_lost', duration_ms: 45000, client_time: at(100) },
    { type: 'paste', details: { chars: 420 }, question_number: 4, client_time: at(104) }
  ]);
  const codes = summary.reasons.map((r) => r.code);
  assert.ok(codes.includes('return_then_insert'));
  assert.ok(codes.includes('paste'));
  assert.equal(summary.status, 'review_suggested');
  assert.match(summary.reasons.find((r) => r.code === 'return_then_insert').text, /Q4/);
});

test('copying question text, leaving, then text bursts reaches review needed', () => {
  const summary = svc.summarizeAttempt([
    { type: 'copy', details: { chars: 160 }, question_number: 2, client_time: at(10) },
    // left 3 s after copying, came back 40 s later
    { type: 'focus_lost', duration_ms: 40000, client_time: at(53) },
    { type: 'text_burst', details: { chars: 300 }, question_number: 2, client_time: at(60) },
    { type: 'focus_lost', duration_ms: 30000, client_time: at(200) },
    { type: 'text_burst', details: { chars: 250 }, question_number: 3, client_time: at(205) }
  ]);
  const codes = summary.reasons.map((r) => r.code);
  assert.ok(codes.includes('copy_then_leave'));
  assert.ok(codes.includes('text_burst'));
  assert.equal(summary.status, 'review_needed');
  assert.equal(summary.reasons[0].code, 'return_then_insert', 'reasons are ordered by weight');
});

test('long time away and second sessions are reported in plain language', () => {
  const summary = svc.summarizeAttempt([
    { type: 'focus_lost', duration_ms: 200000, client_time: at(100) },
    { type: 'connection_gap', duration_ms: 150000, client_time: at(500) },
    { type: 'duplicate_session', client_time: at(600) }
  ]);
  const away = summary.reasons.find((r) => r.code === 'time_away');
  assert.equal(away.text, 'Left the exam 1 time and 1 connection gap (5 min 50 s away in total)');
  assert.ok(summary.reasons.some((r) => r.code === 'second_session'));
  assert.equal(summary.status, 'review_needed');
});

test('blocked pastes count a little; stored JSON details are parsed', () => {
  const summary = svc.summarizeAttempt([
    { type: 'paste', details: JSON.stringify({ chars: 500, blocked: true }), client_time: at(1) },
    { type: 'paste', details: JSON.stringify({ chars: 500, blocked: true }), client_time: at(2) }
  ]);
  assert.deepEqual(summary.reasons.map((r) => r.code), ['blocked_paste']);
  assert.equal(summary.score, 2);
  assert.equal(summary.counts.pastes, 0);
});

test('shuffledOrder is a permutation', () => {
  const order = svc.shuffledOrder(10);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
