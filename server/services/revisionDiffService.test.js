'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffRevisions, toUnits, splitSentences } = require('./revisionDiffService');

const PREV = [
  'Chapter 1 Introduction',
  'This study examines teacher retention in rural schools. The problem is that many teachers leave within two years (Smith et al. 2019). Prior work has focused on urban settings, e.g. Johannesburg.',
  'Chapter 2 Literature Review',
  'Several authors discuss retention (Smith, 2019).'
].join('\n');

const wrap = (text, wordsPerLine) => {
  const words = text.split(/\s+/);
  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) lines.push(words.slice(i, i + wordsPerLine).join(' '));
  return lines.join('\n');
};

test('splits sentences without breaking at abbreviations', () => {
  assert.deepEqual(splitSentences('See Smith et al. (2019) for this. Then e.g. Durban applies. Dr. Ndlovu agreed.'), [
    'See Smith et al. (2019) for this.',
    'Then e.g. Durban applies.',
    'Dr. Ndlovu agreed.'
  ]);
});

test('a one-word edit changes one sentence, not the whole paragraph', () => {
  const curr = PREV.replace('rural schools', 'rural Eastern Cape schools');
  const result = diffRevisions(PREV, curr);
  assert.equal(result.mode, 'diff');
  assert.deepEqual(result.stats, { added: 1, removed: 1, unchanged: 5, change_density: 29 });
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(result.blocks[0].removed, ['This study examines teacher retention in rural schools.']);
  assert.deepEqual(result.blocks[0].added, ['This study examines teacher retention in rural Eastern Cape schools.']);
  assert.deepEqual(result.blocks[0].before_context, ['Chapter 1 Introduction']);
  assert.match(result.prompt_text, /^--- Change 1 ---\n {2}Chapter 1 Introduction\n- This study.*\n\+ This study/);
});

test('PDF text that wraps differently is still compared sentence by sentence', () => {
  const body = PREV.split('\n').filter((line) => !line.startsWith('Chapter')).join(' ');
  const prev = `${wrap(body, 9)}\n12`;
  const curr = `${wrap(`An added opening sentence. ${body}`, 7)}\n13`;
  const result = diffRevisions(prev, curr);
  assert.equal(result.mode, 'diff');
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.removed, 0);
  assert.deepEqual(result.blocks[0].added, ['An added opening sentence.']);
  assert.ok(!toUnits(prev).includes('12'), 'page numbers are ignored');
});

test('identical and rewritten revisions are reported as such', () => {
  assert.equal(diffRevisions(PREV, PREV).mode, 'identical');
  assert.equal(diffRevisions(PREV, PREV).prompt_text, null);
  const rewrite = diffRevisions(PREV, 'Completely different. Nothing is the same. Every sentence is new.');
  assert.equal(rewrite.mode, 'rewrite');
});

test('nearby edits are grouped and the number of blocks is capped', () => {
  const sentences = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`);
  const prev = sentences.join(' ');
  const curr = sentences.map((s, i) => (i % 5 === 0 ? s.replace('is here', 'was changed') : s)).join(' ');
  const result = diffRevisions(prev, curr);
  assert.equal(result.blocks.length, 60);
  assert.equal(result.truncated, true);
  assert.match(result.prompt_text, /further changes/);
});
