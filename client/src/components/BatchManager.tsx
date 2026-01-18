import React, { useState, useEffect } from 'react';
import { FolderPlus, Folder, Edit2, Trash2, X, Check, Plus, Users } from 'lucide-react';
import { batchesAPI, uploadAPI, Batch, Assignment } from '../services/api';

const BatchManager: React.FC = () => {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState<Batch | null>(null);
  const [showAssignModal, setShowAssignModal] = useState<Batch | null>(null);
  const [newBatchName, setNewBatchName] = useState('');
  const [newBatchDescription, setNewBatchDescription] = useState('');
  const [selectedAssignments, setSelectedAssignments] = useState<number[]>([]);

  useEffect(() => {
    fetchData();
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
    if (!showAssignModal || selectedAssignments.length === 0) {
      setError('Please select at least one assignment');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await batchesAPI.assignToBatch(showAssignModal.id, selectedAssignments);
      setSuccess(`Assigned ${selectedAssignments.length} assignment(s) to batch`);
      setShowAssignModal(null);
      setSelectedAssignments([]);
      fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to assign assignments');
    } finally {
      setLoading(false);
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
  };

  const getUnassignedAssignments = () => {
    return assignments.filter(a => !a.batch_id);
  };

  const getAssignmentsInBatch = (batchId: number) => {
    return assignments.filter(a => a.batch_id === batchId);
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

              <button
                onClick={() => openAssignModal(batch)}
                className="w-full mt-4 px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Assign Assignments
              </button>
            </div>
          ))}
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
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                Assign to "{showAssignModal.name}"
              </h3>
              <button
                onClick={() => {
                  setShowAssignModal(null);
                  setSelectedAssignments([]);
                  setError(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Select assignments to add to this batch:
              </p>
              {getUnassignedAssignments().length === 0 ? (
                <p className="text-sm text-gray-500">No unassigned assignments available.</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {getUnassignedAssignments().map((assignment) => (
                    <label key={assignment.id} className="flex items-center space-x-2 p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={selectedAssignments.includes(assignment.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedAssignments([...selectedAssignments, assignment.id]);
                          } else {
                            setSelectedAssignments(selectedAssignments.filter(id => id !== assignment.id));
                          }
                        }}
                        className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                      />
                      <span className="text-sm text-gray-700">{assignment.filename}</span>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button
                  onClick={() => {
                    setShowAssignModal(null);
                    setSelectedAssignments([]);
                    setError(null);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAssignToBatch}
                  disabled={loading || selectedAssignments.length === 0}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                >
                  {loading ? 'Assigning...' : `Assign ${selectedAssignments.length}`}
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








