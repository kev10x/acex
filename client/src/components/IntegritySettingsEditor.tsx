import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { integrityAPI, IntegrityPreset, IntegritySaveImpact, IntegritySettings, IntegritySettingsInput } from '../services/api';
import { btn } from './ui';
import { PRESET_LABELS } from '../utils/integrityText';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Plain-language account of what a settings change means for students right now. */
export const describeSaveImpact = (impact: IntegritySaveImpact | undefined, monitored: boolean) => {
  if (!impact) return monitored ? 'Monitoring settings saved.' : 'Monitoring is off for this assessment.';
  const midAttempt = impact.in_progress_attempts;
  if (!impact.was_monitored && impact.now_monitored) {
    return 'Monitoring is on. Students who open the link now must sign in and opt in before they see questions. Anyone who already had it open will be asked to reload before they can submit.';
  }
  if (impact.was_monitored && impact.now_monitored) {
    return midAttempt > 0
      ? `Saved. ${plural(midAttempt, 'student is', 'students are')} mid-attempt: they keep the settings they started with until they reload the page, but network rules apply to them straight away. New attempts use the new settings.`
      : 'Saved. New attempts use these settings.';
  }
  if (impact.was_monitored && !impact.now_monitored) {
    return `Monitoring is off. Students now open the assessment without signing in or opting in.${midAttempt > 0 ? ` ${plural(midAttempt, 'student')} already mid-attempt can still finish and submit.` : ''}`;
  }
  return 'Saved. This assessment is not monitored.';
};

export type IntegrityPresetMap = Record<string, Omit<IntegritySettings, 'enabled' | 'preset' | 'allowed_ip_ranges'>>;

export default function IntegritySettingsEditor({
  publishedId,
  settings,
  presets,
  onSaved
}: {
  publishedId: number;
  settings: IntegritySettings | null;
  presets: Record<string, Omit<IntegritySettings, 'enabled' | 'preset' | 'allowed_ip_ranges'>>;
  onSaved: (settings: IntegritySettings | null) => void;
}) {
  const [draft, setDraft] = useState<IntegritySettingsInput>(settings ?? { enabled: false, preset: 'test' });
  const [ipText, setIpText] = useState((settings?.allowed_ip_ranges || []).join('\n'));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings ?? { enabled: false, preset: 'test' });
    setIpText((settings?.allowed_ip_ranges || []).join('\n'));
  }, [settings, publishedId]);

  // Keep the save confirmation when the saved settings come back; clear it for another assessment.
  useEffect(() => {
    setMessage(null);
  }, [publishedId]);

  const applyPreset = (preset: IntegrityPreset) => {
    setDraft((prev) => (preset === 'custom' ? { ...prev, preset } : { ...prev, ...(presets[preset] || {}), preset }));
  };
  const setOption = (patch: Partial<IntegritySettingsInput>) => setDraft((prev) => ({ ...prev, ...patch, preset: 'custom' }));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const allowed = ipText.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
      const res = await integrityAPI.updateSettings(publishedId, { ...draft, allowed_ip_ranges: allowed });
      onSaved(res.data.settings);
      setMessage(describeSaveImpact(res.data.impact, Boolean(res.data.settings)));
    } catch (e: any) {
      // A refused change (e.g. a course requires monitoring) leaves the saved settings in place.
      if (e.response?.status === 409) setDraft(settings ?? { enabled: false, preset: 'test' });
      setMessage(e.response?.data?.error || 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: 'require_fullscreen' | 'hide_questions_on_leave' | 'shuffle_questions', label: string, hint: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={Boolean(draft[key])}
        onChange={(e) => setOption({ [key]: e.target.checked })}
        disabled={!draft.enabled}
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
      />
      <span>
        <span className="font-medium text-gray-800">{label}</span>
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
    </label>
  );

  const choice = (key: 'copy_paste' | 'right_click' | 'screenshots', label: string, labels = { log: 'Allow and log', block: 'Block and log' }) => (
    <label className="block text-sm">
      <span className="font-medium text-gray-800">{label}</span>
      <select
        value={draft[key] || 'log'}
        onChange={(e) => setOption({ [key]: e.target.value as 'log' | 'block' })}
        disabled={!draft.enabled}
        className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm focus:border-primary-500 focus:ring-primary-500"
      >
        <option value="log">{labels.log}</option>
        <option value="block">{labels.block}</option>
      </select>
    </label>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
            className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          />
          Monitor this assessment
        </label>
        <label className="text-sm">
          <span className="mr-2 font-medium text-gray-800">Preset</span>
          <select
            value={draft.preset || 'test'}
            onChange={(e) => applyPreset(e.target.value as IntegrityPreset)}
            disabled={!draft.enabled}
            className="rounded-md border-gray-300 text-sm shadow-sm focus:border-primary-500 focus:ring-primary-500"
          >
            {(Object.keys(PRESET_LABELS) as IntegrityPreset[]).map((preset) => (
              <option key={preset} value={preset}>{PRESET_LABELS[preset]}</option>
            ))}
          </select>
        </label>
      </div>
      <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${draft.enabled ? '' : 'opacity-50'}`}>
        {toggle('require_fullscreen', 'Require full screen', 'Questions are hidden until the student returns to full screen.')}
        {toggle('hide_questions_on_leave', 'Hide questions when away', 'Questions disappear while the assessment is not the active window.')}
        {toggle('shuffle_questions', 'Shuffle question order', 'Each student gets the questions in a different order.')}
        {choice('copy_paste', 'Copy and paste')}
        {choice('right_click', 'Right-click')}
        {choice('screenshots', 'Screenshot keys', { log: 'Log only', block: 'Log, wipe clipboard and hide questions briefly' })}
        <label className="block text-sm">
          <span className="font-medium text-gray-800">Allowed networks (optional)</span>
          <textarea
            value={ipText}
            onChange={(e) => setIpText(e.target.value)}
            disabled={!draft.enabled}
            rows={2}
            placeholder="e.g. 196.21.0.0/16"
            className="mt-1 block w-full rounded-md border-gray-300 text-sm shadow-sm focus:border-primary-500 focus:ring-primary-500"
          />
          <span className="text-xs text-gray-500">For venue exams: students can only start from these IP ranges.</span>
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={saving} className={btn.primary}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save settings
        </button>
      </div>
      {message && (
        <p role="status" className="max-w-3xl rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 ring-1 ring-inset ring-gray-200">{message}</p>
      )}
    </div>
  );
}
