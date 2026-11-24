import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Loader2, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ReviewComment } from '../services/api';
import { groupReviewComments, reviewCommentLocation, reviewCommentsAsText } from '../utils/reviewComments';

const CATEGORIES = ['argument', 'structure', 'literature', 'methodology', 'analysis', 'evidence', 'referencing', 'language', 'formatting'];

type Draft = Omit<ReviewComment, 'id'> & { id: number | null; key: string };

let draftKey = 0;
const toDraft = (comment: ReviewComment): Draft => ({ ...comment, key: `c${draftKey++}` });

/**
 * Margin-style comments on a treatise, thesis or dissertation: short points, each tied to the
 * section, page and words where the change should be made (like comments in Word). With onSave,
 * the lecturer can edit, delete and add comments.
 */
export default function ReviewCommentsPanel({
  comments,
  title,
  onSave
}: {
  comments: ReviewComment[];
  title?: string;
  onSave?: (comments: Partial<ReviewComment>[]) => Promise<void>;
}) {
  const [majorOnly, setMajorOnly] = useState(false);
  const [copied, setCopied] = useState(false);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leave edit mode when another result's comments arrive.
  useEffect(() => { setDrafts(null); setError(null); }, [comments]);

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

  const update = (key: string, patch: Partial<Draft>) =>
    setDrafts((prev) => prev && prev.map((d) => (d.key === key ? { ...d, ...patch, edited: true } : d)));

  const addComment = () => setDrafts((prev) => [...(prev || []), {
    id: null, key: `c${draftKey++}`, section: prev?.[prev.length - 1]?.section ?? null, page: null, quote: null,
    comment: '', category: 'argument', severity: 'minor', criterion: null, edited: true
  }]);

  const save = async () => {
    if (!drafts || !onSave) return;
    if (drafts.some((d) => !d.comment.trim())) {
      setError('Every comment needs some text (delete the ones you do not want).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(drafts.map(({ key, ...rest }) => rest as Partial<ReviewComment>));
      setDrafts(null);
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not save the comments.');
    } finally {
      setSaving(false);
    }
  };

  const input = 'w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-primary-500 focus:ring-primary-500';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <MessageSquare className="h-4 w-4 text-amber-600" />
          Detailed comments ({comments.length}{majorCount ? `, ${majorCount} major` : ''})
        </h4>
        {!drafts && (
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-gray-600">
              <input type="checkbox" checked={majorOnly} onChange={(e) => setMajorOnly(e.target.checked)} className="h-3.5 w-3.5 rounded border-gray-300 text-primary-600" />
              Major only
            </label>
            <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-50">
              <Copy className="h-3.5 w-3.5" />
              {copied ? 'Copied' : 'Copy as list'}
            </button>
            {onSave && (
              <button type="button" onClick={() => setDrafts(comments.map(toDraft))} className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-50">
                <Pencil className="h-3.5 w-3.5" />
                Edit comments
              </button>
            )}
          </div>
        )}
      </div>

      {drafts ? (
        <div className="space-y-2">
          <p className="text-xs text-gray-500">
            Edit, delete or add comments. Saving also updates the commented Word document and annotated PDF.
            The quote is the exact text in the document the comment is attached to.
          </p>
          {drafts.map((d, index) => (
            <div key={d.key} className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[11px] font-bold text-white">{index + 1}</span>
                <button type="button" onClick={() => setDrafts((prev) => prev && prev.filter((x) => x.key !== d.key))} className="inline-flex items-center gap-1 text-xs text-red-700 hover:underline" aria-label={`Delete comment ${index + 1}`}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
              <textarea
                value={d.comment}
                onChange={(e) => update(d.key, { comment: e.target.value })}
                rows={2}
                placeholder="What should be changed"
                aria-label={`Comment ${index + 1}`}
                className={input}
              />
              <input value={d.quote ?? ''} onChange={(e) => update(d.key, { quote: e.target.value || null })} placeholder="Exact words in the document (optional)" aria-label={`Quote for comment ${index + 1}`} className={`${input} italic`} />
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <input value={d.section ?? ''} onChange={(e) => update(d.key, { section: e.target.value || null })} placeholder="Section" aria-label={`Section for comment ${index + 1}`} className={`${input} col-span-2`} />
                <input value={d.page ?? ''} onChange={(e) => update(d.key, { page: e.target.value ? Number(e.target.value) : null })} type="number" min={1} placeholder="Page" aria-label={`Page for comment ${index + 1}`} className={input} />
                <select value={d.severity} onChange={(e) => update(d.key, { severity: e.target.value as Draft['severity'] })} aria-label={`Severity of comment ${index + 1}`} className={input}>
                  <option value="minor">Minor</option>
                  <option value="major">Major</option>
                </select>
              </div>
              <select value={d.category} onChange={(e) => update(d.key, { category: e.target.value })} aria-label={`Category of comment ${index + 1}`} className={`${input} capitalize sm:w-48`}>
                {CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={addComment} className="inline-flex items-center gap-1 rounded border border-gray-300 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
              <Plus className="h-3.5 w-3.5" /> Add comment
            </button>
            <span className="flex-1" />
            <button type="button" onClick={() => { setDrafts(null); setError(null); }} disabled={saving} className="rounded px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100">Cancel</button>
            <button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-1 rounded bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700 disabled:opacity-50">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save comments
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        </div>
      ) : (
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
                        {c.edited && <span className="italic">· edited</span>}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groups.length === 0 && <p className="text-sm text-gray-500">{comments.length ? 'No major comments.' : 'No comments.'}</p>}
        </div>
      )}
    </div>
  );
}
