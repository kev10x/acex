import React, { useEffect, useState } from 'react';
import {
  ArrowDown, ArrowUp, Boxes, ChevronDown, ChevronRight,
  ClipboardCheck, Eye, FileText, GripVertical, Loader2,
  Plus, Search, Trash2, User, UserPlus, X,
} from 'lucide-react';
import {
  assessmentsAPI,
  contentAPI,
  modulesAPI,
  LearningModule,
  HomeworkHistoryItem,
  HomeworkOutcomeItem,
  HomeworkReviewQueueItem,
} from '../services/api';

// ── Library types ─────────────────────────────────────────────
interface ContentSection {
  index: number;
  heading: string;
  preview: string;
}

interface LibraryContent {
  id: number;
  title: string;
  code: string;
  sections: ContentSection[];
}

interface LibraryAssessment {
  id: number;
  title: string;
  code: string;
  question_count: number;
}

// ── Drag payload ──────────────────────────────────────────────
interface LibDrag {
  source: 'library';
  item_type: 'content' | 'assessment';
  item_id: number;
  section_index: number; // -1 = whole item
  label: string;
}

const LIB_DRAG_TYPE = 'application/markmate-drag';
const ASSESSMENT_LIBRARY_PAGE_SIZE = 10;

function getAppBasePath() {
  if (typeof window === 'undefined') return '';
  return window.location.pathname.startsWith('/tools') ? '/tools' : '';
}

function encodeLibDrag(e: React.DragEvent, payload: LibDrag) {
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData(LIB_DRAG_TYPE, JSON.stringify(payload));
}

function decodeLibDrag(e: React.DragEvent): LibDrag | null {
  try {
    const raw = e.dataTransfer.getData(LIB_DRAG_TYPE);
    if (!raw) return null;
    const p = JSON.parse(raw) as LibDrag;
    return p?.source === 'library' ? p : null;
  } catch {
    return null;
  }
}

