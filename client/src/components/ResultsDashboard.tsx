import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Download, Eye, Trash2, BarChart3, TrendingUp, Clock, CheckCircle, FileText, ChevronDown, ChevronUp, X, FileCheck, AlertTriangle, Shield, Video, Flag, Save, RefreshCw } from 'lucide-react';
import {
  assessmentsAPI,
  resultsAPI,
  reportsAPI,
  rubricsAPI,
  markingAPI,
  MarkingResult,
  Rubric,
  SubmissionIdentityConflictResponse
} from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { ReviewMode, filterResultsByReviewMode, summarizeReviewQueue } from './resultsReview';
import StatePanel from './feedback/StatePanel';
import { DEFAULT_MARKING_LEVEL, EDUCATION_LEVEL_OPTIONS, normalizeEducationLevelValue } from '../constants/educationLevels';

type GroupByOption = 'none' | 'rubric' | 'date' | 'folder';

const USD_TO_ZAR = 18.5;

function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatCostUsdToZar(usd: number | string | null | undefined): string {
  const n = usd != null ? Number(usd) : NaN;
  if (!Number.isFinite(n)) return '—';
  const zar = n * USD_TO_ZAR;
  return `R ${zar.toFixed(2)}`;
}

function formatModeratorLabel(result: MarkingResult): string | null {
  if (result.moderation_updated_by_name) return result.moderation_updated_by_name;
  if (result.moderation_updated_by_email) return result.moderation_updated_by_email;
  if (result.moderation_updated_by != null) return `User #${result.moderation_updated_by}`;
  return null;
}

