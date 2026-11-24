const fs = require('fs');
const { PDFDocument, rgb, PDFName, PDFDict, PDFArray, PDFString, PDFNumber } = require('pdf-lib');

async function getPdfJs() {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return mod;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whitespace-, case- and quote-style-tolerant pattern for a phrase.
function phrasePattern(phrase) {
  const tokens = String(phrase || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens
    .map((token) => escapeRegExp(token).replace(/['‘’]/g, "['‘’]").replace(/["“”]/g, '["“”]').replace(/[-–—]/g, '[-–—]'))
    .join('\\s*');
}

async function extractAnchorsWithPositions(pdfPath, anchorPhrases, maxMatchesPerPhrase = 3) {
  const pdfjsLib = await getPdfJs();
  const pdfData = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data: pdfData, useSystemFonts: true });
  const pdf = await loadingTask.promise;

  const results = [];

  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
    const page = await pdf.getPage(pageIndex);
    const textContent = await page.getTextContent();
    const items = textContent.items.map((it) => ({
      str: it.str,
      transform: it.transform,
      width: it.width,
      height: it.height
    }));
    // Items joined with spaces; phrases are matched token by token so they may span lines.
    const itemStarts = [];
    let joined = '';
    for (const item of items) {
      itemStarts.push(joined.length);
      joined += `${item.str} `;
    }

    for (const phrase of anchorPhrases) {
      if (!phrase || phrase.length < 8) continue;
      const pattern = phrasePattern(phrase);
      if (!pattern) continue;

      const regex = new RegExp(pattern, 'gi');
      let foundCount = 0;
      let match;
      while (foundCount < maxMatchesPerPhrase && (match = regex.exec(joined)) !== null) {
        const idx = match.index;
        foundCount++;

        let itemIdx = 0;
        while (itemIdx + 1 < itemStarts.length && itemStarts[itemIdx + 1] <= idx) itemIdx++;

        const item = items[itemIdx];
        if (!item) continue;

        const [, , , , x, y] = item.transform;
        const w = item.width || Math.max(phrase.length * 3, 50);
        const h = item.height || 12;
        results.push({ pageIndex: pageIndex - 1, phrase, x, y, w, h });
      }
    }
  }

  return results;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizePhrase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getHighlightRect(pos, pageWidth, pageHeight) {
  const rectWidth = Math.min(Math.max((pos.w || 0) + 60, 70), pageWidth * 0.9);
  const rectHeight = Math.max((pos.h || 0) + 6, 14);
  const x = clamp(pos.x || 10, 10, pageWidth - rectWidth - 10);
  const y = pageHeight - clamp((pos.y || 0) + (pos.h || 0), rectHeight + 10, pageHeight - 10);
  return { x, y, width: rectWidth, height: rectHeight };
}

function avoidAnnotationOverlap(candidate, occupied, pageWidth, pageHeight) {
  const stepY = 26;
  const stepX = 30;
  let { x, y } = candidate;

  for (let i = 0; i < 18; i++) {
    const conflict = occupied.some((point) => Math.abs(point.x - x) < 26 && Math.abs(point.y - y) < 22);
    if (!conflict) {
      occupied.push({ x, y });
      return { x, y };
    }

    y -= stepY;
    if (y < 24) {
      y = clamp(candidate.y + stepY, 24, pageHeight - 24);
      x = clamp(x - stepX, 12, pageWidth - 24);
    }
  }

  occupied.push({ x, y });
  return { x, y };
}

