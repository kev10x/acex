'use strict';

/**
 * Course exam-integrity rules, set by management.
 *
 * A course can carry default monitoring settings for assessments published to it, and can
 * make monitoring required. Required means an assessment in the course can never be left
 * unmonitored: it gets the course settings when published or moved there, and monitoring
 * cannot be switched off. Lecturers may still choose stricter or different presets.
 */

const { query } = require('../database/connection');
const integrity = require('./assessmentIntegrityService');

const rowsOf = (result) => {
  const value = result?.rows || result;
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};

const parsePolicy = (value) => {
  if (!value) return null;
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  const settings = integrity.normalizeSettings(raw?.settings);
  return settings ? { settings, required: raw.required === true } : null;
};

/** Validate a policy from management; null removes the rule. */
const normalizePolicyInput = (input) => {
  const settings = integrity.normalizeSettings(input?.settings);
  return settings ? { settings, required: input.required === true } : null;
};

const getCoursePolicy = async (courseId) => {
  if (!courseId) return null;
  const row = rowsOf(await query('SELECT integrity_policy FROM courses WHERE id = $1', [Number(courseId)]))[0];
  return parsePolicy(row?.integrity_policy);
};

/**
 * Settings to store for a newly published assessment. An explicit choice from the
 * lecturer wins, except that a required course rule never allows "not monitored".
 * `requested` is undefined when the lecturer left the choice on "course default".
 */
const resolvePublishSettings = (policy, requested) => {
  if (requested === undefined) return policy ? policy.settings : null;
  if (!requested && policy?.required) return policy.settings;
  return requested;
};

/** After moving an assessment into a course: a required rule turns monitoring on. */
const enforceOnCourse = async (publishedId, courseId) => {
  const policy = await getCoursePolicy(courseId);
  if (!policy?.required) return null;
  const row = rowsOf(await query('SELECT integrity_settings FROM published_assessments WHERE id = $1', [publishedId]))[0];
  if (integrity.parseStoredSettings(row?.integrity_settings)) return null;
  await query('UPDATE published_assessments SET integrity_settings = $1 WHERE id = $2', [JSON.stringify(policy.settings), publishedId]);
  return policy.settings;
};

/** Apply a course rule to its assessments that are not monitored yet. Returns how many changed. */
const applyToUnmonitored = async (courseId, policy) => {
  const rows = rowsOf(await query('SELECT id, integrity_settings FROM published_assessments WHERE course_id = $1', [Number(courseId)]));
  const targets = rows.filter((row) => !integrity.parseStoredSettings(row.integrity_settings));
  for (const row of targets) {
    await query('UPDATE published_assessments SET integrity_settings = $1 WHERE id = $2', [JSON.stringify(policy.settings), row.id]);
  }
  return targets.length;
};

module.exports = {
  parsePolicy,
  normalizePolicyInput,
  getCoursePolicy,
  resolvePublishSettings,
  enforceOnCourse,
  applyToUnmonitored
};
