import React, { useMemo, useState } from 'react';
import { Copy, MessageSquare } from 'lucide-react';
import type { ReviewComment } from '../services/api';
import { groupReviewComments, reviewCommentLocation, reviewCommentsAsText } from '../utils/reviewComments';

/**
 * Margin-style comments on a treatise, thesis or dissertation: short points, each tied to the
 * section, page and words where the change should be made (like comments in Word).
 */
export default function ReviewCommentsPanel({ comments, title }: { comments: ReviewComment[]; title?: string }) {
  const [majorOnly, setMajorOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const shown = useMemo(() => (majorOnly ? comments.filter((c) => c.severity === 'major') : comments), [comments, majorOnly]);
  const groups = useMemo(() => groupReviewComments(shown), [shown]);
  const majorCount = comments.filter((c) => c.severity === 'major').length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reviewCommentsAsText(shown, title));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <MessageSquare className="h-4 w-4 text-amber-600" />
          Detailed comments ({comments.length}{majorCount ? `, ${majorCount} major` : ''})
        </h4>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-gray-600">
            <input type="checkbox" checked={majorOnly} onChange={(e) => setMajorOnly(e.target.checked)} className="h-3.5 w-3.5 rounded border-gray-300 text-primary-600" />
            Major only
          </label>
          <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-50">
            <Copy className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy as list'}
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {groups.map((group) => (
          <section key={group.section}>
            <h5 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{group.section}</h5>
            <ul className="space-y-2">
              {group.comments.map((c) => (
                <li key={c.id} className="flex gap-3 rounded-md border border-amber-200 bg-amber-50/60 p-2.5">
                  <span className="mt-0.5 inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-bold text-white">
                    {c.id}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    {c.quote && (
                      <p className="break-words border-l-2 border-amber-400 bg-amber-100/70 px-2 py-0.5 text-xs italic text-gray-700">“{c.quote}”</p>
                    )}
                    <p className="break-words text-sm text-gray-900">{c.comment}</p>
                    <p className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
                      {reviewCommentLocation(c, false) && <span>{reviewCommentLocation(c, false)}</span>}
                      {c.severity === 'major' && <span className="font-semibold text-red-700">Major</span>}
                      <span className="capitalize">{c.category}</span>
                      {c.criterion && <span>· {c.criterion}</span>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="text-sm text-gray-500">No major comments.</p>}
      </div>
    </div>
  );
}
