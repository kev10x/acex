const fs = require('fs');
const { PDFDocument, rgb, PDFName, PDFDict, PDFArray, PDFString, PDFNumber } = require('pdf-lib');

async function getPdfJs() {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return mod;
}

async function extractAnchorsWithPositions(pdfPath, anchorPhrases, maxMatchesPerPhrase = 3) {
  const pdfjsLib = await getPdfJs();
  const pdfData = fs.readFileSync(pdfPath);
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
    const joined = items.map((item) => item.str).join('\n');

    for (const phrase of anchorPhrases) {
      if (!phrase || phrase.length < 8) continue;

      let searchIdx = 0;
      let foundCount = 0;
      while (foundCount < maxMatchesPerPhrase) {
        const idx = joined.toLowerCase().indexOf(phrase.toLowerCase(), searchIdx);
        if (idx === -1) break;

        searchIdx = idx + phrase.length;
        foundCount++;

        let cumulative = 0;
        let itemIdx = 0;
        for (; itemIdx < items.length; itemIdx++) {
          const len = items[itemIdx].str.length + 1;
          if (cumulative + len > idx) break;
          cumulative += len;
        }

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

    pagePositions.slice(0, 20).forEach((pos) => {
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

    let pageIssues = [];
    if (pagePositions.length > 0) {
      pageIssues = issues.filter((issue) =>
        (issue.anchorPhrases || []).some((phrase) =>
          pagePositions.some((pos) => normalizePhrase(pos.phrase) === normalizePhrase(phrase))
        )
      );
    } else if (pageIndex === 0) {
      pageIssues = issues;
    }

    if (pageIssues.length === 0 && !(pageIndex === 0 && issues.length > 0)) {
      continue;
    }

    const issuesToShow = pageIssues.length > 0 ? pageIssues : issues;
    const pageDict = page.node;
    let annotsArray = pageDict.get(PDFName.of('Annots'));
    if (!annotsArray) {
      annotsArray = PDFArray.withContext(pdfDoc.context);
      pageDict.set(PDFName.of('Annots'), annotsArray);
    }

    const occupiedAnnotationPoints = [];

    issuesToShow.slice(0, 15).forEach((issue, idx) => {
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

    console.log(`Added ${Math.min(issuesToShow.length, 15)} PDF comment annotations to page ${pageIndex + 1}`);
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

module.exports = {
  annotatePdfWithIssues,
  buildIssuesFromMarking
};
