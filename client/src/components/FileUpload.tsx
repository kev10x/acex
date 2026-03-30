import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, File, Trash2, AlertCircle, CheckCircle, FolderPlus, Plus, X } from 'lucide-react';
import { uploadAPI, batchesAPI, Assignment, Batch } from '../services/api';

const FileUpload: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | ''>('');
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderDescription, setNewFolderDescription] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const fetchAssignments = useCallback(async () => {
    try {
      const response = await uploadAPI.getAssignments();
      setAssignments(response.data.assignments);
    } catch (err) {
      console.error('Failed to fetch assignments:', err);
    }
  }, []);

  const fetchBatches = useCallback(async () => {
    try {
      const response = await batchesAPI.getBatches();
      setBatches(response.data.batches || []);
    } catch (err) {
      console.error('Failed to fetch batches:', err);
    }
  }, []);

  React.useEffect(() => {
    fetchAssignments();
    fetchBatches();
  }, [fetchAssignments, fetchBatches]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    console.log('Files dropped:', acceptedFiles);
    setLoading(true);
    setError(null);

    try {
      if (acceptedFiles.length === 1) {
        const file = acceptedFiles[0];
        const isZip = file.type === 'application/zip' || file.name.toLowerCase().endsWith('.zip');
        if (isZip) {
          console.log('Uploading ZIP file for extraction:', file.name);
          const response = await uploadAPI.uploadZip(file, selectedBatchId || undefined);
          console.log('ZIP upload response:', response.data);
          // Prepend extracted assignments
          if (response.data.assignments) {
            setAssignments(prev => [...response.data.assignments, ...prev]);
          }
        } else {
          console.log('Uploading single file:', file.name);
          const response = await uploadAPI.uploadSingle(file, selectedBatchId || undefined);
          console.log('Upload response:', response.data);
          setAssignments(prev => [response.data.assignment, ...prev]);
        }
      } else {
        console.log('Uploading multiple files:', acceptedFiles.map(f => f.name));
        const response = await uploadAPI.uploadMultiple(acceptedFiles, selectedBatchId || undefined);
        console.log('Upload response:', response.data);
        setAssignments(prev => [...response.data.assignments, ...prev]);
      }
    } catch (err: any) {
      console.error('Upload error:', err);
      console.error('Error response:', err.response?.data);
      console.error('Error details:', {
        message: err.message,
        code: err.code,
        response: err.response?.status,
        responseData: err.response?.data
      });
      
      // Provide more helpful error messages
      if (err.code === 'ERR_NETWORK' || err.message?.includes('Network Error')) {
        setError('Network error: Cannot connect to server. Please ensure the server is running on port 3001.');
      } else if (err.response?.status === 413) {
        setError('File too large. Maximum file size is 10MB for PDFs, 100MB for ZIP files.');
      } else if (err.response?.status === 400) {
        setError(err.response?.data?.error || 'Invalid file. Only PDF files are allowed.');
      } else {
        setError(err.response?.data?.error || err.message || 'Failed to upload files. Please check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [selectedBatchId]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/zip': ['.zip']
    },
    multiple: true,
    disabled: loading
  });

  const handleDelete = async (id: number) => {
    try {
      await uploadAPI.deleteAssignment(id);
      setAssignments(prev => prev.filter(assignment => assignment.id !== id));
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete assignment');
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      setError('Folder name is required');
      return;
    }

    try {
      setCreatingFolder(true);
      setError(null);
      const response = await batchesAPI.createBatch({
        name: newFolderName.trim(),
        description: newFolderDescription.trim() || undefined
      });

      const createdBatch: Batch | undefined = response.data.batch;
      await fetchBatches();

      if (createdBatch?.id) {
        setSelectedBatchId(createdBatch.id);
      }

      setNewFolderName('');
      setNewFolderDescription('');
      setShowCreateFolder(false);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-500" />;
      case 'processing':
        return <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />;
      default:
        return <File className="w-4 h-4 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'text-green-600 bg-green-50';
      case 'error':
        return 'text-red-600 bg-red-50';
      case 'processing':
        return 'text-blue-600 bg-blue-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Upload PDF Assignments</h2>
        <p className="mt-1 text-sm text-gray-600">
          Upload one or multiple PDF files to get started with marking.
        </p>
      </div>

      <div className="bg-white rounded-lg border p-4 space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full max-w-md">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Upload into folder (optional)
            </label>
            <select
              value={selectedBatchId}
              onChange={(e) => setSelectedBatchId(e.target.value ? Number(e.target.value) : '')}
              className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">No folder (unassigned)</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => setShowCreateFolder((prev) => !prev)}
            className="inline-flex items-center justify-center px-4 py-2 rounded-md border border-primary-200 bg-primary-50 text-primary-700 text-sm font-medium hover:bg-primary-100"
          >
            {showCreateFolder ? <X className="w-4 h-4 mr-2" /> : <FolderPlus className="w-4 h-4 mr-2" />}
            {showCreateFolder ? 'Close folder creator' : 'Create folder here'}
          </button>
        </div>

        {showCreateFolder && (
          <div className="rounded-lg border border-dashed border-primary-200 bg-primary-50/40 p-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Folder name
                </label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="For example: Term 1 Essays"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Description (optional)
                </label>
                <input
                  type="text"
                  value={newFolderDescription}
                  onChange={(e) => setNewFolderDescription(e.target.value)}
                  placeholder="Short note about this folder"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <button
                type="button"
                onClick={handleCreateFolder}
                disabled={creatingFolder}
                className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-primary-600 text-white text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
              >
                <Plus className="w-4 h-4 mr-2" />
                {creatingFolder ? 'Creating...' : 'Create folder'}
              </button>
            </div>
            <p className="mt-3 text-xs text-gray-600">
              New folders created here are available immediately and will be selected for the next upload.
            </p>
          </div>
        )}
      </div>

      {/* Upload Area */}
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          isDragActive
            ? 'border-primary-400 bg-primary-50'
            : 'border-gray-300 hover:border-gray-400'
        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto h-12 w-12 text-gray-400" />
        <div className="mt-4">
          <p className="text-lg font-medium text-gray-900">
            {isDragActive
              ? 'Drop the PDF or ZIP files here'
              : 'Drag & drop PDF or ZIP files here, or click to select'}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            Supports multiple PDFs up to 10MB each, or a ZIP up to 100MB
          </p>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">Upload Error</h3>
              <p className="mt-1 text-sm text-red-700">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
          <div className="flex items-center">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-3" />
            <p className="text-sm text-blue-700">Uploading files...</p>
          </div>
        </div>
      )}

      {/* Uploaded Files List */}
      {assignments.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              Uploaded Assignments ({assignments.length})
            </h3>
            <div className="space-y-3">
              {assignments.map((assignment, index) => (
                <div
                  key={assignment.id || `assignment-${index}`}
                  className="flex items-center justify-between p-3 border border-gray-200 rounded-lg"
                >
                  <div className="flex items-center space-x-3">
                    {getStatusIcon(assignment.status)}
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {assignment.filename}
                      </p>
                      <p className="text-xs text-gray-500">
                        {formatFileSize(assignment.file_size)} • Uploaded{' '}
                        {new Date(assignment.uploaded_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-3">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                        assignment.status
                      )}`}
                    >
                      {assignment.status}
                    </span>
                    <button
                      onClick={() => handleDelete(assignment.id)}
                      className="text-red-400 hover:text-red-600 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FileUpload;
