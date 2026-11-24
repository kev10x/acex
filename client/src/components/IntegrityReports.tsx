import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Download, Eye, Loader2, RotateCcw, ShieldCheck, X } from 'lucide-react';
import {
  integrityAPI,
  IntegrityAttempt,
  IntegrityEvent,
  IntegritySettings,
  IntegrityStatus,
  MonitoredAssessmentItem
} from '../services/api';
import { EmptyState, PageHeader, SectionCard, btn } from './ui';
import IntegritySettingsEditor from './IntegritySettingsEditor';
import CourseIntegrityRules from './CourseIntegrityRules';
import WebcamPolicyPanel from './WebcamPolicyPanel';
import AttemptWebcamMedia from './AttemptWebcamMedia';
import { useAuth } from '../contexts/AuthContext';
import { openStudentPreview } from './PublishedMonitoringDialog';
import { PRESET_LABELS, describeEvent } from '../utils/integrityText';


const STATUS_STYLES: Record<IntegrityStatus, { label: string; className: string }> = {
  clean: { label: 'Clean', className: 'bg-green-50 text-green-700 ring-green-200' },
  review_suggested: { label: 'Review suggested', className: 'bg-amber-50 text-amber-800 ring-amber-200' },
  review_needed: { label: 'Review needed', className: 'bg-rose-50 text-rose-700 ring-rose-200' }
};

const ATTEMPT_STATUS_LABELS: Record<IntegrityAttempt['status'], string> = {
  in_progress: 'In progress',
  submitted: 'Submitted',
  exited: 'Exited without submitting'
};


const formatTime = (value: string | number | null | undefined) => (value ? new Date(value).toLocaleString() : '—');


