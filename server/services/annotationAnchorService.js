/**
 * Where marking notes go in a document: sentences from the whole document that best match each
 * criterion's feedback, and the PDF notes built from them. Shared by marking and by re-building
 * the annotated PDF after a lecturer edits the feedback.
 */

const { buildIssuesFromMarking } = require('./pdfAnnotator');

const ANCHOR_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'because', 'before', 'between', 'could', 'does',
  'doing', 'during', 'each', 'from', 'have', 'having', 'into', 'more', 'most', 'other',
  'over', 'should', 'some', 'such', 'than', 'that', 'their', 'there', 'these', 'they',
  'this', 'those', 'through', 'under', 'very', 'what', 'when', 'where', 'which', 'while',
  'with', 'would', 'your', 'student', 'criterion', 'feedback'
]);

const chunkArray = (items, chunkSize) => {
  const result = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
};

const extractAnchorKeywords = (...values) => {
  const seen = new Set();
  const keywords = [];

  values
    .map((value) => String(value || '').toLowerCase())
    .join(' ')
    .match(/[a-z0-9]{4,}/g)
    ?.forEach((word) => {
      if (seen.has(word) || ANCHOR_STOP_WORDS.has(word)) return;
      seen.add(word);
      keywords.push(word);
    });

  return keywords.slice(0, 12);
};

const getDocumentAnchorCandidates = (documentText) => {
  const rawSegments = String(documentText || '')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;:])\s+/))
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment.length >= 20 && segment.length <= 160);

  const unique = [];
  const seen = new Set();
  for (const segment of rawSegments) {
    const normalized = segment.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(segment);
    if (unique.length >= 20000) break;
  }

  return unique;
};

// Sentences from anywhere in the document that best match a criterion's feedback.
const rankAnchorCandidates = (candidates, score, limit) => {
  const keywords = extractAnchorKeywords(score.criterion_name, score.feedback);
  if (keywords.length === 0) return [];
  const criterionName = String(score.criterion_name || '').toLowerCase();
  return candidates
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const keywordHits = keywords.reduce((sum, keyword) => sum + (lower.includes(keyword) ? 1 : 0), 0);
      const phraseBoost = criterionName && lower.includes(criterionName) ? 1 : 0;
      return { candidate, scoreValue: keywordHits * 10 + phraseBoost - Math.abs(candidate.length - 90) / 40 };
    })
    .filter((item) => item.scoreValue > 0)
    .sort((a, b) => b.scoreValue - a.scoreValue)
    .slice(0, limit)
    .map((item) => item.candidate);
};

const buildHeuristicAnchorsMap = (documentText, markingResult, candidates = getDocumentAnchorCandidates(documentText)) => {
  const map = new Map();
  for (const score of markingResult?.scores || []) {
    const ranked = rankAnchorCandidates(candidates, score, 3);
    if (ranked.length > 0) map.set(score.criterion_name, ranked);
  }
  return map;
};

// Generate short anchor quotes from the document for each criterion to enable pinpoint annotations

function buildIssuesWithAnchors(markingResult, anchorsMap) {
  if (!(anchorsMap && anchorsMap.size)) {
    return buildIssuesFromMarking(markingResult);
  }
  const issues = [];
  for (const s of markingResult.scores || []) {
    const note = `${s.criterion_name}: ${s.feedback}`;
    const anchorPhrases = anchorsMap.get(s.criterion_name) || [];
    if (anchorPhrases.length === 0) {
      const fallback = buildIssuesFromMarking({ scores: [s] });
      issues.push(...fallback);
    } else {
      issues.push({ anchorPhrases, note });
    }
  }
  return issues;
}


module.exports = {
  chunkArray,
  extractAnchorKeywords,
  getDocumentAnchorCandidates,
  rankAnchorCandidates,
  buildHeuristicAnchorsMap,
  buildIssuesWithAnchors
};
