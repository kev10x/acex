const ALLOWED_TAGS = new Set([
  'P',
  'BR',
  'UL',
  'OL',
  'LI',
  'STRONG',
  'B',
  'EM',
  'I',
  'U',
  'H2',
  'H3',
  'H4',
  'BLOCKQUOTE',
  'CODE',
  'PRE',
  'A',
]);

const normalizeWhitespace = (value: string) => value.replace(/\r\n/g, '\n').trim();

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const sanitizeRichTextHtml = (input: string): string => {
  try {
    const raw = String(input || '');
    if (!raw.trim()) return '';

    if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
      return escapeHtml(raw);
    }

    const parser = new window.DOMParser();
    const doc = parser.parseFromString(raw, 'text/html');
    const root = doc?.body || doc?.documentElement;
    if (!root) {
      return escapeHtml(raw);
    }

    const cleanNode = (node: Node) => {
      if (node.nodeType === 1) {
        const el = node as HTMLElement;
        const tag = el.tagName.toUpperCase();

        if (!ALLOWED_TAGS.has(tag)) {
          const parent = el.parentNode;
          if (parent) {
            while (el.firstChild) {
              parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
          }
          return;
        }

        Array.from(el.attributes).forEach((attr) => {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
            el.removeAttribute(attr.name);
            return;
          }
          if (tag === 'A' && name === 'href') {
            const href = attr.value.trim();
            const isSafe = /^(https?:|mailto:)/i.test(href);
            if (!isSafe) {
              el.removeAttribute('href');
            } else {
              el.setAttribute('target', '_blank');
              el.setAttribute('rel', 'noopener noreferrer');
            }
            return;
          }
          if (tag !== 'A' && name !== 'class') {
            el.removeAttribute(attr.name);
          }
        });
      }

      Array.from(node.childNodes).forEach((child) => cleanNode(child));
    };

    cleanNode(root);
    if ('innerHTML' in root) {
      return String((root as HTMLElement).innerHTML || '').trim();
    }
    return escapeHtml(raw);
  } catch (_) {
    return escapeHtml(String(input || ''));
  }
};

export const richHtmlToPlainText = (input: string): string => {
  try {
    const raw = String(input || '');
    if (!raw.trim()) return '';

    if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
      return normalizeWhitespace(raw.replace(/<[^>]+>/g, ' '));
    }

    const parser = new window.DOMParser();
    const doc = parser.parseFromString(raw, 'text/html');
    const root = doc?.body || doc?.documentElement;
    if (!root) {
      return normalizeWhitespace(raw.replace(/<[^>]+>/g, ' '));
    }
    return normalizeWhitespace(root.textContent || '');
  } catch (_) {
    return normalizeWhitespace(String(input || '').replace(/<[^>]+>/g, ' '));
  }
};

export const plainTextToRichHtml = (input: string): string => {
  const text = normalizeWhitespace(String(input || ''));
  if (!text) return '';

  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
};

export const getSectionBodyHtml = (section: { body?: string; body_html?: string } | null | undefined): string => {
  const rich = String(section?.body_html || '').trim();
  if (rich) return sanitizeRichTextHtml(rich);
  return plainTextToRichHtml(String(section?.body || ''));
};

export type ContextualBlockLayout = 'auto' | 'plain' | 'science' | 'history' | 'language' | 'business';

const sentenceSplit = (text: string) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const unique = (items: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  items.forEach((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
};

const asListItems = (items: string[], max = 6) =>
  unique(items.map((s) => s.trim()).filter(Boolean)).slice(0, max);

const extractNumberedChecklist = (text: string) => {
  const matches = Array.from(String(text || '').matchAll(/(?:^|[\s])(\d\)\s*[^.]+(?:\.)?)/gim)).map((m) =>
    String(m[1] || '').replace(/^\d\)\s*/, '').trim()
  );
  return asListItems(matches, 6);
};

