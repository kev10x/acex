import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CourseIntegrityRuleItem, integrityAPI, IntegrityPreset } from '../services/api';
import { SectionCard, btn } from './ui';
import { PRESET_LABELS } from '../utils/integrityText';

type RuleChoice = 'none' | Exclude<IntegrityPreset, 'custom'>;

function CourseRuleRow({ course, onSaved }: { course: CourseIntegrityRuleItem; onSaved: () => void }) {
  const currentPreset = course.policy?.settings.preset;
  const initialChoice: RuleChoice = !course.policy ? 'none' : (currentPreset === 'custom' ? 'exam' : (currentPreset as RuleChoice));
  const [choice, setChoice] = useState<RuleChoice>(initialChoice);
  const [required, setRequired] = useState(Boolean(course.policy?.required));
  const [applyExisting, setApplyExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setChoice(initialChoice);
    setRequired(Boolean(course.policy?.required));
    setApplyExisting(false);
  }, [course.policy, initialChoice]);

  const dirty = choice !== initialChoice || required !== Boolean(course.policy?.required) || applyExisting;

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await integrityAPI.saveCourseRule(course.id, {
        settings: choice === 'none' ? { enabled: false } : { enabled: true, preset: choice },
        required: choice !== 'none' && required,
        apply_to_existing: choice !== 'none' && applyExisting
      });
      const applied = res.data.applied_to_existing;
      setMessage(!res.data.policy
        ? 'Rule removed. Existing assessments keep their settings.'
        : `Saved.${applied ? ` Monitoring turned on for ${applied} existing assessment${applied === 1 ? '' : 's'}.` : ''}`);
      onSaved();
    } catch (e: any) {
      setMessage(e.response?.data?.error || 'Could not save this rule.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        <div className="font-medium text-gray-900">{course.name}</div>
        <div className="text-xs text-gray-500">
          {course.code ? `${course.code} · ` : ''}{course.assessment_count} published
          {course.unmonitored_count > 0 ? ` · ${course.unmonitored_count} not monitored` : ''}
        </div>
      </td>
      <td className="px-4 py-3">
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value as RuleChoice)}
          aria-label={`Monitoring rule for ${course.name}`}
          className="rounded-md border-gray-300 text-sm shadow-sm focus:border-primary-500 focus:ring-primary-500"
        >
          <option value="none">No rule</option>
          <option value="quiz">{PRESET_LABELS.quiz}</option>
          <option value="test">{PRESET_LABELS.test}</option>
          <option value="exam">{PRESET_LABELS.exam}</option>
        </select>
      </td>
      <td className="px-4 py-3 text-sm">
        <label className={`flex items-start gap-2 ${choice === 'none' ? 'opacity-50' : ''}`}>
          <input
            type="checkbox"
            checked={required}
            disabled={choice === 'none'}
            onChange={(e) => setRequired(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          />
          <span>
            Required
            <span className="block text-xs text-gray-500">Lecturers can change the preset but not switch monitoring off. Applies to existing assessments too.</span>
          </span>
        </label>
        {choice !== 'none' && !required && course.unmonitored_count > 0 && (
          <label className="mt-2 flex items-start gap-2">
            <input
              type="checkbox"
              checked={applyExisting}
              onChange={(e) => setApplyExisting(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
            />
            <span className="text-xs text-gray-700">Also turn it on for the {course.unmonitored_count} existing unmonitored assessment{course.unmonitored_count === 1 ? '' : 's'}</span>
          </label>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <button type="button" onClick={save} disabled={saving || !dirty} className={btn.secondary}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save
        </button>
        {message && <p role="status" className="mt-1 max-w-[16rem] text-left text-xs text-gray-600">{message}</p>}
      </td>
    </tr>
  );
}

/** Management: monitoring rules per course, applied when lecturers publish to the course. */
export default function CourseIntegrityRules({ onChanged }: { onChanged?: () => void }) {
  const [courses, setCourses] = useState<CourseIntegrityRuleItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await integrityAPI.listCourseRules();
      setCourses(res.data.courses);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not load course rules.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <SectionCard
      title="Course rules"
      description="Default monitoring for assessments published to each course in your organisation. Lecturers see the rule when they publish."
      bodyClassName="p-0"
    >
      {error && <p className="px-5 py-4 text-sm text-red-700">{error}</p>}
      {!courses && !error && <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-primary-600" /></div>}
      {courses && courses.length === 0 && <p className="px-5 py-6 text-sm text-gray-500">No courses in your organisation yet.</p>}
      {courses && courses.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                {['Course', 'Monitoring', 'Enforcement', ''].map((heading) => (
                  <th key={heading} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {courses.map((course) => (
                <CourseRuleRow key={course.id} course={course} onSaved={() => { void load(); onChanged?.(); }} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
