const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, PDFName, PDFDict, PDFArray, PDFString, PDFNumber } = require('pdf-lib');
// pdfjs-dist provides ESM .mjs builds; load dynamically for CJS compatibility
async function getPdfJs() {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return mod;
}

// Map a set of short anchor phrases to page/rect coordinates using pdfjs textItems
async function extractAnchorsWithPositions(pdfPath, anchorPhrases, maxMatchesPerPhrase = 3) {
  const pdfjsLib = await getPdfJs();
  
  // Read the PDF file as a buffer and use data option instead of url
  // This works better across platforms (Windows, Linux, Mac)
  let pdfData;
  try {
    pdfData = fs.readFileSync(pdfPath);
  } catch (error) {
    throw new Error(`Failed to read PDF file: ${pdfPath} - ${error.message}`);
  }
  
  const loadingTask = pdfjsLib.getDocument({ data: pdfData, useSystemFonts: true });
  const pdf = await loadingTask.promise;

  const results = [];
  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex++) {
    const page = await pdf.getPage(pageIndex);
    const textContent = await page.getTextContent();
    // Build a simple plain string and keep per-item offsets for back-mapping
    const items = textContent.items.map((it) => ({ str: it.str, transform: it.transform, width: it.width, height: it.height }));
    const joined = items.map(i => i.str).join('\n');

    for (const phrase of anchorPhrases) {
      if (!phrase || phrase.length < 8) continue;
      let searchIdx = 0;
      let foundCount = 0;
      while (foundCount < maxMatchesPerPhrase) {
        const idx = joined.toLowerCase().indexOf(phrase.toLowerCase(), searchIdx);
        if (idx === -1) break;
        searchIdx = idx + phrase.length;
        foundCount++;
        // Best-effort: locate the first matching text item that contains the start of the phrase
        let cum = 0;
        let itemIdx = 0;
        for (; itemIdx < items.length; itemIdx++) {
          const len = items[itemIdx].str.length + 1; // +1 for the inserted \n
          if (cum + len > idx) break;
          cum += len;
        }
        const it = items[itemIdx];
        if (!it) continue;
        const [a, b, c, d, e, f] = it.transform; // transform matrix
        const x = e;
        const y = f;
        const w = it.width || Math.max(phrase.length * 3, 50);
        const h = it.height || 12;
        results.push({ pageIndex: pageIndex - 1, phrase, x, y, w, h });
      }
    }
  }
  return results;
}