const renderHeading = (title: string) => `<h3>${escapeHtml(title)}</h3>`;
const renderParagraph = (value: string) => `<p>${escapeHtml(value)}</p>`;
const renderList = (items: string[]) =>
  `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;

export const inferContextualBlockLayout = (section: {
  heading?: string;
  title?: string;
  support?: string;
  body?: string;
  body_html?: string;
}): Exclude<ContextualBlockLayout, 'auto'> => {
  const heading = String(section?.heading || section?.title || '').toLowerCase();
  const body = richHtmlToPlainText(String(section?.body_html || '')) || String(section?.body || '');
  const text = `${heading}\n${body}`.toLowerCase();

  const scienceScore = (text.match(/\b(mole|formula|equation|calculate|mass|molar|concentration|rate|reaction|atom|gas|units?)\b/g) || []).length;
  const historyScore = (text.match(/\b(history|historian|timeline|century|colonial|kingdom|war|migration|cause|effect|evidence)\b/g) || []).length
    + (text.match(/\b(1[5-9]\d{2}|20\d{2})\b/g) || []).length;
  const languageScore = (text.match(/\b(grammar|tense|noun|verb|sentence|paragraph|punctuation|spelling|language|essay)\b/g) || []).length;
  const businessScore = (text.match(/\b(market|demand|supply|cost|revenue|profit|business|finance|strategy|consumer|economy)\b/g) || []).length;

  const scored: Array<{ mode: Exclude<ContextualBlockLayout, 'auto'>; score: number }> = [
    { mode: 'science', score: scienceScore },
    { mode: 'history', score: historyScore },
    { mode: 'language', score: languageScore },
    { mode: 'business', score: businessScore },
  ];
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].mode : 'plain';
};

export const buildContextualSectionBodyHtml = (
  section: {
    heading?: string;
    title?: string;
    support?: string;
    body?: string;
    body_html?: string;
  },
  mode: ContextualBlockLayout = 'auto'
): string => {
  const chosenMode = mode === 'auto' ? inferContextualBlockLayout(section) : mode;
  const fallbackHtml = getSectionBodyHtml(section);
  if (chosenMode === 'plain') return fallbackHtml;

  const bodyText =
    richHtmlToPlainText(String(section?.body_html || '')) ||
    String(section?.body || '').trim();
  if (!bodyText) return fallbackHtml;

  const support = String(section?.support || '').trim();
  const sentences = sentenceSplit(bodyText);
  const paragraphs = String(bodyText)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const facts = asListItems(
    sentences.filter((s) =>
      /(=|formula|ratio|unit|convert|standard|definition|law|principle|therefore)/i.test(s) ||
      /\b\d+(\.\d+)?\b/.test(s)
    ),
    7
  );
  const examples = asListItems(
    [
      ...sentences.filter((s) => /\b(example|for instance|for example)\b/i.test(s)),
      ...paragraphs.filter((p) => /\b(example\s*\d+|\d+\.)/i.test(p)),
    ],
    5
  );
  const checklist = extractNumberedChecklist(bodyText);
  const pitfalls = asListItems(
    sentences.filter((s) => /\b(pitfall|common error|avoid|mistake)\b/i.test(s)),
    5
  );
  const timeline = asListItems(
    sentences.filter((s) => /\b(1[5-9]\d{2}|20\d{2})\b/.test(s)),
    6
  );

  const intro = paragraphs[0] || sentences[0] || '';
  const detail = paragraphs.slice(1, 3).join(' ');

  const blocks: string[] = [];

  if (support) {
    blocks.push(renderHeading('Key Point'));
    blocks.push(renderParagraph(support));
  }

  if (chosenMode === 'science') {
    blocks.push(renderHeading('Lesson Goal'));
    blocks.push(renderParagraph(intro));
    if (facts.length) {
      blocks.push(renderHeading('Core Facts'));
      blocks.push(renderList(facts));
    }
    if (examples.length) {
      blocks.push(renderHeading('Worked Examples'));
      blocks.push(renderList(examples));
    }
    if (checklist.length) {
      blocks.push(renderHeading('Problem-Solving Checklist'));
      blocks.push(renderList(checklist));
    }
    if (pitfalls.length) {
      blocks.push(renderHeading('Common Pitfalls'));
      blocks.push(renderList(pitfalls));
    }
  } else if (chosenMode === 'history') {
    blocks.push(renderHeading('Historical Context'));
    blocks.push(renderParagraph(intro));
    if (timeline.length) {
      blocks.push(renderHeading('Timeline Anchors'));
      blocks.push(renderList(timeline));
    }
    if (facts.length) {
      blocks.push(renderHeading('Key Causes and Effects'));
      blocks.push(renderList(facts));
    }
    if (detail) {
      blocks.push(renderHeading('Evidence and Interpretation'));
      blocks.push(renderParagraph(detail));
    }
  } else if (chosenMode === 'language') {
    blocks.push(renderHeading('Concept Focus'));
    blocks.push(renderParagraph(intro));
    if (facts.length) {
      blocks.push(renderHeading('Rules and Structures'));
      blocks.push(renderList(facts));
    }
    if (examples.length) {
      blocks.push(renderHeading('Examples'));
      blocks.push(renderList(examples));
    }
    if (pitfalls.length) {
      blocks.push(renderHeading('Common Mistakes'));
      blocks.push(renderList(pitfalls));
    }
  } else if (chosenMode === 'business') {
    blocks.push(renderHeading('Core Idea'));
    blocks.push(renderParagraph(intro));
    if (facts.length) {
      blocks.push(renderHeading('Framework and Drivers'));
      blocks.push(renderList(facts));
    }
    if (examples.length) {
      blocks.push(renderHeading('Applied Example'));
      blocks.push(renderList(examples));
    }
    if (detail) {
      blocks.push(renderHeading('Interpretation'));
      blocks.push(renderParagraph(detail));
    }
  }

  if (!blocks.length) return fallbackHtml;
  return sanitizeRichTextHtml(blocks.join(''));
};
