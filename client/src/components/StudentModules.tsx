import React, { useEffect, useState } from 'react';
import { modulesAPI } from '../services/api';
import type { LearningModule, StudentHomeworkProgressItem } from '../services/api';
import { BookOpen, Clock, Play, Users } from 'lucide-react';

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

  const getBasePath = () => {
    if (typeof window === 'undefined') return '';
    const path = window.location.pathname || '';
    if (path.startsWith('/tools')) return '/tools';
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) return '';
    if (['take-content', 'take-assessment', 'take-module'].includes(segments[0])) return '';
    return segments[0] ? `/${segments[0]}` : '';
  };

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
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600 mx-auto"></div>
          <p className="mt-3 text-sm text-gray-600">Loading your modules...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[16rem] flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-600 mb-2">⚠️ {error}</div>
          <button
            onClick={loadStudentModules}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (modules.length === 0) {
    return (
      <div className="min-h-[16rem] flex items-center justify-center">
        <div className="text-center">
          <BookOpen className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No modules assigned</h3>
          <p className="text-gray-600">You haven't been assigned to any learning modules yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {homeworkProgress.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-blue-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <Clock className="w-6 h-6 text-blue-600" />
            <h2 className="text-xl font-bold text-gray-900">Homework Progress Timeline</h2>
          </div>
          <div className="space-y-3">
            {homeworkProgress.slice(0, 8).map((entry) => {
              const improved = entry.weak_area_outcomes.filter((w) => w.status === 'improved').length;
              const declined = entry.weak_area_outcomes.filter((w) => w.status === 'declined').length;
              return (
                <div key={`progress-${entry.homework_module_id}`} className="rounded-lg border border-blue-100 bg-blue-50 p-3">
                  <p className="text-sm font-semibold text-blue-900">{entry.homework_module_name}</p>
                  <p className="text-xs text-blue-800 mt-1">
                    Attempts: {entry.attempts_total} total, {entry.completed_attempts} completed
                    {entry.latest_score_percent != null ? ` • Latest score ${entry.latest_score_percent}%` : ''}
                  </p>
                  <p className="text-xs text-blue-800">
                    Weak-area trend: {improved} improved, {declined} declined
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <Users className="w-6 h-6 text-emerald-600" />
          <h1 className="text-2xl font-bold text-gray-900">My Learning Modules</h1>
        </div>

        <div className="space-y-4">
          {modules.map((module) => {
            const firstLaunchableItem = getFirstLaunchableItem(module);

            return (
              <div
                key={module.id}
                className="border border-gray-200 rounded-lg p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900">{module.name}</h2>
                    <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
                      <Clock className="w-4 h-4" />
                      <span>{module.items.length} items</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleLaunchModule(module, firstLaunchableItem?.id)}
                    disabled={!firstLaunchableItem}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
                  >
                    <Play className="w-4 h-4" />
                    Launch Module
                  </button>
                </div>

                <div className="space-y-3">
                  {!firstLaunchableItem && (
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                      This module has been assigned to you, but it does not have any launchable items yet.
                    </div>
                  )}
                  {firstLaunchableItem && (
                    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                      <div className="flex items-start gap-3">
                        <BookOpen className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-medium text-gray-900">Open this module to view its units.</p>
                          <p className="mt-1 text-sm text-gray-600">
                            Unit navigation is available inside the module player so the landing page stays focused on your assigned modules.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