// Draw semi-transparent highlight rectangles and margin notes for each issue
async function annotatePdfWithIssues(inputPath, outputPath, issues) {
  // issues: array of { anchorPhrases: string[], note: string }
  console.log(`📝 Annotating PDF with ${issues.length} issues`);
  
  const pdfBytes = fs.readFileSync(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Collect unique anchor phrases (short, <= 120 chars)
  const phrases = [];
  for (const issue of issues) {
    for (const p of issue.anchorPhrases || []) {
      if (typeof p === 'string' && p.length >= 8 && p.length <= 160) phrases.push(p);
    }
  }
  console.log(`🔍 Searching for ${phrases.length} anchor phrases in PDF`);

  let positions = [];
  try {
    positions = await extractAnchorsWithPositions(inputPath, phrases);
    console.log(`✅ Found ${positions.length} anchor phrase positions`);
  } catch (e) {
    console.warn('Anchor extraction failed, proceeding with page-level notes only:', e.message);
  }

  // Group positions by page
  const byPage = new Map();
  for (const pos of positions) {
    if (!byPage.has(pos.pageIndex)) byPage.set(pos.pageIndex, []);
    byPage.get(pos.pageIndex).push(pos);
  }

  // Draw highlights and notes on each page
  for (let i = 0; i < pdfDoc.getPageCount(); i++) {
    const page = pdfDoc.getPage(i);
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();

    // Draw highlights for found anchor phrases
    const items = byPage.get(i) || [];
    console.log(`📄 Page ${i + 1}: Found ${items.length} anchor positions`);
    
    items.slice(0, 20).forEach((pos, idx) => {
      const rectWidth = Math.min(pos.w + 60, pageWidth * 0.9);
      const rectHeight = Math.max(pos.h + 6, 14);
      const x = Math.min(Math.max(pos.x, 10), pageWidth - rectWidth - 10);
      // PDF coordinates: Y=0 is at bottom, so we need to flip Y coordinate
      const y = pageHeight - Math.min(Math.max(pos.y + pos.h, rectHeight + 10), pageHeight - 10);

      page.drawRectangle({ 
        x, 
        y, 
        width: rectWidth, 
        height: rectHeight, 
        color: rgb(1, 1, 0), 
        opacity: 0.3, 
        borderColor: rgb(1, 0.7, 0), 
        borderOpacity: 0.8,
        borderWidth: 1
      });
      page.drawText(`▲`, { 
        x: x - 8, 
        y: y + rectHeight - 8, 
        size: 12, 
        color: rgb(1, 0.2, 0.2) 
      });
    });

    // Always show margin notes for all issues, even if anchor phrases weren't found
    // If we have page-specific issues, use those; otherwise show all issues on first page
    let pageIssues = [];
    if (items.length > 0) {
      // Filter issues that have matching anchor phrases on this page
      pageIssues = issues.filter(is => (is.anchorPhrases || []).some(p => 
        (byPage.get(i) || []).some(pos => pos.phrase === p)
      ));
    } else if (i === 0) {
      // If no anchors found, show all issues on the first page
      pageIssues = issues;
    }

    // Add PDF comment annotations attached to specific text locations
    // This way comments don't cover the content and are linked to the relevant questions/answers
    if (pageIssues.length > 0 || (i === 0 && issues.length > 0)) {
      const issuesToShow = pageIssues.length > 0 ? pageIssues : issues;
      
      // Get the page's annotation array
      const pageDict = page.node;
      let annotsArray = pageDict.get(PDFName.of('Annots'));
      if (!annotsArray) {
        annotsArray = PDFArray.withContext(pdfDoc.context);
        pageDict.set(PDFName.of('Annots'), annotsArray);
      }
      
      // For each issue, try to attach comment to the first matching anchor phrase position
      issuesToShow.slice(0, 15).forEach((is, idx) => {
        const text = (is.note || '').slice(0, 500);
        if (!text) return;
        
        // Find the first anchor phrase position for this issue on this page
        let commentX = pageWidth - 30; // Default to right margin
        let commentY = 50 + (idx * 25); // Default: stack from bottom
        
        // Try to find a matching anchor phrase position for this issue
        const matchingPos = (byPage.get(i) || []).find(pos => 
          (is.anchorPhrases || []).some(phrase => 
            phrase && pos.phrase && phrase.toLowerCase().includes(pos.phrase.toLowerCase())
          )
        );
        
        if (matchingPos) {
          // Attach comment to the found text position
          // Position comment icon to the right of the text, slightly above it
          commentX = Math.min(Math.max(matchingPos.x + matchingPos.w + 5, 10), pageWidth - 30);
          
          // PDF coordinates: Y=0 is at bottom
          // pdfjs gives us coordinates where y is the baseline, and we need to account for height
          // The transform matrix from pdfjs gives us coordinates in PDF space (Y=0 at bottom)
          // Position icon at the top-right of the text
          const textY = matchingPos.y; // Baseline Y position from pdfjs (PDF coordinates, Y=0 at bottom)
          const textHeight = matchingPos.h || 12; // Height of the text
          // Position icon slightly above the text baseline
          commentY = Math.max(Math.min(textY + textHeight + 3, pageHeight - 20), 20);
          
          console.log(`📍 Positioning comment ${idx + 1} at (${commentX.toFixed(1)}, ${commentY.toFixed(1)}) for text at (${matchingPos.x.toFixed(1)}, ${matchingPos.y.toFixed(1)})`);
        } else {
          // No match found, stack in right margin from top (PDF coordinates: top = high Y)
          commentY = pageHeight - 50 - (idx * 25);
        }
        
        if (commentY < 20 || commentY > pageHeight - 20) return; // Skip if out of bounds
        
        try {
          // Create a Text annotation (sticky note) using pdf-lib's proper API
          const annotationDict = PDFDict.withContext(pdfDoc.context);
          annotationDict.set(PDFName.of('Type'), PDFName.of('Annot'));
          annotationDict.set(PDFName.of('Subtype'), PDFName.of('Text'));
          
          // Rect: [left, bottom, right, top] in PDF coordinates
          const rectArray = PDFArray.withContext(pdfDoc.context);
          rectArray.push(PDFNumber.of(commentX));
          rectArray.push(PDFNumber.of(commentY - 15));
          rectArray.push(PDFNumber.of(commentX + 20));
          rectArray.push(PDFNumber.of(commentY + 5));
          annotationDict.set(PDFName.of('Rect'), rectArray);
          
          // Contents must be a PDFString
          annotationDict.set(PDFName.of('Contents'), PDFString.of(text));
          
          // Title (T) must be a PDFString
          const criterionName = text.split(':')[0] || `Feedback ${idx + 1}`;
          annotationDict.set(PDFName.of('T'), PDFString.of(criterionName));
          
          // Color (C) must be a PDFArray of numbers
          const colorArray = PDFArray.withContext(pdfDoc.context);
          colorArray.push(PDFNumber.of(1));   // Red
          colorArray.push(PDFNumber.of(0.8)); // Green
          colorArray.push(PDFNumber.of(0));   // Blue (yellow/orange color)
          annotationDict.set(PDFName.of('C'), colorArray);
          
          // Open state (boolean) - in PDF, booleans are represented as /true or /false (PDFName)
          // But some viewers expect actual boolean, so we'll omit it (defaults to closed)
          // annotationDict.set(PDFName.of('Open'), PDFName.of('false')); // Omit for compatibility
          
          // Add annotation to the page's annotation array
          annotsArray.push(annotationDict);
        } catch (error) {
          console.warn(`Failed to create annotation ${idx + 1}:`, error.message);
          console.warn('Error stack:', error.stack);
        }
      });
      
      console.log(`✅ Added ${Math.min(issuesToShow.length, 15)} PDF comment annotations to page ${i + 1}`);
    }
  }

  const outBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, outBytes);
  console.log(`✅ PDF annotation complete: ${outputPath}`);
  return outputPath;
}

// Build issues array from AI marking result
function buildIssuesFromMarking(markingResult) {
  // For each score feedback, extract short anchor phrases heuristically
  const issues = [];
  for (const s of markingResult.scores || []) {
    const note = `${s.criterion_name}: ${s.feedback}`;
    const anchorPhrases = [];
    // Heuristic: take up to 3 quoted or key phrases (split by ;, :, .)
    const parts = (s.feedback || '').split(/[.;:]/).map(p => p.trim()).filter(Boolean);
    for (const p of parts) {
      if (p.length >= 20 && p.length <= 140) anchorPhrases.push(p);
      if (anchorPhrases.length >= 3) break;
    }
    if (anchorPhrases.length === 0 && s.feedback) {
      const trimmed = s.feedback.slice(0, 140);
      anchorPhrases.push(trimmed);
    }
    issues.push({ anchorPhrases, note });
  }
  return issues;
}

module.exports = {
  annotatePdfWithIssues,
  buildIssuesFromMarking
};