async function annotatePdfWithIssues(inputPath, outputPath, issues) {
  console.log(`Annotating PDF with ${issues.length} issues`);

  const pdfBytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  const phrases = [];
  for (const issue of issues) {
    for (const phrase of issue.anchorPhrases || []) {
      if (typeof phrase === 'string' && phrase.length >= 8 && phrase.length <= 160) {
        phrases.push(phrase);
      }
    }
  }

  console.log(`Searching for ${phrases.length} anchor phrases in PDF`);

  let positions = [];
  try {
    positions = await extractAnchorsWithPositions(inputPath, phrases);
    console.log(`Found ${positions.length} anchor phrase positions`);
  } catch (error) {
    console.warn('Anchor extraction failed, proceeding with page-level notes only:', error.message);
  }

  const foundPhrases = new Set(positions.map((pos) => normalizePhrase(pos.phrase)));
  const unplacedIssues = issues.filter((issue) =>
    !(issue.anchorPhrases || []).some((phrase) => foundPhrases.has(normalizePhrase(phrase)))
  );

  const byPage = new Map();
  for (const pos of positions) {
    if (!byPage.has(pos.pageIndex)) byPage.set(pos.pageIndex, []);
    byPage.get(pos.pageIndex).push(pos);
  }

  for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex++) {
    const page = pdfDoc.getPage(pageIndex);
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    const pagePositions = byPage.get(pageIndex) || [];

    console.log(`Page ${pageIndex + 1}: Found ${pagePositions.length} anchor positions`);

    pagePositions.slice(0, 30).forEach((pos) => {
      const rect = getHighlightRect(pos, pageWidth, pageHeight);
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        color: rgb(1, 1, 0),
        opacity: 0.3,
        borderColor: rgb(1, 0.7, 0),
        borderOpacity: 0.8,
        borderWidth: 1
      });
      page.drawText('^', {
        x: rect.x - 8,
        y: rect.y + rect.height - 8,
        size: 12,
        color: rgb(1, 0.2, 0.2)
      });
    });

    // Each note goes on the page(s) where its text was found; notes not found anywhere go on page 1.
    let issuesToShow = pagePositions.length > 0
      ? issues.filter((issue) =>
          (issue.anchorPhrases || []).some((phrase) =>
            pagePositions.some((pos) => normalizePhrase(pos.phrase) === normalizePhrase(phrase))
          )
        )
      : [];
    if (pageIndex === 0) issuesToShow = [...issuesToShow, ...unplacedIssues];
    if (issuesToShow.length === 0) continue;

    const pageDict = page.node;
    let annotsArray = pageDict.get(PDFName.of('Annots'));
    if (!annotsArray) {
      annotsArray = PDFArray.withContext(pdfDoc.context);
      pageDict.set(PDFName.of('Annots'), annotsArray);
    }

    const occupiedAnnotationPoints = [];

    issuesToShow.slice(0, 25).forEach((issue, idx) => {
      const text = (issue.note || '').slice(0, 500);
      if (!text) return;

      let commentX = pageWidth - 30;
      let commentY = clamp(pageHeight - 50 - (idx * 28), 24, pageHeight - 24);

      const matchingPos = pagePositions.find((pos) =>
        (issue.anchorPhrases || []).some((phrase) => normalizePhrase(phrase) === normalizePhrase(pos.phrase))
      );

      if (matchingPos) {
        const rect = getHighlightRect(matchingPos, pageWidth, pageHeight);
        commentX = clamp(rect.x + rect.width + 8, 12, pageWidth - 24);
        commentY = clamp(rect.y + rect.height - 4, 24, pageHeight - 24);
      }

      const adjusted = avoidAnnotationOverlap(
        { x: commentX, y: commentY },
        occupiedAnnotationPoints,
        pageWidth,
        pageHeight
      );

      try {
        const annotationDict = PDFDict.withContext(pdfDoc.context);
        annotationDict.set(PDFName.of('Type'), PDFName.of('Annot'));
        annotationDict.set(PDFName.of('Subtype'), PDFName.of('Text'));

        const rectArray = PDFArray.withContext(pdfDoc.context);
        rectArray.push(PDFNumber.of(adjusted.x));
        rectArray.push(PDFNumber.of(adjusted.y - 15));
        rectArray.push(PDFNumber.of(adjusted.x + 20));
        rectArray.push(PDFNumber.of(adjusted.y + 5));
        annotationDict.set(PDFName.of('Rect'), rectArray);
        annotationDict.set(PDFName.of('Contents'), PDFString.of(text));

        const criterionName = text.split(':')[0] || `Feedback ${idx + 1}`;
        annotationDict.set(PDFName.of('T'), PDFString.of(criterionName));

        const colorArray = PDFArray.withContext(pdfDoc.context);
        colorArray.push(PDFNumber.of(1));
        colorArray.push(PDFNumber.of(0.8));
        colorArray.push(PDFNumber.of(0));
        annotationDict.set(PDFName.of('C'), colorArray);

        annotsArray.push(annotationDict);
      } catch (error) {
        console.warn(`Failed to create annotation ${idx + 1}:`, error.message);
      }
    });

    console.log(`Added ${Math.min(issuesToShow.length, 25)} PDF comment annotations to page ${pageIndex + 1}`);
  }

  const outBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, outBytes);
  console.log(`PDF annotation complete: ${outputPath}`);
  return outputPath;
}

