import { filterResultsByReviewMode, getReviewPriority, summarizeReviewQueue } from './resultsReview';
import type { MarkingResult } from '../services/api';

const baseResult: MarkingResult = {
  id: 1,
  assignment_id: 1,
  rubric_id: 1,
  scores: [],
  feedback: '',
  total_score: 10,
  marked_at: new Date().toISOString()
};

test('summarizes queue and reviewed results correctly', () => {
  const results: MarkingResult[] = [
    { ...baseResult, id: 1, flagged_for_moderation: true },
    { ...baseResult, id: 2, needs_review: true, has_low_criterion_confidence: true },
    { ...baseResult, id: 3, custom_feedback: 'Reviewed by lecturer', review_status: 'reviewed' },
  ];

  expect(summarizeReviewQueue(results)).toEqual({
    totalQueued: 2,
    flagged: 1,
    aiSuggested: 1,
    lowConfidence: 1,
    reviewed: 1
  });
  expect(filterResultsByReviewMode(results, 'queue')).toHaveLength(2);
  expect(filterResultsByReviewMode(results, 'reviewed')).toHaveLength(1);
  expect(getReviewPriority(results[0])).toBe('high');
  expect(getReviewPriority(results[1])).toBe('medium');
  expect(getReviewPriority(results[2])).toBe('low');
});
