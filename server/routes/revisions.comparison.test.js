'use strict';

/**
 * Revision comparison: sentence-level changes, and each piece of earlier feedback checked.
 *
 * Run:  node --test server/routes/revisions.comparison.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadWithMocks } = require('../test-utils/loadWithMocks');

const load = (reply, prompts) => loadWithMocks(path.join(__dirname, 'revisions.js'), {
  '../services/aiService': {
    createCompletionWithRetry: async ({ messages }) => {
      prompts.push(messages[0].content);
      return { content: JSON.stringify(reply) };
    }
  }
});

const PREV = 'Chapter 1 Introduction\nMany teachers leave rural schools within two years. Prior work focused on cities.';
const CURR = 'Chapter 1 Introduction\nMany teachers leave rural schools within two years (Dlamini, 2022). Prior work focused on cities.';

test('earlier review comments are checked against the sentence changes', async (t) => {
  const prompts = [];
  const { module: revisions, restore } = load({
    improved_criteria: [{ criterion: 'Evidence', detail: 'Added a citation.' }],
    previous_feedback: [
      { id: 1, status: 'addressed', note: 'Change 1 adds (Dlamini, 2022).' },
      { id: 2, status: 'bogus', note: 'ignored' }
    ],
    narrative_summary: 'Better.'
  }, prompts);
  t.after(restore);

  const items = revisions.previousFeedbackItems([
    { id: 1, section: 'Chapter 1 Introduction', page: 3, quote: 'within two years', comment: 'Cite a source for this figure.' },
    { id: 2, section: null, quote: null, comment: 'Define retention.' }
  ], []);
  assert.deepEqual(items[0], { id: 1, location: 'Chapter 1 Introduction, p. 3', comment: 'Cite a source for this figure.', quote: 'within two years' });

  const comparison = await revisions.generateRevisionComparison(PREV, CURR, [], [], { criteria: [{ name: 'Evidence' }] }, items);

  assert.match(prompts[0], /1\. \[Chapter 1 Introduction, p\. 3\] Cite a source for this figure\. \(on: "within two years"\)/);
  assert.match(prompts[0], /- Many teachers leave rural schools within two years\.\n\+ Many teachers leave rural schools within two years \(Dlamini, 2022\)\./);
  assert.match(prompts[0], /"previous_feedback"/);

  assert.deepEqual(comparison.previous_feedback.map((item) => [item.id, item.status, item.note]), [
    [1, 'addressed', 'Change 1 adds (Dlamini, 2022).'],
    [2, null, null]
  ]);
  assert.equal(comparison.changes.mode, 'diff');
  assert.deepEqual(comparison.changes.stats, { added: 1, removed: 1, unchanged: 2, change_density: 50 });
  assert.deepEqual(comparison.regressed_criteria, []);
});

test('without detailed comments, the previous criterion feedback is checked', async (t) => {
  const prompts = [];
  const { module: revisions, restore } = load({ narrative_summary: 'Same.' }, prompts);
  t.after(restore);
  const items = revisions.previousFeedbackItems(null, [
    { criterion_name: 'Evidence', feedback: 'Cite sources.' },
    { criterion_name: 'Structure', feedback: '' }
  ]);
  assert.deepEqual(items, [{ id: 1, location: 'Evidence', comment: 'Cite sources.', quote: null }]);

  const comparison = await revisions.generateRevisionComparison(PREV, PREV, [], [], { criteria: [] }, items);
  assert.match(prompts[0], /identical/);
  assert.equal(comparison.changes.mode, 'identical');
  assert.equal(comparison.previous_feedback[0].status, null);
});
