import type { MarkingResult } from '../services/api';

export type ReviewMode = 'all' | 'queue' | 'reviewed';

export function isReviewQueueCandidate(result: MarkingResult): boolean {
  return result.flagged_for_moderation === true
    || result.needs_review === true
    || result.has_low_criterion_confidence === true
    || result.review_status === 'queued';
}

export function isReviewedResult(result: MarkingResult): boolean {
  return result.review_status === 'reviewed'
    || (!!result.custom_feedback && result.custom_feedback.trim().length > 0)
    || result.override_total_score != null
    || (!!result.moderation_reason && result.moderation_reason.trim().length > 0 && !isReviewQueueCandidate(result));
}

export function getReviewPriority(result: MarkingResult): 'high' | 'medium' | 'low' | 'none' {
  if (result.flagged_for_moderation) return 'high';
  if (result.needs_review || result.has_low_criterion_confidence) return 'medium';
  if (isReviewedResult(result)) return 'low';
  return 'none';
}

export function summarizeReviewQueue(results: MarkingResult[]) {
  return results.reduce(
    (summary, result) => {
      if (isReviewQueueCandidate(result)) {
        summary.totalQueued += 1;
        if (result.flagged_for_moderation) summary.flagged += 1;
        if (result.needs_review) summary.aiSuggested += 1;
        if (result.has_low_criterion_confidence) summary.lowConfidence += 1;
      }
      if (isReviewedResult(result)) {
        summary.reviewed += 1;
      }
      return summary;
    },
    {
      totalQueued: 0,
      flagged: 0,
      aiSuggested: 0,
      lowConfidence: 0,
      reviewed: 0
    }
  );
}

export function filterResultsByReviewMode(results: MarkingResult[], mode: ReviewMode) {
  if (mode === 'queue') return results.filter(isReviewQueueCandidate);
  if (mode === 'reviewed') return results.filter(isReviewedResult);
  return results;
}
