import React, { useEffect, useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';

/** Feedback text a lecturer can correct in place (the mark is unchanged). */
export default function EditableFeedback({
  text,
  label,
  edited,
  onSave
}: {
  text: string;
  label: string;
  edited?: boolean;
  onSave?: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setDraft(null); setError(null); }, [text]);

  const save = async () => {
    if (draft == null || !onSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setDraft(null);
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not save the feedback.');
    } finally {
      setSaving(false);
    }
  };

  if (draft != null) {
    return (
      <div className="space-y-1.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(12, Math.max(3, draft.split('\n').length + 1))}
          aria-label={`Feedback for ${label}`}
          className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-primary-500 focus:ring-primary-500"
        />
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => setDraft(null)} disabled={saving} className="rounded px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-1 rounded bg-primary-600 px-3 py-1 text-xs font-semibold text-white hover:bg-primary-700 disabled:opacity-50">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
          </button>
        </div>
        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="group">
      <p className="text-sm text-gray-700 whitespace-pre-wrap break-words leading-relaxed">{text || <span className="italic text-gray-400">No feedback.</span>}</p>
      {(onSave || edited) && (
        <div className="mt-1 flex items-center gap-3 text-xs">
          {onSave && (
            <button type="button" onClick={() => setDraft(text)} className="inline-flex items-center gap-1 text-gray-500 hover:text-primary-700" aria-label={`Edit feedback for ${label}`}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          )}
          {edited && <span className="italic text-gray-400">Edited</span>}
        </div>
      )}
    </div>
  );
}
