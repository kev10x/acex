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
  const raw = String(input || '');
  if (!raw.trim()) return '';

  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
    return escapeHtml(raw);
  }

  const parser = new window.DOMParser();
  const doc = parser.parseFromString(raw, 'text/html');

  const cleanNode = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
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

  cleanNode(doc.body);
  return doc.body.innerHTML.trim();
};

export const richHtmlToPlainText = (input: string): string => {
  const raw = String(input || '');
  if (!raw.trim()) return '';

  if (typeof window === 'undefined' || typeof window.DOMParser === 'undefined') {
    return normalizeWhitespace(raw.replace(/<[^>]+>/g, ' '));
  }

  const parser = new window.DOMParser();
  const doc = parser.parseFromString(raw, 'text/html');
  return normalizeWhitespace(doc.body.textContent || '');
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
