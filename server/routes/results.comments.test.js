'use strict';

/**
 * Lecturers edit the generated comments; the commented Word document is rebuilt from the edits.
 *
 * Run:  node --test server/routes/results.comments.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { loadWithMocks } = require('../test-utils/loadWithMocks');

function setup({ filePath = '/nowhere/thesis.docx', docxCalls = [] } = {}) {
  const row = {
    id: 5,
    user_id: 7,
    assignment_id: 50,
    filename: path.basename(filePath),
    file_path: filePath,
    extracted_text: 'Chapter 1 Introduction. Many teachers leave rural schools.',
    scores: JSON.stringify([
      { criterion_name: 'Evidence', points_awarded: 3, max_points: 5, feedback: 'Cite more sources.' },
      { criterion_name: 'Structure', points_awarded: 4, max_points: 5, feedback: 'Clear.' }
    ]),
    review_comments: JSON.stringify([{ id: 1, section: 'Chapter 1', quote: 'leave rural schools', comment: 'Cite a source.', category: 'evidence', severity: 'minor', criterion: null }])
  };
  const updates = [];
  const query = async (sql, params) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT mr.*, a.filename, a.file_path, a.extracted_text')) {
      return { rows: Number(params[0]) === row.id && params[1] === row.user_id ? [row] : [] };
    }
    if (q.startsWith('UPDATE marking_results SET scores')) {
      updates.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  };
  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'results.js'), {
    '../database/connection': { query },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => { req.user = { id: 7, role: 'lecturer', organisation_id: 1 }; next(); },
      requireRoles: () => (_req, _res, next) => next(),
      requireFeature: () => (_req, _res, next) => next()
    },
    '../services/feedbackVideoService': {},
    '../services/auditEventService': { recordAuditEvent: async () => {}, getRequestMetadata: () => ({}) },
    '../services/docxCommenter': { addCommentsToDocx: async (input, output, result) => { docxCalls.push({ input, output, result }); } }
  });
  const app = express();
  app.use(express.json());
  app.use('/results', router);
  return { app, updates, restore };
}

test('edits review comments and criterion feedback without changing marks', async (t) => {
  const { app, updates, restore } = setup();
  t.after(restore);

  const res = await request(app).put('/results/5/comments').send({
    review_comments: [
      { id: 1, section: 'Chapter 1', quote: 'leave rural schools', comment: '  Cite Statistics SA.  ', category: 'evidence', severity: 'major', edited: true },
      { id: null, comment: 'Number the tables.', category: 'made-up', page: '7' }
    ],
    criterion_feedback: { Evidence: 'Cite at least three recent sources.' }
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.review_comments, [
    { id: 1, section: 'Chapter 1', page: null, quote: 'leave rural schools', comment: 'Cite Statistics SA.', category: 'evidence', severity: 'major', criterion: null, edited: true },
    { id: 2, section: null, page: 7, quote: null, comment: 'Number the tables.', category: 'argument', severity: 'minor', criterion: null, edited: true }
  ]);
  assert.deepEqual(res.body.scores.map((s) => [s.criterion_name, s.points_awarded, s.feedback, Boolean(s.feedback_edited)]), [
    ['Evidence', 3, 'Cite at least three recent sources.', true],
    ['Structure', 4, 'Clear.', false]
  ]);
  assert.equal(updates.length, 1);
  assert.deepEqual(JSON.parse(updates[0][1]).map((c) => c.id), [1, 2]);
  assert.equal(updates[0][2], '5');
});

test('rejects empty comments, unknown criteria and other lecturers\' results', async (t) => {
  const { app, updates, restore } = setup();
  t.after(restore);
  assert.equal((await request(app).put('/results/5/comments').send({ review_comments: [{ comment: '  ' }] })).status, 400);
  assert.equal((await request(app).put('/results/5/comments').send({ review_comments: 'nope' })).status, 400);
  assert.equal((await request(app).put('/results/5/comments').send({ criterion_feedback: { Nonsense: 'x' } })).status, 400);
  assert.equal((await request(app).put('/results/6/comments').send({ review_comments: [] })).status, 404);
  assert.equal(updates.length, 0);

  // Deleting every comment clears them.
  const cleared = await request(app).put('/results/5/comments').send({ review_comments: [] });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.review_comments, null);
});

test('an existing commented Word document is rebuilt with the edited comments', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-comments-'));
  const filePath = path.join(dir, 'thesis.docx');
  fs.writeFileSync(filePath, 'original');
  fs.writeFileSync(path.join(dir, 'thesis.marked-comments.docx'), 'old output');
  const docxCalls = [];
  const { app, restore } = setup({ filePath, docxCalls });
  t.after(() => { restore(); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await request(app).put('/results/5/comments').send({ review_comments: [{ comment: 'New point.' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.outputs, { commented_docx: 'updated' });
  assert.equal(docxCalls.length, 1);
  assert.equal(docxCalls[0].output, path.join(dir, 'thesis.marked-comments.docx'));
  assert.deepEqual(docxCalls[0].result.review_comments.map((c) => c.comment), ['New point.']);
});

test('an existing annotated PDF is rebuilt, with each edited comment on its quote\'s page', async (t) => {
  const { PDFDocument, StandardFonts, PDFName } = require('pdf-lib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'results-comments-pdf-'));
  const filePath = path.join(dir, 'thesis.pdf');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Chapter 1 Introduction', { x: 50, y: 780, size: 11, font });
  doc.addPage([595, 842]).drawText('Many teachers leave rural schools within two years.', { x: 50, y: 780, size: 11, font });
  fs.writeFileSync(filePath, await doc.save());
  fs.writeFileSync(path.join(dir, 'thesis.annotated.pdf'), 'old output');
  const { app, restore } = setup({ filePath });
  t.after(() => { restore(); fs.rmSync(dir, { recursive: true, force: true }); });

  const res = await request(app).put('/results/5/comments').send({
    review_comments: [{ comment: 'Cite a source for this figure.', quote: 'leave rural schools within two years' }]
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.outputs, { annotated_pdf: 'updated' });
  assert.equal(res.body.review_comments[0].page, 2, 'page found for the edited quote');

  const annotated = await PDFDocument.load(fs.readFileSync(path.join(dir, 'thesis.annotated.pdf')));
  const notes = annotated.getPages().map((page) => {
    const annots = page.node.lookup(PDFName.of('Annots'));
    return annots ? annots.asArray().map((ref) => annotated.context.lookup(ref).lookup(PDFName.of('Contents')).decodeText()) : [];
  });
  assert.ok(notes[1].includes('Comment 1: Cite a source for this figure.'));
  assert.ok(!notes[0].includes('Comment 1: Cite a source for this figure.'));
});
