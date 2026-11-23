'use strict';

/**
 * Tests for course exam-integrity rules.
 *
 * Run:  node --test server/services/courseIntegrityPolicyService.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('./courseIntegrityPolicyService');

const exam = svc.normalizePolicyInput({ settings: { enabled: true, preset: 'exam' }, required: true });
const testDefault = svc.normalizePolicyInput({ settings: { enabled: true, preset: 'test' } });
const quiz = { enabled: true, preset: 'quiz' };

test('publish settings: course default, explicit choices, and required rules', () => {
  assert.equal(svc.resolvePublishSettings(null, undefined), null, 'no rule, no choice: not monitored');
  assert.equal(svc.resolvePublishSettings(testDefault, undefined).preset, 'test', 'course default applies');
  assert.equal(svc.resolvePublishSettings(testDefault, null), null, 'lecturer may opt out of a default');
  assert.equal(svc.resolvePublishSettings(testDefault, quiz), quiz, 'explicit preset wins');
  assert.equal(svc.resolvePublishSettings(exam, null).preset, 'exam', 'required rule never allows unmonitored');
  assert.equal(svc.resolvePublishSettings(exam, quiz), quiz, 'required rule still allows another preset');
});

test('policy input: off removes the rule; stored JSON is parsed', () => {
  assert.equal(svc.normalizePolicyInput({ settings: { enabled: false } }), null);
  assert.equal(svc.normalizePolicyInput(null), null);
  assert.equal(exam.required, true);
  assert.equal(testDefault.required, false);
  assert.deepEqual(svc.parsePolicy(JSON.stringify(exam)), exam);
  assert.equal(svc.parsePolicy('not json'), null);
});
