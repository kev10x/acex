/**
 * Detailed review comments for long research documents (treatise, thesis, dissertation).
 *
 * The rubric marking gives one block of feedback per criterion. Examiners of long documents
 * also expect margin comments: short points tied to the exact place a change is needed, the way
 * comments in Word look. This reviews the document part by part, asks for short comments that
 * quote the text they refer to, then locates each quote in the document to give its section
 * (and, for PDFs, its page, filled in later by the PDF annotator).
 */

const aiConfig = require('../config/ai-config');
const aiService = require('./aiService');
const { parseAiJsonResponse } = require('./markingService');

const RESEARCH_TYPES = new Set(['treatise', 'thesis', 'dissertation']);
const CATEGORIES = ['argument', 'structure', 'literature', 'methodology', 'analysis', 'evidence', 'referencing', 'language', 'formatting'];

const MAX_PARTS = 16;
const MIN_PART_CHARS = 30000;
const MAX_COMMENTS = 150;
const CONCURRENCY = 3;

const isResearchDocument = (documentType) => RESEARCH_TYPES.has(String(documentType || '').trim().toLowerCase());

const COMMON_HEADINGS = /^(abstract|acknowledg(e)?ments?|declaration|dedication|table of contents|contents|list of (tables|figures|abbreviations)|introduction|background|literature review|theoretical framework|conceptual framework|research design|methodology|research methodology|methods|findings|results|analysis|discussion|conclusions?|recommendations|limitations|references|bibliography|appendi(x|ces))\b/i;

/** Heading-like lines with their character offsets, used to say which section a comment is in. */
const findHeadings = (text) => {
  const headings = [];
  let offset = 0;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    const start = offset;
    offset += rawLine.length + 1;
    if (line.length < 3 || line.length > 110 || /[.,;:]$/.test(line)) continue;
    const words = line.split(/\s+/).length;
    const numbered = /^(\d+(\.\d+){0,3})\.?\s+\S/.test(line) && words <= 14 && /[A-Za-z]/.test(line);
    const labelled = /^(chapter|section|part|appendix)\s+([0-9]+|[ivxlc]+|[a-z])\b/i.test(line);
    const common = COMMON_HEADINGS.test(line) && words <= 8;
    const capitals = words <= 10 && /[A-Z]/.test(line) && line === line.toUpperCase() && /[A-Z]{3}/.test(line);
    if (numbered || labelled || common || capitals) headings.push({ offset: start, title: line.replace(/\s+/g, ' ') });
  }
  return headings;
};

/** "Chapter 2 › 2.3 Theoretical framework": the chapter-level heading and the nearest one. */
const sectionAt = (headings, position) => {
  let nearest = null;
  let chapter = null;
  for (const heading of headings) {
    if (heading.offset > position) break;
    nearest = heading;
    if (/^(chapter|part)\b/i.test(heading.title) || /^\d+\.?\s/.test(heading.title) || COMMON_HEADINGS.test(heading.title)) chapter = heading;
  }
  if (!nearest) return null;
  if (chapter && chapter !== nearest) return `${chapter.title} › ${nearest.title}`;
  return nearest.title;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Offset of a quote in the text, tolerant of line breaks, spacing, case and typographic quotes. */
const locateQuote = (text, quote) => {
  const tokens = String(quote || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return -1;
  const pattern = (list) => list
    .map((token) => escapeRegExp(token).replace(/['‘’]/g, "['‘’]").replace(/["“”]/g, '["“”]').replace(/[-–—]/g, '[-–—]'))
    .join('\\s+');
  for (const list of [tokens.slice(0, 14), tokens.slice(0, 6), tokens.slice(-6)]) {
    if (list.length < 3) continue;
    const match = new RegExp(pattern(list), 'i').exec(text);
    if (match) return match.index;
  }
  return -1;
};

/** Split into at most MAX_PARTS parts on paragraph boundaries, keeping each part's offset. */
const splitIntoParts = (text) => {
  const source = String(text || '');
  const target = Math.max(MIN_PART_CHARS, Math.ceil(source.length / MAX_PARTS));
  const parts = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + target);
    if (end < source.length) {
      const paragraphBreak = source.lastIndexOf('\n\n', end);
      const lineBreak = source.lastIndexOf('\n', end);
      if (paragraphBreak > start + target * 0.6) end = paragraphBreak;
      else if (lineBreak > start + target * 0.6) end = lineBreak;
    }
    parts.push({ offset: start, text: source.slice(start, end) });
    start = end;
  }
  // Breaking at paragraphs can leave a little over; fold it into the last part.
  while (parts.length > MAX_PARTS) {
    const last = parts.pop();
    parts[parts.length - 1].text += last.text;
  }
  return parts;
};

