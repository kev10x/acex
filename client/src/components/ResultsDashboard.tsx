import React, { useState, useEffect, useMemo } from 'react';
import { Download, Eye, Trash2, BarChart3, TrendingUp, Clock, CheckCircle, FileText, ChevronDown, ChevronUp, X, FileCheck, AlertTriangle, Shield } from 'lucide-react';
import { resultsAPI, reportsAPI, rubricsAPI, MarkingResult, Rubric } from '../services/api';

type GroupByOption = 'none' | 'rubric' | 'date';

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

const ResultsDashboard: React.FC = () => {
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
  
  // Filtering and grouping state
  const [selectedRubric, setSelectedRubric] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [hourInterval, setHourInterval] = useState<string>('');
  const [groupBy, setGroupBy] = useState<GroupByOption>('none');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [resultsRes, statsRes, rubricsRes, analyticsRes] = await Promise.all([
        resultsAPI.getResults(),
        resultsAPI.getStats(),
        rubricsAPI.getRubrics(),
        resultsAPI.getAnalyticsOverview().catch(() => null) // Analytics is optional
      ]);
      setAllResults(resultsRes.data.results);
      setStats(statsRes.data.stats);
      setRubrics(rubricsRes.data.rubrics);
      if (analyticsRes?.data?.overview) {
        setAnalytics(analyticsRes.data.overview);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  const _handleExportCSV = async () => {
    try {
      const response = await resultsAPI.exportCSV();
      const blob = new Blob([response.data], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'marking_results.csv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to export CSV');
    }
  };

  // Filter and group results
  const filteredAndGroupedResults = useMemo(() => {
    let filtered = allResults;

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

    return { grouped: false, data: filtered };
  }, [allResults, selectedRubric, dateFrom, dateTo, hourInterval, groupBy]);

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
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Results Dashboard</h2>
          <p className="mt-1 text-sm text-gray-600">
            View and manage marking results.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => setShowAnalytics(!showAnalytics)}
            className="inline-flex items-center px-4 py-2 border border-primary-300 text-sm font-medium rounded-md shadow-sm text-primary-700 bg-white hover:bg-primary-50"
          >
            <BarChart3 className="w-4 h-4 mr-2" />
            {showAnalytics ? 'Hide' : 'Show'} Analytics
          </button>
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
          <div className="flex space-x-2">
            <button
              onClick={handleDeleteAllResults}
              className="inline-flex items-center px-4 py-2 border border-red-300 text-sm font-medium rounded-md shadow-sm text-red-700 bg-white hover:bg-red-50"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete All Results
            </button>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">Error</h3>
              <p className="mt-1 text-sm text-red-700">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Analytics Section */}
      {showAnalytics && analytics && (
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
      {stats && (
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

      {/* Filters and Grouping */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex flex-wrap items-end gap-4 mb-4">
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

            {(selectedRubric !== 'all' || dateFrom || dateTo || hourInterval) && (
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
      </div>

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
                <div className="text-center py-8">
                  <p className="text-gray-500">No marking results found.</p>
                  <p className="text-sm text-gray-400 mt-1">
                    {allResults.length === 0 
                      ? 'Mark some assignments to see results here.'
                      : 'Try adjusting your filters.'}
                  </p>
                </div>
              );
            }

            const renderResultsTable = (resultsToShow: MarkingResult[]) => (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Student/Assignment
                      </th>
                      {groupBy !== 'rubric' && (
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Rubric
                        </th>
                      )}
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Score
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Confidence
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Tokens / Cost
                      </th>
                      {groupBy !== 'date' && (
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Marked At
                        </th>
                      )}
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
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
                        <td className="px-6 py-4 max-w-xs">
                          <div>
                            <div className="flex items-start space-x-2 flex-wrap">
                              <div className="text-sm font-medium text-gray-900 break-words min-w-0 flex-1">
                                {result.student_name || 'Unnamed Student'}
                              </div>
                              {result.needs_review && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800 flex-shrink-0" title="Needs Human Review">
                                  <AlertTriangle className="w-3 h-3 mr-1" />
                                  Review
                                </span>
                              )}
                              {result.language_errors && result.language_errors.length > 0 && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 flex-shrink-0" title={`${result.language_errors.length} language error(s) detected`}>
                                  {result.language_errors.length} error{result.language_errors.length !== 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
                            <div className="text-sm text-gray-500 break-words mt-1">
                              {result.filename}
                            </div>
                          </div>
                        </td>
                        {groupBy !== 'rubric' && (
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {result.rubric_name}
                          </td>
                        )}
                        <td className="px-6 py-4 whitespace-nowrap">
                          {(() => {
                            const maxPoints = result.max_points || 100;
                            const percentage = ((result.total_score / maxPoints) * 100).toFixed(1);
                            return (
                              <div className="flex flex-col">
                                <span
                                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getGradeColor(
                                    result.total_score,
                                    maxPoints
                                  )}`}
                                >
                                  {result.total_score}
                                  {result.max_points ? ` / ${result.max_points}` : ''}
                                </span>
                                <span className="text-xs text-gray-500 mt-1">
                                  {isFinite(Number(percentage)) ? `${percentage}%` : 'N/A'}
                                </span>
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
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
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
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
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {formatDate(result.marked_at)}
                          </td>
                        )}
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          <div className="flex space-x-2">
                            <button
                              onClick={() => setSelectedResult(result)}
                              className="text-primary-600 hover:text-primary-900"
                              title="View Details"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleViewAnnotatedPDF(result.id)}
                              className="text-green-600 hover:text-green-900"
                              title="View Annotated PDF"
                            >
                              <FileCheck className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDownloadPDF(result.id)}
                              className="text-blue-600 hover:text-blue-900"
                              title="Download PDF Report"
                            >
                              <FileText className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteResult(result.id)}
                              className="text-red-600 hover:text-red-900"
                              title="Delete Result"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
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
          <div className="relative top-10 mx-auto p-6 border w-11/12 md:w-4/5 lg:w-3/4 xl:w-2/3 shadow-lg rounded-md bg-white max-h-[90vh] overflow-y-auto">
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

              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium text-gray-700">Assignment</h4>
                  <p className="text-sm text-gray-900">{selectedResult.filename}</p>
                  {selectedResult.student_name && (
                    <p className="text-sm text-gray-600">Student: {selectedResult.student_name}</p>
                  )}
                </div>

                <div>
                  <h4 className="text-sm font-medium text-gray-700">Rubric</h4>
                  <p className="text-sm text-gray-900">{selectedResult.rubric_name}</p>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-gray-700">Scores</h4>
                  <div className="space-y-2">
                    {(Array.isArray(selectedResult.scores) ? selectedResult.scores : []).map((score, index) => (
                      <div key={`score-${selectedResult.id}-${index}`} className="flex justify-between items-center p-2 bg-gray-50 rounded">
                        <div className="flex-1">
                          <span className="text-sm text-gray-900">{score.criterion_name}</span>
                          {score.confidence !== undefined && (
                            <div className="mt-1">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getConfidenceColor(score.confidence)}`}>
                                <Shield className="w-3 h-3 mr-1" />
                                Confidence: {score.confidence}%
                              </span>
                            </div>
                          )}
                        </div>
                        <span className="text-sm font-medium text-gray-900 ml-2">
                          {score.points_awarded}/{score.max_points}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between items-center p-2 bg-primary-50 rounded border-t">
                      <span className="text-sm font-medium text-gray-900">Total Score</span>
                      <div className="text-sm font-bold text-primary-900 flex items-center space-x-2">
                        <span>
                          {selectedResult.total_score}
                          {selectedResult.max_points ? ` / ${selectedResult.max_points}` : ''}
                        </span>
                        {selectedResult.max_points && selectedResult.max_points > 0 && (
                          <span className="text-xs font-medium text-primary-600">
                            {((selectedResult.total_score / selectedResult.max_points) * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {selectedResult.overall_confidence !== undefined && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Assessment Confidence</h4>
                    <div className="flex items-center space-x-3">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
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
                        <div className="flex items-center px-3 py-2 bg-red-50 border border-red-200 rounded-md">
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
                  <div className="mt-4">
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Handwriting recognition</h4>
                    <div className="flex items-center space-x-3">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
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
                  <div className="mt-4">
                    <h4 className="text-sm font-medium text-gray-700 mb-2">Token usage & cost</h4>
                    <div className="flex flex-wrap gap-4 text-sm text-gray-600">
                      {selectedResult.total_tokens != null && (
                        <span>{formatTokens(selectedResult.total_tokens)} total tokens</span>
                      )}
                      {selectedResult.prompt_tokens != null && (
                        <span>{formatTokens(selectedResult.prompt_tokens)} in · {formatTokens(selectedResult.completion_tokens)} out</span>
                      )}
                      {selectedResult.estimated_cost_usd != null && (
                        <span className="font-medium text-gray-900">{formatCostUsdToZar(selectedResult.estimated_cost_usd)} (≈ ${(selectedResult.estimated_cost_usd).toFixed(4)} USD)</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Comprehensive Feedback Section - Primary Focus */}
                <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-6 border-l-4 border-blue-500">
                  <div className="flex items-center mb-4">
                    <FileText className="w-6 h-6 text-blue-600 mr-2" />
                    <h4 className="text-lg font-semibold text-gray-900">Comprehensive Feedback</h4>
                  </div>
                  {selectedResult.handwriting_recognition_confidence != null && (
                    <p className="mb-3 text-sm text-gray-600">
                      Handwritten submission — recognition confidence: <span className="font-medium">{selectedResult.handwriting_recognition_confidence}%</span>
                    </p>
                  )}
                  <div className="bg-white rounded-lg p-5 shadow-sm border border-gray-200">
                    <p className="text-base text-gray-900 whitespace-pre-wrap leading-relaxed">
                      {selectedResult.feedback ?? (selectedResult as any).overall_feedback ?? 'No feedback available'}
                    </p>
                  </div>
                </div>

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
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex-1">
                              <h5 className="text-base font-semibold text-gray-900 mb-1">
                                {score.criterion_name}
                              </h5>
                              <div className="flex items-center space-x-3 text-sm">
                                <span className="text-gray-600">
                                  Score: <span className="font-semibold text-gray-900">{score.points_awarded} / {score.max_points}</span>
                                </span>
                                {score.confidence !== undefined && (
                                  <span className="text-gray-500">
                                    Confidence: {score.confidence}%
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          {score.feedback && (
                            <div className="mt-3 pt-3 border-t border-gray-100">
                              <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
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
                          <div className="flex items-start justify-between mb-2">
                            <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                              correction.type === 'correction'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-blue-100 text-blue-800'
                            }`}>
                              {correction.type === 'correction' ? 'Correction' : 'Suggestion'}
                            </span>
                            <span className="text-xs text-gray-500 font-medium">
                              {correction.criterion_name}
                            </span>
                          </div>
                          <div className="mt-2">
                            <p className="text-xs font-semibold text-gray-700 mb-1">
                              Location: <span className="font-normal">{correction.location}</span>
                            </p>
                            <p className="text-sm text-gray-800 mb-2">
                              <span className="font-semibold">Issue:</span> {correction.issue}
                            </p>
                            <p className="text-sm text-gray-800 mb-2">
                              <span className="font-semibold">
                                {correction.type === 'correction' ? 'Correction:' : 'Suggestion:'}
                              </span> {correction.correction}
                            </p>
                            <p className="text-xs text-gray-600 italic">
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
                          <div className="flex items-start justify-between mb-2">
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
                            <p className="text-xs font-semibold text-gray-700">
                              Location: <span className="font-normal">{error.location}</span>
                            </p>
                            <p className="text-sm text-red-700">
                              <span className="font-semibold">Error:</span> "{error.error_text}"
                            </p>
                            <p className="text-sm text-green-700">
                              <span className="font-semibold">Correction:</span> "{error.correction}"
                            </p>
                            <p className="text-xs text-gray-600 italic">
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

                <div className="flex space-x-2 pt-4">
                  <button
                    onClick={() => handleViewAnnotatedPDF(selectedResult.id)}
                    className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                  >
                    <FileCheck className="w-4 h-4 mr-2" />
                    View Annotated PDF
                  </button>
                  <button
                    onClick={() => handleDownloadPDF(selectedResult.id)}
                    className="inline-flex items-center px-3 py-2 border border-transparent text-sm leading-4 font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <FileText className="w-4 h-4 mr-2" />
                    Download Report
                  </button>
                </div>
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
