/**
 * What changed between two revisions of a document, compared sentence by sentence.
 *
 * Comparing by line does not work for submitted documents: in Word documents a "line" is a whole
 * paragraph (one changed word marks it all as changed), and in PDFs the line breaks move whenever
 * text is added, so nearly every line differs and the comparison is lost. Both texts are therefore
 * reflowed into sentences (and short heading lines) before diffing.
 */

const { diffArrays } = require('diff');

const ABBREVIATIONS = /\b(e\.g|i\.e|et al|cf|vs|viz|etc|dr|prof|mr|mrs|ms|no|nos|pp|p|fig|figs|vol|ed|eds|eq|ch|sec|approx|st|jr|sr)\.$/i;
const PAGE_NUMBER_LINE = /^\s*(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?\s*$/i;

const COMMON_HEADINGS = /^(abstract|acknowledg(e)?ments?|declaration|table of contents|contents|introduction|background|literature review|theoretical framework|conceptual framework|research design|methodology|research methodology|methods|findings|results|analysis|discussion|conclusions?|recommendations|limitations|references|bibliography|appendi(x|ces))\b/i;

// A heading on its own line (kept as its own unit). Wrapped PDF lines are not, so they reflow.
const isHeading = (line) => {
  if (line.length > 90 || /[.,;:!?]$/.test(line)) return false;
  const words = line.split(' ');
  if (words.length > 12) return false;
  if (/^(\d+(\.\d+){0,3}\.?|chapter|section|part|appendix)\s/i.test(line)) return true;
  if (COMMON_HEADINGS.test(line) && words.length <= 8) return true;
  if (/[A-Z]{3}/.test(line) && line === line.toUpperCase()) return true;
  const significant = words.filter((word) => word.length > 3);
  return significant.length > 0 && words.length <= 10 && significant.every((word) => /^[A-Z(“"']/.test(word));
};

const MAX_BLOCKS = 60;
const MAX_UNIT_CHARS = 600;
const MAX_PROMPT_CHARS = 40000;

/** Split a paragraph into sentences without breaking at "e.g." or "et al.". */
const splitSentences = (paragraph) => {
  const sentences = [];
  let start = 0;
  const boundary = /[.!?]["'”’)\]]*\s+(?=["'“‘(\[]?[A-Z0-9])/g;
  let match;
  while ((match = boundary.exec(paragraph)) !== null) {
    const end = match.index + match[0].trimEnd().length;
    const candidate = paragraph.slice(start, end).trim();
    if (ABBREVIATIONS.test(candidate) || /\b[A-Z]\.$/.test(candidate)) continue;
    if (candidate) sentences.push(candidate);
    start = match.index + match[0].length;
  }
  const rest = paragraph.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
};

/** Text as comparable units: sentences, plus short heading-like lines kept on their own. */
const toUnits = (text) => {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim());

  const units = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) units.push(...splitSentences(paragraph.join(' ')));
    paragraph = [];
  };
  for (const line of lines) {
    if (!line) { flush(); continue; }
    if (PAGE_NUMBER_LINE.test(line)) continue;
    if (isHeading(line)) {
      flush();
      units.push(line);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return units;
};

const clip = (value) => (value.length > MAX_UNIT_CHARS ? `${value.slice(0, MAX_UNIT_CHARS)}…` : value);

/**
 * Compare two revisions. Returns:
 *  - stats: { added, removed, unchanged, change_density } in sentences;
 *  - blocks: up to MAX_BLOCKS change blocks { before_context, removed[], added[], after_context };
 *  - prompt_text: the blocks as +/- text for the AI (null when identical);
 *  - mode: 'identical' | 'diff' | 'rewrite'.
 */
const diffRevisions = (prevText, currText, contextUnits = 1) => {
  const prev = toUnits(prevText);
  const curr = toUnits(currText);
  const parts = diffArrays(prev, curr);

  const flat = [];
  for (const part of parts) {
    const type = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
    for (const value of part.value) flat.push({ type, value });
  }
  const added = flat.filter((u) => u.type === 'added').length;
  const removed = flat.filter((u) => u.type === 'removed').length;
  const unchanged = flat.length - added - removed;
  const changeDensity = flat.length ? Math.round(((added + removed) / flat.length) * 100) : 0;
  const stats = { added, removed, unchanged, change_density: changeDensity };

  if (added + removed === 0) return { stats, blocks: [], prompt_text: null, mode: 'identical' };

  const blocks = [];
  let index = 0;
  while (index < flat.length && blocks.length < MAX_BLOCKS) {
    if (flat[index].type === 'unchanged') { index++; continue; }
    const block = { before_context: [], removed: [], added: [], after_context: [] };
    for (let back = Math.max(0, index - contextUnits); back < index; back++) {
      if (flat[back].type === 'unchanged') block.before_context.push(clip(flat[back].value));
    }
    // A block runs until `contextUnits * 2 + 1` unchanged units in a row, so nearby edits stay together.
    let quiet = 0;
    let end = index;
    while (end < flat.length && quiet <= contextUnits * 2) {
      if (flat[end].type === 'unchanged') quiet++;
      else {
        quiet = 0;
        block[flat[end].type].push(clip(flat[end].value));
      }
      end++;
    }
    let lastChange = end - 1;
    while (lastChange > index && flat[lastChange].type === 'unchanged') lastChange--;
    for (let forward = lastChange + 1; forward < Math.min(flat.length, lastChange + 1 + contextUnits); forward++) {
      if (flat[forward].type === 'unchanged') block.after_context.push(clip(flat[forward].value));
    }
    blocks.push(block);
    index = lastChange + 1;
  }
  const truncated = index < flat.length && flat.slice(index).some((u) => u.type !== 'unchanged');

  let promptText = blocks.map((block, i) => [
    `--- Change ${i + 1} ---`,
    ...block.before_context.map((v) => `  ${v}`),
    ...block.removed.map((v) => `- ${v}`),
    ...block.added.map((v) => `+ ${v}`),
    ...block.after_context.map((v) => `  ${v}`)
  ].join('\n')).join('\n\n');
  if (promptText.length > MAX_PROMPT_CHARS) promptText = `${promptText.slice(0, MAX_PROMPT_CHARS)}\n\n...[further changes truncated]`;
  else if (truncated) promptText += '\n\n...[further changes not shown]';

  return { stats, blocks, truncated, prompt_text: promptText, mode: changeDensity > 70 ? 'rewrite' : 'diff' };
};

module.exports = { diffRevisions, toUnits, splitSentences };