function buildIssuesFromMarking(markingResult) {
  const issues = [];

  for (const score of markingResult.scores || []) {
    const note = `${score.criterion_name}: ${score.feedback}`;
    const anchorPhrases = [];
    const parts = (score.feedback || '').split(/[.;:]/).map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.length >= 20 && part.length <= 140) anchorPhrases.push(part);
      if (anchorPhrases.length >= 3) break;
    }
    if (anchorPhrases.length === 0 && score.feedback) {
      anchorPhrases.push(score.feedback.slice(0, 140));
    }
    issues.push({ anchorPhrases, note });
  }

  for (const correction of markingResult.corrections || []) {
    const locationText = String(correction.location || '').trim();
    const issueText = String(correction.issue || '').trim();
    const correctionText = String(correction.correction || '').trim();
    const note = [correction.criterion_name || 'Correction', issueText || correctionText || locationText]
      .filter(Boolean)
      .join(': ');
    const anchorPhrases = [locationText, issueText, correctionText]
      .filter((value) => typeof value === 'string' && value.length >= 8 && value.length <= 160);
    if (note && anchorPhrases.length > 0) {
      issues.push({ anchorPhrases, note });
    }
  }

  for (const error of markingResult.language_errors || []) {
    const errorText = String(error.error_text || '').trim();
    const locationText = String(error.location || '').trim();
    const correctionText = String(error.correction || '').trim();
    const note = [
      error.error_type ? `Language (${error.error_type})` : 'Language',
      correctionText || errorText || locationText
    ]
      .filter(Boolean)
      .join(': ');
    const anchorPhrases = [errorText, locationText, correctionText]
      .filter((value) => typeof value === 'string' && value.length >= 8 && value.length <= 160);
    if (note && anchorPhrases.length > 0) {
      issues.push({ anchorPhrases, note });
    }
  }

  return issues;
}

// The words of a review comment's quote used to find it in a PDF (short enough to sit on few lines).
const reviewAnchorPhrase = (quote) => String(quote || '').trim().split(/\s+/).slice(0, 10).join(' ').slice(0, 150);

/** Map of phrase -> 1-based page number for the phrases found in the PDF. */
async function findPhrasePages(pdfPath, phrases) {
  const wanted = Array.from(new Set((phrases || []).filter((phrase) => typeof phrase === 'string' && phrase.length >= 8)));
  const pages = new Map();
  if (wanted.length === 0) return pages;
  for (const position of await extractAnchorsWithPositions(pdfPath, wanted, 1)) {
    if (!pages.has(position.phrase)) pages.set(position.phrase, position.pageIndex + 1);
  }
  return pages;
}

/** One PDF note per detailed review comment, anchored on its quote. */
function buildReviewIssues(reviewComments) {
  return (reviewComments || []).map((comment) => {
    const label = `Comment ${comment.id}${comment.severity === 'major' ? ' (major)' : ''}`;
    const phrase = reviewAnchorPhrase(comment.quote);
    return {
      anchorPhrases: phrase.length >= 8 ? [phrase] : [],
      note: `${label}: ${comment.comment}`
    };
  });
}

module.exports = {
  annotatePdfWithIssues,
  buildIssuesFromMarking,
  buildReviewIssues,
  findPhrasePages,
  reviewAnchorPhrase
};
