import React, { useEffect, useState } from 'react';
import {
  ArrowDown, ArrowUp, Boxes, ChevronDown, ChevronRight,
  ClipboardCheck, Eye, FileText, GripVertical, Loader2,
  Plus, Search, Trash2, User, UserPlus, X,
} from 'lucide-react';
import { assessmentsAPI, contentAPI, modulesAPI, LearningModule } from '../services/api';

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
  const [students, setStudents] = useState<{ id: number; name: string; email: string }[]>([]);

  // UI
  const [moduleName, setModuleName] = useState('');
  const [libSearch, setLibSearch] = useState('');
  const [expandedContent, setExpandedContent] = useState<Set<number>>(new Set());
  const [studentByModule, setStudentByModule] = useState<Record<number, string>>({});
  const [previewTarget, setPreviewTarget] = useState<{ title: string; src: string } | null>(null);

  // Drag state
  const [isDraggingFromLib, setIsDraggingFromLib] = useState(false);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [internalDrag, setInternalDrag] = useState<{ moduleId: number; itemId: number } | null>(null);

  // Async state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => { void loadAll(); }, []);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [studentsRes, modulesRes, contentRes, assessmentsRes] = await Promise.all([
        modulesAPI.listAvailableStudents(),
        modulesAPI.list(),
        contentAPI.getMy(),
        assessmentsAPI.getPublished(),
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
                onChange={(e) => setLibSearch(e.target.value)}
                placeholder="Filter..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400"
              />
            </div>

            {/* Content section */}
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-1">
              Content ({filteredContent.length})
            </p>

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

            {/* Assessments section */}
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2 px-1">
              Assessments ({filteredAssessments.length})
            </p>
            {filteredAssessments.length === 0 ? (
              <p className="text-xs text-gray-400 px-1">No published assessments yet.</p>
            ) : (
              <div className="space-y-0.5">
                {filteredAssessments.map((item) => (
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
            )}
          </div>
        </div>

        {/* ── Modules panel ───────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-4">

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