function StatusBadge({ status }: { status: IntegrityStatus }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.clean;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${style.className}`}>
      {status === 'clean' ? <CheckCircle2 className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {style.label}
    </span>
  );
}

function AttemptDetail({ attemptId, onClose, onChanged }: { attemptId: number; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<{ attempt: IntegrityAttempt; events: IntegrityEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [reopening, setReopening] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await integrityAPI.getAttempt(attemptId);
      setData({ attempt: res.data.attempt, events: res.data.events });
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not load this attempt.');
    }
  }, [attemptId]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const reopen = async () => {
    setReopening(true);
    try {
      await integrityAPI.reopenAttempt(attemptId);
      await load();
      onChanged();
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not reopen this attempt.');
    } finally {
      setReopening(false);
    }
  };

  const events = (data?.events || []).filter((event) => showAll || event.severity !== 'info' || ['attempt_started', 'submitted', 'exited', 'reopened'].includes(event.type));
  const hiddenCount = (data?.events.length || 0) - events.length;

  // Portal to <body>: the workspace container would otherwise offset a fixed-position drawer.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-gray-900/40" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between border-b border-gray-100 bg-white px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-gray-900">{data?.attempt.student_name || 'Attempt'}</h3>
            {data && <p className="text-xs text-gray-500">{data.attempt.student_email}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        {error && <div className="m-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {!data && !error && <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-primary-600" /></div>}
        {data && (
          <div className="space-y-5 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={data.attempt.integrity_status} />
              <span className="text-xs text-gray-500">Score {data.attempt.integrity_score}</span>
              <span className="text-xs text-gray-500">· {ATTEMPT_STATUS_LABELS[data.attempt.status]}</span>
              {data.attempt.status === 'exited' && (
                <button type="button" onClick={reopen} disabled={reopening} className={`${btn.secondary} ml-auto`}>
                  {reopening ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  Reopen for this student
                </button>
              )}
            </div>
            <div>
              <h4 className="mb-1.5 text-sm font-semibold text-gray-900">Summary</h4>
              {data.attempt.summary?.reasons?.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                  {data.attempt.summary.reasons.map((reason) => <li key={reason.code}>{reason.text}</li>)}
                </ul>
              ) : (
                <p className="text-sm text-gray-600">Nothing unusual was recorded.</p>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-gray-500">Started</dt><dd className="text-gray-800">{formatTime(data.attempt.started_at)}</dd>
              <dt className="text-gray-500">Ended</dt><dd className="text-gray-800">{formatTime(data.attempt.ended_at)}</dd>
              <dt className="text-gray-500">Submission</dt><dd className="text-gray-800">{data.attempt.submission_code || '—'}</dd>
              <dt className="text-gray-500">IP addresses</dt>
              <dd className="text-gray-800">{data.attempt.ip_addresses.map((entry) => entry.ip).join(', ') || '—'}</dd>
              <dt className="text-gray-500">Browser</dt><dd className="break-words text-xs text-gray-600">{data.attempt.user_agent || '—'}</dd>
            </dl>
            {(data.attempt.media_count || 0) > 0 && (
              <AttemptWebcamMedia attemptId={data.attempt.id} count={data.attempt.media_count || 0} onDeleted={() => { void load(); onChanged(); }} />
            )}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h4 className="text-sm font-semibold text-gray-900">Timeline</h4>
                <label className="flex items-center gap-1.5 text-xs text-gray-600">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="h-3.5 w-3.5 rounded border-gray-300" />
                  Show minor events{hiddenCount > 0 && !showAll ? ` (${hiddenCount})` : ''}
                </label>
              </div>
              <ol className="space-y-1.5">
                {events.map((event) => (
                  <li key={event.id} className="flex gap-3 text-sm">
                    <span className="w-20 shrink-0 text-xs tabular-nums text-gray-400">
                      {new Date(event.client_time || event.created_at).toLocaleTimeString()}
                    </span>
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${event.severity === 'flag' ? 'bg-rose-500' : event.severity === 'notice' ? 'bg-amber-400' : 'bg-gray-300'}`} />
                    <span className={event.severity === 'info' ? 'text-gray-500' : 'text-gray-800'}>{describeEvent(event)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

const IntegrityReports: React.FC = () => {
  const { user } = useAuth();
  const isManagement = user?.role === 'management' || user?.role === 'admin';
  const [items, setItems] = useState<MonitoredAssessmentItem[]>([]);
  const [presets, setPresets] = useState<Record<string, any>>({});
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [report, setReport] = useState<{ settings: IntegritySettings | null; attempts: IntegrityAttempt[]; title: string; code: string } | null>(null);
  const [filter, setFilter] = useState<'all' | IntegrityStatus | 'in_progress'>('all');
  const [openAttemptId, setOpenAttemptId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await integrityAPI.listMonitored();
      setItems(res.data.items);
      setPresets(res.data.presets || {});
      setSelectedId((current) => current ?? res.data.items.find((item) => item.settings)?.id ?? res.data.items[0]?.id ?? null);
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not load assessments.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadReport = useCallback(async (id: number) => {
    try {
      const res = await integrityAPI.getReport(id);
      setReport({ settings: res.data.settings, attempts: res.data.attempts, title: res.data.assessment.title, code: res.data.assessment.code });
    } catch (e: any) {
      setError(e.response?.data?.error || 'Could not load the report.');
    }
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    setReport(null);
    if (selectedId) void loadReport(selectedId);
  }, [selectedId, loadReport]);

  const filtered = useMemo(() => (report?.attempts || []).filter((attempt) => {
    if (filter === 'all') return true;
    if (filter === 'in_progress') return attempt.status === 'in_progress';
    return attempt.integrity_status === filter;
  }), [report, filter]);

  const exportCsv = async () => {
    if (!selectedId) return;
    const res = await integrityAPI.exportCsv(selectedId);
    const url = URL.createObjectURL(res.data as Blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `integrity-${report?.code || selectedId}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const counts = (status: IntegrityStatus | 'in_progress') => (report?.attempts || []).filter((attempt) => (
    status === 'in_progress' ? attempt.status === 'in_progress' : attempt.integrity_status === status
  )).length;

  if (loading) {
    return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-primary-600" /></div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Exam integrity"
        description="Monitor published assessments and review what happened during each student's attempt."
        icon={ShieldCheck}
      />
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {items.length === 0 ? (
        <SectionCard>
          <EmptyState
            icon={ShieldCheck}
            title="No published assessments yet"
            description="Publish an assessment from the Assessment Generator, then turn on monitoring here or when publishing."
          />
        </SectionCard>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-medium text-gray-700" htmlFor="integrity-assessment">Assessment</label>
            <select
              id="integrity-assessment"
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              className="min-w-0 max-w-full flex-1 rounded-md border-gray-300 text-sm shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:max-w-md"
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · code {item.code} · {new Date(item.created_at).toLocaleDateString()}{item.owner_name ? ` — ${item.owner_name}` : ''}{item.settings ? ` · ${PRESET_LABELS[item.settings.preset]}` : ' · not monitored'}
                  {item.attempts.review_needed ? ` · ${item.attempts.review_needed} need review` : ''}
                </option>
              ))}
            </select>
          </div>

          {selectedId && (
            <SectionCard
              title="Monitoring settings"
              description={report?.settings ? `${PRESET_LABELS[report.settings.preset]} · changes apply to attempts started after saving` : 'This assessment is not monitored.'}
              actions={report ? (
                <button type="button" onClick={() => openStudentPreview(report.code)} className={btn.secondary}>
                  <Eye className="h-4 w-4" />
                  Preview as student
                </button>
              ) : undefined}
            >
              {report && (
                <p className="mb-4 text-xs text-gray-500 break-all">
                  These settings apply to the student link{' '}
                  <span className="font-mono text-gray-700">{`${window.location.origin}${window.location.pathname.replace(/\/[^/]*$/, '')}/take-assessment?code=${report.code}`}</span>.
                  Check it matches the link your students use: each published copy has its own code.
                </p>
              )}
              <IntegritySettingsEditor
                publishedId={selectedId}
                settings={report?.settings ?? null}
                presets={presets}
                onSaved={(settings) => {
                  setReport((prev) => (prev ? { ...prev, settings } : prev));
                  void loadList();
                }}
              />
            </SectionCard>
          )}

          <SectionCard
            title={report ? `Attempts — ${report.title}` : 'Attempts'}
            description="Sorted with the attempts most worth reviewing first."
            actions={
              <button type="button" onClick={exportCsv} disabled={!report?.attempts.length} className={btn.secondary}>
                <Download className="h-4 w-4" />
                Export CSV
              </button>
            }
            bodyClassName="p-0"
          >
            <div className="flex flex-wrap gap-2 border-b border-gray-100 px-5 py-3">
              {([
                ['all', `All (${report?.attempts.length || 0})`],
                ['review_needed', `Review needed (${counts('review_needed')})`],
                ['review_suggested', `Review suggested (${counts('review_suggested')})`],
                ['clean', `Clean (${counts('clean')})`],
                ['in_progress', `In progress (${counts('in_progress')})`]
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${filter === value ? 'bg-primary-50 text-primary-700 ring-primary-200' : 'text-gray-600 ring-gray-200 hover:bg-gray-50'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {!report ? (
              <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-primary-600" /></div>
            ) : filtered.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-gray-500">No attempts to show.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      {['Student', 'Integrity', 'What was recorded', 'Attempt', 'Network'].map((heading) => (
                        <th key={heading} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">{heading}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filtered.map((attempt) => (
                      <tr key={attempt.id} onClick={() => setOpenAttemptId(attempt.id)} className="cursor-pointer align-top hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{attempt.student_name}</div>
                          <div className="text-xs text-gray-500">{attempt.student_email}</div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3"><StatusBadge status={attempt.integrity_status} /></td>
                        <td className="px-4 py-3 text-gray-700">
                          {attempt.summary?.reasons?.length
                            ? attempt.summary.reasons.slice(0, 2).map((reason) => <div key={reason.code}>{reason.text}</div>)
                            : <span className="text-gray-400">Nothing unusual</span>}
                          {(attempt.summary?.reasons?.length || 0) > 2 && (
                            <div className="text-xs text-primary-600">+{(attempt.summary?.reasons?.length || 0) - 2} more</div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-600">
                          <div className="text-sm text-gray-800">{ATTEMPT_STATUS_LABELS[attempt.status]}</div>
                          {formatTime(attempt.started_at)}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600">
                          {attempt.ip_addresses.map((entry) => <div key={entry.ip}>{entry.ip}</div>)}
                          {attempt.shared_ip_with && attempt.shared_ip_with.length > 0 && (
                            <div className="mt-0.5 text-gray-400" title={attempt.shared_ip_with.join(', ')}>
                              Same IP as {attempt.shared_ip_with.length} other{attempt.shared_ip_with.length === 1 ? '' : 's'}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}

      {isManagement && <WebcamPolicyPanel />}

      {isManagement && (
        <CourseIntegrityRules
          onChanged={() => {
            void loadList();
            if (selectedId) void loadReport(selectedId);
          }}
        />
      )}

      {openAttemptId && (
        <AttemptDetail
          attemptId={openAttemptId}
          onClose={() => setOpenAttemptId(null)}
          onChanged={() => { if (selectedId) void loadReport(selectedId); }}
        />
      )}
    </div>
  );
};

export default IntegrityReports;
