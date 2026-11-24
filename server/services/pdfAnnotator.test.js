'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts, PDFName } = require('pdf-lib');
const { annotatePdfWithIssues, buildReviewIssues, findPhrasePages } = require('./pdfAnnotator');

const makePdf = async (file, pages) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 18, size: 11, font }));
  }
  fs.writeFileSync(file, await doc.save());
};

const notesByPage = async (file) => {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  return doc.getPages().map((page) => {
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (!annots) return [];
    return annots.asArray().map((ref) => doc.context.lookup(ref).lookup(PDFName.of('Contents')).decodeText());
  });
};

test('notes go on the page of their quote (even across line breaks); unfound notes only on page 1', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-annot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'thesis.pdf');
  const output = path.join(dir, 'thesis.annotated.pdf');
  await makePdf(input, [
    ['Chapter 1 Introduction', 'This study examines teacher retention.'],
    ['Chapter 2 Literature review', 'Several authors discuss retention in rural', 'schools across the Eastern Cape (Smith, 2019).']
  ]);

  const pages = await findPhrasePages(input, ['retention in rural schools across', 'not in the document anywhere']);
  assert.equal(pages.get('retention in rural schools across'), 2, 'found across a line break');
  assert.equal(pages.has('not in the document anywhere'), false);

  const issues = buildReviewIssues([
    { id: 1, severity: 'major', quote: 'Several authors discuss retention in rural schools across the Eastern Cape', comment: 'Synthesise the sources.' },
    { id: 2, severity: 'minor', quote: 'words that are nowhere in it', comment: 'Unplaced note.' }
  ]);
  await annotatePdfWithIssues(input, output, issues);

  const notes = await notesByPage(output);
  assert.deepEqual(notes[0], ['Comment 2: Unplaced note.']);
  assert.deepEqual(notes[1], ['Comment 1 (major): Synthesise the sources.']);
});
