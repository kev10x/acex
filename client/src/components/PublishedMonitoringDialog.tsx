import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, ShieldCheck, X } from 'lucide-react';
import { integrityAPI, IntegritySettings } from '../services/api';
import IntegritySettingsEditor, { IntegrityPresetMap } from './IntegritySettingsEditor';
import { btn } from './ui';

export const studentTakeLink = (code: string) => `${window.location.origin}/tools/take-assessment?code=${encodeURIComponent(code)}`;

/** Open the student view of a published assessment in preview mode (nothing is recorded). */
export const openStudentPreview = (code: string) => {
  window.open(`${studentTakeLink(code)}&preview=1`, '_blank', 'noopener,noreferrer');
};

/**
 * Monitoring settings for one published link, opened from the published assessments list,
 * so the settings always apply to the link students actually use.
 */
export default function PublishedMonitoringDialog({
  item,
  onClose,
  onSaved
}: {
  item: { id: number; code: string; title: string; integrity_settings?: IntegritySettings | null };
  onClose: () => void;
  onSaved: (settings: IntegritySettings | null) => void;
}) {
  const [presets, setPresets] = useState<IntegrityPresetMap>({});
  const [settings, setSettings] = useState<IntegritySettings | null>(item.integrity_settings ?? null);

  useEffect(() => {
    integrityAPI.getPresets().then((res) => setPresets(res.data.presets || {})).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="monitoring-dialog-title"
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 id="monitoring-dialog-title" className="flex items-center gap-2 text-base font-semibold text-gray-900">
              <ShieldCheck className="h-5 w-5 text-violet-600" />
              Monitoring: {item.title || item.code}
            </h2>
            <p className="mt-1 break-all text-xs text-gray-500">
              Applies to the student link <span className="font-mono text-gray-700">{studentTakeLink(item.code)}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <IntegritySettingsEditor
            publishedId={item.id}
            settings={settings}
            presets={presets}
            onSaved={(saved) => {
              setSettings(saved);
              onSaved(saved);
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4">
            <p className="text-xs text-gray-500">
              Reports for this link are under <span className="font-medium text-gray-700">Exam Integrity</span> in the marking workspace.
            </p>
            <button type="button" onClick={() => openStudentPreview(item.code)} className={btn.secondary}>
              <Eye className="h-4 w-4" />
              Preview as student
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
