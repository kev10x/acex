import React, { useEffect, useState } from 'react';
import { modulesAPI } from '../services/api';
import type { LearningModule, StudentHomeworkProgressItem } from '../services/api';
import { BookOpen, ClipboardCheck, Clock, GraduationCap, Loader2, Play, Sparkles } from 'lucide-react';

export default function StudentModules() {
  const [modules, setModules] = useState<LearningModule[]>([]);
  const [homeworkProgress, setHomeworkProgress] = useState<StudentHomeworkProgressItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStudentModules();
  }, []);

  const loadStudentModules = async () => {
    try {
      setLoading(true);
      setError(null);
      const [modulesRes, progressRes] = await Promise.all([
        modulesAPI.getStudentModules(),
        modulesAPI.getStudentHomeworkProgress().catch(() => ({ data: { items: [] } as any })),
      ]);
      setModules(modulesRes.data.modules || []);
      setHomeworkProgress(progressRes.data.items || []);
    } catch (err) {
      console.error('Failed to load student modules:', err);
      setError('Failed to load your modules. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const getBasePath = () => '/tools';

  const getModulePlayerUrl = (moduleId: number, itemId?: number) => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams({ module_id: String(moduleId) });
    if (itemId) params.set('item_id', String(itemId));
    return `${window.location.origin}${getBasePath()}/take-module?${params.toString()}`;
  };

  const handleLaunchModule = (module: LearningModule, itemId?: number) => {
    const url = getModulePlayerUrl(module.id, itemId);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const getFirstLaunchableItem = (module: LearningModule) =>
    [...module.items]
      .sort((a, b) => (a.position - b.position) || (a.id - b.id))
      .find((item) => Boolean(item.code)) || null;

  if (loading) {
    return (
      <div className="min-h-[16rem] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary-600" />
          <p className="mt-3 text-sm text-gray-600">Loading your modules...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[16rem] flex items-center justify-center">
        <div className="text-center">
          <div className="mb-3 text-rose-600">{error}</div>
          <button
            onClick={loadStudentModules}
            className="rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white shadow-sm hover:bg-primary-700"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (modules.length === 0) {
    return (
      <div className="flex min-h-[16rem] items-center justify-center">
        <div className="text-center">
          <span className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-50 text-primary-500 ring-1 ring-inset ring-primary-100">
            <BookOpen className="h-7 w-7" />
          </span>
          <h3 className="text-lg font-semibold text-gray-900">No modules yet</h3>
          <p className="mt-1 text-sm text-gray-500">When your lecturer shares a module with you, it will appear here.</p>
        </div>
      </div>
    );
  }

  // Group by course so a course reads as one ordered path; standalone modules go last.
  const groups: { key: string; title: string | null; modules: LearningModule[] }[] = [];
  modules.forEach((module) => {
    const title = module.course_name || null;
    const key = title || '__other';
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, title, modules: [] };
      groups.push(group);
    }
    group.modules.push(module);
  });
  groups.sort((a, b) => (a.title ? 0 : 1) - (b.title ? 0 : 1));

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary-600 via-primary-700 to-accent-700 p-6 text-white shadow-lg sm:p-8">
        <div className="pointer-events-none absolute -right-10 -top-12 h-48 w-48 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -bottom-16 left-1/3 h-40 w-40 rounded-full bg-accent-400/20" />
        <div className="relative flex items-center gap-4">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
            <GraduationCap className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">My learning</h1>
            <p className="mt-1 text-sm text-white/80">
              {modules.length} module{modules.length === 1 ? '' : 's'} across {groups.length} course{groups.length === 1 ? '' : 's'}. Pick up where you left off.
            </p>
          </div>
        </div>
      </div>

      {homeworkProgress.length > 0 && (
        <div className="rounded-2xl border border-gray-200/70 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
              <Clock className="h-5 w-5" />
            </span>
            <h2 className="text-lg font-bold text-gray-900">Homework progress</h2>
          </div>
          <div className="space-y-3">
            {homeworkProgress.slice(0, 8).map((entry) => {
              const improved = entry.weak_area_outcomes.filter((w) => w.status === 'improved').length;
              const declined = entry.weak_area_outcomes.filter((w) => w.status === 'declined').length;
              return (
                <div key={`progress-${entry.homework_module_id}`} className="rounded-xl border border-primary-100 bg-primary-50/60 p-3">
                  <p className="text-sm font-semibold text-primary-900">{entry.homework_module_name}</p>
                  <p className="mt-1 text-xs text-primary-800">
                    Attempts: {entry.attempts_total} total, {entry.completed_attempts} completed
                    {entry.latest_score_percent != null ? ` • Latest score ${entry.latest_score_percent}%` : ''}
                  </p>
                  <p className="text-xs text-primary-800">Weak-area trend: {improved} improved, {declined} declined</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key}>
          <div className="mb-3 flex items-center gap-2.5">
            <Sparkles className="h-4 w-4 text-primary-500" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500">{group.title || 'Other modules'}</h2>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">{group.modules.length}</span>
          </div>
          <div className="space-y-3">
            {group.modules.map((module, idx) => {
              const firstLaunchableItem = getFirstLaunchableItem(module);
              const lessons = module.items.filter((i) => i.item_type === 'content').length;
              const quizzes = module.items.filter((i) => i.item_type === 'assessment').length;
              return (
                <div
                  key={module.id}
                  className="group flex flex-col gap-4 rounded-2xl border border-gray-200/70 bg-white p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary-200 hover:shadow-lg sm:flex-row sm:items-center"
                >
                  <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary-500 to-accent-600 text-lg font-bold text-white shadow-[0_8px_20px_-6px_rgba(79,70,229,0.55)]">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-semibold leading-snug text-gray-900">{module.name}</h3>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      {lessons > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary-50 px-2.5 py-1 font-medium text-primary-700 ring-1 ring-inset ring-primary-100">
                          <BookOpen className="h-3 w-3" /> {lessons} lesson{lessons === 1 ? '' : 's'}
                        </span>
                      )}
                      {quizzes > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
                          <ClipboardCheck className="h-3 w-3" /> {quizzes} quiz{quizzes === 1 ? '' : 'zes'}
                        </span>
                      )}
                      {!firstLaunchableItem && <span className="text-amber-700">Nothing to open yet</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => handleLaunchModule(module, firstLaunchableItem?.id)}
                    disabled={!firstLaunchableItem}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-primary-700 hover:shadow-md disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
                  >
                    <Play className="h-4 w-4" />
                    Start
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
