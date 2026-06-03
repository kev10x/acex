import React, { useState, useEffect, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { FolderPlus, Folder, Edit2, Trash2, X, Plus, Users, CalendarClock, PlayCircle, RotateCcw, Upload, CheckCircle, AlertCircle } from 'lucide-react';
import { batchesAPI, uploadAPI, rubricsAPI, Batch, Assignment, Rubric, MarkingJob } from '../services/api';

const BatchManager: React.FC = () => {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState<Batch | null>(null);
  const [showAssignModal, setShowAssignModal] = useState<Batch | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState<Batch | null>(null);
  const [newBatchName, setNewBatchName] = useState('');
  const [newBatchDescription, setNewBatchDescription] = useState('');
  const [selectedAssignments, setSelectedAssignments] = useState<number[]>([]);
  const [selectedAssignmentsToRemove, setSelectedAssignmentsToRemove] = useState<number[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [jobs, setJobs] = useState<MarkingJob[]>([]);
  const [selectedRubricId, setSelectedRubricId] = useState<number | ''>('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [showUploadModal, setShowUploadModal] = useState<Batch | null>(null);
  const [uploadResults, setUploadResults] = useState<{ name: string; ok: boolean; error?: string }[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const res = await batchesAPI.getAllJobs();
        setJobs(res.data.jobs || []);
      } catch {
        // Keep current UI state if polling fails.
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [batchesRes, assignmentsRes] = await Promise.all([
        batchesAPI.getBatches(),
        uploadAPI.getAssignments()
      ]);
      setBatches(batchesRes.data.batches);
      setAssignments(assignmentsRes.data.assignments);
      const [rubricsRes, jobsRes] = await Promise.all([rubricsAPI.getRubrics(), batchesAPI.getAllJobs()]);
      setRubrics(rubricsRes.data.rubrics || []);
      setJobs(jobsRes.data.jobs || []);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateBatch = async () => {
    if (!newBatchName.trim()) {
      setError('Batch name is required');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await batchesAPI.createBatch({
        name: newBatchName.trim(),
        description: newBatchDescription.trim() || undefined
      });
      setSuccess('Batch created successfully');
      setNewBatchName('');
      setNewBatchDescription('');
      setShowCreateModal(false);
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create batch');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateBatch = async () => {
    if (!showEditModal || !newBatchName.trim()) {
      setError('Batch name is required');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await batchesAPI.updateBatch(showEditModal.id, {
        name: newBatchName.trim(),
        description: newBatchDescription.trim() || undefined
      });
      setSuccess('Batch updated successfully');
      setShowEditModal(null);
      setNewBatchName('');
      setNewBatchDescription('');
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update batch');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteBatch = async (batch: Batch) => {
    if (!window.confirm(`Are you sure you want to delete batch "${batch.name}"? Assignments will be removed from this batch but not deleted.`)) {
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await batchesAPI.deleteBatch(batch.id);
      setSuccess('Batch deleted successfully');
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete batch');
    } finally {
      setLoading(false);
    }
  };

  const handleAssignToBatch = async () => {
    if (!showAssignModal || (selectedAssignments.length === 0 && selectedAssignmentsToRemove.length === 0)) {
      setError('Please select at least one change');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      if (selectedAssignments.length > 0) {
        await batchesAPI.assignToBatch(showAssignModal.id, selectedAssignments);
      }
      if (selectedAssignmentsToRemove.length > 0) {
        await batchesAPI.unassignFromBatch(showAssignModal.id, selectedAssignmentsToRemove);
      }
      const messages = [];
      if (selectedAssignments.length > 0) {
        messages.push(`added ${selectedAssignments.length}`);
      }
      if (selectedAssignmentsToRemove.length > 0) {
        messages.push(`removed ${selectedAssignmentsToRemove.length}`);
      }
      setSuccess(`Batch contents updated: ${messages.join(', ')}`);
      setShowAssignModal(null);
      setSelectedAssignments([]);
      setSelectedAssignmentsToRemove([]);
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update batch contents');
    } finally {
      setLoading(false);
    }
  };

  const handleScheduleMarking = async () => {
    if (!showScheduleModal) return;
    if (!selectedRubricId) {
      setError('Please select a rubric for marking');
      return;
    }
    try {
      setLoading(true);
      setError(null);
      await batchesAPI.scheduleMarking(showScheduleModal.id, {
        rubric_id: Number(selectedRubricId),
        scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : undefined
      });
      setSuccess('Batch marking job scheduled');
      setShowScheduleModal(null);
      setSelectedRubricId('');
      setScheduledFor('');
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to schedule marking');
    } finally {
      setLoading(false);
    }
  };

  const onDropToBatch = useCallback(async (acceptedFiles: File[]) => {
    if (!showUploadModal || acceptedFiles.length === 0) return;
    setUploading(true);
    const results: { name: string; ok: boolean; error?: string }[] = [];
    for (const file of acceptedFiles) {
      try {
        const isZip = file.type === 'application/zip' || file.name.toLowerCase().endsWith('.zip');
        if (isZip) {
          await uploadAPI.uploadZip(file, showUploadModal.id);
        } else {
          await uploadAPI.uploadSingle(file, showUploadModal.id);
        }
        results.push({ name: file.name, ok: true });
      } catch (err: any) {
        results.push({ name: file.name, ok: false, error: err.response?.data?.error || err.message });
      }
    }
    setUploadResults(prev => [...results, ...prev]);
    setUploading(false);
    fetchData();
  }, [showUploadModal]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onDropToBatch,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/json': ['.json'],
      'application/xml': ['.xml'],
      'application/javascript': ['.js'],
      'text/html': ['.html'],
      'text/css': ['.css', '.scss', '.sass'],
      'text/plain': [
        '.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
        '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.kts', '.scala', '.r', '.m',
        '.sql', '.sh', '.bash', '.zsh', '.ps1', '.pl', '.lua', '.dart', '.yaml', '.yml',
        '.toml', '.ini', '.cfg', '.md', '.txt'
      ],
      'application/zip': ['.zip'],
    },
    disabled: uploading,
  });

  const handleRunNow = async (job: MarkingJob) => {
    try {
      setError(null);
      await batchesAPI.runJobNow(job.id);
      setSuccess(`Job started for "${job.batch_name || `Folder #${job.batch_id}`}"`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to start job');
    }
  };

  const handleRetry = async (job: MarkingJob) => {
    try {
      setError(null);
      await batchesAPI.retryJob(job.id);
      setSuccess(`Retrying failed assignments for "${job.batch_name || `Folder #${job.batch_id}`}"`);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to retry job');
    }
  };

  const openEditModal = (batch: Batch) => {
    setShowEditModal(batch);
    setNewBatchName(batch.name);
    setNewBatchDescription(batch.description || '');
  };

  const openAssignModal = (batch: Batch) => {
    setShowAssignModal(batch);
    setSelectedAssignments([]);
    setSelectedAssignmentsToRemove([]);
  };

  const openScheduleModal = (batch: Batch) => {
    setShowScheduleModal(batch);
    setSelectedRubricId('');
    setScheduledFor('');
  };

  const getUnassignedAssignments = () => {
    return assignments.filter(a => !a.batch_id);
  };
  const getAssignmentsForBatch = (batchId: number) => {
    return assignments.filter((a) => a.batch_id === batchId);
  };
  const getMovableAssignments = (batchId: number) => {
    return assignments.filter((assignment) => assignment.batch_id !== batchId);
  };
  const getBatchName = (batchId?: number | null) => {
    if (!batchId) return 'Unassigned';
    return batches.find((batch) => batch.id === batchId)?.name || `Folder #${batchId}`;
  };

  const getJobProgress = (job: MarkingJob) => {
    if (!job.total_count || job.total_count <= 0) return 0;
    return Math.min(100, Math.round((job.processed_count / job.total_count) * 100));
  };

  if (loading && batches.length === 0) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-gray-500">Loading batches...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Batch Management</h2>
          <p className="text-sm text-gray-500 mt-1">Organize assignments into batches for easier management</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
        >
          <FolderPlus className="h-5 w-5 mr-2" />
          Create Batch
        </button>
      </div>

      {/* Messages */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
          {success}
        </div>
      )}

      {/* Progress report */}
      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-indigo-900 mb-3">Marking progress report</h3>
        {jobs.length === 0 ? (
          <p className="text-sm text-indigo-700">No batch jobs yet. Schedule one from a folder card.</p>
        ) : (
          <div className="space-y-3">
            {jobs.slice(0, 6).map((job) => (
              <div key={job.id} className="bg-white border border-indigo-100 rounded-md p-3">
                <div className="flex justify-between items-start text-sm mb-1">
                  <span className="font-medium text-gray-800">{job.batch_name || `Folder #${job.batch_id}`}</span>
                  <div className="flex items-center gap-2">
                    {job.status === 'scheduled' && job.processing_mode === 'standard' && (
                      <button
                        onClick={() => handleRunNow(job)}
                        title="Start marking now"
                        className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:text-indigo-900"
                      >
                        <PlayCircle className="h-4 w-4" />
                        Run now
                      </button>
                    )}
                    {(job.status === 'failed' || job.status === 'completed_with_errors') && (
                      <button
                        onClick={() => handleRetry(job)}
                        title="Retry failed assignments"
                        className="inline-flex items-center gap-1 text-xs font-medium text-orange-600 hover:text-orange-800"
                      >
                        <RotateCcw className="h-4 w-4" />
                        Retry
                      </button>
                    )}
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      job.status === 'completed' ? 'bg-green-100 text-green-700' :
                      job.status === 'completed_with_errors' ? 'bg-yellow-100 text-yellow-700' :
                      job.status === 'failed' ? 'bg-red-100 text-red-700' :
                      job.status === 'running' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>{job.status}</span>
                  </div>
                </div>
                <div className="w-full h-2 bg-gray-200 rounded">
                  <div className="h-2 bg-indigo-600 rounded" style={{ width: `${getJobProgress(job)}%` }} />
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  {job.processed_count}/{job.total_count} processed • {job.success_count} succeeded • {job.failed_count} failed
                </div>
                {job.last_error && (job.status === 'failed' || job.status === 'completed_with_errors') && (
                  <div className="text-xs text-red-600 mt-1 truncate" title={job.last_error}>
                    {job.last_error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Batches List */}
      {batches.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <Folder className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No batches yet</h3>
          <p className="text-gray-500 mb-4">Create your first batch to organize assignments</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
          >
            <Plus className="h-5 w-5 mr-2" />
            Create Batch
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {getUnassignedAssignments().length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-yellow-900 mb-2">Unassigned uploads</h3>
              <div className="text-sm text-yellow-800 space-y-1 max-h-36 overflow-y-auto">
                {getUnassignedAssignments().slice(0, 8).map((assignment) => (
                  <div key={assignment.id} className="truncate">- {assignment.filename}</div>
                ))}
                {getUnassignedAssignments().length > 8 && (
                  <div className="text-xs text-yellow-700">+ {getUnassignedAssignments().length - 8} more</div>
                )}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {batches.map((batch) => (
            <div key={batch.id} className="bg-white rounded-lg shadow p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center">
                  <Folder className="h-8 w-8 text-primary-600 mr-3" />
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{batch.name}</h3>
                    {batch.description && (
                      <p className="text-sm text-gray-500 mt-1">{batch.description}</p>
                    )}
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => openEditModal(batch)}
                    className="text-gray-400 hover:text-gray-600"
                    title="Edit batch"
                  >
                    <Edit2 className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => handleDeleteBatch(batch)}
                    className="text-gray-400 hover:text-red-600"
                    title="Delete batch"
                  >
                    <Trash2 className="h-5 w-5" />
                  </button>
                </div>
              </div>
              
              <div className="flex items-center justify-between text-sm text-gray-600 mb-4">
                <div className="flex items-center">
                  <Users className="h-4 w-4 mr-1" />
                  <span>{batch.assignment_count || 0} assignment(s)</span>
                </div>
                <span className="text-xs text-gray-400">
                  {new Date(batch.created_at).toLocaleDateString()}
                </span>
              </div>

              <div className="mt-2 p-3 bg-gray-50 rounded border border-gray-100">
                <p className="text-xs font-semibold text-gray-700 mb-2">Uploaded docs in this folder</p>
                {getAssignmentsForBatch(batch.id).length === 0 ? (
                  <p className="text-xs text-gray-500">No docs yet</p>
                ) : (
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {getAssignmentsForBatch(batch.id).slice(0, 6).map((assignment) => (
                      <div key={assignment.id} className="text-xs text-gray-700 truncate">- {assignment.filename}</div>
                    ))}
                    {getAssignmentsForBatch(batch.id).length > 6 && (
                      <div className="text-xs text-gray-500">+ {getAssignmentsForBatch(batch.id).length - 6} more</div>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <button
                  onClick={() => openAssignModal(batch)}
                  className="px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  Edit Contents
                </button>
                <button
                  onClick={() => { setShowUploadModal(batch); setUploadResults([]); }}
                  className="inline-flex items-center justify-center gap-1 px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  <Upload className="h-4 w-4" />
                  Upload here
                </button>
              </div>
              <button
                onClick={() => openScheduleModal(batch)}
                className="w-full mt-2 px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700"
              >
                Schedule Marking
              </button>
            </div>
          ))}
          </div>
        </div>
      )}

      {/* Create Batch Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Create New Batch</h3>
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setNewBatchName('');
                  setNewBatchDescription('');
                  setError(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Batch Name *
                </label>
                <input
                  type="text"
                  value={newBatchName}
                  onChange={(e) => setNewBatchName(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="e.g., Spring 2024 Assignments"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description (optional)
                </label>
                <textarea
                  value={newBatchDescription}
                  onChange={(e) => setNewBatchDescription(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="Brief description of this batch"
                  rows={3}
                />
              </div>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => {
                    setShowCreateModal(false);
                    setNewBatchName('');
                    setNewBatchDescription('');
                    setError(null);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateBatch}
                  disabled={loading}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {loading ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Batch Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">Edit Batch</h3>
              <button
                onClick={() => {
                  setShowEditModal(null);
                  setNewBatchName('');
                  setNewBatchDescription('');
                  setError(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Batch Name *
                </label>
                <input
                  type="text"
                  value={newBatchName}
                  onChange={(e) => setNewBatchName(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description (optional)
                </label>
                <textarea
                  value={newBatchDescription}
                  onChange={(e) => setNewBatchDescription(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  rows={3}
                />
              </div>
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => {
                    setShowEditModal(null);
                    setNewBatchName('');
                    setNewBatchDescription('');
                    setError(null);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateBatch}
                  disabled={loading}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {loading ? 'Updating...' : 'Update'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Assign to Batch Modal */}
      {showAssignModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-2xl shadow-lg rounded-md bg-white max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                Edit Contents for "{showAssignModal.name}"
              </h3>
              <button
                onClick={() => {
                  setShowAssignModal(null);
                  setSelectedAssignments([]);
                  setSelectedAssignmentsToRemove([]);
                  setError(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Add or remove assignments from this batch:
              </p>
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold text-gray-800 mb-2">Currently in this batch</h4>
                  {getAssignmentsForBatch(showAssignModal.id).length === 0 ? (
                    <p className="text-sm text-gray-500">No assignments in this batch yet.</p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto border border-gray-200 rounded-md p-2">
                      {getAssignmentsForBatch(showAssignModal.id).map((assignment) => (
                        <label key={assignment.id} className="flex items-center space-x-2 p-2 hover:bg-gray-50 rounded">
                          <input
                            type="checkbox"
                            checked={selectedAssignmentsToRemove.includes(assignment.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedAssignmentsToRemove([...selectedAssignmentsToRemove, assignment.id]);
                              } else {
                                setSelectedAssignmentsToRemove(selectedAssignmentsToRemove.filter(currentId => currentId !== assignment.id));
                              }
                            }}
                            className="h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
                          />
                          <span className="text-sm text-gray-700 flex-1">{assignment.filename}</span>
                          <span className="text-xs text-red-600">Remove</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="text-sm font-semibold text-gray-800 mb-2">Available to add or move in</h4>
                  {getMovableAssignments(showAssignModal.id).length === 0 ? (
                    <p className="text-sm text-gray-500">No assignments available to move into this batch.</p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto border border-gray-200 rounded-md p-2">
                      {getMovableAssignments(showAssignModal.id).map((assignment) => (
                        <label key={assignment.id} className="flex items-center space-x-2 p-2 hover:bg-gray-50 rounded">
                          <input
                            type="checkbox"
                            checked={selectedAssignments.includes(assignment.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedAssignments([...selectedAssignments, assignment.id]);
                              } else {
                                setSelectedAssignments(selectedAssignments.filter(currentId => currentId !== assignment.id));
                              }
                            }}
                            className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-gray-700 truncate">{assignment.filename}</div>
                            <div className="text-xs text-gray-500">From: {getBatchName(assignment.batch_id)}</div>
                          </div>
                          <span className="text-xs text-primary-600">
                            {assignment.batch_id ? 'Move here' : 'Add'}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button
                  onClick={() => {
                    setShowAssignModal(null);
                    setSelectedAssignments([]);
                    setSelectedAssignmentsToRemove([]);
                    setError(null);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAssignToBatch}
                  disabled={loading || (selectedAssignments.length === 0 && selectedAssignmentsToRemove.length === 0)}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {loading ? 'Saving...' : `Save Changes (${selectedAssignments.length + selectedAssignmentsToRemove.length})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload directly to batch modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-lg shadow-lg rounded-md bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center gap-2">
                <Upload className="h-5 w-5 text-indigo-600" />
                Upload to "{showUploadModal.name}"
              </h3>
              <button
                onClick={() => { setShowUploadModal(null); setUploadResults([]); fetchData(); }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Dropzone */}
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                isDragActive ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-indigo-400 hover:bg-gray-50'
              } ${uploading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <input {...getInputProps()} />
              <Upload className="h-10 w-10 text-gray-400 mx-auto mb-3" />
              {isDragActive ? (
                <p className="text-sm text-indigo-600 font-medium">Drop files here…</p>
              ) : (
                <>
                  <p className="text-sm font-medium text-gray-700">Drag &amp; drop files here</p>
                  <p className="text-xs text-gray-500 mt-1">PDF, Word, code files (.py, .js, .java, …), or ZIP — or click to browse</p>
                  <p className="text-xs text-gray-400 mt-2">ZIP files are automatically extracted</p>
                </>
              )}
              {uploading && <p className="text-xs text-indigo-600 mt-2 animate-pulse">Uploading…</p>}
            </div>

            {/* Results */}
            {uploadResults.length > 0 && (
              <div className="mt-4 space-y-1 max-h-48 overflow-y-auto">
                {uploadResults.map((r, i) => (
                  <div key={i} className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${r.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                    {r.ok
                      ? <CheckCircle className="h-3.5 w-3.5 flex-shrink-0" />
                      : <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />}
                    <span className="truncate flex-1">{r.name}</span>
                    {r.error && <span className="flex-shrink-0">{r.error}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end mt-4">
              <button
                onClick={() => { setShowUploadModal(null); setUploadResults([]); fetchData(); }}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Schedule Marking Modal */}
      {showScheduleModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <CalendarClock className="h-5 w-5 mr-2 text-indigo-600" />
                Schedule Marking
              </h3>
              <button
                onClick={() => {
                  setShowScheduleModal(null);
                  setSelectedRubricId('');
                  setScheduledFor('');
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-3">
              Folder: <span className="font-medium">{showScheduleModal.name}</span>
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Rubric *</label>
                <select
                  value={selectedRubricId}
                  onChange={(e) => setSelectedRubricId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="">Select rubric</option>
                  {rubrics.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Start time (optional)
                </label>
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="text-xs text-gray-500 mt-1">Leave empty to start immediately.</p>
              </div>
              <div className="flex justify-end space-x-3 pt-2">
                <button
                  onClick={() => setShowScheduleModal(null)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleScheduleMarking}
                  disabled={loading}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
                >
                  {loading ? 'Scheduling...' : 'Schedule'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BatchManager;








