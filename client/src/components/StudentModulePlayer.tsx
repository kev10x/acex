import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle, ExternalLink, Layers, Loader2 } from 'lucide-react';
import { modulesAPI } from '../services/api';
import type { LearningModule, LearningModuleItem } from '../services/api';

function getAppBasePath() {
  if (typeof window === 'undefined') return '';
  const path = window.location.pathname || '';
  if (path.startsWith('/tools')) return '/tools';
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  if (['take-content', 'take-assessment', 'take-module'].includes(segments[0])) return '';
  return segments[0] ? `/${segments[0]}` : '';
}

function getItemLaunchPath(item: LearningModuleItem) {
  if (!item.code) return null;
  if (item.item_type === 'content') {
    const params = new URLSearchParams({ code: item.code });
    if (item.section_index >= 0) {
      params.set('section', String(item.section_index));
    }
    return `${getAppBasePath()}/take-content?${params.toString()}`;
  }
  return `${getAppBasePath()}/take-assessment?code=${encodeURIComponent(item.code)}`;
}

export default function StudentModulePlayer() {
  const [moduleData, setModuleData] = useState<LearningModule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);

  const moduleId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const raw = Number(params.get('module_id'));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }, []);

  const requestedItemId = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const raw = Number(params.get('item_id'));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }, []);

  useEffect(() => {
    const loadModule = async () => {
      if (!moduleId) {
        setError('No module was selected.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const response = await modulesAPI.getStudentModules();
        const modules = response.data.modules || [];
        const foundModule = modules.find((module) => module.id === moduleId) || null;

        if (!foundModule) {
          setError('This module could not be found.');
          setModuleData(null);
          return;
        }

        const sortedItems = [...foundModule.items].sort((a, b) => (a.position - b.position) || (a.id - b.id));
        setModuleData({ ...foundModule, items: sortedItems });

        const requestedItem = requestedItemId
          ? sortedItems.find((item) => item.id === requestedItemId)
          : null;
        const firstLaunchable = requestedItem || sortedItems.find((item) => Boolean(getItemLaunchPath(item))) || null;
        setSelectedItemId(firstLaunchable?.id || sortedItems[0]?.id || null);
      } catch (loadError) {
        console.error('Failed to load module player:', loadError);
        setError('Failed to load this module. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    loadModule();
  }, [moduleId, requestedItemId]);

  const selectedItem = moduleData?.items.find((item) => item.id === selectedItemId) || null;
  const selectedIndex = moduleData?.items.findIndex((item) => item.id === selectedItemId) ?? -1;
  const previousItem = selectedIndex > 0 && moduleData ? moduleData.items[selectedIndex - 1] : null;
  const nextItem = selectedIndex >= 0 && moduleData && selectedIndex < moduleData.items.length - 1
    ? moduleData.items[selectedIndex + 1]
    : null;

  const openSelectedItem = () => {
    if (!selectedItem) return;
    const path = getItemLaunchPath(selectedItem);
    if (!path) return;
    window.open(path, '_blank', 'noopener,noreferrer');
  };

  const updateSelection = (item: LearningModuleItem | null) => {
    if (!item) return;
    setSelectedItemId(item.id);

    const params = new URLSearchParams(window.location.search);
    params.set('module_id', String(item.module_id));
    params.set('item_id', String(item.id));
    window.history.replaceState({}, '', `${getAppBasePath()}/take-module?${params.toString()}`);
  };

  const goBackToModules = () => {
    window.location.assign(getAppBasePath() || '/');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 className="w-10 h-10 animate-spin text-emerald-600 mx-auto" />
          <p className="mt-3 text-sm text-gray-600">Loading module...</p>
        </div>
      </div>
    );
  }

  if (error || !moduleData) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-6 text-center">
          <div className="text-red-600 mb-3">{error || 'Module not found.'}</div>
          <button
            type="button"
            onClick={goBackToModules}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"
          >
            Back to modules
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
          <button
            type="button"
            onClick={goBackToModules}
            className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to modules
          </button>

          <div className="mt-4 flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">
                <Layers className="w-4 h-4" />
                Module navigation
              </div>
              <h1 className="mt-3 text-3xl font-bold text-gray-900">{moduleData.name}</h1>
              <p className="mt-2 text-sm text-gray-600">
                Move between units on the left, then open the selected content or assessment when you are ready.
              </p>
            </div>
            <div className="text-sm text-gray-500 shrink-0">{moduleData.items.length} units</div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px,1fr] gap-6">
          <aside className="bg-white rounded-2xl shadow-sm border border-gray-200 p-4 h-fit">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">Units</h2>
            <div className="space-y-2">
              {moduleData.items.map((item, index) => {
                const isActive = item.id === selectedItemId;
                const canOpen = Boolean(getItemLaunchPath(item));

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => updateSelection(item)}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                      isActive
                        ? 'border-emerald-300 bg-emerald-50'
                        : 'border-gray-200 bg-white hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="flex items-center justify-center w-8 h-8 rounded-full bg-white border border-gray-200 text-sm font-semibold text-gray-700 shrink-0">
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {item.item_type === 'content' ? (
                            <BookOpen className="w-4 h-4 text-blue-500 shrink-0" />
                          ) : (
                            <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                          )}
                          <span className="font-medium text-gray-900 truncate">{item.title}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                          <span>{item.item_type === 'content' ? 'Content' : 'Assessment'}</span>
                          {item.item_type === 'content' && item.section_index >= 0 && (
                            <span>Section {item.section_index + 1}</span>
                          )}
                          {!canOpen && <span>Not available</span>}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
            {selectedItem ? (
              <div className="space-y-6">
                <div>
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    {selectedItem.item_type === 'content' ? (
                      <BookOpen className="w-4 h-4 text-blue-500" />
                    ) : (
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    )}
                    <span>{selectedItem.item_type === 'content' ? 'Content unit' : 'Assessment unit'}</span>
                  </div>
                  <h2 className="mt-2 text-2xl font-semibold text-gray-900">{selectedItem.title}</h2>
                  <p className="mt-2 text-sm text-gray-600">
                    {selectedItem.item_type === 'content'
                      ? selectedItem.section_index >= 0
                        ? `This opens directly to section ${selectedItem.section_index + 1} inside the lesson.`
                        : 'This opens the full lesson content.'
                      : 'This opens the student assessment for this unit.'}
                  </p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={openSelectedItem}
                    disabled={!getItemLaunchPath(selectedItem)}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    <ExternalLink className="w-4 h-4" />
                    {selectedItem.item_type === 'content' ? 'Open this unit' : 'Take this assessment'}
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSelection(previousItem)}
                    disabled={!previousItem}
                    className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Previous unit
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSelection(nextItem)}
                    disabled={!nextItem}
                    className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Next unit
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-600">Select a unit to continue.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
