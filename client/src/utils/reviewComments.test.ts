import { groupReviewComments, reviewCommentLocation, reviewCommentsAsText } from './reviewComments';
import type { ReviewComment } from '../services/api';

const comment = (id: number, section: string | null, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id, section, quote: null, comment: `Comment ${id}`, category: 'argument', severity: 'minor', criterion: null, ...extra
});

describe('review comments', () => {
  it('groups consecutive comments by section in document order', () => {
    const groups = groupReviewComments([comment(1, null), comment(2, 'Chapter 1'), comment(3, 'Chapter 1'), comment(4, 'Chapter 2')]);
    expect(groups.map((g) => [g.section, g.comments.length])).toEqual([['Before the first heading', 1], ['Chapter 1', 2], ['Chapter 2', 1]]);
  });

  it('gives the location with section and page', () => {
    expect(reviewCommentLocation(comment(1, 'Chapter 2 › 2.3 Method', { page: 14 }))).toBe('Chapter 2 › 2.3 Method, p. 14');
    expect(reviewCommentLocation(comment(1, 'Chapter 2', { page: 14 }), false)).toBe('p. 14');
  });

  it('copies as bullets with the quoted text', () => {
    const text = reviewCommentsAsText([comment(1, 'Chapter 1', { severity: 'major', page: 3, quote: 'the exact words' })], 'Thesis comments');
    expect(text).toBe('Thesis comments\n\nChapter 1\n• 1. [major] Comment 1 (p. 3)\n    “the exact words”');
  });
});
