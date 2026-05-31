const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { extractTextFromPDF: extractTextFromPDFWithOCR, getPdfPageImages } = require('./pdfOCR');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const CODE_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
  '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.kts', '.scala', '.r', '.m',
  '.sql', '.sh', '.bash', '.zsh', '.ps1', '.pl', '.lua', '.dart', '.html', '.css',
  '.scss', '.sass', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.md',
  '.txt'
]);
const CODE_MIME_PREFIXES = ['text/'];
const CODE_MIME_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/sql',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-python-code',
  'application/xml',
  'application/x-sh',
  'application/x-shellscript'
]);

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

function isCodeDocument(fileNameOrPath = '', mimeType = '') {
  const ext = getFileExtension(fileNameOrPath);
  const mime = String(mimeType || '').toLowerCase();
  return CODE_EXTENSIONS.has(ext) || CODE_MIME_TYPES.has(mime) || CODE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function isSupportedDocument(fileNameOrPath = '', mimeType = '') {
  return isPdfDocument(fileNameOrPath, mimeType) || isDocxDocument(fileNameOrPath, mimeType) || isCodeDocument(fileNameOrPath, mimeType);
}

function getSupportedDocumentLabel(fileNameOrPath = '', mimeType = '') {
  if (isPdfDocument(fileNameOrPath, mimeType)) return 'PDF';
  if (isDocxDocument(fileNameOrPath, mimeType)) return 'Word document';
  if (isCodeDocument(fileNameOrPath, mimeType)) return 'code file';
  return 'document';
}

function getCodeLanguageLabel(fileNameOrPath = '') {
  const ext = getFileExtension(fileNameOrPath).replace(/^\./, '');
  const aliases = {
    py: 'Python',
    js: 'JavaScript',
    jsx: 'React JSX',
    ts: 'TypeScript',
    tsx: 'React TSX',
    sh: 'Shell',
    bash: 'Bash',
    zsh: 'Zsh',
    ps1: 'PowerShell',
    rb: 'Ruby',
    rs: 'Rust',
    kt: 'Kotlin',
    kts: 'Kotlin',
    cs: 'C#',
    cpp: 'C++',
    cc: 'C++',
    cxx: 'C++',
    hpp: 'C++',
    c: 'C',
    h: 'C/C++ header',
    m: 'Objective-C/MATLAB',
    sql: 'SQL',
    html: 'HTML',
    css: 'CSS',
    scss: 'SCSS',
    sass: 'Sass',
    yml: 'YAML',
    yaml: 'YAML',
    md: 'Markdown'
  };
  return aliases[ext] || (ext ? ext.toUpperCase() : 'source code');
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

async function extractTextFromCodeFile(filePath, originalName = filePath) {
  const stats = fs.statSync(filePath);
  const maxBytesRaw = process.env.CODE_UPLOAD_MAX_BYTES || process.env.MAX_FILE_SIZE || '';
  const maxBytes = /^\d+$/.test(String(maxBytesRaw).trim()) ? Number(maxBytesRaw) : 10 * 1024 * 1024;
  if (stats.size > maxBytes) {
    throw new Error(`Code file is too large to mark as text. Maximum code file size is ${Math.round(maxBytes / 1024 / 1024)}MB.`);
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) {
    throw new Error('This appears to be a binary file, not a readable source-code file.');
  }
  const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return '';
  return [
    `SOURCE FILE: ${originalName}`,
    `LANGUAGE: ${getCodeLanguageLabel(originalName)}`,
    '',
    '```',
    text,
    '```'
  ].join('\n');
}

async function extractTextFromDocument(filePath, originalName = filePath, mimeType = '') {
  if (isPdfDocument(originalName || filePath, mimeType)) {
    return extractTextFromPDFWithOCR(filePath);
  }

  if (isDocxDocument(originalName || filePath, mimeType)) {
    return extractTextFromDocx(filePath);
  }

  if (isCodeDocument(originalName || filePath, mimeType)) {
    return extractTextFromCodeFile(filePath, originalName || filePath);
  }

  throw new Error('Unsupported file type. Please upload a PDF, DOCX Word document, or source-code file.');
}

module.exports = {
  CODE_EXTENSIONS,
  DOCX_MIME,
  extractTextFromDocument,
  extractTextFromCodeFile,
  extractTextFromDocx,
  extractTextFromDocxBuffer,
  extractTextFromPDF: extractTextFromPDFWithOCR,
  getPdfPageImages,
  getSupportedDocumentLabel,
  isCodeDocument,
  isDocxDocument,
  isPdfDocument,
  isSupportedDocument
};