// ── Component ─────────────────────────────────────────────────
const ModuleOrganizer: React.FC = () => {
  // Data
  const [modules, setModules] = useState<LearningModule[]>([]);
  const [contentLib, setContentLib] = useState<LibraryContent[]>([]);
  const [assessmentLib, setAssessmentLib] = useState<LibraryAssessment[]>([]);
  const [homeworkHistory, setHomeworkHistory] = useState<HomeworkHistoryItem[]>([]);
  const [homeworkOutcomes, setHomeworkOutcomes] = useState<HomeworkOutcomeItem[]>([]);
  const [homeworkReviewQueue, setHomeworkReviewQueue] = useState<HomeworkReviewQueueItem[]>([]);
  const [students, setStudents] = useState<{ id: number; name: string; email: string }[]>([]);

  // UI
  const [moduleName, setModuleName] = useState('');
  const [libSearch, setLibSearch] = useState('');
  const [expandedContent, setExpandedContent] = useState<Set<number>>(new Set());
  const [studentByModule, setStudentByModule] = useState<Record<number, string>>({});
  const [previewTarget, setPreviewTarget] = useState<{ title: string; src: string } | null>(null);
  const [assessmentPage, setAssessmentPage] = useState(1);
  const [homeworkStudentFilter, setHomeworkStudentFilter] = useState('');
  const [homeworkModuleFilter, setHomeworkModuleFilter] = useState('');
  const [homeworkDateFrom, setHomeworkDateFrom] = useState('');
  const [homeworkDateTo, setHomeworkDateTo] = useState('');
  const [homeworkStatusFilter, setHomeworkStatusFilter] = useState<'all' | 'draft' | 'reviewed' | 'published'>('all');
  const [trendStudentId, setTrendStudentId] = useState<number | 'all'>('all');
  const [reviewNotesByModule, setReviewNotesByModule] = useState<Record<number, string>>({});
  const [selectedHomeworkIds, setSelectedHomeworkIds] = useState<Set<number>>(new Set());

  // Drag state
  const [isDraggingFromLib, setIsDraggingFromLib] = useState(false);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [internalDrag, setInternalDrag] = useState<{ moduleId: number; itemId: number } | null>(null);

  // Async state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => { void loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [
        studentsRes,
        modulesRes,
        contentRes,
        assessmentsRes,
        homeworkHistoryRes,
        homeworkOutcomesRes,
        homeworkReviewQueueRes,
      ] = await Promise.all([
        modulesAPI.listAvailableStudents(),
        modulesAPI.list(),
        contentAPI.getMy(),
        assessmentsAPI.getPublished(),
        modulesAPI.getHomeworkHistory(),
        modulesAPI.getHomeworkOutcomes(),
        modulesAPI.getHomeworkReviewQueue({ status: 'all', reminder_days: 3 }),
      ]);
      setStudents(studentsRes.data.students || []);
      setModules(modulesRes.data.modules || []);
      setContentLib(
        (contentRes.data.items || []).map((i: any) => ({
          id: i.id,
          title: i.title || i.code,
          code: i.code,
          sections: Array.isArray(i.sections) ? i.sections : [],
        }))
      );
      setAssessmentLib(
        (assessmentsRes.data.items || []).map((i: any) => ({
          id: i.id,
          title: i.title || i.code,
          code: i.code,
          question_count: i.question_count || 0,
        }))
      );
      setHomeworkHistory(homeworkHistoryRes.data.items || []);
      setHomeworkOutcomes(homeworkOutcomesRes.data.items || []);
      setHomeworkReviewQueue(homeworkReviewQueueRes.data.items || []);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  // ── Module CRUD ───────────────────────────────────────────
  const handleCreateModule = async () => {
    const name = moduleName.trim();
    if (!name) return;
    setWorking('create');
    try {
      await modulesAPI.create(name);
      setModuleName('');
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to create module');
    } finally {
      setWorking(null);
    }
  };

  const handleDeleteModule = async (id: number) => {
    if (!window.confirm('Delete this module and all its items?')) return;
    setWorking(`del-mod-${id}`);
    try {
      await modulesAPI.remove(id);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to delete module');
    } finally {
      setWorking(null);
    }
  };

  // ── Item management ───────────────────────────────────────
  const handleLibraryDrop = async (moduleId: number, payload: LibDrag) => {
    setDropTarget(null);
    setIsDraggingFromLib(false);
    setWorking(`add-${moduleId}`);
    try {
      const si = payload.section_index >= 0 ? payload.section_index : undefined;
      await modulesAPI.addItem(moduleId, payload.item_type, payload.item_id, si);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to add item');
    } finally {
      setWorking(null);
    }
  };

  const handleRemoveItem = async (moduleId: number, moduleItemId: number) => {
    setWorking(`rem-item-${moduleItemId}`);
    try {
      await modulesAPI.removeItem(moduleId, moduleItemId);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to remove item');
    } finally {
      setWorking(null);
    }
  };

  const moveItem = async (moduleId: number, itemId: number, dir: 'up' | 'down') => {
    const mod = modules.find((m) => m.id === moduleId);
    if (!mod) return;
    const sorted = [...mod.items].sort((a, b) => (a.position - b.position) || (a.id - b.id));
    const idx = sorted.findIndex((i) => i.id === itemId);
    const target = dir === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= sorted.length) return;
    const next = [...sorted];
    [next[idx], next[target]] = [next[target], next[idx]];
    setWorking(`reorder-${moduleId}`);
    try {
      await modulesAPI.reorderItems(moduleId, next.map((i) => i.id));
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to reorder');
    } finally {
      setWorking(null);
    }
  };

  const reorderByDrop = async (moduleId: number, draggedId: number, targetId: number) => {
    const mod = modules.find((m) => m.id === moduleId);
    if (!mod) return;
    const sorted = [...mod.items].sort((a, b) => (a.position - b.position) || (a.id - b.id));
    const from = sorted.findIndex((i) => i.id === draggedId);
    const to = sorted.findIndex((i) => i.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...sorted];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setWorking(`reorder-${moduleId}`);
    try {
      await modulesAPI.reorderItems(moduleId, next.map((i) => i.id));
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to reorder');
    } finally {
      setWorking(null);
      setInternalDrag(null);
    }
  };

  // ── Student management ────────────────────────────────────
  const handleAddStudent = async (moduleId: number) => {
    const userId = Number(studentByModule[moduleId] || '');
    if (!userId) return;
    setWorking(`add-stu-${moduleId}`);
    try {
      await modulesAPI.addStudent(moduleId, userId);
      setStudentByModule((p) => ({ ...p, [moduleId]: '' }));
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to add student');
    } finally {
      setWorking(null);
    }
  };

  const handleRemoveStudent = async (moduleId: number, studentId: number) => {
    setWorking(`rem-stu-${moduleId}-${studentId}`);
    try {
      await modulesAPI.removeStudent(moduleId, studentId);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to remove student');
    } finally {
      setWorking(null);
    }
  };

  const handleGenerateCustomHomework = async (moduleId: number, student: { id: number; name: string; email: string }) => {
    setError(null);
    setNotice(null);
    setWorking(`gen-homework-${moduleId}-${student.id}`);
    try {
      const res = await modulesAPI.generateCustomHomework(moduleId, {
        student_user_id: student.id,
        student_name: student.name || student.email,
      });
      const payload = res.data;
      const weakAreaCount = payload.analysis?.weak_areas?.length || 0;
      setNotice(
        `Created "${payload.homework_module.name}" for ${payload.student.name}. ` +
        `Added targeted content and assessment based on ${payload.analysis?.submissions_analyzed || 0} marked submissions (${weakAreaCount} weak areas identified).`
      );
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to generate custom homework module');
    } finally {
      setWorking(null);
    }
  };

  const handleRegenerateFromHistory = async (item: HomeworkHistoryItem) => {
    if (!item.source_module_id || !item.student?.id) {
      setError('This history item cannot be regenerated because the source module or student reference is missing.');
      return;
    }
    setError(null);
    setNotice(null);
    setWorking(`regen-homework-${item.homework_module_id}`);
    try {
      const res = await modulesAPI.generateCustomHomework(item.source_module_id, {
        student_user_id: item.student.id,
        student_name: item.student.name,
      });
      const payload = res.data;
      setNotice(
        `Regenerated homework for ${payload.student.name}. New module: "${payload.homework_module.name}".`
      );
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to regenerate homework');
    } finally {
      setWorking(null);
    }
  };

  const handleUpdateHomeworkWorkflow = async (
    item: HomeworkHistoryItem,
    status: 'draft' | 'reviewed' | 'published',
    reviewNotes?: string
  ) => {
    setError(null);
    setNotice(null);
    setWorking(`workflow-${item.homework_module_id}-${status}`);
    try {
      await modulesAPI.updateHomeworkWorkflow(item.homework_module_id, {
        status,
        review_notes: reviewNotes ?? item.workflow?.review_notes ?? null,
      });
      if (status === 'published') {
        setNotice(`Published "${item.homework_module_name}". Students can now access it in their modules.`);
      } else if (status === 'reviewed') {
        setNotice(`Marked "${item.homework_module_name}" as reviewed. It remains hidden from students until published.`);
      } else {
        setNotice(`Moved "${item.homework_module_name}" back to draft.`);
      }
      await loadAll();
    } catch (e: any) {
      const blockers = Array.isArray(e.response?.data?.blockers) ? e.response.data.blockers : [];
      if (blockers.length > 0) {
        setError(`${e.response?.data?.error || 'Publish guardrails failed'}: ${blockers.join('; ')}`);
      } else {
        setError(e.response?.data?.error || e.message || 'Failed to update homework workflow');
      }
    } finally {
      setWorking(null);
    }
  };

  const handleBulkUpdateHomeworkWorkflow = async (status: 'draft' | 'reviewed' | 'published') => {
    const selectedIds = filteredHomeworkHistory
      .map((item) => item.homework_module_id)
      .filter((id) => selectedHomeworkIds.has(id));
    if (selectedIds.length === 0) {
      setError('Select at least one homework module to run a bulk action.');
      return;
    }
    setError(null);
    setNotice(null);
    setWorking(`workflow-bulk-${status}`);
    try {
      const res = await modulesAPI.bulkUpdateHomeworkWorkflow(selectedIds, { status });
      const updatedCount = Number(res.data?.updated_count || 0);
      const skippedCount = Array.isArray(res.data?.skipped_ids) ? res.data.skipped_ids.length : 0;
      if (status === 'published') {
        setNotice(`Bulk publish complete. Updated ${updatedCount} modules${skippedCount ? `, skipped ${skippedCount}` : ''}.`);
      } else if (status === 'reviewed') {
        setNotice(`Bulk review complete. Updated ${updatedCount} modules${skippedCount ? `, skipped ${skippedCount}` : ''}.`);
      } else {
        setNotice(`Bulk draft update complete. Updated ${updatedCount} modules${skippedCount ? `, skipped ${skippedCount}` : ''}.`);
      }
      await loadAll();
      setSelectedHomeworkIds((prev) => {
        const next = new Set(prev);
        selectedIds.forEach((id) => next.delete(id));
        return next;
      });
    } catch (e: any) {
      const skippedDetails = Array.isArray(e.response?.data?.skipped_details) ? e.response.data.skipped_details : [];
      if (skippedDetails.length > 0) {
        const first = skippedDetails[0];
        setError(`Bulk update blocked for some modules. Example #${first.module_id}: ${(first.blockers || []).join('; ')}`);
      } else {
        setError(e.response?.data?.error || e.message || 'Failed to run bulk workflow update');
      }
    } finally {
      setWorking(null);
    }
  };

  const handlePublishAllReviewed = async () => {
    const reviewedIds = filteredHomeworkHistory
      .filter((item) => (item.workflow?.status || 'draft') === 'reviewed')
      .map((item) => item.homework_module_id);
    if (reviewedIds.length === 0) {
      setError('No reviewed homework modules are visible in the current filters.');
      return;
    }
    setError(null);
    setNotice(null);
    setWorking('workflow-bulk-publish-reviewed');
    try {
      setSelectedHomeworkIds((prev) => {
        const next = new Set(prev);
        reviewedIds.forEach((id) => next.add(id));
        return next;
      });
      const response = await modulesAPI.bulkUpdateHomeworkWorkflow(reviewedIds, { status: 'published' });
      const updatedCount = Number(response.data?.updated_count || 0);
      const skippedCount = Array.isArray(response.data?.skipped_ids) ? response.data.skipped_ids.length : 0;
      setNotice(`Publish reviewed complete. Updated ${updatedCount}${skippedCount ? `, skipped ${skippedCount}` : ''}.`);
      await loadAll();
      setSelectedHomeworkIds((prev) => {
        const next = new Set(prev);
        reviewedIds.forEach((id) => next.delete(id));
        return next;
      });
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to publish reviewed homework modules');
    } finally {
      setWorking(null);
    }
  };

  const handleExportOutcomeTrendsCsv = () => {
    const escapeCsv = (value: any) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    let csv = '';
    let fileName = 'homework_outcome_trends.csv';

    if (trendStudentId === 'all') {
      const header = ['student_name', 'homework_cycles', 'latest_score_percent', 'total_improved_areas'];
      const rows = outcomeByStudentSummary.map((row) => [
        row.name,
        row.cycles,
        row.latestScore == null ? '' : row.latestScore,
        row.improvedTotal,
      ]);
      csv = [header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
    } else {
      const selectedStudent = trendStudents.find((student) => Number(student.id) === Number(trendStudentId));
      fileName = `homework_outcome_trends_${String(selectedStudent?.name || trendStudentId).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.csv`;
      const header = [
        'date',
        'homework_module',
        'latest_score_percent',
        'attempts_total',
        'completed_attempts',
        'improved_count',
        'unchanged_count',
        'declined_count',
        'follow_up_recommended',
      ];
      const rows = trendOutcomes.map((item) => [
        item.homework_created_at ? new Date(String(item.homework_created_at)).toISOString() : '',
        item.homework_module_name,
        item.latest_score_percent == null ? '' : item.latest_score_percent,
        item.attempts_total,
        item.completed_attempts,
        item.summary?.improved_count || 0,
        item.summary?.unchanged_count || 0,
        item.summary?.declined_count || 0,
        item.summary?.follow_up_recommended ? 'yes' : 'no',
      ]);
      csv = [header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
    }

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.setAttribute('download', fileName);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setNotice('Outcome trends CSV exported.');
  };

  const handleExportOutcomeCriteriaCsv = () => {
    const escapeCsv = (value: any) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rowsSource = trendStudentId === 'all' ? homeworkOutcomes : trendOutcomes;
    const header = [
      'student_name',
      'homework_date',
      'homework_module',
      'criterion_name',
      'baseline_percent',
      'current_percent',
      'delta_percent',
      'status',
    ];
    const rows = rowsSource.flatMap((item) => {
      const criterionRows = Array.isArray(item.weak_area_outcomes) ? item.weak_area_outcomes : [];
      if (criterionRows.length === 0) {
        return [[
          item.student?.name || '',
          item.homework_created_at ? new Date(String(item.homework_created_at)).toISOString() : '',
          item.homework_module_name || '',
          '',
          '',
          '',
          '',
          'no_data',
        ]];
      }
      return criterionRows.map((criterion) => [
        item.student?.name || '',
        item.homework_created_at ? new Date(String(item.homework_created_at)).toISOString() : '',
        item.homework_module_name || '',
        criterion.criterion_name,
        criterion.baseline_percent,
        criterion.current_percent == null ? '' : criterion.current_percent,
        criterion.delta_percent == null ? '' : criterion.delta_percent,
        criterion.status,
      ]);
    });
    const csv = [header, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
    const fileName = trendStudentId === 'all'
      ? 'homework_outcome_criteria_all_students.csv'
      : `homework_outcome_criteria_${String(trendStudents.find((s) => Number(s.id) === Number(trendStudentId))?.name || trendStudentId).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.csv`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.setAttribute('download', fileName);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setNotice('Detailed criteria CSV exported.');
  };

  // ── UI helpers ────────────────────────────────────────────
  const toggleExpand = (id: number) =>
    setExpandedContent((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const lc = libSearch.toLowerCase();
  const filteredContent = contentLib.filter(
    (c) => !lc || c.title.toLowerCase().includes(lc) ||
      c.sections.some((s) => s.heading.toLowerCase().includes(lc))
  );
  const filteredAssessments = assessmentLib.filter(
    (a) => !lc || a.title.toLowerCase().includes(lc)
  );
  const assessmentPageCount = Math.max(1, Math.ceil(filteredAssessments.length / ASSESSMENT_LIBRARY_PAGE_SIZE));
  const paginatedAssessments = filteredAssessments.slice(
    (assessmentPage - 1) * ASSESSMENT_LIBRARY_PAGE_SIZE,
    assessmentPage * ASSESSMENT_LIBRARY_PAGE_SIZE
  );
  const filteredHomeworkHistory = homeworkHistory.filter((item) => {
    const studentMatch = !homeworkStudentFilter.trim()
      || `${item.student?.name || ''} ${item.student?.email || ''}`.toLowerCase().includes(homeworkStudentFilter.trim().toLowerCase());
    const moduleMatch = !homeworkModuleFilter.trim()
      || String(item.source_module_name || '').toLowerCase().includes(homeworkModuleFilter.trim().toLowerCase());
    const dateValue = new Date(item.homework_created_at);
    const fromMatch = !homeworkDateFrom || (!Number.isNaN(dateValue.getTime()) && dateValue >= new Date(`${homeworkDateFrom}T00:00:00`));
    const toMatch = !homeworkDateTo || (!Number.isNaN(dateValue.getTime()) && dateValue <= new Date(`${homeworkDateTo}T23:59:59`));
    const status = (item.workflow?.status || 'draft') as 'draft' | 'reviewed' | 'published';
    const statusMatch = homeworkStatusFilter === 'all' || status === homeworkStatusFilter;
    return studentMatch && moduleMatch && fromMatch && toMatch && statusMatch;
  });
  const outcomeByModuleId = new Map(homeworkOutcomes.map((item) => [item.homework_module_id, item]));
  const trendStudents = Array.from(new Map(
    homeworkOutcomes
      .filter((item) => item.student?.id != null)
      .map((item) => [Number(item.student.id), item.student])
  ).entries())
    .map(([id, student]) => ({ id, name: student?.name || `Student ${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const trendOutcomes = homeworkOutcomes
    .filter((item) => {
      if (trendStudentId === 'all') return false;
      return Number(item.student?.id) === Number(trendStudentId);
    })
    .sort((a, b) => new Date(String(a.homework_created_at || 0)).getTime() - new Date(String(b.homework_created_at || 0)).getTime());
  const trendScores = trendOutcomes
    .filter((item) => item.latest_score_percent != null)
    .map((item) => Number(item.latest_score_percent))
    .filter((v) => Number.isFinite(v));
  const trendMinScore = trendScores.length > 0 ? Math.min(...trendScores) : 0;
  const trendMaxScore = trendScores.length > 0 ? Math.max(...trendScores) : 100;
  const trendRange = Math.max(10, trendMaxScore - trendMinScore);
  const trendPathPoints = trendOutcomes.map((item, idx) => {
    const score = Number(item.latest_score_percent);
    if (!Number.isFinite(score)) return null;
    const x = trendOutcomes.length <= 1 ? 20 : 20 + (idx * 260) / (trendOutcomes.length - 1);
    const y = 90 - ((score - trendMinScore) / trendRange) * 70;
    return { x, y, score };
  }).filter(Boolean) as Array<{ x: number; y: number; score: number }>;
  const trendPath = trendPathPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const outcomeByStudentSummary = trendStudents.map((student) => {
    const rows = homeworkOutcomes
      .filter((item) => Number(item.student?.id) === Number(student.id))
      .sort((a, b) => new Date(String(a.homework_created_at || 0)).getTime() - new Date(String(b.homework_created_at || 0)).getTime());
    const latest = rows[rows.length - 1] || null;
    const latestScore = latest?.latest_score_percent != null ? Number(latest.latest_score_percent) : null;
    const improvedTotal = rows.reduce((sum, row) => sum + Number(row.summary?.improved_count || 0), 0);
    return {
      id: student.id,
      name: student.name,
      cycles: rows.length,
      latestScore,
      improvedTotal,
    };
  });
  const selectedVisibleHomeworkCount = filteredHomeworkHistory
    .map((item) => item.homework_module_id)
    .filter((id) => selectedHomeworkIds.has(id)).length;
  const reviewedVisibleCount = filteredHomeworkHistory
    .filter((item) => (item.workflow?.status || 'draft') === 'reviewed').length;
  const allFilteredSelected = filteredHomeworkHistory.length > 0
    && selectedVisibleHomeworkCount === filteredHomeworkHistory.length;

  const workflowBadgeClass = (status: string) => {
    if (status === 'published') return 'bg-emerald-100 text-emerald-800 border-emerald-200';
    if (status === 'reviewed') return 'bg-amber-100 text-amber-800 border-amber-200';
    return 'bg-slate-100 text-slate-700 border-slate-200';
  };

  const getReviewNotesValue = (item: HomeworkHistoryItem) =>
    reviewNotesByModule[item.homework_module_id] ?? item.workflow?.review_notes ?? '';

  const getChecklist = (item: HomeworkHistoryItem) => {
    const weakAreas = item.workflow?.reason_payload?.weak_areas || [];
    const rubricCriteria = item.workflow?.reason_payload?.rubric_criteria || [];
    const hasNotes = !!String(item.workflow?.review_notes || '').trim();
    const status = item.workflow?.status || 'draft';
    const hasPublishedContent = !!item.content?.code;
    const hasPublishedAssessment = !!item.assessment?.code;
    return {
      weakAreaCoverage: weakAreas.length > 0,
      rubricCoverage: rubricCriteria.length > 0,
      hasNotes,
      hasPublishedContent,
      hasPublishedAssessment,
      readyToPublish: status !== 'published' && weakAreas.length > 0 && rubricCriteria.length > 0,
    };
  };

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredAssessments.length / ASSESSMENT_LIBRARY_PAGE_SIZE));
    setAssessmentPage((prev) => Math.min(prev, maxPage));
  }, [filteredAssessments.length]);

  const resetLibDrag = () => { setIsDraggingFromLib(false); setDropTarget(null); };

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {previewTarget && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-6xl h-[90vh] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-slate-200 bg-slate-50">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Content preview</div>
                <h3 className="text-lg font-semibold text-slate-900">{previewTarget.title}</h3>
              </div>
              <button
                type="button"
                onClick={() => setPreviewTarget(null)}
                className="inline-flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-white"
              >
                <X className="w-4 h-4" />
                Close
              </button>
            </div>
            <iframe title={previewTarget.title} src={previewTarget.src} className="flex-1 w-full bg-white" />
          </div>
        </div>
      )}

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          {error}
        </div>
      )}
      {notice && (
        <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
          {notice}
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-4 items-start">

        {/* ── Library panel ──────────────────────────────── */}
        <div
          className="lg:w-80 shrink-0 bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden sticky top-4"
          onDragEnd={resetLibDrag}
        >
          <div className="bg-gray-50 border-b border-gray-200 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-800">Content Library</h3>
            <p className="text-xs text-gray-500 mt-0.5">Drag items into a module →</p>
          </div>

          <div className="p-3 max-h-[calc(100vh-220px)] overflow-y-auto">
            {/* Search */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
              <input
                value={libSearch}
                onChange={(e) => {
                  setLibSearch(e.target.value);
                  setAssessmentPage(1);
                }}
                placeholder="Filter..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
              />
            </div>

            {/* Content section */}
            <details className="mb-3 border border-gray-200 rounded-lg overflow-hidden" open>
              <summary className="cursor-pointer list-none px-3 py-2 bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Content history ({filteredContent.length})
              </summary>
              <div className="pt-2">

            {loading ? (
              <div className="flex items-center gap-2 text-xs text-gray-500 px-1 mb-3">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading...
              </div>
            ) : filteredContent.length === 0 ? (
              <p className="text-xs text-gray-400 px-1 mb-3">No published content yet.</p>
            ) : (
              <div className="space-y-0.5 mb-4">
                {filteredContent.map((item) => {
                  const isOpen = expandedContent.has(item.id);
                  return (
                    <div key={item.id}>
                      {/* Content item header — draggable as whole item */}
                      <div
                        draggable
                        onDragStart={(e) => {
                          setIsDraggingFromLib(true);
                          encodeLibDrag(e, {
                            source: 'library',
                            item_type: 'content',
                            item_id: item.id,
                            section_index: -1,
                            label: item.title,
                          });
                        }}
                        onDragEnd={resetLibDrag}
                        className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-grab active:cursor-grabbing group select-none"
                      >
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); toggleExpand(item.id); }}
                          className="shrink-0 text-gray-400 hover:text-gray-600 p-0.5"
                        >
                          {isOpen
                            ? <ChevronDown className="w-3.5 h-3.5" />
                            : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                        <FileText className="w-4 h-4 text-indigo-500 shrink-0" />
                        <span className="text-sm text-gray-800 font-medium truncate flex-1" title={item.title}>
                          {item.title}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewTarget({
                              title: item.title,
                              src: `${window.location.origin}${getAppBasePath()}/take-content?code=${encodeURIComponent(item.code)}`,
                            });
                          }}
                          className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 text-gray-500 hover:text-indigo-600 hover:border-indigo-200 hover:bg-indigo-50 shrink-0"
                          title="Preview content"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-[10px] text-gray-400 shrink-0 tabular-nums">
                          {item.sections.length}p
                        </span>
                        <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-500 shrink-0" />
                      </div>

                      {/* Expanded sections — each draggable individually */}
                      {isOpen && (
                        <div className="ml-5 border-l-2 border-indigo-100 pl-2 space-y-0.5 mb-1">
                          {item.sections.length === 0 ? (
                            <p className="text-xs text-gray-400 py-1 px-2">No sections.</p>
                          ) : (
                            item.sections.map((section) => (
                              <div
                                key={section.index}
                                draggable
                                onDragStart={(e) => {
                                  e.stopPropagation();
                                  setIsDraggingFromLib(true);
                                  encodeLibDrag(e, {
                                    source: 'library',
                                    item_type: 'content',
                                    item_id: item.id,
                                    section_index: section.index,
                                    label: `${item.title} › Page ${section.index + 1}: ${section.heading}`,
                                  });
                                }}
                                onDragEnd={resetLibDrag}
                                className="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-indigo-50 cursor-grab active:cursor-grabbing group select-none"
                              >
                                <span className="text-[10px] font-bold text-indigo-400 mt-0.5 shrink-0 w-4 text-right tabular-nums">
                                  {section.index + 1}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-medium text-gray-700 truncate">
                                    {section.heading}
                                  </p>
                                  {section.preview && (
                                    <p className="text-[11px] text-gray-400 truncate leading-tight">
                                      {section.preview}
                                    </p>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setPreviewTarget({
                                      title: `${item.title} • Section ${section.index + 1}`,
                                      src: `${window.location.origin}${getAppBasePath()}/take-content?code=${encodeURIComponent(item.code)}&section=${section.index}`,
                                    });
                                  }}
                                  className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-indigo-200 text-indigo-500 hover:bg-white shrink-0"
                                  title="Preview section"
                                >
                                  <Eye className="w-3 h-3" />
                                </button>
                                <GripVertical className="w-3 h-3 text-gray-300 group-hover:text-indigo-400 shrink-0 mt-0.5" />
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
              </div>
            </details>

            {/* Assessments section */}
            <details className="border border-gray-200 rounded-lg overflow-hidden" open>
              <summary className="cursor-pointer list-none px-3 py-2 bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                Assessment history ({filteredAssessments.length})
              </summary>
              <div className="pt-2">
            {filteredAssessments.length === 0 ? (
              <p className="text-xs text-gray-400 px-1">No published assessments yet.</p>
            ) : (
              <>
                <div className="space-y-0.5">
                {paginatedAssessments.map((item) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => {
                      setIsDraggingFromLib(true);
                      encodeLibDrag(e, {
                        source: 'library',
                        item_type: 'assessment',
                        item_id: item.id,
                        section_index: -1,
                        label: item.title,
                      });
                    }}
                    onDragEnd={resetLibDrag}
                    className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-grab active:cursor-grabbing group select-none"
                  >
                    <ClipboardCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="text-sm text-gray-800 font-medium truncate flex-1" title={item.title}>
                      {item.title}
                    </span>
                    {item.question_count > 0 && (
                      <span className="text-[10px] text-gray-400 shrink-0 tabular-nums">
                        {item.question_count}q
                      </span>
                    )}
                    <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-500 shrink-0" />
                  </div>
                ))}
                </div>
                {assessmentPageCount > 1 && (
                  <div className="mt-3 flex items-center justify-between gap-2 px-1 text-[11px] text-gray-500">
                    <span>
                      Page {assessmentPage} of {assessmentPageCount}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setAssessmentPage((prev) => Math.max(1, prev - 1))}
                        disabled={assessmentPage === 1}
                        className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50"
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        onClick={() => setAssessmentPage((prev) => Math.min(assessmentPageCount, prev + 1))}
                        disabled={assessmentPage === assessmentPageCount}
                        className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
              </div>
            </details>
          </div>
        </div>

        {/* ── Modules panel ───────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-4">
          <details className="bg-white border border-blue-200 rounded-xl shadow-sm overflow-hidden" open={homeworkOutcomes.length > 0}>
            <summary className="cursor-pointer list-none px-4 py-3 bg-blue-50 border-b border-blue-100 text-sm font-semibold text-blue-900">
              Outcome trends by student ({homeworkOutcomes.length})
            </summary>
            <div className="p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-blue-900 font-medium">Student view</label>
                <select
                  value={trendStudentId}
                  onChange={(e) => {
                    const value = e.target.value;
                    setTrendStudentId(value === 'all' ? 'all' : Number(value));
                  }}
                  className="px-2 py-1 text-xs border border-blue-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value="all">All students overview</option>
                  {trendStudents.map((student) => (
                    <option key={`trend-student-${student.id}`} value={student.id}>
                      {student.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleExportOutcomeTrendsCsv}
                  disabled={trendStudentId !== 'all' && trendOutcomes.length === 0}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-blue-300 text-blue-800 bg-white hover:bg-blue-100 disabled:opacity-40"
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={handleExportOutcomeCriteriaCsv}
                  disabled={trendStudentId !== 'all' && trendOutcomes.length === 0}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-blue-300 text-blue-800 bg-white hover:bg-blue-100 disabled:opacity-40"
                >
                  Export Detailed CSV
                </button>
              </div>

              {trendStudentId === 'all' ? (
                outcomeByStudentSummary.length === 0 ? (
                  <p className="text-sm text-gray-500">No outcome trend data yet.</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-blue-100">
                    <table className="min-w-full divide-y divide-blue-100">
                      <thead className="bg-blue-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-blue-700 uppercase tracking-wider">Student</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-blue-700 uppercase tracking-wider">Homework cycles</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-blue-700 uppercase tracking-wider">Latest score</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-blue-700 uppercase tracking-wider">Total improved areas</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-blue-50">
                        {outcomeByStudentSummary.map((row) => (
                          <tr key={`trend-row-${row.id}`}>
                            <td className="px-3 py-2 text-sm text-gray-800">{row.name}</td>
                            <td className="px-3 py-2 text-sm text-gray-700">{row.cycles}</td>
                            <td className="px-3 py-2 text-sm text-gray-700">{row.latestScore == null ? 'n/a' : `${row.latestScore}%`}</td>
                            <td className="px-3 py-2 text-sm text-gray-700">{row.improvedTotal}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : trendOutcomes.length === 0 ? (
                <p className="text-sm text-gray-500">No trend history for this student yet.</p>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <div className="rounded border border-blue-100 bg-blue-50 p-2">
                      <p className="text-[11px] text-blue-700">Homework cycles</p>
                      <p className="text-sm font-semibold text-blue-900">{trendOutcomes.length}</p>
                    </div>
                    <div className="rounded border border-blue-100 bg-blue-50 p-2">
                      <p className="text-[11px] text-blue-700">Latest score</p>
                      <p className="text-sm font-semibold text-blue-900">
                        {trendOutcomes[trendOutcomes.length - 1]?.latest_score_percent == null
                          ? 'n/a'
                          : `${trendOutcomes[trendOutcomes.length - 1].latest_score_percent}%`}
                      </p>
                    </div>
                    <div className="rounded border border-blue-100 bg-blue-50 p-2">
                      <p className="text-[11px] text-blue-700">Total improved areas</p>
                      <p className="text-sm font-semibold text-blue-900">
                        {trendOutcomes.reduce((sum, item) => sum + Number(item.summary?.improved_count || 0), 0)}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg border border-blue-100 bg-white p-2">
                    {trendPathPoints.length < 2 ? (
                      <p className="text-xs text-gray-500">Need at least two scored cycles to draw a trend line.</p>
                    ) : (
                      <svg viewBox="0 0 300 110" className="w-full h-28">
                        <line x1="20" y1="90" x2="280" y2="90" stroke="#cbd5e1" strokeWidth="1" />
                        <line x1="20" y1="20" x2="20" y2="90" stroke="#cbd5e1" strokeWidth="1" />
                        <polyline fill="none" stroke="#2563eb" strokeWidth="2.5" points={trendPath} />
                        {trendPathPoints.map((point, idx) => (
                          <g key={`trend-point-${idx}`}>
                            <circle cx={point.x} cy={point.y} r="3.5" fill="#2563eb" />
                            <text x={point.x} y={point.y - 6} textAnchor="middle" fontSize="8" fill="#1e3a8a">
                              {point.score}%
                            </text>
                          </g>
                        ))}
                      </svg>
                    )}
                  </div>
                  <div className="space-y-1">
                    {trendOutcomes.map((item) => (
                      <p key={`trend-detail-${item.homework_module_id}`} className="text-xs text-blue-900">
                        {new Date(String(item.homework_created_at || '')).toLocaleDateString()} • {item.homework_module_name}
                        {' '}• Improved {item.summary?.improved_count || 0}, unchanged {item.summary?.unchanged_count || 0}, declined {item.summary?.declined_count || 0}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>

          <details className="bg-white border border-amber-200 rounded-xl shadow-sm overflow-hidden" open={homeworkReviewQueue.length > 0}>
            <summary className="cursor-pointer list-none px-4 py-3 bg-amber-50 border-b border-amber-100 text-sm font-semibold text-amber-900">
              Homework review queue ({homeworkReviewQueue.length})
            </summary>
            <div className="p-3">
              {homeworkReviewQueue.length === 0 ? (
                <p className="text-sm text-gray-500">No draft/reviewed homework modules waiting in the queue.</p>
              ) : (
                <ul className="space-y-2">
                  {homeworkReviewQueue.slice(0, 10).map((queueItem) => (
                    <li key={`queue-${queueItem.homework_module_id}`} className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-amber-900 truncate">{queueItem.homework_module_name}</p>
                          <p className="text-xs text-amber-800">
                            {queueItem.student.name} • {queueItem.workflow_status.toUpperCase()} • {queueItem.age_days} day(s) waiting
                          </p>
                        </div>
                        {queueItem.needs_reminder && (
                          <span className="px-2 py-0.5 text-[10px] border rounded-full bg-red-50 text-red-700 border-red-200">
                            Reminder due
                          </span>
                        )}
                      </div>
                      {queueItem.blockers.length > 0 && (
                        <p className="mt-1 text-[11px] text-amber-800">
                          Publish blockers: {queueItem.blockers.join('; ')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>

          <details className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden" open={homeworkHistory.length > 0}>
            <summary className="cursor-pointer list-none px-4 py-3 bg-emerald-50 border-b border-emerald-100 text-sm font-semibold text-emerald-900">
              Custom homework history ({homeworkHistory.length})
            </summary>
            <div className="p-3">
              <div className="mb-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
                <input
                  value={homeworkStudentFilter}
                  onChange={(e) => setHomeworkStudentFilter(e.target.value)}
                  placeholder="Filter by student"
                  className="px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
                <input
                  value={homeworkModuleFilter}
                  onChange={(e) => setHomeworkModuleFilter(e.target.value)}
                  placeholder="Filter by source module"
                  className="px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
                <input
                  type="date"
                  value={homeworkDateFrom}
                  onChange={(e) => setHomeworkDateFrom(e.target.value)}
                  className="px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
                <input
                  type="date"
                  value={homeworkDateTo}
                  onChange={(e) => setHomeworkDateTo(e.target.value)}
                  className="px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-400"
                />
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {(['all', 'draft', 'reviewed', 'published'] as const).map((status) => (
                  <button
                    key={status}
                    type="button"
                    onClick={() => setHomeworkStatusFilter(status)}
                    className={`px-2.5 py-1 text-xs border rounded-full ${
                      homeworkStatusFilter === status
                        ? 'bg-emerald-100 text-emerald-800 border-emerald-300'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
                  </button>
                ))}
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-2 py-2">
                <label className="inline-flex items-center gap-2 text-xs text-emerald-900">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={(e) => {
                      const isChecked = e.target.checked;
                      setSelectedHomeworkIds((prev) => {
                        const next = new Set(prev);
                        if (isChecked) {
                          filteredHomeworkHistory.forEach((item) => next.add(item.homework_module_id));
                        } else {
                          filteredHomeworkHistory.forEach((item) => next.delete(item.homework_module_id));
                        }
                        return next;
                      });
                    }}
                    className="rounded border-emerald-300 text-emerald-600 focus:ring-emerald-400"
                  />
                  Select all filtered ({filteredHomeworkHistory.length})
                </label>
                <span className="text-[11px] text-emerald-800">
                  Selected: {selectedVisibleHomeworkCount}
                </span>
                <button
                  type="button"
                  onClick={() => handleBulkUpdateHomeworkWorkflow('reviewed')}
                  disabled={!!working || selectedVisibleHomeworkCount === 0}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-amber-300 text-amber-800 bg-white hover:bg-amber-100 disabled:opacity-40"
                >
                  Mark reviewed
                </button>
                <button
                  type="button"
                  onClick={handlePublishAllReviewed}
                  disabled={!!working || reviewedVisibleCount === 0}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-emerald-400 text-emerald-900 bg-emerald-100 hover:bg-emerald-200 disabled:opacity-40"
                >
                  Publish all reviewed ({reviewedVisibleCount})
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkUpdateHomeworkWorkflow('published')}
                  disabled={!!working || selectedVisibleHomeworkCount === 0}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-emerald-300 text-emerald-800 bg-white hover:bg-emerald-100 disabled:opacity-40"
                >
                  Publish selected
                </button>
                <button
                  type="button"
                  onClick={() => handleBulkUpdateHomeworkWorkflow('draft')}
                  disabled={!!working || selectedVisibleHomeworkCount === 0}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-300 text-slate-700 bg-white hover:bg-slate-100 disabled:opacity-40"
                >
                  Move to draft
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedHomeworkIds(new Set())}
                  disabled={!!working || selectedVisibleHomeworkCount === 0}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-300 text-gray-700 bg-white hover:bg-gray-100 disabled:opacity-40"
                >
                  Clear selection
                </button>
              </div>
              {filteredHomeworkHistory.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {homeworkHistory.length === 0
                    ? 'No custom homework modules generated yet.'
                    : 'No history items match the current filters.'}
                </p>
              ) : (
                <ul className="space-y-2">
                  {filteredHomeworkHistory.map((item) => {
                    const checklist = getChecklist(item);
                    const outcome = outcomeByModuleId.get(item.homework_module_id);
                    return (
                    <li key={item.homework_module_id} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={selectedHomeworkIds.has(item.homework_module_id)}
                            onChange={(e) => {
                              const isChecked = e.target.checked;
                              setSelectedHomeworkIds((prev) => {
                                const next = new Set(prev);
                                if (isChecked) next.add(item.homework_module_id);
                                else next.delete(item.homework_module_id);
                                return next;
                              });
                            }}
                            className="mt-0.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-400"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900 truncate" title={item.homework_module_name}>
                              {item.homework_module_name}
                            </p>
                            <p className="text-xs text-gray-500">
                              Source: {item.source_module_name} • Student: {item.student.name}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 text-[11px] border rounded-full ${workflowBadgeClass(item.workflow?.status || 'draft')}`}>
                            {(item.workflow?.status || 'draft').toUpperCase()}
                          </span>
                          <span className="text-[11px] text-gray-500">
                            {new Date(item.homework_created_at).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className={`px-2 py-0.5 text-[10px] border rounded-full ${checklist.weakAreaCoverage ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          Weak Areas {checklist.weakAreaCoverage ? 'OK' : 'Missing'}
                        </span>
                        <span className={`px-2 py-0.5 text-[10px] border rounded-full ${checklist.rubricCoverage ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          Rubric Match {checklist.rubricCoverage ? 'OK' : 'Missing'}
                        </span>
                        <span className={`px-2 py-0.5 text-[10px] border rounded-full ${checklist.hasNotes ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          Notes {checklist.hasNotes ? 'Added' : 'None'}
                        </span>
                        <span className={`px-2 py-0.5 text-[10px] border rounded-full ${checklist.hasPublishedContent && checklist.hasPublishedAssessment ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                          Assets {(checklist.hasPublishedContent && checklist.hasPublishedAssessment) ? 'Ready' : 'Partial'}
                        </span>
                        {checklist.readyToPublish && (
                          <span className="px-2 py-0.5 text-[10px] border rounded-full bg-amber-50 text-amber-700 border-amber-200">
                            Ready to Publish
                          </span>
                        )}
                        {(item.workflow?.publish_blockers || []).length > 0 && (
                          <span className="px-2 py-0.5 text-[10px] border rounded-full bg-rose-50 text-rose-700 border-rose-200">
                            Publish blocked ({(item.workflow?.publish_blockers || []).length})
                          </span>
                        )}
                      </div>
                      {outcome && (
                        <details className="mt-2 border border-blue-200 rounded-md bg-blue-50">
                          <summary className="cursor-pointer list-none px-2 py-1 text-xs font-medium text-blue-800">
                            Outcome tracking
                          </summary>
                          <div className="px-2 pb-2 text-xs text-blue-900 space-y-1">
                            <p>
                              Attempts: {outcome.attempts_total} total, {outcome.completed_attempts} completed
                              {outcome.latest_score_percent != null ? ` • Latest score: ${outcome.latest_score_percent}%` : ''}
                            </p>
                            <p>
                              Improvement: {outcome.summary.improved_count} improved, {outcome.summary.unchanged_count} unchanged, {outcome.summary.declined_count} declined
                            </p>
                            {outcome.weak_area_outcomes.slice(0, 4).map((weakArea) => (
                              <p key={`${item.homework_module_id}-${weakArea.criterion_name}`}>
                                {weakArea.criterion_name}: {weakArea.baseline_percent}% → {weakArea.current_percent ?? 'n/a'}%
                                {weakArea.delta_percent != null ? ` (${weakArea.delta_percent > 0 ? '+' : ''}${weakArea.delta_percent}%)` : ''}
                              </p>
                            ))}
                          </div>
                        </details>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleRegenerateFromHistory(item)}
                          disabled={!!working || !item.source_module_id || !item.student?.id}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-emerald-300 text-emerald-800 bg-white hover:bg-emerald-100 disabled:opacity-40"
                          title={(!item.source_module_id || !item.student?.id) ? 'Source module/student unavailable for regeneration' : 'Regenerate from same source module and student'}
                        >
                          {working === `regen-homework-${item.homework_module_id}` ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <ClipboardCheck className="w-3 h-3" />
                          )}
                          Regenerate
                        </button>
                        {outcome?.summary.follow_up_recommended && (
                          <button
                            type="button"
                            onClick={() => handleRegenerateFromHistory(item)}
                            disabled={!!working || !item.source_module_id || !item.student?.id}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-blue-300 text-blue-800 bg-white hover:bg-blue-100 disabled:opacity-40"
                          >
                            Follow-up homework
                          </button>
                        )}
                        {item.workflow?.status !== 'reviewed' && (
                          <button
                            type="button"
                            onClick={() => handleUpdateHomeworkWorkflow(item, 'reviewed')}
                            disabled={!!working}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-amber-300 text-amber-800 bg-white hover:bg-amber-100 disabled:opacity-40"
                            title="Mark as reviewed (still hidden from students until published)"
                          >
                            {working === `workflow-${item.homework_module_id}-reviewed` ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Eye className="w-3 h-3" />
                            )}
                            Mark reviewed
                          </button>
                        )}
                        {item.workflow?.status !== 'published' && (
                          <button
                            type="button"
                            onClick={() => handleUpdateHomeworkWorkflow(item, 'published')}
                            disabled={!!working}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-emerald-300 text-emerald-800 bg-white hover:bg-emerald-100 disabled:opacity-40"
                            title="Publish this homework to make it visible to enrolled students"
                          >
                            {working === `workflow-${item.homework_module_id}-published` ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <User className="w-3 h-3" />
                            )}
                            Publish
                          </button>
                        )}
                        {item.workflow?.status !== 'draft' && (
                          <button
                            type="button"
                            onClick={() => handleUpdateHomeworkWorkflow(item, 'draft')}
                            disabled={!!working}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-300 text-slate-700 bg-white hover:bg-slate-100 disabled:opacity-40"
                            title="Move back to draft and hide from students"
                          >
                            {working === `workflow-${item.homework_module_id}-draft` ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <ArrowDown className="w-3 h-3" />
                            )}
                            Draft
                          </button>
                        )}
                        {item.content?.code && (
                          <a
                            href={`${window.location.origin}${getAppBasePath()}/take-content?code=${encodeURIComponent(item.content.code)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100"
                          >
                            <FileText className="w-3 h-3" />
                            View content
                          </a>
                        )}
                        {item.assessment?.code && (
                          <a
                            href={`${window.location.origin}${getAppBasePath()}/take-assessment?code=${encodeURIComponent(item.assessment.code)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
                          >
                            <ClipboardCheck className="w-3 h-3" />
                            View assessment
                          </a>
                        )}
                      </div>
                      {(item.workflow?.reason_summary || (item.workflow?.reason_payload?.weak_areas?.length || 0) > 0) && (
                        <details className="mt-2 border border-gray-200 rounded-md bg-white">
                          <summary className="cursor-pointer list-none px-2 py-1 text-xs font-medium text-gray-700">
                            Why this homework was generated
                          </summary>
                          <div className="px-2 pb-2 text-xs text-gray-700 space-y-1">
                            {item.workflow?.reason_summary && (
                              <p>{item.workflow.reason_summary}</p>
                            )}
                            {(item.workflow?.reason_payload?.weak_areas || []).slice(0, 5).length > 0 && (
                              <p>
                                Focus areas: {(item.workflow?.reason_payload?.weak_areas || [])
                                  .slice(0, 5)
                                  .map((w) => `${w.criterion_name} (${w.avg_percent}%)`)
                                  .join(', ')}
                              </p>
                            )}
                            {(item.workflow?.reason_payload?.feedback_themes || []).slice(0, 2).length > 0 && (
                              <p>
                                Feedback themes: {(item.workflow?.reason_payload?.feedback_themes || [])
                                  .slice(0, 2)
                                  .join(' | ')}
                              </p>
                            )}
                            {item.workflow?.reason_payload?.rubric_alignment && (
                              <p>
                                Rubric alignment: {item.workflow.reason_payload.rubric_alignment}
                              </p>
                            )}
                            {(item.workflow?.reason_payload?.rubric_criteria || []).slice(0, 4).length > 0 && (
                              <p>
                                Criteria targets: {(item.workflow?.reason_payload?.rubric_criteria || [])
                                  .slice(0, 4)
                                  .map((c) => `${c.name} (${c.max_points})`)
                                  .join(', ')}
                              </p>
                            )}
                          </div>
                        </details>
                      )}
                      <details className="mt-2 border border-gray-200 rounded-md bg-white">
                        <summary className="cursor-pointer list-none px-2 py-1 text-xs font-medium text-gray-700">
                          Lecturer review notes
                        </summary>
                        <div className="px-2 pb-2 space-y-2">
                          <textarea
                            value={getReviewNotesValue(item)}
                            onChange={(e) => setReviewNotesByModule((prev) => ({
                              ...prev,
                              [item.homework_module_id]: e.target.value,
                            }))}
                            rows={3}
                            placeholder="Add guidance, rationale, or publication notes for this homework..."
                            className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-400"
                          />
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={() => handleUpdateHomeworkWorkflow(item, item.workflow?.status || 'draft', getReviewNotesValue(item))}
                              disabled={!!working}
                              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-indigo-300 text-indigo-800 bg-white hover:bg-indigo-50 disabled:opacity-40"
                            >
                              {working === `workflow-${item.homework_module_id}-${item.workflow?.status || 'draft'}` ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <ClipboardCheck className="w-3 h-3" />
                              )}
                              Save notes
                            </button>
                          </div>
                        </div>
                      </details>
                    </li>
                  );})}
                </ul>
              )}
            </div>
          </details>

          {/* Create module */}
          <div className="flex gap-2">
            <input
              value={moduleName}
              onChange={(e) => setModuleName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleCreateModule()}
              placeholder="New module name (e.g. Module 1: Algebra)"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
            />
            <button
              type="button"
              onClick={handleCreateModule}
              disabled={working === 'create' || !moduleName.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap"
            >
              {working === 'create'
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <Plus className="w-4 h-4" />}
              Create module
            </button>
          </div>

          {/* Module list */}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading modules...
            </div>
          ) : modules.length === 0 ? (
            <div className="text-center py-16 bg-gray-50 rounded-xl border-2 border-dashed border-gray-200">
              <Boxes className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No modules yet. Create one, then drag content from the library.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {modules.map((module) => {
                const sortedItems = [...module.items].sort(
                  (a, b) => (a.position - b.position) || (a.id - b.id)
                );
                const isDropTarget = dropTarget === module.id;

                return (
                  <div
                    key={module.id}
                    className={`bg-white border rounded-xl shadow-sm overflow-hidden transition-all ${
                      isDropTarget
                        ? 'border-indigo-400 ring-2 ring-indigo-200 shadow-md'
                        : 'border-gray-200'
                    }`}
                    onDragOver={(e) => {
                      if (isDraggingFromLib) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'copy';
                        setDropTarget(module.id);
                      }
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDropTarget(null);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const payload = decodeLibDrag(e);
                      if (payload) void handleLibraryDrop(module.id, payload);
                    }}
                  >
                    {/* Module header */}
                    <div className="flex items-center justify-between gap-3 px-4 py-3 bg-indigo-50 border-b border-indigo-100">
                      <div className="flex items-center gap-2 min-w-0">
                        <Boxes className="w-4 h-4 text-indigo-600 shrink-0" />
                        <h3 className="font-semibold text-gray-900 text-sm truncate">{module.name}</h3>
                        <span className="text-xs text-indigo-400 shrink-0 tabular-nums">
                          {sortedItems.length} item{sortedItems.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteModule(module.id)}
                        disabled={working === `del-mod-${module.id}`}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                      </button>
                    </div>

                    {/* Drop zone banner — visible only while dragging from library */}
                    {isDraggingFromLib && (
                      <div className={`mx-4 mt-3 rounded-lg border-2 border-dashed py-2 text-center text-xs font-medium transition-colors ${
                        isDropTarget
                          ? 'border-indigo-400 bg-indigo-50 text-indigo-600'
                          : 'border-gray-200 text-gray-400'
                      }`}>
                        {isDropTarget ? '↓ Drop to add here' : 'Drag items here'}
                      </div>
                    )}

                    {/* Items */}
                    <div className="px-4 pt-3 pb-2">
                      {sortedItems.length === 0 ? (
                        !isDraggingFromLib && (
                          <p className="text-xs text-gray-400 py-1">
                            No items yet — drag from the library on the left.
                          </p>
                        )
                      ) : (
                        <ul className="space-y-1.5">
                          {sortedItems.map((item, idx) => {
                            const isContent = item.item_type === 'content';
                            const si = item.section_index ?? -1;
                            const prevType = idx > 0 ? sortedItems[idx - 1].item_type : null;
                            const showGroupLabel = idx === 0 || item.item_type !== prevType;

                            return (
                              <React.Fragment key={item.id}>
                                {showGroupLabel && (
                                  <li className="px-2 py-1">
                                    <div className="flex items-center gap-2 text-[10px] uppercase font-semibold tracking-wide text-gray-500">
                                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
                                        isContent ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'
                                      }`}>
                                        {isContent ? 'Content' : 'Assessments'}
                                      </span>
                                    </div>
                                  </li>
                                )}
                                <li
                                  draggable
                                  onDragStart={(e) => {
                                    e.stopPropagation();
                                    setInternalDrag({ moduleId: module.id, itemId: item.id });
                                    e.dataTransfer.effectAllowed = 'move';
                                  }}
                                  onDragOver={(e) => {
                                    if (isDraggingFromLib) {
                                      return;
                                    }
                                    if (internalDrag?.moduleId === module.id && internalDrag?.itemId !== item.id) {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      e.dataTransfer.dropEffect = 'move';
                                    }
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();

                                    if (internalDrag && internalDrag.moduleId === module.id && internalDrag.itemId !== item.id) {
                                      void reorderByDrop(module.id, internalDrag.itemId, item.id);
                                      return;
                                    }

                                    const payload = decodeLibDrag(e);
                                    if (payload) void handleLibraryDrop(module.id, payload);
                                  }}
                                  onDragEnd={() => setInternalDrag(null)}
                                  className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 group transition-colors ${
                                    internalDrag?.moduleId === module.id && internalDrag?.itemId === item.id
                                      ? 'opacity-40 bg-gray-100 border-gray-200'
                                      : 'bg-gray-50 border-gray-200 hover:bg-white cursor-move'
                                  }`}
                                >
                                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400 shrink-0" />
                                  <span className="text-xs font-bold text-gray-400 w-5 shrink-0 text-right tabular-nums">
                                    {idx + 1}
                                  </span>
                                  <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded font-semibold shrink-0 ${
                                    isContent
                                      ? 'bg-indigo-100 text-indigo-700'
                                      : 'bg-emerald-100 text-emerald-700'
                                  }`}>
                                    {isContent ? 'Content' : 'Assessment'}
                                  </span>
                                  <span className="truncate flex-1 text-gray-800 text-sm" title={item.title}>
                                    {item.title}
                                  </span>
                                  {si >= 0 && (
                                    <span className="text-[10px] text-indigo-400 shrink-0 tabular-nums">
                                      p.{si + 1}
                                    </span>
                                  )}
                                  <div className="flex items-center gap-1 shrink-0 ml-auto">
                                    {isContent && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const baseSrc = `${window.location.origin}${getAppBasePath()}/take-content?code=${encodeURIComponent(item.code)}`;
                                          const src = si >= 0 ? `${baseSrc}&section=${si}` : baseSrc;
                                          setPreviewTarget({ title: item.title, src });
                                        }}
                                        title="Preview content"
                                        className="p-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
                                      >
                                        <Eye className="w-3 h-3" />
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => moveItem(module.id, item.id, 'up')}
                                      disabled={idx === 0 || !!working}
                                      title="Move up"
                                      className="p-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-100"
                                    >
                                      <ArrowUp className="w-3 h-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => moveItem(module.id, item.id, 'down')}
                                      disabled={idx === sortedItems.length - 1 || !!working}
                                      title="Move down"
                                      className="p-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-100"
                                    >
                                      <ArrowDown className="w-3 h-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleRemoveItem(module.id, item.id)}
                                      disabled={working === `rem-item-${item.id}`}
                                      title="Remove from module"
                                      className="p-1 rounded border border-red-200 bg-red-50 text-red-500 hover:bg-red-100 disabled:opacity-30"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                </li>
                              </React.Fragment>
                            );
                          })}
                        </ul>
                      )}
                    </div>

                    {/* Students section */}
                    <div className="px-4 py-3 border-t border-gray-100">
                      <div className="flex items-center gap-2 mb-2">
                        <User className="w-3.5 h-3.5 text-gray-400" />
                        <span className="text-xs font-semibold text-gray-600">Students</span>
                        <span className="text-xs text-gray-400 tabular-nums">{module.students.length}</span>
                      </div>
                      <div className="flex gap-2 mb-2">
                        <select
                          value={studentByModule[module.id] || ''}
                          onChange={(e) => setStudentByModule((p) => ({ ...p, [module.id]: e.target.value }))}
                          className="flex-1 text-xs px-2 py-1.5 border border-gray-300 rounded-lg min-w-0 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                        >
                          <option value="">Select student</option>
                          {students.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name || s.email} ({s.email})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleAddStudent(module.id)}
                          disabled={!studentByModule[module.id] || working === `add-stu-${module.id}`}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 shrink-0"
                        >
                          <UserPlus className="w-3 h-3" />
                          Add
                        </button>
                      </div>
                      {module.students.length > 0 && (
                        <ul className="space-y-1">
                          {module.students.map((s) => (
                            <li
                              key={s.id}
                              className="flex items-center gap-2 text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5"
                            >
                              <span className="flex-1 font-medium text-gray-700 truncate">
                                {s.name || s.email}
                              </span>
                              <span className="text-gray-400 truncate hidden sm:block">{s.email}</span>
                              <button
                                type="button"
                                onClick={() => handleGenerateCustomHomework(module.id, s)}
                                disabled={!!working}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] border border-emerald-200 text-emerald-700 bg-emerald-50 rounded hover:bg-emerald-100 disabled:opacity-40 shrink-0"
                                title="Generate custom homework module for this student"
                              >
                                {working === `gen-homework-${module.id}-${s.id}` ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <ClipboardCheck className="w-3 h-3" />
                                )}
                                Homework
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRemoveStudent(module.id, s.id)}
                                disabled={working === `rem-stu-${module.id}-${s.id}`}
                                className="text-red-400 hover:text-red-600 disabled:opacity-30 shrink-0"
                                title="Remove student"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ModuleOrganizer;
