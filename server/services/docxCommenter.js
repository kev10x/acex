const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const yauzl = require('yauzl');

const COMMENTS_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENTS_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function readAllZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) return reject(openErr || new Error('Could not open DOCX'));

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            entries.set(entry.fileName, Buffer.alloc(0));
            zipfile.readEntry();
            return;
          }

          const chunks = [];
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

function writeZipEntries(entries, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    for (const [name, buffer] of entries.entries()) {
      archive.append(buffer, { name });
    }

    archive.finalize();
  });
}

function getNextCommentId(commentsXml) {
  const ids = [...String(commentsXml || '').matchAll(/w:id="(\d+)"/g)].map((match) => Number(match[1]));
  return ids.length ? Math.max(...ids) + 1 : 0;
}

function createCommentsRoot() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '</w:comments>'
  ].join('');
}

function buildCommentXml(id, text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const paragraphs = (lines.length ? lines : ['Acexen feedback']).map((line) => (
    `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
  )).join('');

  return `<w:comment w:id="${id}" w:author="Acexen" w:initials="MM" w:date="${new Date().toISOString()}">${paragraphs}</w:comment>`;
}

function ensureCommentsXml(entries, comments) {
  const existing = entries.get('word/comments.xml')?.toString('utf8') || createCommentsRoot();
  const startId = getNextCommentId(existing);
  const xmlComments = comments.map((comment, index) => ({
    ...comment,
    id: startId + index,
    xml: buildCommentXml(startId + index, comment.text)
  }));

  const updated = existing.includes('</w:comments>')
    ? existing.replace('</w:comments>', `${xmlComments.map((comment) => comment.xml).join('')}</w:comments>`)
    : createCommentsRoot().replace('</w:comments>', `${xmlComments.map((comment) => comment.xml).join('')}</w:comments>`);

  entries.set('word/comments.xml', Buffer.from(updated, 'utf8'));
  return xmlComments;
}

function ensureContentType(entries) {
  const contentTypesPath = '[Content_Types].xml';
  const xml = entries.get(contentTypesPath)?.toString('utf8');
  if (!xml || xml.includes('PartName="/word/comments.xml"')) return;

  const override = `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CONTENT_TYPE}"/>`;
  const updated = xml.replace('</Types>', `${override}</Types>`);
  entries.set(contentTypesPath, Buffer.from(updated, 'utf8'));
}

function ensureCommentsRelationship(entries) {
  const relsPath = 'word/_rels/document.xml.rels';
  const xml = entries.get(relsPath)?.toString('utf8');
  if (!xml) return;
  if (xml.includes(COMMENTS_REL_TYPE)) return;

  const ids = [...xml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
  const nextId = ids.length ? Math.max(...ids) + 1 : 1;
  const rel = `<Relationship Id="rId${nextId}" Type="${COMMENTS_REL_TYPE}" Target="comments.xml"/>`;
  const updated = xml.replace('</Relationships>', `${rel}</Relationships>`);
  entries.set(relsPath, Buffer.from(updated, 'utf8'));
}

function textFromParagraphXml(paragraphXml) {
  return [...String(paragraphXml || '').matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => match[1])
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordsForComment(comment) {
  const stopWords = new Set(['about', 'after', 'before', 'because', 'could', 'should', 'their', 'there', 'these', 'those', 'which', 'while', 'with', 'would', 'feedback', 'criterion', 'student']);
  const words = String(`${comment.criterion || ''} ${comment.text || ''}`).toLowerCase().match(/[a-z0-9]{5,}/g) || [];
  return Array.from(new Set(words.filter((word) => !stopWords.has(word)))).slice(0, 10);
}

function selectParagraphIndex(paragraphs, paragraphTexts, comment, fallbackIndex) {
  const keywords = keywordsForComment(comment);
  if (keywords.length === 0) return fallbackIndex % Math.max(paragraphs.length, 1);

  let bestIndex = -1;
  let bestScore = 0;
  paragraphTexts.forEach((text, index) => {
    const lower = text.toLowerCase();
    const score = keywords.reduce((sum, keyword) => sum + (lower.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex >= 0 ? bestIndex : fallbackIndex % Math.max(paragraphs.length, 1);
}

function insertCommentReference(paragraphXml, commentId) {
  const marker = [
    `<w:commentRangeStart w:id="${commentId}"/>`,
    `<w:commentRangeEnd w:id="${commentId}"/>`,
    `<w:r><w:commentReference w:id="${commentId}"/></w:r>`
  ].join('');
  return String(paragraphXml).replace('</w:p>', `${marker}</w:p>`);
}

function annotateDocumentXml(documentXml, comments) {
  const paragraphs = [...String(documentXml || '').matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)];
  if (paragraphs.length === 0) {
    throw new Error('Could not find paragraphs in the DOCX document.');
  }

  const paragraphTexts = paragraphs.map((match) => textFromParagraphXml(match[0]));
  const replacements = new Map();

  comments.forEach((comment, index) => {
    const targetIndex = selectParagraphIndex(paragraphs, paragraphTexts, comment, index);
    const existing = replacements.get(targetIndex) || paragraphs[targetIndex][0];
    replacements.set(targetIndex, insertCommentReference(existing, comment.id));
  });

  let offset = 0;
  let updated = String(documentXml || '');
  for (const [index, replacement] of Array.from(replacements.entries()).sort((a, b) => a[0] - b[0])) {
    const match = paragraphs[index];
    const start = match.index + offset;
    const end = start + match[0].length;
    updated = updated.slice(0, start) + replacement + updated.slice(end);
    offset += replacement.length - match[0].length;
  }

  return updated;
}

function buildCommentsFromMarking(markingResult) {
  const scores = Array.isArray(markingResult?.scores) ? markingResult.scores : [];
  const comments = scores.map((score) => ({
    criterion: score.criterion_name || score.name || 'Criterion',
    text: [
      `${score.criterion_name || score.name || 'Criterion'}: ${score.points_awarded ?? 0}/${score.max_points ?? ''}`,
      score.feedback || ''
    ].filter(Boolean).join('\n')
  }));

  if (markingResult?.overall_feedback) {
    comments.unshift({
      criterion: 'Overall feedback',
      text: `Overall feedback\n${markingResult.overall_feedback}`
    });
  }

  return comments.filter((comment) => String(comment.text || '').trim());
}

async function addCommentsToDocx(inputPath, outputPath, markingResult) {
  const entries = await readAllZipEntries(inputPath);
  const documentXml = entries.get('word/document.xml')?.toString('utf8');
  if (!documentXml) {
    throw new Error('The DOCX file does not contain word/document.xml.');
  }

  const comments = buildCommentsFromMarking(markingResult);
  if (comments.length === 0) {
    throw new Error('No marking comments were available to insert.');
  }

  const commentsWithIds = ensureCommentsXml(entries, comments);
  ensureContentType(entries);
  ensureCommentsRelationship(entries);
  entries.set('word/document.xml', Buffer.from(annotateDocumentXml(documentXml, commentsWithIds), 'utf8'));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await writeZipEntries(entries, outputPath);
  return outputPath;
}

module.exports = {
  addCommentsToDocx,
  buildCommentsFromMarking
};
