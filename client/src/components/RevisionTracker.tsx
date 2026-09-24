import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  TrendingUp,
  Upload,
  X,
  XCircle
} from 'lucide-react';
import {
  revisionsApi,
  type RevisionComparison,
  type RevisionSeriesListItem,
  type RevisionSubmission,
  type RevisionSeries
} from '../services/api';
import api from '../services/api';
import { getApiErrorMessage } from '../services/api';

interface Rubric {
  id: number;
  name: string;
  total_points: number;
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

function ProgressBar({ score, baseline }: { score: number; baseline?: number }) {
  const color =
    score >= 75 ? 'bg-emerald-500' :
    score >= 50 ? 'bg-amber-500' :
    score >= 25 ? 'bg-orange-500' : 'bg-red-500';

  return (
    <div className="relative w-full">
      <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
        <div
          className={`h-3 rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
        {baseline !== undefined && baseline > 0 && (
          <div
            className="absolute top-0 h-3 w-0.5 bg-gray-500 opacity-60"
            style={{ left: `${Math.min(100, baseline)}%` }}
            title={`Baseline: ${baseline}%`}
          />
        )}
      </div>
      <span className="text-xs font-semibold text-gray-700 mt-0.5 block text-right">
        {score.toFixed(1)}%
      </span>
    </div>
  );
}

// ─── Score Table ──────────────────────────────────────────────────────────────

function ScoreTable({ scores, totalScore, totalPoints }: {
  scores: RevisionSubmission['scores'];
  totalScore: number;
  totalPoints: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-50 text-gray-600 uppercase text-xs tracking-wide">
            <th className="text-left px-3 py-2 font-medium border-b">Criterion</th>
            <th className="text-center px-3 py-2 font-medium border-b w-24">Score</th>
            <th className="text-left px-3 py-2 font-medium border-b">Feedback</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s, i) => (
            <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
              <td className="px-3 py-2 font-medium text-gray-800 align-top">{s.criterion_name}</td>
              <td className="px-3 py-2 text-center align-top whitespace-nowrap">
                <span className="font-semibold">{s.points_awarded}</span>
                <span className="text-gray-400">/{s.max_points}</span>
              </td>
              <td className="px-3 py-2 text-gray-600 align-top">{s.feedback}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-gray-50 font-semibold">
            <td className="px-3 py-2">Total</td>
            <td className="px-3 py-2 text-center">
              {totalScore}/{totalPoints}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Comparison Panel ─────────────────────────────────────────────────────────

function ComparisonPanel({ comparison }: { comparison: RevisionComparison }) {
  return (
    <div className="space-y-4">
      {comparison.narrative_summary && (
        <p className="text-sm text-gray-700 bg-primary-50 border border-primary-100 rounded-lg px-4 py-3 leading-relaxed">
          {comparison.narrative_summary}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {comparison.improved_criteria.length > 0 && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
              <span className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Improved</span>
            </div>
            <ul className="space-y-2">
              {comparison.improved_criteria.map((c, i) => (
                <li key={i} className="text-xs text-emerald-800">
                  <span className="font-semibold">{c.criterion}:</span> {c.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        {comparison.unchanged_criteria.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide">Still Needs Work</span>
            </div>
            <ul className="space-y-2">
              {comparison.unchanged_criteria.map((c, i) => (
                <li key={i} className="text-xs text-amber-800">
                  <span className="font-semibold">{c.criterion}:</span> {c.detail}
                </li>
              ))}
            </ul>
          </div>
        )}

        {comparison.regressed_criteria.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
              <span className="text-xs font-semibold text-red-700 uppercase tracking-wide">Regressed</span>
            </div>
            <ul className="space-y-2">
              {comparison.regressed_criteria.map((c, i) => (
                <li key={i} className="text-xs text-red-800">
                  <span className="font-semibold">{c.criterion}:</span> {c.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {(comparison.key_improvement || comparison.key_remaining_issue) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-1">
          {comparison.key_improvement && (
            <div className="flex gap-2 items-start text-sm text-gray-700">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
              <div><span className="font-semibold">Top improvement:</span> {comparison.key_improvement}</div>
            </div>
          )}
          {comparison.key_remaining_issue && (
            <div className="flex gap-2 items-start text-sm text-gray-700">
              <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
              <div><span className="font-semibold">Focus area:</span> {comparison.key_remaining_issue}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Revision Card ────────────────────────────────────────────────────────────

function RevisionCard({
  revision,
  totalPoints,
  baseline,
  isExpanded,
  onToggle
}: {
  revision: RevisionSubmission;
  totalPoints: number;
  baseline?: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'scores' | 'feedback' | 'comparison'>('scores');

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50 text-left transition-colors"
      >
        <span className="flex-shrink-0 w-7 h-7 rounded-full bg-primary-100 text-primary-700 font-bold text-sm flex items-center justify-center">
          {revision.revision_number}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">
              Revision {revision.revision_number}
            </span>
            <span className="text-xs text-gray-400">
              {new Date(revision.uploaded_at).toLocaleDateString()}
            </span>
            {revision.revision_number === 1 && (
              <span className="text-xs bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">baseline</span>
            )}
          </div>
          <div className="mt-1 w-48">
            <ProgressBar score={revision.progress_score} baseline={revision.revision_number > 1 ? baseline : undefined} />
          </div>
        </div>
        <div className="text-right flex-shrink-0 mr-2">
          <span className="text-sm font-semibold text-gray-700">{revision.total_score}/{totalPoints}</span>
        </div>
        {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
      </button>

      {isExpanded && (
        <div className="border-t border-gray-200">
          <div className="flex border-b border-gray-200 bg-gray-50">
            {(['scores', 'feedback', ...(revision.comparison ? ['comparison'] : [])] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab as typeof activeTab)}
                className={`px-4 py-2 text-xs font-semibold capitalize transition-colors ${
                  activeTab === tab
                    ? 'border-b-2 border-primary-600 text-primary-700 bg-white'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab === 'comparison' ? 'Vs. Previous' : tab}
              </button>
            ))}
          </div>
          <div className="p-4 bg-white">
            {activeTab === 'scores' && (
              <ScoreTable scores={revision.scores} totalScore={revision.total_score} totalPoints={totalPoints} />
            )}
            {activeTab === 'feedback' && (
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                {revision.overall_feedback || 'No feedback available.'}
              </p>
            )}
            {activeTab === 'comparison' && revision.comparison && (
              <ComparisonPanel comparison={revision.comparison} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Series Detail View ───────────────────────────────────────────────────────

function SeriesDetail({
  series,
  onUpload,
  onBack,
  uploading,
  uploadError,
  readOnly
}: {
  series: RevisionSeries & { revisions: RevisionSubmission[] };
  onUpload: (file: File) => void;
  onBack: () => void;
  uploading: boolean;
  uploadError: string | null;
  readOnly: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [expandedRevisions, setExpandedRevisions] = useState<Set<number>>(new Set());

  const toggleRevision = (revNum: number) => {
    setExpandedRevisions(prev => {
      const next = new Set(prev);
      if (next.has(revNum)) next.delete(revNum);
      else next.add(revNum);
      return next;
    });
  };

  const baseline = series.revisions[0]?.progress_score;
  const latest = series.revisions[series.revisions.length - 1]?.progress_score ?? 0;
  const delta = series.revisions.length > 1 ? latest - (baseline ?? 0) : null;

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) onUpload(file);
  }, [onUpload]);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <button onClick={onBack} className="text-gray-400 hover:text-gray-600 mt-0.5">
          <ChevronRight className="w-5 h-5 rotate-180" />
        </button>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900">{series.name}</h2>
          <p className="text-sm text-gray-500">{series.student_name} · {series.rubric_name}</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-gray-900">{latest.toFixed(1)}%</div>
          {delta !== null && (
            <div className={`text-sm font-semibold ${delta >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
              {delta >= 0 ? '+' : ''}{delta.toFixed(1)}% since v1
            </div>
          )}
        </div>
      </div>

      {/* Overall progress bar */}
      <ProgressBar score={latest} baseline={baseline} />

      {/* Upload drop zone — staff only */}
      {!readOnly && (
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
          className="border-2 border-dashed border-gray-300 rounded-xl p-5 text-center hover:border-primary-400 transition-colors cursor-pointer"
          onClick={() => fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.doc,.docx,.txt"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }}
          />
          {uploading ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="w-7 h-7 text-primary-500 animate-spin" />
              <p className="text-sm text-gray-500">Marking revision… this may take a moment</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Upload className="w-7 h-7 text-gray-400" />
              <p className="text-sm font-medium text-gray-600">Drop a new revision here or click to browse</p>
              <p className="text-xs text-gray-400">PDF, DOCX, DOC, TXT</p>
            </div>
          )}
        </div>
      )}

      {uploadError && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {uploadError}
        </div>
      )}

      {/* Revision timeline */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
          Revisions ({series.revisions.length})
        </h3>
        {series.revisions.length === 0 ? (
          <p className="text-sm text-gray-400">No revisions yet. Upload the first document above.</p>
        ) : (
          [...series.revisions].reverse().map(rev => (
            <RevisionCard
              key={rev.id}
              revision={rev}
              totalPoints={series.total_points}
              baseline={baseline}
              isExpanded={expandedRevisions.has(rev.revision_number)}
              onToggle={() => toggleRevision(rev.revision_number)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Create Series Modal ──────────────────────────────────────────────────────

function CreateSeriesModal({
  rubrics,
  onClose,
  onCreate
}: {
  rubrics: Rubric[];
  onClose: () => void;
  onCreate: (name: string, studentName: string, rubricId: number) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [studentName, setStudentName] = useState('');
  const [rubricId, setRubricId] = useState(rubrics[0]?.id ?? 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !studentName.trim() || !rubricId) return;
    setSaving(true);
    setError('');
    try {
      await onCreate(name.trim(), studentName.trim(), rubricId);
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-semibold text-gray-900">New Revision Series</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Series Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Research Proposal – Draft 1"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Student Name</label>
            <input
              value={studentName}
              onChange={e => setStudentName(e.target.value)}
              placeholder="e.g. Jane Smith"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Rubric</label>
            <select
              value={rubricId}
              onChange={e => setRubricId(parseInt(e.target.value))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              required
            >
              {rubrics.map(r => (
                <option key={r.id} value={r.id}>{r.name} ({r.total_points} pts)</option>
              ))}
            </select>
          </div>
          {error && (
            <p className="text-sm text-red-600 flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </p>
          )}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 border border-gray-300 text-gray-700 rounded-lg py-2 text-sm font-medium hover:bg-gray-50">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim() || !studentName.trim() || !rubricId}
              className="flex-1 bg-primary-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm transition-colors"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Student Folder List ──────────────────────────────────────────────────────

function StudentFolderList({
  byStudent,
  selectedSeriesId,
  onSelectSeries
}: {
  byStudent: Record<string, RevisionSeriesListItem[]>;
  selectedSeriesId: number | null;
  onSelectSeries: (id: number) => void;
}) {
  const [expandedStudents, setExpandedStudents] = useState<Set<string>>(new Set(Object.keys(byStudent)));

  useEffect(() => {
    setExpandedStudents(prev => {
      const next = new Set(prev);
      Object.keys(byStudent).forEach(k => next.add(k));
      return next;
    });
  }, [byStudent]);

  const toggleStudent = (name: string) => {
    setExpandedStudents(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  if (Object.keys(byStudent).length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-gray-400 gap-2">
        <FolderOpen className="w-10 h-10" />
        <p className="text-sm">No series yet. Create one to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {Object.entries(byStudent).map(([student, seriesList]) => (
        <div key={student}>
          <button
            onClick={() => toggleStudent(student)}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-gray-100 text-left transition-colors"
          >
            {expandedStudents.has(student)
              ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
              : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
            <FolderOpen className="w-4 h-4 text-amber-500 flex-shrink-0" />
            <span className="text-sm font-semibold text-gray-800 truncate flex-1">{student}</span>
            <span className="text-xs text-gray-400 flex-shrink-0">{seriesList.length}</span>
          </button>

          {expandedStudents.has(student) && (
            <div className="ml-7 space-y-0.5 mb-1">
              {seriesList.map(s => (
                <button
                  key={s.id}
                  onClick={() => onSelectSeries(s.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${
                    selectedSeriesId === s.id
                      ? 'bg-primary-50 text-primary-700 font-semibold'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <TrendingUp className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
                  <span className="truncate flex-1">{s.name}</span>
                  <span className={`text-xs font-semibold flex-shrink-0 ${
                    s.latest_progress >= 75 ? 'text-emerald-600' :
                    s.latest_progress >= 50 ? 'text-amber-600' : 'text-gray-400'
                  }`}>
                    {s.latest_progress > 0 ? `${s.latest_progress.toFixed(0)}%` : '—'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RevisionTracker({ readOnly = false }: { readOnly?: boolean } = {}) {
  const [byStudent, setByStudent] = useState<Record<string, RevisionSeriesListItem[]>>({});
  const [seriesList, setSeriesList] = useState<RevisionSeriesListItem[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<number | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<(RevisionSeries & { revisions: RevisionSubmission[] }) | null>(null);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const data = await revisionsApi.listSeries();
      setSeriesList(data.series);
      setByStudent(data.by_student);
    } catch (err) {
      setListError(getApiErrorMessage(err));
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadRubrics = useCallback(async () => {
    try {
      const res = await api.get('/rubrics');
      setRubrics((res.data.rubrics || res.data || []).map((r: Rubric) => ({
        id: r.id,
        name: r.name,
        total_points: r.total_points
      })));
    } catch (e) {
      console.warn('Could not load rubrics', e);
    }
  }, []);

  useEffect(() => {
    loadList();
    if (!readOnly) loadRubrics();
  }, [loadList, loadRubrics, readOnly]);

  const loadDetail = useCallback(async (id: number) => {
    setLoadingDetail(true);
    setUploadError(null);
    try {
      const data = await revisionsApi.getSeriesDetail(id);
      setSelectedDetail({ ...data.series, revisions: data.revisions });
    } catch (err) {
      console.error('Error loading series detail:', err);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  const handleSelectSeries = (id: number) => {
    setSelectedSeriesId(id);
    loadDetail(id);
  };

  const handleCreateSeries = async (name: string, studentName: string, rubricId: number) => {
    const data = await revisionsApi.createSeries(name, studentName, rubricId);
    await loadList();
    handleSelectSeries(data.series.id);
  };

  const handleUploadRevision = async (file: File) => {
    if (!selectedSeriesId) return;
    setUploading(true);
    setUploadError(null);
    try {
      await revisionsApi.uploadRevision(selectedSeriesId, file);
      await loadList();
      await loadDetail(selectedSeriesId);
    } catch (err) {
      setUploadError(getApiErrorMessage(err, 'Upload failed'));
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteSeries = async (id: number) => {
    if (!window.confirm('Delete this revision series and all its revisions?')) return;
    try {
      await revisionsApi.deleteSeries(id);
      if (selectedSeriesId === id) {
        setSelectedSeriesId(null);
        setSelectedDetail(null);
      }
      await loadList();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <TrendingUp className="w-5 h-5 text-primary-600" />
          <div>
            <h1 className="text-base font-semibold text-gray-900">Revision Tracking</h1>
            <p className="text-xs text-gray-500">
              {readOnly
                ? 'Track your progress across successive revisions'
                : 'Upload successive revisions and track longitudinal improvement'}
            </p>
          </div>
        </div>
        {!readOnly && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 bg-primary-600 text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-primary-700 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New Series
          </button>
        )}
      </div>

      <div className="flex min-h-[500px]">
        {/* Left sidebar — student folders */}
        <div className="w-72 flex-shrink-0 border-r border-gray-200 p-3 overflow-y-auto">
          {loadingList ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
            </div>
          ) : listError ? (
            <p className="text-sm text-red-500 p-2">{listError}</p>
          ) : (
            <StudentFolderList
              byStudent={byStudent}
              selectedSeriesId={selectedSeriesId}
              onSelectSeries={handleSelectSeries}
            />
          )}
        </div>

        {/* Right panel */}
        <div className="flex-1 p-5 overflow-y-auto">
          {!selectedSeriesId && (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
              <TrendingUp className="w-12 h-12 opacity-30" />
              <p className="text-sm">
                {readOnly
                  ? 'Select a revision series from the left to view your progress.'
                  : 'Select a revision series from the left, or create a new one.'}
              </p>
            </div>
          )}

          {selectedSeriesId && loadingDetail && (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
            </div>
          )}

          {selectedSeriesId && !loadingDetail && selectedDetail && (
            <SeriesDetail
              series={selectedDetail}
              onUpload={handleUploadRevision}
              onBack={() => { setSelectedSeriesId(null); setSelectedDetail(null); }}
              uploading={uploading}
              uploadError={uploadError}
              readOnly={readOnly}
            />
          )}
        </div>
      </div>

      {!readOnly && showCreate && (
        <CreateSeriesModal
          rubrics={rubrics}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreateSeries}
        />
      )}
    </div>
  );
}
