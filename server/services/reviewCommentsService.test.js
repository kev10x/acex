'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateReviewComments,
  attachReviewComments,
  isResearchDocument,
  findHeadings,
  sectionAt,
  locateQuote,
  splitIntoParts
} = require('./reviewCommentsService');

const THESIS = [
  'Abstract',
  'This thesis studies teacher retention.',
  '',
  'CHAPTER 1 INTRODUCTION',
  '1.1 Background',
  'Many teachers leave rural schools within two years of',
  'appointment, which affects learner outcomes.',
  '',
  '1.2 Problem statement',
  'The problem is that retention is poorly understood.',
  '',
  'CHAPTER 2 LITERATURE REVIEW',
  'Several authors discuss retention (Smith, 2019).'
].join('\n');

test('recognises research documents only', () => {
  assert.equal(isResearchDocument('treatise'), true);
  assert.equal(isResearchDocument('Thesis'), true);
  assert.equal(isResearchDocument('dissertation'), true);
  assert.equal(isResearchDocument('assignment'), false);
  assert.equal(isResearchDocument(null), false);
});

test('finds headings and the section a position is in', () => {
  const headings = findHeadings(THESIS).map((h) => h.title);
  assert.deepEqual(headings, ['Abstract', 'CHAPTER 1 INTRODUCTION', '1.1 Background', '1.2 Problem statement', 'CHAPTER 2 LITERATURE REVIEW']);
  const at = (phrase) => sectionAt(findHeadings(THESIS), THESIS.indexOf(phrase));
  assert.equal(at('within two years'), 'CHAPTER 1 INTRODUCTION › 1.1 Background');
  assert.equal(at('Several authors'), 'CHAPTER 2 LITERATURE REVIEW');
  assert.equal(at('This thesis'), 'Abstract');
});

test('locates quotes across line breaks, case and quote styles', () => {
  assert.equal(locateQuote(THESIS, 'leave rural schools within two years of appointment, which'), THESIS.indexOf('leave rural'));
  assert.equal(locateQuote(THESIS, 'THE PROBLEM IS THAT RETENTION'), THESIS.indexOf('The problem is'));
  assert.equal(locateQuote("It is the teacher's choice", 'the teacher’s choice'), 6);
  assert.equal(locateQuote(THESIS, 'words that are not there at all'), -1);
});

test('splits long documents into a bounded number of parts on paragraph breaks', () => {
  const paragraph = `${'Sentence about retention. '.repeat(40)}\n\n`;
  const long = paragraph.repeat(1000); // about a million characters
  const parts = splitIntoParts(long);
  assert.ok(parts.length <= 16);
  assert.equal(parts.map((p) => p.text).join(''), long, 'nothing lost or duplicated');
  assert.ok(parts.slice(0, -1).every((p) => p.text.endsWith('\n') || long[p.offset + p.text.length] === '\n'));
});

test('builds located, ordered, de-duplicated comments and survives a failed part', async () => {
  const replies = [
    JSON.stringify({ comments: [
      { quote: 'Several authors discuss retention', comment: 'Synthesise the sources instead of listing them.', category: 'literature', severity: 'major', criterion: 'literature review' },
      { quote: 'within two years of appointment', comment: 'Cite a source for this figure.', category: 'evidence', severity: 'minor', criterion: '' },
      { quote: 'within two years of appointment', comment: 'Cite a source for this figure.', category: 'evidence', severity: 'minor' },
      { quote: 'made-up words that do not appear', comment: 'Unlocated comment.', category: 'nonsense', severity: 'major' },
      { quote: 'x', comment: '' }
    ] })
  ];
  const result = await generateReviewComments({
    text: THESIS,
    documentType: 'thesis',
    rubric: { criteria: [{ name: 'Literature review' }, { name: 'Methodology' }] },
    complete: async (prompt) => {
      assert.match(prompt, /part 1 of 1 of a thesis/);
      assert.match(prompt, /"Literature review", "Methodology"/);
      return { content: replies[0] };
    }
  });
  assert.equal(result.parts_failed, 0);
  assert.deepEqual(result.comments.map((c) => c.comment), [
    'Unlocated comment.',
    'Cite a source for this figure.',
    'Synthesise the sources instead of listing them.'
  ]);
  const [unlocated, cite, synth] = result.comments;
  assert.deepEqual(result.comments.map((c) => c.id), [1, 2, 3]);
  assert.equal(unlocated.quote, null, 'quotes not in the text are dropped');
  assert.equal(unlocated.category, 'argument');
  assert.equal(cite.section, 'CHAPTER 1 INTRODUCTION › 1.1 Background');
  assert.equal(synth.section, 'CHAPTER 2 LITERATURE REVIEW');
  assert.equal(synth.criterion, 'Literature review', 'criterion matched to the rubric name');
  assert.equal(synth.severity, 'major');

  const failing = await generateReviewComments({ text: THESIS, documentType: 'thesis', rubric: {}, complete: async () => { throw new Error('rate limited'); } });
  assert.deepEqual(failing, { comments: [], parts_reviewed: 0, parts_failed: 1 });
});

test('attachReviewComments leaves other document types alone', async () => {
  const marking = { scores: [], document_type: 'assignment' };
  assert.equal(await attachReviewComments({ markingResult: marking, text: THESIS }), marking);
  assert.equal(marking.review_comments, undefined);
});
