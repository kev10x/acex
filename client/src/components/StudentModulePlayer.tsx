import { PublicBrand } from './BrandMark';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ClipboardCheck, ExternalLink, Loader2, Sparkles, Trophy } from 'lucide-react';
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
      <div className="min-h-screen bg-app flex flex-col items-center justify-center gap-6 p-4"><PublicBrand />
        <div className="text-center">
          <Loader2 className="w-10 h-10 animate-spin text-primary-600 mx-auto" />
          <p className="mt-3 text-sm text-gray-600">Loading module...</p>
        </div>
      </div>
    );
  }

  if (error || !moduleData) {
    return (
      <div className="min-h-screen bg-app flex flex-col items-center justify-center gap-6 p-4"><PublicBrand />
        <div className="max-w-md w-full bg-white rounded-2xl border border-gray-200/70 shadow-lg p-6 text-center">
          <div className="text-rose-600 mb-3">{error || 'Module not found.'}</div>
          <button
            type="button"
            onClick={goBackToModules}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg font-semibold shadow-sm hover:bg-primary-700"
          >
            Back to modules
          </button>
        </div>
      </div>
    );
  }

  const totalSteps = moduleData.items.length;
  const stepNumber = selectedIndex >= 0 ? selectedIndex + 1 : 0;
  const progressPct = totalSteps > 0 ? Math.round((stepNumber / totalSteps) * 100) : 0;
  const isAssessment = selectedItem?.item_type === 'assessment';
  const courseName = (moduleData as any).course_name as string | null | undefined;

  return (
    <div className="min-h-screen lg:h-screen lg:overflow-hidden bg-app flex flex-col">
      <aside className="order-1 lg:fixed lg:inset-y-0 lg:left-0 lg:w-80 bg-white border-r border-gray-200/80 shadow-sm z-20 flex flex-col">
        <div className="relative overflow-hidden bg-gradient-to-br from-primary-600 via-primary-700 to-accent-700 px-5 pb-5 pt-4 text-white">
          <div className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-white/10" />
          <div className="pointer-events-none absolute -bottom-12 -left-6 h-28 w-28 rounded-full bg-accent-400/20" />
          <button
            type="button"
            onClick={goBackToModules}
            className="relative inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white/90 backdrop-blur transition-colors hover:bg-white/20"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            All modules
          </button>
          {courseName && (
            <p className="relative mt-4 text-[11px] font-semibold uppercase tracking-widest text-white/70">{courseName}</p>
          )}
          <h1 className="relative mt-1 text-lg font-bold leading-snug">{moduleData.name}</h1>
          <div className="relative mt-4">
            <div className="flex items-center justify-between text-[11px] font-medium text-white/80">
              <span>Step {stepNumber} of {totalSteps}</span>
              <span>{progressPct}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-white transition-all duration-500" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-1.5">
            {navigationGroups.map((group, index) => {
              const isActiveGroup = group.parentItem?.id === selectedItemId || group.subItems.some((item) => item.id === selectedItemId);
              const canOpenParent = Boolean(getItemLaunchPath(group.primaryItem));
              const hasSubUnits = group.subItems.length > 0;
              const showSections = isActiveGroup && !hasSubUnits && embeddedSections.length > 0;
              const showSubUnits = hasSubUnits && isActiveGroup;
              const isQuiz = group.itemType === 'assessment';

              return (
                <div key={group.key}>
                  <button
                    type="button"
                    onClick={() => updateSelection(group.parentItem || group.primaryItem)}
                    disabled={!canOpenParent}
                    className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all disabled:cursor-not-allowed ${
                      isActiveGroup
                        ? isQuiz
                          ? 'border-amber-200 bg-amber-50 shadow-sm'
                          : 'border-primary-200 bg-primary-50 shadow-sm'
                        : 'border-transparent hover:bg-gray-50'
                    }`}
                  >
                    <span
                      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm ${
                        isQuiz
                          ? 'bg-gradient-to-br from-amber-400 to-orange-500'
                          : 'bg-gradient-to-br from-primary-500 to-accent-600'
                      } ${isActiveGroup ? '' : 'opacity-80'}`}
                    >
                      {isQuiz ? <ClipboardCheck className="h-4 w-4" /> : <BookOpen className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`text-[10px] font-semibold uppercase tracking-wider ${isQuiz ? 'text-amber-600' : 'text-primary-600'}`}>
                        {index + 1} · {isQuiz ? 'Quiz' : 'Lesson'}
                      </div>
                      <div className="text-sm font-medium leading-snug text-gray-800 break-words">{group.parentTitle}</div>
                    </div>
                  </button>

                  {(showSubUnits || showSections) && (
                    <div className="ml-7 mt-1 mb-1 space-y-0.5 border-l-2 border-primary-100 pl-3">
                      {showSubUnits && group.subItems.map((subItem) => (
                        <button
                          key={subItem.id}
                          type="button"
                          onClick={() => updateSelection(subItem)}
                          className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            subItem.id === selectedItemId
                              ? 'bg-primary-100 text-primary-900 font-semibold'
                              : 'text-gray-500 hover:bg-gray-100'
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
                              ? 'bg-primary-100 text-primary-900 font-semibold'
                              : 'text-gray-500 hover:bg-gray-100'
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
                              ? 'bg-amber-100 text-amber-900 font-semibold'
                              : 'text-gray-500 hover:bg-gray-100'
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
        </div>

        <div className="border-t border-gray-100 p-4 flex gap-2">
          <button
            type="button"
            onClick={() => updateSelection(previousItem)}
            disabled={!previousItem}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-40"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Prev
          </button>
          <button
            type="button"
            onClick={() => updateSelection(nextItem)}
            disabled={!nextItem}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:bg-gray-200 disabled:text-gray-400"
          >
            Next <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </aside>

      <main className="order-2 flex-1 flex flex-col overflow-y-auto lg:ml-80">
        <div className="flex-1 flex flex-col gap-4 px-4 py-4 lg:px-8 lg:py-6">
          {selectedItem ? (
            <>
              <div className="overflow-hidden rounded-2xl border border-gray-200/70 bg-white shadow-sm">
                <div className={`h-1.5 bg-gradient-to-r ${isAssessment ? 'from-amber-400 to-orange-500' : 'from-primary-500 via-accent-500 to-accent-400'}`} />
                <div className="flex flex-wrap items-start justify-between gap-4 p-5 lg:p-6">
                  <div className="min-w-0">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
                      isAssessment ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-primary-50 text-primary-700 ring-primary-200'
                    }`}>
                      {isAssessment ? <ClipboardCheck className="h-3.5 w-3.5" /> : <BookOpen className="h-3.5 w-3.5" />}
                      {isAssessment ? 'Quiz' : 'Lesson'}
                    </span>
                    <h2 className="mt-3 text-2xl lg:text-3xl font-bold tracking-tight text-gray-900">{selectedItem.title}</h2>
                    <p className="mt-2 max-w-3xl text-sm text-gray-500">
                      {isAssessment
                        ? 'Check what you have learned. Your result is saved to your course gradebook.'
                        : selectedItem.section_index >= 0
                          ? `Continue from section ${selectedItem.section_index + 1}. Use the topics on the left to jump around.`
                          : 'Read through the lesson at your own pace, then move on to the next step.'}
                    </p>
                  </div>
                  <div className="rounded-xl bg-gray-50 px-3 py-2 text-right ring-1 ring-inset ring-gray-200">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Progress</div>
                    <div className="text-sm font-bold text-gray-800">{stepNumber} / {totalSteps}</div>
                  </div>
                </div>
              </div>

              {selectedItem.item_type === 'content' && getItemLaunchPath(selectedItem) ? (
                <div className="relative min-h-[28rem] flex-1 overflow-hidden rounded-2xl border border-gray-200/70 bg-white shadow-sm">
                  <iframe
                    ref={iframeRef}
                    title={selectedItem.title}
                    src={getItemLaunchPath(selectedItem) ? `${getItemLaunchPath(selectedItem)}&embedded=true` : undefined}
                    className="absolute inset-0 w-full h-full bg-white"
                  />
                </div>
              ) : (
                <div className="relative overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-orange-50 p-8 shadow-sm lg:p-12">
                  <div className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-amber-200/40 blur-2xl" />
                  <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center">
                    <span className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-[0_10px_24px_-8px_rgba(245,158,11,0.7)]">
                      <Trophy className="h-8 w-8" />
                    </span>
                    <div className="max-w-xl">
                      <h3 className="text-xl font-bold text-gray-900">Ready to test yourself?</h3>
                      <p className="mt-1.5 text-sm text-gray-600">
                        The quiz opens in a focused screen so you can concentrate. When you submit, it is marked for you and the result appears in your gradebook.
                      </p>
                      <button
                        type="button"
                        onClick={openSelectedItem}
                        disabled={!getItemLaunchPath(selectedItem)}
                        className="mt-5 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:from-amber-600 hover:to-orange-600 hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Sparkles className="h-4 w-4" />
                        Start the quiz
                        <ExternalLink className="h-4 w-4 opacity-80" />
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pb-2 lg:hidden">
                <button
                  type="button"
                  onClick={() => updateSelection(previousItem)}
                  disabled={!previousItem}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-600 shadow-sm disabled:opacity-40"
                >
                  <ArrowLeft className="w-4 h-4" /> Previous
                </button>
                <button
                  type="button"
                  onClick={() => updateSelection(nextItem)}
                  disabled={!nextItem}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:bg-gray-200 disabled:text-gray-400"
                >
                  Next <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-gray-200/70 bg-white p-8 text-sm text-gray-600 shadow-sm">Select a step to continue.</div>
          )}
        </div>
      </main>
    </div>
  );
}
