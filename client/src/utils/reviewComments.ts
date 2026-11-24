import type { ReviewComment } from '../services/api';

const NO_SECTION = 'Before the first heading';

/** "p. 14", or "Chapter 2 › 2.3 Method, p. 14" when the section is included. */
export function reviewCommentLocation(comment: ReviewComment, withSection = true): string {
  return [withSection ? comment.section : null, comment.page ? `p. ${comment.page}` : null].filter(Boolean).join(', ');
}

/** Comments grouped by section, in document order. */
export function groupReviewComments(comments: ReviewComment[]): { section: string; comments: ReviewComment[] }[] {
  const groups: { section: string; comments: ReviewComment[] }[] = [];
  for (const comment of comments) {
    const section = comment.section || NO_SECTION;
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.comments.push(comment);
    else groups.push({ section, comments: [comment] });
  }
  return groups;
}

/** Plain-text bullets for pasting into an email or feedback form. */
export function reviewCommentsAsText(comments: ReviewComment[], title?: string): string {
  const lines: string[] = [];
  if (title) lines.push(title, '');
  for (const group of groupReviewComments(comments)) {
    lines.push(group.section);
    for (const comment of group.comments) {
      const where = reviewCommentLocation(comment, false);
      const tag = comment.severity === 'major' ? ' [major]' : '';
      lines.push(`• ${comment.id}.${tag} ${comment.comment}${where ? ` (${where})` : ''}`);
      if (comment.quote) lines.push(`    “${comment.quote}”`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
