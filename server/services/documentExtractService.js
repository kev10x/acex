const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { extractTextFromPDF: extractTextFromPDFWithOCR, getPdfPageImages } = require('./pdfOCR');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function getFileExtension(fileNameOrPath = '') {
  return path.extname(String(fileNameOrPath || '')).toLowerCase();
}

function isPdfDocument(fileNameOrPath = '', mimeType = '') {
  return String(mimeType || '').toLowerCase() === 'application/pdf' || getFileExtension(fileNameOrPath) === '.pdf';
}

function isDocxDocument(fileNameOrPath = '', mimeType = '') {
  return String(mimeType || '').toLowerCase() === DOCX_MIME || getFileExtension(fileNameOrPath) === '.docx';
}

function isSupportedDocument(fileNameOrPath = '', mimeType = '') {
  return isPdfDocument(fileNameOrPath, mimeType) || isDocxDocument(fileNameOrPath, mimeType);
}

function getSupportedDocumentLabel(fileNameOrPath = '', mimeType = '') {
  if (isPdfDocument(fileNameOrPath, mimeType)) return 'PDF';
  if (isDocxDocument(fileNameOrPath, mimeType)) return 'Word document';
  return 'document';
}

async function extractTextFromDocxBuffer(buffer) {
  const xmlFiles = [];

  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) return reject(openErr || new Error('Failed to open DOCX'));

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = String(entry.fileName || '');
        const isTextXml = /^word\/(document|header\d+|footer\d+)\.xml$/i.test(name);
        if (!isTextXml) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) {
            zipfile.readEntry();
            return;
          }

          const chunks = [];
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on('end', () => {
            xmlFiles.push(Buffer.concat(chunks).toString('utf8'));
            zipfile.readEntry();
          });
          stream.on('error', () => zipfile.readEntry());
        });
      });
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });

  const joinedXml = xmlFiles.join('\n');
  if (!joinedXml.trim()) return '';

  return decodeXmlEntities(
    joinedXml
      .replace(/<w:p\b[^>]*>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab\/>/g, ' ')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, ' ')
      .replace(/\t/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
  ).trim();
}

async function extractTextFromDocx(filePath) {
  const buffer = fs.readFileSync(filePath);
  return extractTextFromDocxBuffer(buffer);
}

async function extractTextFromDocument(filePath, originalName = filePath, mimeType = '') {
  if (isPdfDocument(originalName || filePath, mimeType)) {
    return extractTextFromPDFWithOCR(filePath);
  }

  if (isDocxDocument(originalName || filePath, mimeType)) {
    return extractTextFromDocx(filePath);
  }

  throw new Error('Unsupported file type. Please upload a PDF or DOCX Word document.');
}

module.exports = {
  DOCX_MIME,
  extractTextFromDocument,
  extractTextFromDocx,
  extractTextFromDocxBuffer,
  extractTextFromPDF: extractTextFromPDFWithOCR,
  getPdfPageImages,
  getSupportedDocumentLabel,
  isDocxDocument,
  isPdfDocument,
  isSupportedDocument
};
