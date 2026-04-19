import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle, ChevronDown, ChevronRight, ExternalLink, Layers, Loader2 } from 'lucide-react';
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

function getContentParentTitle(item: LearningModuleItem) {
  if (item.item_type !== 'content') return item.title;
  if (item.section_index < 0) return item.title;
  const [baseTitle] = String(item.title || '').split(' \u203a Page ');
  return baseTitle?.trim() || item.title;
}

function getContentSectionLabel(item: LearningModuleItem) {
  if (item.item_type !== 'content' || item.section_index < 0) return item.title;
  const match = String(item.title || '').match(/: (.+)$/);
  return match?.[1]?.trim() || `Topic ${item.section_index + 1}`;
}

export default function StudentModulePlayer() {
  const [moduleData, setModuleData] = useState<LearningModule | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

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
  const navigationGroups = useMemo(() => {
    if (!moduleData) return [];

    const groups: Array<{
      key: string;
      itemType: 'content' | 'assessment';
      parentTitle: string;
      parentItem: LearningModuleItem | null;
      primaryItem: LearningModuleItem;
      subItems: LearningModuleItem[];
    }> = [];
    const contentGroupMap = new Map<string, number>();

    moduleData.items.forEach((item) => {
      if (item.item_type !== 'content') {
        groups.push({
          key: `assessment:${item.id}`,
          itemType: 'assessment',
          parentTitle: item.title,
          parentItem: item,
          primaryItem: item,
          subItems: [],
        });
        return;
      }

      const groupKey = `content:${item.item_id}:${item.code || item.id}`;
      const existingIndex = contentGroupMap.get(groupKey);

      if (existingIndex === undefined) {
        groups.push({
          key: groupKey,
          itemType: 'content',
          parentTitle: getContentParentTitle(item),
          parentItem: item.section_index < 0 ? item : null,
          primaryItem: item,
          subItems: item.section_index >= 0 ? [item] : [],
        });
        contentGroupMap.set(groupKey, groups.length - 1);
        return;
      }

      const group = groups[existingIndex];
      if (item.section_index < 0) {
        group.parentItem = item;
        group.primaryItem = item;
        group.parentTitle = item.title;
      } else {
        group.subItems.push(item);
        if (!group.parentItem) {
          group.primaryItem = group.subItems[0];
          group.parentTitle = getContentParentTitle(item);
        }
      }
    });

    return groups.map((group) => ({
      ...group,
      subItems: [...group.subItems].sort((a, b) => (a.section_index - b.section_index) || (a.position - b.position) || (a.id - b.id)),
    }));
  }, [moduleData]);

  useEffect(() => {
    if (!navigationGroups.length) return;
    setExpandedGroups((prev) => {
      const next = { ...prev };
      navigationGroups.forEach((group) => {
        if (!(group.key in next)) {
          next[group.key] = group.itemType === 'content';
        }
        if (group.subItems.some((item) => item.id === selectedItemId)) {
          next[group.key] = true;
        }
      });
      return next;
    });
  }, [navigationGroups, selectedItemId]);

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

  const toggleGroup = (groupKey: string) => {
    setExpandedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
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
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-slate-100 flex flex-col">
      <aside className="order-1 lg:fixed lg:inset-y-0 lg:left-0 lg:w-80 bg-white border-r border-slate-200 shadow-sm z-20">
        <div className="h-full overflow-y-auto p-5 space-y-5">
          <button
            type="button"
            onClick={goBackToModules}
            className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to modules
          </button>

          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="inline-flex items-center gap-2 text-sm text-emerald-700">
              <Layers className="w-4 h-4" />
              Module navigation
            </div>
            <h1 className="mt-3 text-2xl font-bold text-slate-900">{moduleData.name}</h1>
            <p className="mt-2 text-sm text-slate-600">
              {moduleData.items.length} learning item{moduleData.items.length !== 1 ? 's' : ''} in this module.
            </p>
          </div>

          {selectedItem && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <div className="text-xs uppercase tracking-wide text-slate-500">Current unit</div>
              <div className="flex items-center gap-2 text-sm text-slate-600">
                {selectedItem.item_type === 'content' ? (
                  <BookOpen className="w-4 h-4 text-blue-500" />
                ) : (
                  <CheckCircle className="w-4 h-4 text-emerald-500" />
                )}
                <span>{selectedItem.item_type === 'content' ? 'Content' : 'Assessment'}</span>
              </div>
              <h2 className="text-lg font-semibold text-slate-900">{selectedItem.title}</h2>
              <p className="text-sm text-slate-600">
                {selectedItem.item_type === 'content'
                  ? selectedItem.section_index >= 0
                    ? `Starts at section ${selectedItem.section_index + 1} inside this player.`
                    : 'Opens inside this player.'
                  : 'Launches in the assessment view.'}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <button
              type="button"
              onClick={() => updateSelection(previousItem)}
              disabled={!previousItem}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 border border-slate-300 rounded-xl text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <ArrowLeft className="w-4 h-4" />
              Previous unit
            </button>
            <button
              type="button"
              onClick={() => updateSelection(nextItem)}
              disabled={!nextItem}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 border border-slate-300 rounded-xl text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Next unit
              <ArrowRight className="w-4 h-4" />
            </button>
            {selectedItem && (
              <button
                type="button"
                onClick={openSelectedItem}
                disabled={!getItemLaunchPath(selectedItem)}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
              >
                <ExternalLink className="w-4 h-4" />
                {selectedItem.item_type === 'content' ? 'Open in new tab' : 'Take assessment'}
              </button>
            )}
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-700">Module navigation</h2>
            <div className="space-y-2">
              {navigationGroups.map((group, index) => {
                const isExpanded = !!expandedGroups[group.key];
                const isActiveGroup = group.parentItem?.id === selectedItemId || group.subItems.some((item) => item.id === selectedItemId);
                const canOpenParent = Boolean(getItemLaunchPath(group.primaryItem));
                const hasSubUnits = group.subItems.length > 0;

                return (
                  <div
                    key={group.key}
                    className={`rounded-2xl border transition-colors ${
                      isActiveGroup ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => updateSelection(group.parentItem || group.primaryItem)}
                        disabled={!canOpenParent}
                        className="flex-1 px-3 py-3 text-left rounded-l-2xl hover:bg-slate-50 disabled:cursor-not-allowed"
                      >
                        <div className="flex items-start gap-3">
                          <span className="flex items-center justify-center w-8 h-8 rounded-full bg-white border border-slate-200 text-sm font-semibold text-slate-700 shrink-0">
                            {index + 1}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              {group.itemType === 'content' ? (
                                <BookOpen className="w-4 h-4 text-blue-500 shrink-0" />
                              ) : (
                                <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                              )}
                              <span className="font-medium text-slate-900 truncate">{group.parentTitle}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span>{group.itemType === 'content' ? 'Content' : 'Assessment'}</span>
                              {group.itemType === 'content' && hasSubUnits && (
                                <span>{group.subItems.length} topic{group.subItems.length !== 1 ? 's' : ''}</span>
                              )}
                              {!canOpenParent && <span>Not available</span>}
                            </div>
                          </div>
                        </div>
                      </button>
                      {hasSubUnits && (
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.key)}
                          className="px-3 rounded-r-2xl border-l border-slate-200 text-slate-600 hover:bg-slate-50"
                          aria-label={isExpanded ? 'Collapse topics' : 'Expand topics'}
                        >
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      )}
                    </div>
                    {hasSubUnits && isExpanded && (
                      <div className="px-3 pb-3">
                        <div className="ml-11 space-y-1 border-l border-emerald-200 pl-3">
                          {group.subItems.map((subItem) => {
                            const isActiveSubItem = subItem.id === selectedItemId;
                            return (
                              <button
                                key={subItem.id}
                                type="button"
                                onClick={() => updateSelection(subItem)}
                                className={`w-full rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                                  isActiveSubItem
                                    ? 'bg-emerald-100 text-emerald-900'
                                    : 'text-slate-600 hover:bg-slate-50'
                                }`}
                              >
                                <div className="font-medium">{getContentSectionLabel(subItem)}</div>
                                <div className="text-xs text-slate-500 mt-0.5">
                                  Topic {subItem.section_index + 1}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </aside>

      <main className="order-2 flex-1 flex flex-col overflow-y-auto lg:ml-80">
        <div className="flex-1 flex flex-col px-4 py-4 lg:px-8 lg:py-6">
        <div className="flex-1 flex flex-col rounded-[28px] border border-slate-200 bg-white shadow-sm">
          {selectedItem ? (
            <div className="flex-1 flex flex-col p-4 lg:p-8 gap-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    {selectedItem.item_type === 'content' ? (
                      <BookOpen className="w-4 h-4 text-blue-500" />
                    ) : (
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    )}
                    <span>{selectedItem.item_type === 'content' ? 'Content unit' : 'Assessment unit'}</span>
                  </div>
                  <h2 className="mt-2 text-2xl lg:text-3xl font-semibold text-slate-900">{selectedItem.title}</h2>
                  <p className="mt-2 text-sm text-slate-600 max-w-3xl">
                    {selectedItem.item_type === 'content'
                      ? selectedItem.section_index >= 0
                        ? `This content starts at section ${selectedItem.section_index + 1} and stays inside the module player.`
                        : 'This content opens inline inside the module player.'
                      : 'This unit opens the student assessment flow in a focused assessment screen.'}
                  </p>
                </div>
              </div>

              {selectedItem.item_type === 'content' && getItemLaunchPath(selectedItem) ? (
                <div className="flex-1 relative rounded-[24px] border border-slate-200 overflow-hidden bg-slate-50">
                  <iframe
                    title={selectedItem.title}
                    src={getItemLaunchPath(selectedItem) ? `${getItemLaunchPath(selectedItem)}&embedded=true` : undefined}
                    className="absolute inset-0 w-full h-full bg-white"
                  />
                </div>
              ) : (
                <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-8 lg:p-12">
                  <div className="max-w-2xl space-y-4">
                    <h3 className="text-xl font-semibold text-slate-900">Ready to take this assessment</h3>
                    <p className="text-sm text-slate-600">
                      Assessments still launch in the dedicated assessment experience so students can focus without the lesson content around them.
                    </p>
                    <button
                      type="button"
                      onClick={openSelectedItem}
                      disabled={!getItemLaunchPath(selectedItem)}
                      className="inline-flex items-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Take this assessment
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="p-8 text-sm text-slate-600">Select a unit to continue.</div>
          )}
        </div>
        </div>
      </main>
    </div>
  );
}
