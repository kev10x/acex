import React, { useEffect, useState } from 'react';
import { modulesAPI } from '../services/api';
import type { LearningModule, LearningModuleItem } from '../services/api';
import { BookOpen, CheckCircle, Clock, Copy, ExternalLink, Play, Users } from 'lucide-react';

export default function StudentModules() {
  const [modules, setModules] = useState<LearningModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStudentModules();
  }, []);

  const loadStudentModules = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await modulesAPI.getStudentModules();
      setModules(response.data.modules || []);
    } catch (err) {
      console.error('Failed to load student modules:', err);
      setError('Failed to load your modules. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const getItemLaunchUrl = (item: LearningModuleItem) => {
    if (!item.code) return null;
    if (item.item_type === 'content') {
      const params = new URLSearchParams({ code: item.code });
      if (item.section_index >= 0) {
        params.set('section', String(item.section_index));
      }
      return `/take-content?${params.toString()}`;
    }
    return `/take-assessment?code=${encodeURIComponent(item.code)}`;
  };

  const getBasePath = () => {
    if (typeof window === 'undefined') return '';
    const path = window.location.pathname || '';
    if (path.startsWith('/tools')) return '/tools';
    const segments = path.split('/').filter(Boolean);
    return segments[0] ? `/${segments[0]}` : '';
  };

  const getItemShareUrl = (item: LearningModuleItem) => {
    const relativeUrl = getItemLaunchUrl(item);
    if (!relativeUrl || typeof window === 'undefined') return null;
    return `${window.location.origin}${getBasePath()}${relativeUrl}`;
  };

  const handleLaunchItem = (item: LearningModuleItem) => {
    const url = getItemLaunchUrl(item);
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const handleCopyItemUrl = async (item: LearningModuleItem) => {
    const url = getItemShareUrl(item);
    if (!url || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(url);
    } catch (error) {
      console.error('Failed to copy item URL:', error);
    }
  };

  const getFirstLaunchableItem = (module: LearningModule) =>
    [...module.items]
      .sort((a, b) => (a.position - b.position) || (a.id - b.id))
      .find((item) => Boolean(getItemLaunchUrl(item))) || null;

  const handleLaunchModule = (module: LearningModule) => {
    const firstItem = getFirstLaunchableItem(module);
    if (!firstItem) return;
    handleLaunchItem(firstItem);
  };

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
                    onClick={() => handleLaunchModule(module)}
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
                  {module.items.map((item, index) => (
                    <div key={item.id} className="p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="flex items-center justify-center w-8 h-8 bg-emerald-100 text-emerald-700 rounded-full text-sm font-medium shrink-0">
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
                              <span className={`px-2 py-1 text-xs rounded-full ${
                                item.item_type === 'content'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-emerald-100 text-emerald-700'
                              }`}>
                                {item.item_type === 'content' ? 'Content' : 'Assessment'}
                              </span>
                            </div>
                            {item.item_type === 'content' && (
                              <p className="text-sm text-gray-500 mt-1">
                                {item.section_index >= 0 ? `Section ${item.section_index + 1}` : 'Full lesson'}
                              </p>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => handleLaunchItem(item)}
                          disabled={!item.code}
                          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed shrink-0"
                        >
                          <Play className="w-4 h-4" />
                          {item.item_type === 'content' ? 'Open Content' : 'Take Assessment'}
                        </button>
                      </div>

                      {getItemShareUrl(item) && (
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                          <input
                            readOnly
                            value={getItemShareUrl(item) || ''}
                            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm text-gray-700"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleCopyItemUrl(item)}
                              className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm text-gray-700 hover:bg-gray-100"
                            >
                              <Copy className="w-4 h-4" />
                              Copy URL
                            </button>
                            <button
                              type="button"
                              onClick={() => handleLaunchItem(item)}
                              className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm text-gray-700 hover:bg-gray-100"
                            >
                              <ExternalLink className="w-4 h-4" />
                              Open Link
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
