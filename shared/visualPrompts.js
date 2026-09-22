// Single source of truth for classifying a section visual and building its default
// prompt text. Consumed by both the server (contentService.js, via require) and the
// client (ContentGenerator.tsx, via import) so the "auto" prompt shown in the editor
// always matches what the backend uses when repairing/normalizing legacy content.
// Kept as plain CommonJS (no ESM `export`) so Node's require() and the client bundler
// can both load it without a build step.

function inferVisualKind(visual) {
  const rawKind = String(visual?.kind || '').trim().toLowerCase();
  if (['illustration', 'diagram', 'flowchart', 'graph', 'graphs', 'chart'].includes(rawKind)) {
    return 'illustration';
  }
  const combinedText = [visual?.title, visual?.alt_text, visual?.prompt]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\b(illustration|diagram|flowchart|graph|graphs|chart|concept map|mind map|process map)\b/.test(combinedText)) {
    return 'illustration';
  }
  return 'image';
}

function buildVisualPromptFromContext(visual, section = {}) {
  const kind = inferVisualKind(visual);
  const parts = [
    section?.heading || section?.title ? `Section: ${String(section.heading || section.title).trim()}.` : '',
    visual?.title ? `Visual title: ${String(visual.title).trim()}.` : '',
    visual?.alt_text ? `Description: ${String(visual.alt_text).trim()}.` : '',
    section?.support ? `Key idea: ${String(section.support).trim()}.` : '',
    section?.body ? `Lesson context: ${String(section.body).replace(/\s+/g, ' ').slice(0, 280)}.` : '',
    kind === 'illustration'
      ? 'Create a clean educational diagram or infographic for this concept, with no in-image text, labels, or numbers.'
      : 'Create a clean educational supporting image for this concept, with no in-image text or overlays.',
  ].filter(Boolean);
  return parts.join(' ').trim().slice(0, 360);
}

module.exports = { inferVisualKind, buildVisualPromptFromContext };