const ResultsDashboard: React.FC = () => {
  const { user } = useAuth();
  const allowDownloadResults = user?.features?.download_results !== false;
  const allowFeedbackVideo = user?.features?.feedback_video !== false;
  const normalizedRole = (user?.role === 'admin' ? 'management' : user?.role || 'lecturer').toLowerCase();
  const canModerate = normalizedRole === 'lecturer' || normalizedRole === 'management';
  const isStudent = normalizedRole === 'student';
  const [allResults, setAllResults] = useState<MarkingResult[]>([]);
  const [, setRubrics] = useState<Rubric[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    totalResults: number;
    averageScore: number;
    statusCounts: any[];
    recentResults: number;
  } | null>(null);
  const [selectedResult, setSelectedResult] = useState<MarkingResult | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [reviewMode, setReviewMode] = useState<ReviewMode>('all');
  const [reviewQueueSummary, setReviewQueueSummary] = useState({
    totalQueued: 0,
    flagged: 0,
    aiSuggested: 0,
    lowConfidence: 0,
    reviewed: 0
  });
  const [identityConflicts, setIdentityConflicts] = useState<SubmissionIdentityConflictResponse | null>(null);
  const [identityResolveBusy, setIdentityResolveBusy] = useState<number | null>(null);
  const [identityResolutionSelection, setIdentityResolutionSelection] = useState<Record<number, number>>({});
  const [feedbackVideoStatus, setFeedbackVideoStatus] = useState<'idle' | 'generating' | 'completed' | 'failed'>('idle');
  const [feedbackVideoProgress, setFeedbackVideoProgress] = useState(0);
  const [feedbackVideoError, setFeedbackVideoError] = useState<string | null>(null);
  const [feedbackVideoBlobUrl, setFeedbackVideoBlobUrl] = useState<string | null>(null);
  const [moderationReason, setModerationReason] = useState('');
  const [customFeedback, setCustomFeedback] = useState('');
  const [overrideScore, setOverrideScore] = useState('');
  const [savingModeration, setSavingModeration] = useState(false);
  const feedbackVideoPollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const feedbackVideoBlobUrlRef = React.useRef<string | null>(null);
  const [remarkPanelOpen, setRemarkPanelOpen] = useState(false);
  const [remarkOptions, setRemarkOptions] = useState<{
    assessment_type: string;
    level: string;
    provider: string;
    strictness_level: string;
    mark_as_image: boolean;
  }>({ assessment_type: 'assignment', level: DEFAULT_MARKING_LEVEL, provider: 'openai', strictness_level: 'strict', mark_as_image: false });
  const [remarking, setRemarking] = useState(false);
  const [remarkError, setRemarkError] = useState<string | null>(null);
  
  // Filtering and grouping state
  const [selectedRubric, setSelectedRubric] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [hourInterval, setHourInterval] = useState<string>('');
  const [groupBy, setGroupBy] = useState<GroupByOption>(isStudent ? 'folder' : 'none');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (isStudent) setGroupBy('folder');
  }, [isStudent]);

  useEffect(() => {
    setFeedbackVideoStatus('idle');
    setFeedbackVideoProgress(0);
    setFeedbackVideoError(null);
    if (feedbackVideoBlobUrlRef.current) {
      URL.revokeObjectURL(feedbackVideoBlobUrlRef.current);
      feedbackVideoBlobUrlRef.current = null;
      setFeedbackVideoBlobUrl(null);
    }
    if (feedbackVideoPollRef.current) {
      clearInterval(feedbackVideoPollRef.current);
      feedbackVideoPollRef.current = null;
    }
  }, [selectedResult?.id]);

  useEffect(() => {
    setModerationReason(selectedResult?.moderation_reason || '');
    setCustomFeedback(selectedResult?.custom_feedback || '');
    setOverrideScore(
      selectedResult?.override_total_score != null && Number.isFinite(Number(selectedResult.override_total_score))
        ? String(selectedResult.override_total_score)
        : ''
    );
    setRemarkPanelOpen(false);
    setRemarkError(null);
    if (selectedResult) {
      setRemarkOptions(prev => ({
        ...prev,
        provider: (selectedResult as any).provider || prev.provider,
        strictness_level: (selectedResult as any).strictness_level || prev.strictness_level,
      }));
    }
  }, [selectedResult]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (isStudent) {
        const resultsRes = await resultsAPI.getResults();
        setAllResults(resultsRes.data.results);
        setStats(null);
        setRubrics([]);
        setAnalytics(null);
        setReviewQueueSummary({
          totalQueued: 0,
          flagged: 0,
          aiSuggested: 0,
          lowConfidence: 0,
          reviewed: 0
        });
        setIdentityConflicts(null);
        return;
      }
      const [resultsRes, statsRes, rubricsRes, analyticsRes, reviewQueueRes, identityConflictRes] = await Promise.all([
        resultsAPI.getResults(),
        resultsAPI.getStats(),
        rubricsAPI.getRubrics(),
        resultsAPI.getAnalyticsOverview().catch(() => null),
        resultsAPI.getReviewQueue().catch(() => null),
        assessmentsAPI.getSubmissionIdentityConflicts({ limit: 12 }).catch(() => null)
      ]);
      setAllResults(resultsRes.data.results);
      setStats(statsRes.data.stats);
      setRubrics(rubricsRes.data.rubrics);
      setReviewQueueSummary(reviewQueueRes?.data?.summary || summarizeReviewQueue(resultsRes.data.results));
      setIdentityConflicts(identityConflictRes?.data || null);
      if (analyticsRes?.data?.overview) {
        setAnalytics(analyticsRes.data.overview);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  }, [isStudent]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!identityConflicts?.items) return;
    setIdentityResolutionSelection((prev) => {
      const next = { ...prev };
      identityConflicts.items.forEach((item) => {
        if (!next[item.id] && item.candidates.length > 0) {
          next[item.id] = item.candidates[0].id;
        }
      });
      return next;
    });
  }, [identityConflicts]);

  // Filter and group results
  const filteredAndGroupedResults = useMemo(() => {
    let filtered = filterResultsByReviewMode(allResults, reviewMode);

    // Filter by rubric
    if (selectedRubric !== 'all') {
      filtered = filtered.filter(result => result.rubric_name === selectedRubric);
    }

    // Filter by hour interval (takes precedence over date range)
    if (hourInterval) {
      const hours = parseInt(hourInterval, 10);
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - hours);
      filtered = filtered.filter(result => new Date(result.marked_at) >= cutoffTime);
    } else {
      // Filter by date range (only if hour interval is not set)
      if (dateFrom) {
        const fromDate = new Date(dateFrom);
        filtered = filtered.filter(result => new Date(result.marked_at) >= fromDate);
      }
      if (dateTo) {
        const toDate = new Date(dateTo);
        toDate.setHours(23, 59, 59, 999); // End of day
        filtered = filtered.filter(result => new Date(result.marked_at) <= toDate);
      }
    }

    // Group results
    if (groupBy === 'none') {
      return { grouped: false, data: filtered };
    }

    if (groupBy === 'rubric') {
      const grouped: Record<string, MarkingResult[]> = {};
      filtered.forEach(result => {
        const key = result.rubric_name || 'Unknown Rubric';
        if (!grouped[key]) {
          grouped[key] = [];
        }
        grouped[key].push(result);
      });
      return { grouped: true, data: grouped };
    }

    if (groupBy === 'date') {
      const grouped: Record<string, MarkingResult[]> = {};
      filtered.forEach(result => {
        const date = new Date(result.marked_at).toISOString().split('T')[0];
        if (!grouped[date]) {
          grouped[date] = [];
        }
        grouped[date].push(result);
      });
      return { grouped: true, data: grouped };
    }
    if (groupBy === 'folder') {
      const grouped: Record<string, MarkingResult[]> = {};
      filtered.forEach(result => {
        const key = result.folder_name || 'Unassigned';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(result);
      });
      return { grouped: true, data: grouped };
    }

    return { grouped: false, data: filtered };
  }, [allResults, reviewMode, selectedRubric, dateFrom, dateTo, hourInterval, groupBy]);

  // Initialize expanded groups when groupBy changes
  useEffect(() => {
    if (groupBy !== 'none' && filteredAndGroupedResults.grouped) {
      const groupedData = filteredAndGroupedResults.data as Record<string, MarkingResult[]>;
      const keys = Object.keys(groupedData);
      if (keys.length > 0) {
        setExpandedGroups(prev => {
          // Only set if currently empty
          if (prev.size === 0) {
            return new Set(keys);
          }
          // Otherwise merge new keys with existing
          const newSet = new Set(prev);
          keys.forEach(key => newSet.add(key));
          return newSet;
        });
      }
    } else if (groupBy === 'none') {
      setExpandedGroups(new Set());
    }
  }, [groupBy, filteredAndGroupedResults.grouped, filteredAndGroupedResults.data]);

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  };

  const clearFilters = () => {
    setReviewMode('all');
    setSelectedRubric('all');
    setDateFrom('');
    setDateTo('');
    setHourInterval('');
  };

  const handleDeleteResult = async (id: number) => {
    if (!window.confirm('Are you sure you want to delete this result?')) return;

    try {
      await resultsAPI.deleteResult(id);
      setAllResults(prev => prev.filter(result => result.id !== id));
      if (selectedResult?.id === id) {
        setSelectedResult(null);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete result');
    }
  };

  const handleResolveIdentityConflict = async (submissionId: number) => {
    const selectedStudentId = identityResolutionSelection[submissionId];
    if (!selectedStudentId) {
      setError('Select a student before resolving this identity conflict.');
      return;
    }
    setIdentityResolveBusy(submissionId);
    try {
      await assessmentsAPI.resolveSubmissionIdentityConflict(submissionId, selectedStudentId);
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to resolve submission identity conflict');
    } finally {
      setIdentityResolveBusy(null);
    }
  };

  const applyResultPatch = (id: number, patch: Partial<MarkingResult>) => {
    setAllResults((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setSelectedResult((prev) => (prev && prev.id === id ? { ...prev, ...patch } : prev));
  };

  const handleToggleModerationFlag = async (result: MarkingResult) => {
    try {
      const nextFlag = !result.flagged_for_moderation;
      await resultsAPI.setModerationFlag(result.id, {
        flagged: nextFlag,
        moderation_reason: moderationReason || result.moderation_reason || undefined
      });
      applyResultPatch(result.id, {
        flagged_for_moderation: nextFlag,
        moderation_reason: moderationReason || result.moderation_reason || null,
        moderation_updated_by: user?.id ?? null,
        moderation_updated_by_name: user?.name || user?.email || null,
        moderation_updated_by_email: user?.email || null,
        moderation_updated_at: new Date().toISOString()
      });
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update moderation flag');
    }
  };

  const handleSaveLecturerOverride = async () => {
    if (!selectedResult) return;
    try {
      setSavingModeration(true);
      const overrideVal = overrideScore.trim() === '' ? null : Number(overrideScore);
      await resultsAPI.saveLecturerOverride(selectedResult.id, {
        custom_feedback: customFeedback.trim() || null,
        override_total_score: overrideVal,
        moderation_reason: moderationReason.trim() || null
      });
      applyResultPatch(selectedResult.id, {
        custom_feedback: customFeedback.trim() || null,
        override_total_score: overrideVal,
        moderation_reason: moderationReason.trim() || null,
        moderation_updated_by: user?.id ?? null,
        moderation_updated_by_name: user?.name || user?.email || null,
        moderation_updated_by_email: user?.email || null,
        moderation_updated_at: new Date().toISOString(),
        effective_feedback: customFeedback.trim() || selectedResult.feedback,
        effective_total_score: overrideVal == null ? selectedResult.total_score : overrideVal
      });
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save lecturer override');
    } finally {
      setSavingModeration(false);
    }
  };

  const handleViewAnnotatedPDF = async (resultId: number) => {
    try {
      const response = await resultsAPI.getAnnotatedPDF(resultId);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      window.open(url, '_blank');
      // Clean up the URL after a delay
      setTimeout(() => window.URL.revokeObjectURL(url), 100);
    } catch (err: any) {
      if (err.response?.status === 404) {
        setError('Annotated PDF not found. This result may have been marked with report generation instead of annotation.');
      } else {
        setError(err.response?.data?.error || 'Failed to view annotated PDF');
      }
    }
  };

  const handleDownloadPDF = async (resultId: number) => {
    try {
      const response = await reportsAPI.generatePDF(resultId);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `assignment_report_${resultId}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to generate PDF report');
    }
  };

  const handleDownloadBatchPDF = async () => {
    const displayResults: MarkingResult[] = filteredAndGroupedResults.grouped 
      ? Object.values(filteredAndGroupedResults.data as Record<string, MarkingResult[]>).flat() 
      : (filteredAndGroupedResults.data as MarkingResult[]);

    if (displayResults.length === 0) {
      setError('No results available for batch download');
      return;
    }

    try {
      const resultIds = displayResults.map((result: MarkingResult) => result.id);
      const response = await reportsAPI.generateBatchPDF(resultIds);
      const blob = new Blob([response.data], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `batch_report_${new Date().toISOString().split('T')[0]}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to generate batch PDF report');
    }
  };

  const handleDeleteAllResults = () => {
    if (allResults.length === 0) {
      setError('No results to delete');
      return;
    }
    setShowDeleteConfirm(true);
  };

  const confirmDeleteAll = async () => {
    try {
      await resultsAPI.deleteAllResults();
      setAllResults([]);
      setSelectedResult(null);
      setStats(prev => prev ? { ...prev, totalResults: 0 } : null);
      setShowDeleteConfirm(false);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete all results');
    }
  };

  const handleDownloadAll = async () => {
    if (allResults.length === 0) {
      setError('No results available for download');
      return;
    }

    try {
      const response = await resultsAPI.downloadAll();
      const blob = new Blob([response.data], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `marking_results_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to download results');
    }
  };

  const handleDownloadCSV = async () => {
    const displayResults: MarkingResult[] = filteredAndGroupedResults.grouped 
      ? Object.values(filteredAndGroupedResults.data as Record<string, MarkingResult[]>).flat() 
      : (filteredAndGroupedResults.data as MarkingResult[]);

    if (displayResults.length === 0) {
      setError('No results available for download');
      return;
    }

    try {
      const response = await resultsAPI.downloadCSV();
      const blob = new Blob([response.data], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `marking_results_detailed_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to download CSV');
    }
  };

  const fetchFeedbackVideoBlob = React.useCallback(async (resultId: number) => {
    const res = await resultsAPI.getFeedbackVideoContent(resultId);
    const url = URL.createObjectURL(res.data as Blob);
    if (feedbackVideoBlobUrlRef.current) {
      URL.revokeObjectURL(feedbackVideoBlobUrlRef.current);
    }
    feedbackVideoBlobUrlRef.current = url;
    setFeedbackVideoBlobUrl(url);
    setFeedbackVideoStatus('completed');
    setFeedbackVideoError(null);
  }, []);

  const pollFeedbackVideoStatus = React.useCallback((resultId: number) => {
    if (feedbackVideoPollRef.current) return;
    const poll = async () => {
      try {
        const res = await resultsAPI.getFeedbackVideoStatus(resultId);
        const data = res.data as { status: string; progress?: number; video_url?: string; error?: string };
        setFeedbackVideoProgress(data.progress ?? 0);
        if (data.status === 'completed' && data.video_url) {
          if (feedbackVideoPollRef.current) {
            clearInterval(feedbackVideoPollRef.current);
            feedbackVideoPollRef.current = null;
          }
          await fetchFeedbackVideoBlob(resultId);
          return;
        }
        if (data.status === 'failed') {
          if (feedbackVideoPollRef.current) {
            clearInterval(feedbackVideoPollRef.current);
            feedbackVideoPollRef.current = null;
          }
          setFeedbackVideoStatus('failed');
          setFeedbackVideoError(data.error || 'Video generation failed');
        }
      } catch (_) {
        // keep polling
      }
    };
    poll();
    feedbackVideoPollRef.current = setInterval(poll, 15000);
  }, [fetchFeedbackVideoBlob]);

  const handleStartFeedbackVideo = async () => {
    if (!selectedResult) return;
    setFeedbackVideoError(null);
    setFeedbackVideoStatus('generating');
    setFeedbackVideoProgress(0);
    try {
      const res = await resultsAPI.createFeedbackVideo(selectedResult.id);
      const data = res.data as { status: string; video_url?: string };
      if (data.status === 'completed' && data.video_url) {
        await fetchFeedbackVideoBlob(selectedResult.id);
        return;
      }
      if (data.status === 'queued' || data.status === 'in_progress') {
        pollFeedbackVideoStatus(selectedResult.id);
      }
    } catch (err: any) {
      setFeedbackVideoStatus('failed');
      setFeedbackVideoError(err.response?.data?.error || err.message || 'Failed to start video');
    }
  };

  const handleRemark = async () => {
    if (!selectedResult) return;
    setRemarking(true);
    setRemarkError(null);
    try {
      const res = await markingAPI.markSingle({
        assignment_id: selectedResult.assignment_id,
        rubric_id: selectedResult.rubric_id,
        student_name: selectedResult.student_name,
        assessment_type: remarkOptions.assessment_type as any,
        level: remarkOptions.level as any,
        provider: remarkOptions.provider as any,
        strictness_level: remarkOptions.strictness_level as any,
        mark_as_image: remarkOptions.mark_as_image,
      });
      const newResult: MarkingResult = res.data.result || res.data;
      // Replace old result in list and update selectedResult
      setAllResults(prev => prev.map(r => r.assignment_id === selectedResult.assignment_id ? newResult : r));
      setSelectedResult(newResult);
      setRemarkPanelOpen(false);
    } catch (err: any) {
      setRemarkError(err.response?.data?.error || err.message || 'Re-marking failed. Please try again.');
    } finally {
      setRemarking(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getGradeColor = (score: number, maxScore: number) => {
    const percentage = (score / maxScore) * 100;
    if (percentage >= 90) return 'text-green-600 bg-green-50';
    if (percentage >= 80) return 'text-blue-600 bg-blue-50';
    if (percentage >= 70) return 'text-yellow-600 bg-yellow-50';
    if (percentage >= 60) return 'text-orange-600 bg-orange-50';
    return 'text-red-600 bg-red-50';
  };

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 80) return 'text-green-600 bg-green-50';
    if (confidence >= 60) return 'text-yellow-600 bg-yellow-50';
    return 'text-red-600 bg-red-50';
  };

  const getConfidenceLabel = (confidence: number) => {
    if (confidence >= 80) return 'High';
    if (confidence >= 60) return 'Medium';
    return 'Low';
  };

  if (loading) {
    return (
      <StatePanel variant="loading" title="Loading results" message="Collecting marking outcomes and analytics..." />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{isStudent ? 'Student Portal: My Results' : 'Results Dashboard'}</h2>
          <p className="mt-1 text-sm text-gray-600">
            {isStudent ? 'View your marked scripts grouped by folder.' : 'View and manage marking results.'}
          </p>
        </div>
        {!isStudent && <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setShowAnalytics(!showAnalytics)}
            className="inline-flex items-center px-4 py-2 border border-primary-300 text-sm font-medium rounded-md shadow-sm text-primary-700 bg-white hover:bg-primary-50"
          >
            <BarChart3 className="w-4 h-4 mr-2" />
            {showAnalytics ? 'Hide' : 'Show'} Analytics
          </button>
          {allowDownloadResults && (
            <div className="flex space-x-2">
              <button
                onClick={handleDownloadAll}
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50"
              >
                <Download className="w-4 h-4 mr-2" />
                Download All (JSON)
              </button>
              <button
                onClick={handleDownloadCSV}
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50"
              >
                <Download className="w-4 h-4 mr-2" />
                Download CSV
              </button>
              <button
                onClick={handleDownloadBatchPDF}
                className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50"
              >
                <FileText className="w-4 h-4 mr-2" />
                Download All PDFs
              </button>
            </div>
          )}
          <div className="flex space-x-2">
            <button
              onClick={handleDeleteAllResults}
              className="inline-flex items-center px-4 py-2 border border-red-300 text-sm font-medium rounded-md shadow-sm text-red-700 bg-white hover:bg-red-50"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All Results
            </button>
          </div>
        </div>}
      </div>

      {/* Error Message */}
      {error && (
        <StatePanel variant="error" title="Something went wrong" message={error} actionLabel="Retry" onAction={() => { void fetchData(); }} />
      )}

      {/* Analytics Section */}
      {!isStudent && showAnalytics && analytics && (
        <div className="bg-white shadow rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Analytics Overview</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-blue-50 p-4 rounded-lg">
              <div className="text-sm text-blue-600 font-medium">Total Markings</div>
              <div className="text-2xl font-bold text-blue-900 mt-1">{analytics.total_markings || 0}</div>
            </div>
            <div className="bg-green-50 p-4 rounded-lg">
              <div className="text-sm text-green-600 font-medium">Average Score</div>
              <div className="text-2xl font-bold text-green-900 mt-1">{analytics.average_score || '0.00'}</div>
            </div>
            <div className="bg-yellow-50 p-4 rounded-lg">
              <div className="text-sm text-yellow-600 font-medium">Min Score</div>
              <div className="text-2xl font-bold text-yellow-900 mt-1">{analytics.min_score || '0.00'}</div>
            </div>
            <div className="bg-purple-50 p-4 rounded-lg">
              <div className="text-sm text-purple-600 font-medium">Max Score</div>
              <div className="text-2xl font-bold text-purple-900 mt-1">{analytics.max_score || '0.00'}</div>
            </div>
          </div>

          {/* Score Distribution */}
          {analytics.score_distribution && analytics.score_distribution.length > 0 && (
            <div className="mb-6">
              <h4 className="text-md font-semibold text-gray-800 mb-3">Score Distribution</h4>
              <div className="space-y-2">
                {analytics.score_distribution.map((item: any, idx: number) => (
                  <div key={idx} className="flex items-center">
                    <div className="w-32 text-sm text-gray-600">{item.grade_band}</div>
                    <div className="flex-1 bg-gray-200 rounded-full h-6 mr-4">
                      <div 
                        className="bg-primary-600 h-6 rounded-full flex items-center justify-end pr-2"
                        style={{ width: `${(item.count / analytics.total_markings) * 100}%` }}
                      >
                        <span className="text-xs text-white font-medium">{item.count}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rubric Usage Stats */}
          {analytics.rubric_stats && analytics.rubric_stats.length > 0 && (
            <div className="mb-6">
              <h4 className="text-md font-semibold text-gray-800 mb-3">Rubric Usage Statistics</h4>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rubric</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Usage Count</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Avg Score</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Max Points</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {analytics.rubric_stats.map((stat: any, idx: number) => (
                      <tr key={idx}>
                        <td className="px-4 py-3 text-sm text-gray-900">{stat.rubric_name}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{stat.usage_count}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{parseFloat(stat.avg_score || 0).toFixed(2)}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{stat.max_points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Trends */}
          {analytics.trends && analytics.trends.length > 0 && (
            <div>
              <h4 className="text-md font-semibold text-gray-800 mb-3">Trends (Last 30 Days)</h4>
              <div className="space-y-2">
                {analytics.trends.slice(0, 7).map((trend: any, idx: number) => (
                  <div key={idx} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                    <span className="text-sm text-gray-600">{new Date(trend.date).toLocaleDateString()}</span>
                    <div className="flex items-center space-x-4">
                      <span className="text-sm text-gray-600">{trend.count} markings</span>
                      <span className="text-sm font-medium text-gray-900">Avg: {parseFloat(trend.avg_score || 0).toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Statistics Cards */}
      {!isStudent && stats && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <CheckCircle className="h-6 w-6 text-green-400" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">
                      Total Results
                    </dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {stats.totalResults}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <TrendingUp className="h-6 w-6 text-blue-400" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">
                      Average Score
                    </dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {stats.averageScore.toFixed(1)}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <Clock className="h-6 w-6 text-yellow-400" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">
                      Recent (7 days)
                    </dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {stats.recentResults}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white overflow-hidden shadow rounded-lg">
            <div className="p-5">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <BarChart3 className="h-6 w-6 text-purple-400" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  <dl>
                    <dt className="text-sm font-medium text-gray-500 truncate">
                      Status Counts
                    </dt>
                    <dd className="text-lg font-medium text-gray-900">
                      {stats.statusCounts.length}
                    </dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {!isStudent && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <div className="text-sm font-medium text-amber-700">Queued For Review</div>
            <div className="mt-1 text-2xl font-bold text-amber-900">{reviewQueueSummary.totalQueued}</div>
          </div>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="text-sm font-medium text-red-700">Lecturer Flagged</div>
            <div className="mt-1 text-2xl font-bold text-red-900">{reviewQueueSummary.flagged}</div>
          </div>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="text-sm font-medium text-yellow-700">AI Suggested Review</div>
            <div className="mt-1 text-2xl font-bold text-yellow-900">{reviewQueueSummary.aiSuggested}</div>
          </div>
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
            <div className="text-sm font-medium text-orange-700">Low Criterion Confidence</div>
            <div className="mt-1 text-2xl font-bold text-orange-900">{reviewQueueSummary.lowConfidence}</div>
          </div>
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="text-sm font-medium text-green-700">Reviewed</div>
            <div className="mt-1 text-2xl font-bold text-green-900">{reviewQueueSummary.reviewed}</div>
          </div>
        </div>
      )}

      {!isStudent && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Submission Identity Conflict Queue</h3>
              <p className="text-xs text-gray-500 mt-1">Resolve unresolved student identity matches for assessment submissions.</p>
            </div>
            {identityConflicts?.summary && (
              <div className="text-xs text-gray-600">
                Unresolved: {identityConflicts.summary.unresolved_submissions} | Multi-candidate: {identityConflicts.summary.multi_candidate_submissions}
              </div>
            )}
          </div>
          {!identityConflicts ? (
            <div className="mt-3 text-sm text-gray-600">Identity conflict queue is unavailable right now.</div>
          ) : (
            <div className="mt-3 overflow-x-auto border border-gray-200 rounded-lg">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Submission</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Student Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Candidates</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Assign To</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {identityConflicts.items.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-sm text-gray-500 text-center">No unresolved identity conflicts.</td>
                    </tr>
                  ) : identityConflicts.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        <div>{item.submission_code}</div>
                        <div className="text-xs text-gray-500">{item.assessment_code}</div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">{item.student_name}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{item.candidate_count}</td>
                      <td className="px-4 py-3 text-sm text-gray-700 min-w-[240px]">
                        <select
                          value={identityResolutionSelection[item.id] || ''}
                          onChange={(event) => setIdentityResolutionSelection((prev) => ({
                            ...prev,
                            [item.id]: Number(event.target.value)
                          }))}
                          className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                          disabled={item.candidates.length === 0}
                        >
                          {item.candidates.length === 0 ? (
                            <option value="">No candidates</option>
                          ) : item.candidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.name} ({candidate.match_reason})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-700">
                        <button
                          onClick={() => handleResolveIdentityConflict(item.id)}
                          disabled={item.candidates.length === 0 || identityResolveBusy === item.id}
                          className="px-3 py-1.5 rounded-md bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
                        >
                          {identityResolveBusy === item.id ? 'Resolving...' : 'Resolve'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Filters and Grouping */}
      {!isStudent && <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex flex-wrap items-end gap-4 mb-4">
            <div className="min-w-[180px]">
              <label htmlFor="reviewMode" className="block text-sm font-medium text-gray-700 mb-1">
                Review Workflow
              </label>
              <select
                id="reviewMode"
                value={reviewMode}
                onChange={(e) => setReviewMode(e.target.value as ReviewMode)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              >
                <option value="all">All Results</option>
                <option value="queue">Review Queue</option>
                <option value="reviewed">Reviewed Results</option>
              </select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label htmlFor="rubricFilter" className="block text-sm font-medium text-gray-700 mb-1">
                Filter by Rubric
              </label>
              <select
                id="rubricFilter"
                value={selectedRubric}
                onChange={(e) => setSelectedRubric(e.target.value)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              >
                <option value="all">All Rubrics</option>
                {Array.from(new Set(allResults.map(r => r.rubric_name).filter(Boolean))).map(rubricName => (
                  <option key={rubricName} value={rubricName}>{rubricName}</option>
                ))}
              </select>
            </div>

            <div className="min-w-[150px]">
              <label htmlFor="dateFrom" className="block text-sm font-medium text-gray-700 mb-1">
                From Date
              </label>
              <input
                type="date"
                id="dateFrom"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setHourInterval(''); // Clear hour interval when date is selected
                }}
                disabled={!!hourInterval}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </div>

            <div className="min-w-[150px]">
              <label htmlFor="dateTo" className="block text-sm font-medium text-gray-700 mb-1">
                To Date
              </label>
              <input
                type="date"
                id="dateTo"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setHourInterval(''); // Clear hour interval when date is selected
                }}
                disabled={!!hourInterval}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
              />
            </div>

            <div className="min-w-[150px]">
              <label htmlFor="hourInterval" className="block text-sm font-medium text-gray-700 mb-1">
                Time Interval
              </label>
              <select
                id="hourInterval"
                value={hourInterval}
                onChange={(e) => {
                  setHourInterval(e.target.value);
                  if (e.target.value) {
                    setDateFrom(''); // Clear date filters when hour interval is selected
                    setDateTo('');
                  }
                }}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              >
                <option value="">Custom Date Range</option>
                <option value="1">Last 1 Hour</option>
                <option value="3">Last 3 Hours</option>
                <option value="6">Last 6 Hours</option>
                <option value="12">Last 12 Hours</option>
                <option value="24">Last 24 Hours</option>
                <option value="48">Last 48 Hours</option>
                <option value="72">Last 72 Hours</option>
                <option value="168">Last 7 Days</option>
                <option value="720">Last 30 Days</option>
              </select>
            </div>

            <div className="min-w-[150px]">
              <label htmlFor="groupBy" className="block text-sm font-medium text-gray-700 mb-1">
                Group By
              </label>
              <select
                id="groupBy"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as GroupByOption)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
              >
                <option value="none">No Grouping</option>
                <option value="rubric">By Rubric</option>
                <option value="date">By Date</option>
              </select>
            </div>

            {(reviewMode !== 'all' || selectedRubric !== 'all' || dateFrom || dateTo || hourInterval) && (
              <button
                onClick={clearFilters}
                className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                <X className="w-4 h-4 mr-1" />
                Clear
              </button>
            )}
          </div>
        </div>
      </div>}

      {/* Results Table */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            {`Marking Results (${filteredAndGroupedResults.grouped 
              ? Object.values(filteredAndGroupedResults.data as Record<string, MarkingResult[]>).flat().length 
              : (filteredAndGroupedResults.data as MarkingResult[]).length})`}
          </h3>
          
          {(() => {
            const displayResults: MarkingResult[] = filteredAndGroupedResults.grouped 
              ? Object.values(filteredAndGroupedResults.data as Record<string, MarkingResult[]>).flat() 
              : (filteredAndGroupedResults.data as MarkingResult[]);

            if (displayResults.length === 0) {
              return (
                <StatePanel
                  variant="empty"
                  title="No marking results found"
                  message={allResults.length === 0 ? 'Mark some assignments to see results here.' : 'Try adjusting your filters.'}
                />
              );
            }

            const renderResultsTable = (resultsToShow: MarkingResult[]) => (
              <div className="overflow-x-auto">
                <table className="min-w-full table-fixed divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="w-[24%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Student/Assignment
                      </th>
                      {!isStudent && (
                        <th className="w-[12%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Review Status
                        </th>
                      )}
                      {groupBy !== 'rubric' && (
                        <th className="w-[14%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Rubric
                        </th>
                      )}
                      {groupBy !== 'folder' && (
                        <th className="w-[12%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Folder
                        </th>
                      )}
                      <th className="w-[10%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Score
                      </th>
                      <th className="w-[12%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Confidence
                      </th>
                      <th className="w-[10%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Tokens / Cost
                      </th>
                      {groupBy !== 'date' && (
                        <th className="w-[10%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Marked At
                        </th>
                      )}
                      <th className="w-[10%] px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {resultsToShow.map((result, index) => (
                      <tr 
                        key={result.id || `result-${index}`} 
                        className={`hover:bg-gray-50 ${result.needs_review ? 'bg-red-50 border-l-4 border-red-400' : ''}`}
                      >
	                        <td className="px-4 py-4 align-top">
	                          <div>
                            <div className="flex min-w-0 flex-wrap items-start gap-2">
                              <div className="min-w-0 flex-1 whitespace-normal break-words text-sm font-medium text-gray-900">
                                {result.student_name || 'Unnamed Student'}
                              </div>
                              {result.needs_review && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 flex-shrink-0" title="Needs Human Review">
                                  <AlertTriangle className="w-3 h-3 mr-1" />
                                  Review
                                </span>
                              )}
                              {result.flagged_for_moderation && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 flex-shrink-0" title="Flagged for moderation">
                                  <Flag className="w-3 h-3 mr-1" />
                                  Moderation
                                </span>
                              )}
                              {result.override_total_score != null && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 flex-shrink-0" title="Lecturer score override">
                                  Override
                                </span>
                              )}
                              {result.language_errors && result.language_errors.length > 0 && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 flex-shrink-0" title={`${result.language_errors.length} language error(s) detected`}>
                                  {result.language_errors.length} error{result.language_errors.length !== 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
	                            <div className="mt-1 text-sm text-gray-500 whitespace-normal break-words">
	                              {result.filename}
	                            </div>
	                          </div>
	                        </td>
                          {!isStudent && (
                            <td className="px-4 py-4 align-top">
                              <span
                                className={`inline-flex max-w-full items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-normal break-words ${
                                  result.review_status === 'reviewed'
                                    ? 'bg-green-100 text-green-800'
                                    : result.flagged_for_moderation
                                    ? 'bg-red-100 text-red-800'
                                    : result.needs_review || result.has_low_criterion_confidence
                                    ? 'bg-yellow-100 text-yellow-800'
                                    : 'bg-gray-100 text-gray-700'
                                }`}
                              >
                                {result.review_status === 'reviewed'
                                  ? 'Reviewed'
                                  : result.flagged_for_moderation
                                  ? 'Flagged'
                                  : result.needs_review || result.has_low_criterion_confidence
                                  ? 'Queued'
                                  : 'Normal'}
                              </span>
                            </td>
	                          )}
	                        {groupBy !== 'rubric' && (
	                          <td className="px-4 py-4 align-top text-sm text-gray-900 whitespace-normal break-words">
	                            {result.rubric_name}
	                          </td>
                        )}
                        {groupBy !== 'folder' && (
                          <td className="px-4 py-4 align-top text-sm text-gray-900 whitespace-normal break-words">
                            {result.folder_name || 'Unassigned'}
                          </td>
                        )}
                        <td className="px-4 py-4 align-top">
                          {(() => {
                            const maxPoints = result.max_points || 100;
                            const shownScore = result.effective_total_score ?? result.override_total_score ?? result.total_score;
                            const percentage = ((shownScore / maxPoints) * 100).toFixed(1);
                            return (
                              <div className="flex flex-col">
                                <span
                                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getGradeColor(
                                    shownScore,
                                    maxPoints
                                  )}`}
                                >
                                  {shownScore}
                                  {result.max_points ? ` / ${result.max_points}` : ''}
                                </span>
                                <span className="text-xs text-gray-500 mt-1">
                                  {isFinite(Number(percentage)) ? `${percentage}%` : 'N/A'}
                                </span>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="flex flex-col space-y-0.5">
                            {result.overall_confidence !== undefined ? (
                              <>
                                <div className="flex items-center space-x-2">
                                  <span
                                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getConfidenceColor(
                                      result.overall_confidence
                                    )}`}
                                    title={`Confidence: ${result.overall_confidence}%`}
                                  >
                                    <Shield className="w-3 h-3 mr-1" />
                                    {result.overall_confidence}%
                                  </span>
                                  <span className="text-xs text-gray-500">
                                    ({getConfidenceLabel(result.overall_confidence)})
                                  </span>
                                </div>
                                {result.handwriting_recognition_confidence != null && (
                                  <span className="text-xs text-gray-500" title="Handwriting recognition confidence">
                                    Handwriting: {result.handwriting_recognition_confidence}%
                                  </span>
                                )}
                              </>
                            ) : result.handwriting_recognition_confidence != null ? (
                              <span className="text-xs text-gray-600" title="Handwriting recognition confidence">
                                Handwriting: {result.handwriting_recognition_confidence}%
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">N/A</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-4 align-top text-sm text-gray-600">
                          <div className="flex flex-col">
                            <span className="text-xs">
                              {formatTokens(result.total_tokens)} tokens
                            </span>
                            <span className="text-xs text-gray-500">
                              {formatCostUsdToZar(result.estimated_cost_usd)}
                            </span>
                          </div>
                        </td>
                        {groupBy !== 'date' && (
                          <td className="px-4 py-4 align-top text-sm text-gray-500 whitespace-normal break-words">
                            {formatDate(result.marked_at)}
                          </td>
                        )}
                        <td className="px-4 py-4 align-top text-sm font-medium">
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => setSelectedResult(result)}
                              className="text-primary-600 hover:text-primary-900"
                              title="View Details"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {!isStudent && <button
                              onClick={() => handleViewAnnotatedPDF(result.id)}
                              className="text-green-600 hover:text-green-900"
                              title="View Annotated PDF"
                            >
                              <FileCheck className="w-4 h-4" />
                            </button>}
                            {!isStudent && allowDownloadResults && (
                              <button
                                onClick={() => handleDownloadPDF(result.id)}
                                className="text-blue-600 hover:text-blue-900"
                                title="Download PDF Report"
                              >
                                <FileText className="w-4 h-4" />
                              </button>
                            )}
                            {!isStudent && <button
                              onClick={() => handleDeleteResult(result.id)}
                              className="text-red-600 hover:text-red-900"
                              title="Delete Result"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>}
                            {canModerate && (
                              <button
                                onClick={() => handleToggleModerationFlag(result)}
                                className={`${result.flagged_for_moderation ? 'text-amber-700 hover:text-amber-900' : 'text-gray-500 hover:text-amber-800'}`}
                                title={result.flagged_for_moderation ? 'Remove moderation flag' : 'Flag for moderation'}
                              >
                                <Flag className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

            if (filteredAndGroupedResults.grouped) {
              const groupedData = filteredAndGroupedResults.data as Record<string, MarkingResult[]>;
              const sortedKeys = Object.keys(groupedData).sort((a, b) => {
                if (groupBy === 'date') {
                  return b.localeCompare(a); // Descending dates
                }
                return a.localeCompare(b); // Alphabetical
              });

              return (
                <div className="space-y-4">
                  {sortedKeys.map(key => {
                    const groupResults = groupedData[key];
                    const isExpanded = expandedGroups.has(key);
                    const avgScore = groupResults.reduce((sum, r) => sum + r.total_score, 0) / groupResults.length;

                    return (
                      <div key={key} className="border border-gray-200 rounded-lg overflow-hidden">
                        <button
                          onClick={() => toggleGroup(key)}
                          className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 flex justify-between items-center"
                        >
                          <div className="flex items-center space-x-3">
                            {isExpanded ? (
                              <ChevronDown className="w-5 h-5 text-gray-500" />
                            ) : (
                              <ChevronUp className="w-5 h-5 text-gray-500" />
                            )}
                            <div className="text-left">
                              <div className="font-medium text-gray-900">
                                {groupBy === 'date' 
                                  ? new Date(key).toLocaleDateString('en-US', { 
                                      year: 'numeric', 
                                      month: 'long', 
                                      day: 'numeric' 
                                    })
                                  : key}
                              </div>
                              <div className="text-sm text-gray-500">
                                {groupResults.length} result{groupResults.length !== 1 ? 's' : ''} • 
                                Avg Score: {avgScore.toFixed(1)}
                              </div>
                            </div>
                          </div>
                        </button>
                        {isExpanded && (
                          <div className="p-4">
                            {renderResultsTable(groupResults)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            }

            return renderResultsTable(displayResults);
          })()}
        </div>
      </div>

      {/* Result Detail Modal */}
      {selectedResult && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-10 mx-auto w-11/12 rounded-md border bg-white p-6 shadow-lg max-h-[90vh] overflow-y-auto md:w-11/12 lg:w-5/6 xl:w-4/5 2xl:w-3/4">
            <div className="mt-3">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-2xl font-bold text-gray-900">
                    Marking Details
                  </h3>
                  <p className="text-sm text-gray-600 mt-1">Comprehensive feedback and detailed analysis</p>
                </div>
                <button
                  onClick={() => setSelectedResult(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <span className="sr-only">Close</span>
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <h4 className="text-sm font-medium text-gray-700">Assignment</h4>
                    <p className="mt-1 text-sm text-gray-900 whitespace-normal break-words">{selectedResult.filename}</p>
                    {selectedResult.student_name && (
                      <p className="mt-2 text-sm text-gray-600 whitespace-normal break-words">Student: {selectedResult.student_name}</p>
                    )}
                    <p className="mt-1 text-sm text-gray-600 whitespace-normal break-words">Folder: {selectedResult.folder_name || 'Unassigned'}</p>
                  </div>

                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <h4 className="text-sm font-medium text-gray-700">Rubric</h4>
                    <p className="mt-1 text-sm text-gray-900 whitespace-normal break-words">{selectedResult.rubric_name}</p>
                  </div>
                </div>

                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <h4 className="mb-3 text-sm font-medium text-gray-700">Scores</h4>
                  <div className="space-y-2">
                    {(Array.isArray(selectedResult.scores) ? selectedResult.scores : []).map((score, index) => (
                      <div key={`score-${selectedResult.id}-${index}`} className="flex flex-col gap-3 rounded-lg bg-gray-50 p-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <span className="text-sm text-gray-900 whitespace-normal break-words">{score.criterion_name}</span>
                          {score.confidence !== undefined && (
                            <div className="mt-1">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getConfidenceColor(score.confidence)}`}>
                                <Shield className="w-3 h-3 mr-1" />
                                Confidence: {score.confidence}%
                              </span>
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 text-sm font-medium text-gray-900">
                          {score.points_awarded}/{score.max_points}
                        </span>
                      </div>
                    ))}
                    <div className="flex flex-col gap-2 rounded-lg border-t bg-primary-50 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm font-medium text-gray-900">Total Score</span>
                      <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-primary-900">
                        <span>
                          {(selectedResult.effective_total_score ?? selectedResult.override_total_score ?? selectedResult.total_score)}
                          {selectedResult.max_points ? ` / ${selectedResult.max_points}` : ''}
                        </span>
                        {selectedResult.max_points && selectedResult.max_points > 0 && (
                          <span className="text-xs font-medium text-primary-600">
                            {(((selectedResult.effective_total_score ?? selectedResult.override_total_score ?? selectedResult.total_score) / selectedResult.max_points) * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                {selectedResult.overall_confidence !== undefined && (
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Assessment Confidence</h4>
                    <div className="flex flex-col gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                          <span className="text-xs text-gray-600">Overall Confidence</span>
                          <span className={`text-sm font-medium ${getConfidenceColor(selectedResult.overall_confidence).split(' ')[0]}`}>
                            {selectedResult.overall_confidence}% ({getConfidenceLabel(selectedResult.overall_confidence)})
                          </span>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2">
                          <div
                            className={`h-2 rounded-full ${
                              selectedResult.overall_confidence >= 80 ? 'bg-green-500' :
                              selectedResult.overall_confidence >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${selectedResult.overall_confidence}%` }}
                          ></div>
                        </div>
                      </div>
                      {selectedResult.needs_review && (
                        <div className="flex items-center rounded-md border border-red-200 bg-red-50 px-3 py-2">
                          <AlertTriangle className="w-4 h-4 text-red-600 mr-2" />
                          <span className="text-xs text-red-800 font-medium">Needs Review</span>
                        </div>
                      )}
                    </div>
                    {selectedResult.min_criterion_confidence !== undefined && (
                      <p className="mt-2 text-xs text-gray-500">
                        Minimum criterion confidence: {selectedResult.min_criterion_confidence}%
                      </p>
                    )}
                  </div>
                )}

                {selectedResult.handwriting_recognition_confidence != null && (
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Handwriting recognition</h4>
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                          <span className="text-xs text-gray-600">How legible the handwritten submission was</span>
                          <span className={`text-sm font-medium ${getConfidenceColor(selectedResult.handwriting_recognition_confidence).split(' ')[0]}`}>
                            {selectedResult.handwriting_recognition_confidence}% ({getConfidenceLabel(selectedResult.handwriting_recognition_confidence)})
                          </span>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2">
                          <div
                            className={`h-2 rounded-full ${
                              selectedResult.handwriting_recognition_confidence >= 80 ? 'bg-green-500' :
                              selectedResult.handwriting_recognition_confidence >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                            }`}
                            style={{ width: `${selectedResult.handwriting_recognition_confidence}%` }}
                          ></div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {(selectedResult.prompt_tokens != null || selectedResult.estimated_cost_usd != null) && (
                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Token usage & cost</h4>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-gray-600">
                      {selectedResult.total_tokens != null && (
                        <span className="whitespace-normal break-words">{formatTokens(selectedResult.total_tokens)} total tokens</span>
                      )}
                      {selectedResult.prompt_tokens != null && (
                        <span>{formatTokens(selectedResult.prompt_tokens)} in · {formatTokens(selectedResult.completion_tokens)} out</span>
                      )}
                      {selectedResult.estimated_cost_usd != null && (() => {
                        const usd = Number(selectedResult.estimated_cost_usd);
                        return (
                          <span className="font-medium text-gray-900 whitespace-normal break-words">
                            {formatCostUsdToZar(selectedResult.estimated_cost_usd)}
                            {Number.isFinite(usd) ? ` (≈ $${usd.toFixed(4)} USD)` : ''}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                )}
                </div>

                {/* Comprehensive Feedback Section - Primary Focus */}
                <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-6 border-l-4 border-blue-500">
                  <div className="flex items-center mb-4">
                    <FileText className="w-6 h-6 text-blue-600 mr-2" />
                    <h4 className="text-lg font-semibold text-gray-900">Comprehensive Feedback</h4>
                  </div>
                  {selectedResult.handwriting_recognition_confidence != null && (
                    <p className="mb-3 text-sm text-gray-600 whitespace-normal break-words">
                      Handwritten submission — recognition confidence: <span className="font-medium">{selectedResult.handwriting_recognition_confidence}%</span>
                    </p>
                  )}
                  <div className="bg-white rounded-lg p-5 shadow-sm border border-gray-200">
                    <p className="text-base text-gray-900 whitespace-pre-wrap break-words leading-relaxed">
                      {selectedResult.effective_feedback || selectedResult.custom_feedback || selectedResult.feedback || (selectedResult as any).overall_feedback || 'No feedback available'}
                    </p>
                  </div>
                </div>

                {canModerate && (
                  <div className="mt-6 bg-amber-50 rounded-lg p-6 border-l-4 border-amber-500">
                    <div className="flex items-center mb-4">
                      <Flag className="w-5 h-5 text-amber-600 mr-2" />
                      <h4 className="text-lg font-semibold text-gray-900">Moderation and Lecturer Override</h4>
                    </div>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Moderation reason</label>
                        <input
                          type="text"
                          value={moderationReason}
                          onChange={(e) => setModerationReason(e.target.value)}
                          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                          placeholder="Reason for moderation or override"
                        />
                      </div>
                      {(selectedResult.moderation_updated_at || selectedResult.moderation_updated_by_name || selectedResult.moderation_updated_by_email) && (
                        <div className="rounded-md bg-white/80 border border-amber-200 px-3 py-2 text-sm text-gray-700 whitespace-normal break-words">
                          <span className="font-medium text-gray-900">Last review update:</span>{' '}
                          {formatModeratorLabel(selectedResult) || 'Unknown reviewer'}
                          {selectedResult.moderation_updated_at ? ` on ${formatDate(selectedResult.moderation_updated_at)}` : ''}
                        </div>
                      )}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Custom lecturer feedback</label>
                        <textarea
                          value={customFeedback}
                          onChange={(e) => setCustomFeedback(e.target.value)}
                          rows={4}
                          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                          placeholder="Add or edit feedback for this script"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Override total score</label>
                        <input
                          type="number"
                          min={0}
                          max={selectedResult.max_points || undefined}
                          step="0.5"
                          value={overrideScore}
                          onChange={(e) => setOverrideScore(e.target.value)}
                          className="w-full md:w-60 border border-gray-300 rounded-md px-3 py-2 text-sm"
                          placeholder="Leave blank to keep AI score"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggleModerationFlag(selectedResult)}
                          className={`inline-flex items-center px-3 py-2 rounded-md text-sm font-medium ${
                            selectedResult.flagged_for_moderation ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                        >
                          <Flag className="w-4 h-4 mr-2" />
                          {selectedResult.flagged_for_moderation ? 'Unflag moderation' : 'Flag for moderation'}
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveLecturerOverride}
                          disabled={savingModeration}
                          className="inline-flex items-center px-3 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          <Save className="w-4 h-4 mr-2" />
                          {savingModeration ? 'Saving...' : 'Save override'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Re-mark section */}
                {canModerate && (
                  <div className="mt-6 bg-emerald-50 rounded-lg p-6 border-l-4 border-emerald-500">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center">
                        <RefreshCw className="w-5 h-5 text-emerald-600 mr-2" />
                        <h4 className="text-lg font-semibold text-gray-900">Re-mark Document</h4>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setRemarkPanelOpen(o => !o); setRemarkError(null); }}
                        className="text-sm text-emerald-700 font-medium hover:text-emerald-900"
                      >
                        {remarkPanelOpen ? 'Cancel' : 'Configure & re-mark'}
                      </button>
                    </div>
                    <p className="text-sm text-gray-600 mb-3">Run AI marking again on this document, optionally with different settings. A new version will be saved and this result will be updated.</p>
                    {remarkPanelOpen && (
                      <div className="space-y-4 mt-4 border-t border-emerald-200 pt-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Assessment type</label>
                            <select
                              value={remarkOptions.assessment_type}
                              onChange={e => setRemarkOptions(o => ({ ...o, assessment_type: e.target.value }))}
                              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                            >
                              <option value="assignment">Assignment</option>
                              <option value="test">Test / Quiz</option>
                              <option value="treatise">Treatise / Dissertation</option>
                              <option value="thesis">Thesis</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Level</label>
                            <select
                              value={remarkOptions.level}
                              onChange={e => setRemarkOptions(o => ({ ...o, level: normalizeEducationLevelValue(e.target.value, DEFAULT_MARKING_LEVEL) }))}
                              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                            >
                              {EDUCATION_LEVEL_OPTIONS.filter((option) => option.value).map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">AI provider</label>
                            <select
                              value={remarkOptions.provider}
                              onChange={e => setRemarkOptions(o => ({ ...o, provider: e.target.value }))}
                              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                            >
                              <option value="openai">OpenAI</option>
                              <option value="anthropic">Anthropic (Claude)</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Strictness</label>
                            <select
                              value={remarkOptions.strictness_level}
                              onChange={e => setRemarkOptions(o => ({ ...o, strictness_level: e.target.value }))}
                              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                            >
                              <option value="very_strict">Very strict</option>
                              <option value="strict">Strict</option>
                              <option value="moderate">Moderate</option>
                              <option value="lenient">Lenient</option>
                            </select>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={remarkOptions.mark_as_image}
                            onChange={e => setRemarkOptions(o => ({ ...o, mark_as_image: e.target.checked }))}
                            className="rounded border-gray-300"
                          />
                          Mark as image (use Vision API for scanned / handwritten submissions)
                        </label>
                        {remarkError && (
                          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{remarkError}</p>
                        )}
                        <button
                          type="button"
                          onClick={handleRemark}
                          disabled={remarking}
                          className="inline-flex items-center px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-md hover:bg-emerald-700 disabled:opacity-50"
                        >
                          <RefreshCw className={`w-4 h-4 mr-2 ${remarking ? 'animate-spin' : ''}`} />
                          {remarking ? 'Re-marking…' : 'Re-mark now'}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Video explaining feedback (only when feature enabled) */}
                {allowFeedbackVideo && (
                  <div className="mt-6 bg-gradient-to-r from-violet-50 to-purple-50 rounded-lg p-6 border-l-4 border-violet-500">
                    <div className="flex items-center mb-4">
                      <Video className="w-6 h-6 text-violet-600 mr-2" />
                      <h4 className="text-lg font-semibold text-gray-900">Video explaining this feedback</h4>
                    </div>
                    <p className="text-sm text-gray-600 mb-4">
                      Watch a short video that walks through your marks and feedback for this assignment.
                    </p>
                    {feedbackVideoBlobUrl ? (
                      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                        <video
                          src={feedbackVideoBlobUrl}
                          controls
                          className="w-full max-h-[400px]"
                          playsInline
                        >
                          Your browser does not support the video tag.
                        </video>
                      </div>
                    ) : feedbackVideoStatus === 'generating' ? (
                      <div className="bg-white rounded-lg p-6 border border-gray-200">
                        <div className="flex items-center justify-center gap-3 text-violet-700">
                          <div className="animate-spin rounded-full h-8 w-8 border-2 border-violet-500 border-t-transparent" />
                          <span>Generating video… This may take a few minutes.</span>
                        </div>
                        {feedbackVideoProgress > 0 && (
                          <p className="text-sm text-gray-500 mt-2 text-center">Progress: {feedbackVideoProgress}%</p>
                        )}
                      </div>
                    ) : feedbackVideoStatus === 'failed' ? (
                      <div className="bg-white rounded-lg p-4 border border-red-200">
                        <p className="text-sm text-red-700 mb-2">{feedbackVideoError}</p>
                        <button
                          type="button"
                          onClick={handleStartFeedbackVideo}
                          className="text-sm text-violet-600 hover:text-violet-800 font-medium"
                        >
                          Try again
                        </button>
                      </div>
                    ) : (
                      <div className="bg-white rounded-lg p-6 border border-gray-200 flex flex-col items-center justify-center min-h-[120px] text-center">
                        <Video className="w-12 h-12 text-violet-300 mb-2" />
                        <p className="text-gray-500 text-sm mb-3">Generate a short video explaining this feedback (powered by Sora).</p>
                        <button
                          type="button"
                          onClick={handleStartFeedbackVideo}
                          className="inline-flex items-center px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-md hover:bg-violet-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500"
                        >
                          <Video className="w-4 h-4 mr-2" />
                          Generate video
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Per-Criterion Detailed Feedback */}
                {Array.isArray(selectedResult.scores) && selectedResult.scores.length > 0 && (
                  <div className="mt-6">
                    <div className="flex items-center mb-4">
                      <FileCheck className="w-5 h-5 text-gray-600 mr-2" />
                      <h4 className="text-lg font-semibold text-gray-900">Detailed Criterion Feedback</h4>
                    </div>
                    <div className="space-y-4">
                      {selectedResult.scores.map((score, index) => (
                        <div 
                          key={`feedback-${selectedResult.id}-${index}`}
                          className="bg-white rounded-lg p-5 shadow-sm border border-gray-200 hover:shadow-md transition-shadow"
                        >
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between mb-3">
                            <div className="flex-1">
                              <h5 className="text-base font-semibold text-gray-900 mb-1 whitespace-normal break-words">
                                {score.criterion_name}
                              </h5>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                <span className="text-gray-600 whitespace-normal break-words">
                                  Score: <span className="font-semibold text-gray-900">{score.points_awarded} / {score.max_points}</span>
                                </span>
                                {score.confidence !== undefined && (
                                  <span className="text-gray-500 whitespace-normal break-words">
                                    Confidence: {score.confidence}%
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          {score.rubric_basis && (
                            <div className="mt-3 pt-3 border-t border-gray-100">
                              <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-1">Rubric Basis</p>
                              <p className="text-sm text-indigo-900 bg-indigo-50 rounded px-3 py-2 whitespace-pre-wrap break-words leading-relaxed border border-indigo-100">
                                {score.rubric_basis}
                              </p>
                            </div>
                          )}
                          {score.feedback && (
                            <div className="mt-3 pt-3 border-t border-gray-100">
                            <p className="text-sm text-gray-700 whitespace-pre-wrap break-words leading-relaxed">
                              {score.feedback}
                            </p>
                          </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Array.isArray(selectedResult.corrections) && selectedResult.corrections.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-3">Corrections & Suggestions Report</h4>
                    <div className="space-y-3">
                      {selectedResult.corrections.map((correction, index) => (
                        <div 
                          key={`correction-${selectedResult.id}-${index}`}
                          className={`p-3 rounded-lg border-l-4 ${
                            correction.type === 'correction' 
                              ? 'bg-red-50 border-red-400' 
                              : 'bg-blue-50 border-blue-400'
                          }`}
                        >
                          <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                              correction.type === 'correction'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-blue-100 text-blue-800'
                            }`}>
                              {correction.type === 'correction' ? 'Correction' : 'Suggestion'}
                            </span>
                            <span className="text-xs text-gray-500 font-medium whitespace-normal break-words">
                              {correction.criterion_name}
                            </span>
                          </div>
                          <div className="mt-2">
                            <p className="text-xs font-semibold text-gray-700 mb-1 whitespace-normal break-words">
                              Location: <span className="font-normal">{correction.location}</span>
                            </p>
                            <p className="text-sm text-gray-800 mb-2 whitespace-pre-wrap break-words">
                              <span className="font-semibold">Issue:</span> {correction.issue}
                            </p>
                            <p className="text-sm text-gray-800 mb-2 whitespace-pre-wrap break-words">
                              <span className="font-semibold">
                                {correction.type === 'correction' ? 'Correction:' : 'Suggestion:'}
                              </span> {correction.correction}
                            </p>
                            <p className="text-xs text-gray-600 italic whitespace-pre-wrap break-words">
                              {correction.reason}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Array.isArray(selectedResult.language_errors) && selectedResult.language_errors.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-3">
                      Language Errors ({selectedResult.language_errors.length})
                    </h4>
                    <div className="space-y-2">
                      {selectedResult.language_errors.map((error: any, index: number) => (
                        <div 
                          key={`language-error-${selectedResult.id}-${index}`}
                          className={`p-3 rounded-lg border-l-4 ${
                            error.error_type === 'grammar' 
                              ? 'bg-yellow-50 border-yellow-400' 
                              : error.error_type === 'spelling'
                              ? 'bg-orange-50 border-orange-400'
                              : error.error_type === 'reference'
                              ? 'bg-purple-50 border-purple-400'
                              : error.error_type === 'punctuation'
                              ? 'bg-pink-50 border-pink-400'
                              : 'bg-indigo-50 border-indigo-400'
                          }`}
                        >
                          <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                              error.error_type === 'grammar'
                                ? 'bg-yellow-100 text-yellow-800'
                                : error.error_type === 'spelling'
                                ? 'bg-orange-100 text-orange-800'
                                : error.error_type === 'reference'
                                ? 'bg-purple-100 text-purple-800'
                                : error.error_type === 'punctuation'
                                ? 'bg-pink-100 text-pink-800'
                                : 'bg-indigo-100 text-indigo-800'
                            }`}>
                              {error.error_type.charAt(0).toUpperCase() + error.error_type.slice(1)}
                            </span>
                          </div>
                          <div className="mt-2 space-y-1">
                            <p className="text-xs font-semibold text-gray-700 whitespace-normal break-words">
                              Location: <span className="font-normal">{error.location}</span>
                            </p>
                            <p className="text-sm text-red-700 whitespace-pre-wrap break-words">
                              <span className="font-semibold">Error:</span> "{error.error_text}"
                            </p>
                            <p className="text-sm text-green-700 whitespace-pre-wrap break-words">
                              <span className="font-semibold">Correction:</span> "{error.correction}"
                            </p>
                            <p className="text-xs text-gray-600 italic whitespace-pre-wrap break-words">
                              {error.explanation}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <h4 className="text-sm font-medium text-gray-700">Marked At</h4>
                  <p className="text-sm text-gray-900">{formatDate(selectedResult.marked_at)}</p>
                </div>

                {!isStudent && <div className="flex flex-wrap gap-2 pt-4">
                  <button
                    onClick={() => handleViewAnnotatedPDF(selectedResult.id)}
                    className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                  >
                    <FileCheck className="w-4 h-4 mr-2" />
                    View Annotated PDF
                  </button>
                  {allowDownloadResults && (
                    <button
                      onClick={() => handleDownloadPDF(selectedResult.id)}
                      className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                    >
                      <FileText className="w-4 h-4 mr-2" />
                      Download Report
                    </button>
                  )}
                </div>}
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setSelectedResult(null)}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3 text-center">
              <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100">
                <Trash2 className="h-6 w-6 text-red-600" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 mt-4">Delete All Results</h3>
              <div className="mt-2 px-7 py-3">
                <p className="text-sm text-gray-500">
                  Are you sure you want to delete ALL {allResults.length} marking results? This action cannot be undone.
                </p>
              </div>
              <div className="items-center px-4 py-3">
                <button
                  onClick={confirmDeleteAll}
                  className="px-4 py-2 bg-red-500 text-white text-base font-medium rounded-md w-24 mr-2 hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-300"
                >
                  Delete
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-4 py-2 bg-gray-500 text-white text-base font-medium rounded-md w-24 hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ResultsDashboard;
