'use strict';

/**
 * Tests for the organisation webcam policy (POPIA) and settings clamping.
 *
 * Run:  node --test server/services/webcamPolicyService.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('./webcamPolicyService');

const allAcks = Object.fromEntries(svc.ACKNOWLEDGEMENTS.map((key) => [key, true]));
const manager = { id: 4, name: 'Prof Dube' };

test('allowing webcam monitoring needs every POPIA acknowledgement', () => {
  const missing = svc.buildPolicy({ allowed: true, acknowledgements: { ...allAcks, minors: false } }, manager);
  assert.match(missing.error, /POPIA/);
  assert.deepEqual(missing.missing, ['minors']);

  const ok = svc.buildPolicy({ allowed: true, allow_video: true, retention_days: 200, acknowledgements: allAcks }, manager, new Date('2026-11-24T10:00:00Z'));
  assert.equal(ok.policy.allowed, true);
  assert.equal(ok.policy.allow_video, true);
  assert.equal(ok.policy.retention_days, 90, 'retention is capped at 90 days');
  assert.deepEqual(ok.policy.accepted_by, { id: 4, name: 'Prof Dube' });
  assert.equal(ok.policy.accepted_at, '2026-11-24T10:00:00.000Z');

  const off = svc.buildPolicy({ allowed: false, allow_video: true }, manager);
  assert.equal(off.policy.allowed, false);
  assert.equal(off.policy.allow_video, false);
});

test('assessment webcam settings are limited by the organisation policy', () => {
  const settings = { enabled: true, preset: 'exam', webcam: 'video', webcam_required: true };
  assert.deepEqual(
    [svc.clampSettings(settings, svc.parsePolicy(null)).webcam, svc.clampSettings(settings, svc.parsePolicy(null)).webcam_required],
    ['off', false],
    'no policy: webcam off'
  );
  const snapshotsOnly = svc.parsePolicy({ allowed: true, allow_video: false });
  assert.equal(svc.clampSettings(settings, snapshotsOnly).webcam, 'snapshots', 'video falls back to snapshots');
  assert.equal(svc.clampSettings(settings, snapshotsOnly).webcam_required, true);
  assert.equal(svc.clampSettings(settings, svc.parsePolicy({ allowed: true, allow_video: true })).webcam, 'video');
  assert.equal(svc.parsePolicy('{bad').allowed, false);
  assert.equal(svc.parsePolicy(null).retention_days, 30);
});
