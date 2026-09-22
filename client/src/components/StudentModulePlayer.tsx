import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle, ChevronDown, ChevronRight, ExternalLink, Layers, Loader2 } from 'lucide-react';
import { modulesAPI } from '../services/api';
import type { LearningModule, LearningModuleItem } from '../services/api';

function getAppBasePath() {
  return '/tools';
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
  const [embeddedSections, setEmbeddedSections] = useState<Array<{ idx: number; title: string }>>([]);
  const [embeddedHasCheckpoint, setEmbeddedHasCheckpoint] = useState(false);
  const [embeddedCurrentSection, setEmbeddedCurrentSection] = useState<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

  useEffect(() => {
    setEmbeddedSections([]);
    setEmbeddedHasCheckpoint(false);
    setEmbeddedCurrentSection(null);
  }, [selectedItemId]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'mm:sections') {
        setEmbeddedSections(e.data.sections || []);
        setEmbeddedHasCheckpoint(!!e.data.hasCheckpoint);
      }
      if (e.data?.type === 'mm:sectionChange') {
        setEmbeddedCurrentSection(e.data.currentSection);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const goToEmbeddedSection = (sectionIdx: number) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'mm:goToSection', section: sectionIdx }, '*');
    setEmbeddedCurrentSection(sectionIdx);
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

          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">
              <Layers className="w-3.5 h-3.5" />
              {moduleData.name}
            </div>
          </div>

          <div className="flex-1 space-y-1">
            {navigationGroups.map((group, index) => {
              const isActiveGroup = group.parentItem?.id === selectedItemId || group.subItems.some((item) => item.id === selectedItemId);
              const canOpenParent = Boolean(getItemLaunchPath(group.primaryItem));
              const hasSubUnits = group.subItems.length > 0;
              const showSections = isActiveGroup && !hasSubUnits && embeddedSections.length > 0;
              const showSubUnits = hasSubUnits && isActiveGroup;

              return (
                <div key={group.key}>
                  <button
                    type="button"
                    onClick={() => updateSelection(group.parentItem || group.primaryItem)}
                    disabled={!canOpenParent}
                    className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors disabled:cursor-not-allowed ${
                      isActiveGroup
                        ? 'bg-emerald-50 text-emerald-900'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className={`mt-0.5 text-xs font-semibold w-5 shrink-0 ${isActiveGroup ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {group.itemType === 'content'
                          ? <BookOpen className={`w-3.5 h-3.5 shrink-0 ${isActiveGroup ? 'text-emerald-600' : 'text-primary-400'}`} />
                          : <CheckCircle className={`w-3.5 h-3.5 shrink-0 ${isActiveGroup ? 'text-emerald-600' : 'text-emerald-400'}`} />}
                        <span className="text-sm font-medium break-words leading-snug">{group.parentTitle}</span>
                      </div>
                    </div>
                  </button>

                  {(showSubUnits || showSections) && (
                    <div className="ml-8 mt-0.5 mb-1 space-y-0.5 border-l-2 border-emerald-100 pl-3">
                      {showSubUnits && group.subItems.map((subItem) => (
                        <button
                          key={subItem.id}
                          type="button"
                          onClick={() => updateSelection(subItem)}
                          className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            subItem.id === selectedItemId
                              ? 'bg-emerald-100 text-emerald-900 font-medium'
                              : 'text-slate-500 hover:bg-slate-100'
                          }`}
                        >
                          {getContentSectionLabel(subItem)}
                        </button>
                      ))}
                      {showSections && embeddedSections.map((section) => (
                        <button
                          key={section.idx}
                          type="button"
                          onClick={() => goToEmbeddedSection(section.idx)}
                          className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            embeddedCurrentSection === section.idx
                              ? 'bg-emerald-100 text-emerald-900 font-medium'
                              : 'text-slate-500 hover:bg-slate-100'
                          }`}
                        >
                          {section.title}
                        </button>
                      ))}
                      {showSections && embeddedHasCheckpoint && (
                        <button
                          type="button"
                          onClick={() => goToEmbeddedSection(-1)}
                          className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            embeddedCurrentSection === -1
                              ? 'bg-amber-100 text-amber-900 font-medium'
                              : 'text-slate-500 hover:bg-slate-100'
                          }`}
                        >
                          Knowledge checkpoint
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="pt-3 border-t border-slate-100 flex gap-2">
            <button
              type="button"
              onClick={() => updateSelection(previousItem)}
              disabled={!previousItem}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <button
              type="button"
              onClick={() => updateSelection(nextItem)}
              disabled={!nextItem}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              Next <ArrowRight className="w-3.5 h-3.5" />
            </button>
            {selectedItem?.item_type === 'assessment' && (
              <button
                type="button"
                onClick={openSelectedItem}
                disabled={!getItemLaunchPath(selectedItem)}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:bg-slate-300"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Start
              </button>
            )}
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
                      <BookOpen className="w-4 h-4 text-primary-500" />
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
                    ref={iframeRef}
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