const buildPrompt = ({ part, index, total, documentLabel, criteria, sectionHint }) => `You are an external examiner writing margin comments on part ${index + 1} of ${total} of a ${documentLabel}, the way comments look in Microsoft Word.
${sectionHint ? `This part starts in: ${sectionHint}\n` : ''}
Write short, specific comments on what the candidate should change in THIS part only:
- Each comment is one short bullet (at most 30 words), saying what is wrong and what to change (e.g. "Define 'resilience' before using it as a construct.", "Cite a source for this claim.", "Move this to the methodology chapter.").
- Each comment quotes the exact words it refers to: 5 to 20 consecutive words copied verbatim from the text below.
- Cover argument and coherence, structure, use of literature, methodology, analysis, evidence for claims, referencing and citation style, academic language, and formatting (headings, tables, figures, numbering).
- Only comment where a change is needed. Do not praise or summarise. Do not repeat the same point; if a problem recurs, comment on its first occurrence and say it recurs.
- Give between 4 and 15 comments, depending on how many real problems there are.
${criteria.length ? `- Where it fits, name the rubric criterion the comment relates to, using one of: ${criteria.map((name) => `"${name}"`).join(', ')}.\n` : ''}
Return ONLY this JSON:
{"comments":[{"quote":"exact words from the text","comment":"short bullet","category":"${CATEGORIES.join('|')}","severity":"major|minor","criterion":"rubric criterion name or empty"}]}

TEXT (part ${index + 1} of ${total}):
${part.text}`;

const runWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const current = next++;
      results[current] = await worker(items[current], current);
    }
  });
  await Promise.all(runners);
  return results;
};

const cleanText = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Review a long research document. Returns { comments, parts_reviewed, parts_failed }, where each
 * comment is { id, section, quote, comment, category, severity, criterion, position }.
 */
const generateReviewComments = async ({ text, documentType, rubric, provider = null, complete = null }) => {
  const source = String(text || '');
  if (!source.trim()) return { comments: [], parts_reviewed: 0, parts_failed: 0 };

  const criteria = (Array.isArray(rubric?.criteria) ? rubric.criteria : [])
    .map((criterion) => cleanText(criterion?.name, 80))
    .filter(Boolean);
  const documentLabel = String(documentType || '').toLowerCase() === 'thesis' ? 'thesis' : 'treatise or dissertation';
  const headings = findHeadings(source);
  const parts = splitIntoParts(source);
  const config = aiConfig.getTaskConfig('detailedReview', provider);
  const callModel = complete || ((prompt) => aiService.createCompletionWithRetry({
    provider: config.provider,
    model: config.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: config.temperature,
    maxTokens: config.maxTokens
  }, 2));

  let failed = 0;
  const perPart = await runWithConcurrency(parts, CONCURRENCY, async (part, index) => {
    try {
      const response = await callModel(buildPrompt({
        part,
        index,
        total: parts.length,
        documentLabel,
        criteria,
        sectionHint: sectionAt(headings, part.offset)
      }));
      const parsed = parseAiJsonResponse(response?.content ?? response).parsed;
      return (Array.isArray(parsed?.comments) ? parsed.comments : []).map((item) => ({ item, part }));
    } catch (error) {
      failed += 1;
      console.warn(`Detailed review of part ${index + 1}/${parts.length} failed (non-fatal):`, error.message);
      return [];
    }
  });

  const seen = new Set();
  const comments = [];
  for (const { item, part } of perPart.flat()) {
    const comment = cleanText(item?.comment, 400);
    if (!comment) continue;
    const quote = cleanText(item?.quote, 240);
    const inPart = quote ? locateQuote(part.text, quote) : -1;
    const position = inPart >= 0 ? part.offset + inPart : (quote ? locateQuote(source, quote) : -1);
    const key = `${comment.toLowerCase()}|${position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const category = String(item?.category || '').toLowerCase();
    const criterion = cleanText(item?.criterion, 80);
    comments.push({
      section: sectionAt(headings, position >= 0 ? position : part.offset),
      quote: position >= 0 ? quote : null,
      comment,
      category: CATEGORIES.includes(category) ? category : 'argument',
      severity: String(item?.severity || '').toLowerCase() === 'major' ? 'major' : 'minor',
      criterion: criteria.find((name) => name.toLowerCase() === criterion.toLowerCase()) || null,
      position: position >= 0 ? position : part.offset
    });
  }

  comments.sort((a, b) => a.position - b.position);
  return {
    comments: comments.slice(0, MAX_COMMENTS).map((comment, index) => ({ id: index + 1, ...comment })),
    parts_reviewed: parts.length - failed,
    parts_failed: failed
  };
};

/** Add review comments to a marking result for research documents; never fails the marking. */
const attachReviewComments = async ({ markingResult, text, documentType, rubric, provider = null }) => {
  const type = documentType || markingResult?.document_type;
  if (!markingResult || !isResearchDocument(type)) return markingResult;
  try {
    const review = await generateReviewComments({ text, documentType: type, rubric, provider });
    markingResult.review_comments = review.comments;
    if (review.parts_failed) markingResult.review_comments_note = `${review.parts_failed} of ${review.parts_reviewed + review.parts_failed} parts could not be reviewed in detail.`;
  } catch (error) {
    console.warn('Detailed review comments failed (non-fatal):', error.message);
  }
  return markingResult;
};

/** One-line reference for a comment: "Chapter 2 › 2.3 Method, p. 14". */
const commentLocation = (comment) => [comment?.section, comment?.page ? `p. ${comment.page}` : null].filter(Boolean).join(', ');

module.exports = {
  isResearchDocument,
  generateReviewComments,
  attachReviewComments,
  commentLocation,
  findHeadings,
  sectionAt,
  locateQuote,
  splitIntoParts
};
