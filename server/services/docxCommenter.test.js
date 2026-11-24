'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const yauzl = require('yauzl');
const { addCommentsToDocx } = require('./docxCommenter');

const paragraph = (text) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

const writeDocx = (file, bodyXml) => new Promise((resolve, reject) => {
  const out = fs.createWriteStream(file);
  const zip = archiver('zip');
  out.on('close', resolve);
  zip.on('error', reject);
  zip.pipe(out);
  zip.append('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', { name: '[Content_Types].xml' });
  zip.append('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>', { name: 'word/_rels/document.xml.rels' });
  zip.append(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`, { name: 'word/document.xml' });
  zip.finalize();
});

const readEntry = (file, name) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true }, (err, zip) => {
    if (err) return reject(err);
    zip.on('entry', (entry) => {
      if (entry.fileName !== name) return zip.readEntry();
      zip.openReadStream(entry, (streamErr, stream) => {
        if (streamErr) return reject(streamErr);
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
      });
    });
    zip.on('end', () => resolve(null));
    zip.readEntry();
  });
});

test('each detailed review comment is a Word comment on the paragraph it quotes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-comments-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'thesis.docx');
  const output = path.join(dir, 'thesis.marked.docx');
  await writeDocx(input, [
    paragraph('Chapter 1 Introduction'),
    paragraph('Many teachers leave rural schools within two years of appointment.'),
    paragraph('Chapter 2 Literature review'),
    paragraph('Several authors discuss retention (Smith, 2019).')
  ].join(''));

  await addCommentsToDocx(input, output, {
    scores: [],
    review_comments: [
      { id: 1, severity: 'minor', criterion: null, quote: 'leave rural schools within two years', comment: 'Cite a source for this figure.' },
      { id: 2, severity: 'major', criterion: 'Literature review', quote: 'Several authors discuss retention', comment: 'Synthesise the sources.' }
    ]
  });

  const comments = await readEntry(output, 'word/comments.xml');
  assert.match(comments, /Comment 1<\/w:t>.*Cite a source for this figure\./s);
  assert.match(comments, /Comment 2 \(major\) – Literature review<\/w:t>.*Synthesise the sources\./s);

  const documentXml = await readEntry(output, 'word/document.xml');
  const paragraphs = documentXml.match(/<w:p>[\s\S]*?<\/w:p>/g);
  assert.match(paragraphs[1], /^<w:p><w:pPr>.*<\/w:pPr><w:commentRangeStart w:id="0"\/><w:r><w:t>Many teachers.*<w:commentRangeEnd w:id="0"\/><w:r><w:commentReference w:id="0"\/><\/w:r><\/w:p>$/s, 'range covers the quoted paragraph');
  assert.match(paragraphs[3], /commentRangeStart w:id="1"\/><w:r><w:t>Several authors/);
  assert.doesNotMatch(paragraphs[0] + paragraphs[2], /comment/);
});
