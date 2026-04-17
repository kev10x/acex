import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Trash2, ArrowUp, ArrowDown, Boxes, UserPlus, User } from 'lucide-react';
import { assessmentsAPI, contentAPI, modulesAPI, LearningModule } from '../services/api';

type SelectOption = { type: 'content' | 'assessment'; id: number; title: string; code: string };

const ModuleOrganizer: React.FC = () => {
  const [modules, setModules] = useState<LearningModule[]>([]);
  const [publishedContent, setPublishedContent] = useState<{ id: number; title: string; code: string }[]>([]);
  const [publishedAssessments, setPublishedAssessments] = useState<{ id: number; title: string; code: string }[]>([]);
  const [moduleName, setModuleName] = useState('');
  const [selectedModuleId, setSelectedModuleId] = useState<number | null>(null);
  const [selectedItemKey, setSelectedItemKey] = useState('');
  const [availableStudents, setAvailableStudents] = useState<{ id: number; name: string; email: string }[]>([]);
  const [selectedStudentByModule, setSelectedStudentByModule] = useState<Record<number, string>>({});
  const [dragItem, setDragItem] = useState<{ moduleId: number; itemId: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    void loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [studentsRes, modulesRes, contentsRes, assessmentsRes] = await Promise.all([
        modulesAPI.listAvailableStudents(),
        modulesAPI.list(),
        contentAPI.getMy(),
        assessmentsAPI.getPublished(),
      ]);
      setAvailableStudents(studentsRes.data.students || []);
      setModules(modulesRes.data.modules || []);
      setPublishedContent((contentsRes.data.items || []).map((i: any) => ({ id: i.id, title: i.title || i.code, code: i.code })));
      setPublishedAssessments((assessmentsRes.data.items || []).map((i: any) => ({ id: i.id, title: i.title || i.code, code: i.code })));
      if (!selectedModuleId && (modulesRes.data.modules || []).length > 0) {
        setSelectedModuleId(modulesRes.data.modules[0].id);
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load modules');
    } finally {
      setLoading(false);
    }
  };

  const allOptions = useMemo<SelectOption[]>(() => {
    return [
      ...publishedContent.map((c) => ({ type: 'content' as const, id: c.id, title: c.title, code: c.code })),
      ...publishedAssessments.map((a) => ({ type: 'assessment' as const, id: a.id, title: a.title, code: a.code })),
    ];
  }, [publishedContent, publishedAssessments]);

  const handleCreateModule = async () => {
    const cleanName = moduleName.trim();
    if (!cleanName) return;
    setWorking('create');
    setError(null);
    try {
      await modulesAPI.create(cleanName);
      setModuleName('');
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to create module');
    } finally {
      setWorking(null);
    }
  };

  const handleDeleteModule = async (id: number) => {
    if (!window.confirm('Delete this module and all ordered items inside it?')) return;
    setWorking(`delete-module-${id}`);
    setError(null);
    try {
      await modulesAPI.remove(id);
      if (selectedModuleId === id) setSelectedModuleId(null);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to delete module');
    } finally {
      setWorking(null);
    }
  };

  const handleAddItem = async () => {
    if (!selectedModuleId || !selectedItemKey) return;
    const [type, idRaw] = selectedItemKey.split(':');
    const itemId = Number(idRaw);
    if (!['content', 'assessment'].includes(type) || !Number.isFinite(itemId)) return;
    setWorking('add-item');
    setError(null);
    try {
      await modulesAPI.addItem(selectedModuleId, type as 'content' | 'assessment', itemId);
      setSelectedItemKey('');
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to add item to module');
    } finally {
      setWorking(null);
    }
  };

  const handleRemoveItem = async (moduleId: number, moduleItemId: number) => {
    setWorking(`remove-item-${moduleItemId}`);
    setError(null);
    try {
      await modulesAPI.removeItem(moduleId, moduleItemId);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to remove module item');
    } finally {
      setWorking(null);
    }
  };

  const handleAddStudent = async (moduleId: number) => {
    const selected = Number(selectedStudentByModule[moduleId] || '');
    if (!Number.isFinite(selected) || selected <= 0) return;
    setWorking(`add-student-${moduleId}`);
    setError(null);
    try {
      await modulesAPI.addStudent(moduleId, selected);
      setSelectedStudentByModule((prev) => ({ ...prev, [moduleId]: '' }));
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to add student');
    } finally {
      setWorking(null);
    }
  };

  const handleRemoveStudent = async (moduleId: number, studentUserId: number) => {
    setWorking(`remove-student-${moduleId}-${studentUserId}`);
    setError(null);
    try {
      await modulesAPI.removeStudent(moduleId, studentUserId);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to remove student');
    } finally {
      setWorking(null);
    }
  };

  const moveItem = async (moduleId: number, itemId: number, direction: 'up' | 'down') => {
    const module = modules.find((m) => m.id === moduleId);
    if (!module) return;
    const current = [...module.items].sort((a, b) => (a.position - b.position) || (a.id - b.id));
    const index = current.findIndex((i) => i.id === itemId);
    if (index < 0) return;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= current.length) return;
    const next = [...current];
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    const orderedIds = next.map((i) => i.id);
    setWorking(`reorder-${moduleId}`);
    setError(null);
    try {
      await modulesAPI.reorderItems(moduleId, orderedIds);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to reorder module');
    } finally {
      setWorking(null);
    }
  };

  const reorderByDragDrop = async (moduleId: number, draggedItemId: number, targetItemId: number) => {
    const module = modules.find((m) => m.id === moduleId);
    if (!module) return;
    const ordered = [...module.items].sort((a, b) => (a.position - b.position) || (a.id - b.id));
    const fromIndex = ordered.findIndex((i) => i.id === draggedItemId);
    const toIndex = ordered.findIndex((i) => i.id === targetItemId);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
    const next = [...ordered];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const orderedIds = next.map((i) => i.id);
    setWorking(`reorder-${moduleId}`);
    setError(null);
    try {
      await modulesAPI.reorderItems(moduleId, orderedIds);
      await loadAll();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to reorder module');
    } finally {
      setWorking(null);
      setDragItem(null);
    }
  };

  return (
    <div className="mb-6 p-4 bg-indigo-50 border border-indigo-200 rounded-lg">
      <div className="flex items-center gap-2 mb-3">
        <Boxes className="w-5 h-5 text-indigo-700" />
        <h3 className="text-sm font-semibold text-indigo-900">Modules (order content and assessments)</h3>
      </div>

      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>}

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          value={moduleName}
          onChange={(e) => setModuleName(e.target.value)}
          placeholder="New module name (e.g. Module 1: Algebra)"
          className="min-w-[220px] flex-1 px-3 py-2 border border-gray-300 rounded text-sm"
        />
        <button
          type="button"
          onClick={handleCreateModule}
          disabled={working === 'create' || !moduleName.trim()}
          className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
        >
          {working === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Create module
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select
          value={selectedModuleId ?? ''}
          onChange={(e) => setSelectedModuleId(e.target.value ? Number(e.target.value) : null)}
          className="px-3 py-2 border border-gray-300 rounded text-sm min-w-[220px]"
        >
          <option value="">Select module</option>
          {modules.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
        <select
          value={selectedItemKey}
          onChange={(e) => setSelectedItemKey(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded text-sm min-w-[260px] flex-1"
        >
          <option value="">Select content/assessment to add</option>
          {allOptions.map((opt) => (
            <option key={`${opt.type}:${opt.id}`} value={`${opt.type}:${opt.id}`}>
              [{opt.type}] {opt.title} ({opt.code})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAddItem}
          disabled={!selectedModuleId || !selectedItemKey || working === 'add-item'}
          className="px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
        >
          {working === 'add-item' ? 'Adding...' : 'Add to module'}
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-gray-600">Loading modules...</div>
      ) : modules.length === 0 ? (
        <div className="text-sm text-indigo-900">No modules yet. Create one to start ordering learning pieces.</div>
      ) : (
        <div className="space-y-3">
          {modules.map((module) => (
            <div key={module.id} className="bg-white border border-indigo-100 rounded p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="font-medium text-gray-800">{module.name}</div>
                <button
                  type="button"
                  onClick={() => handleDeleteModule(module.id)}
                  disabled={working === `delete-module-${module.id}`}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                >
                  <Trash2 className="w-3 h-3" />
                  Delete module
                </button>
              </div>
              <div className="mb-3 p-2 border border-indigo-100 rounded bg-indigo-50/40">
                <div className="flex items-center gap-2 mb-2">
                  <User className="w-4 h-4 text-indigo-700" />
                  <span className="text-xs font-semibold text-indigo-900">Students in module</span>
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                  <select
                    value={selectedStudentByModule[module.id] || ''}
                    onChange={(e) => setSelectedStudentByModule((prev) => ({ ...prev, [module.id]: e.target.value }))}
                    className="px-2 py-1 border border-gray-300 rounded text-xs min-w-[220px]"
                  >
                    <option value="">Select student</option>
                    {availableStudents.map((student) => (
                      <option key={student.id} value={student.id}>
                        {student.name || student.email} ({student.email})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => handleAddStudent(module.id)}
                    disabled={!selectedStudentByModule[module.id] || working === `add-student-${module.id}`}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
                  >
                    <UserPlus className="w-3 h-3" />
                    Add student
                  </button>
                </div>
                {module.students && module.students.length > 0 ? (
                  <ul className="space-y-1">
                    {module.students.map((student) => (
                      <li key={student.id} className="flex items-center gap-2 text-xs text-gray-700 bg-white border border-gray-200 rounded px-2 py-1">
                        <span className="font-medium">{student.name || student.email}</span>
                        <span className="text-gray-500">{student.email}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveStudent(module.id, student.id)}
                          disabled={working === `remove-student-${module.id}-${student.id}`}
                          className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                        >
                          <Trash2 className="w-3 h-3" />
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-gray-600">No students assigned yet.</p>
                )}
              </div>
              {module.items.length === 0 ? (
                <p className="text-xs text-gray-600">No items yet in this module.</p>
              ) : (
                <ul className="space-y-2">
                  {module.items
                    .slice()
                    .sort((a, b) => (a.position - b.position) || (a.id - b.id))
                    .map((item, idx, arr) => (
                      <li
                        key={item.id}
                        draggable
                        onDragStart={() => setDragItem({ moduleId: module.id, itemId: item.id })}
                        onDragOver={(e) => {
                          if (dragItem?.moduleId === module.id && dragItem?.itemId !== item.id) {
                            e.preventDefault();
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragItem && dragItem.moduleId === module.id) {
                            void reorderByDragDrop(module.id, dragItem.itemId, item.id);
                          }
                        }}
                        className="flex items-center gap-2 flex-wrap text-sm text-gray-700 border border-gray-200 rounded p-2 cursor-move"
                      >
                        <span className="text-xs font-semibold text-indigo-700">#{idx + 1}</span>
                        <span className="text-xs uppercase bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">{item.item_type}</span>
                        <span className="font-medium truncate max-w-[280px]" title={item.title}>{item.title}</span>
                        <span className="text-xs text-gray-500">{item.code}</span>
                        <button
                          type="button"
                          onClick={() => moveItem(module.id, item.id, 'up')}
                          disabled={idx === 0 || working === `reorder-${module.id}`}
                          className="inline-flex items-center justify-center p-1 border border-gray-300 rounded disabled:opacity-40"
                          title="Move up"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveItem(module.id, item.id, 'down')}
                          disabled={idx === arr.length - 1 || working === `reorder-${module.id}`}
                          className="inline-flex items-center justify-center p-1 border border-gray-300 rounded disabled:opacity-40"
                          title="Move down"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(module.id, item.id)}
                          disabled={working === `remove-item-${item.id}`}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                        >
                          <Trash2 className="w-3 h-3" />
                          Remove
                        </button>
                      </li>
                    ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-gray-500">Tip: drag and drop items to reorder, or use arrows.</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModuleOrganizer;
