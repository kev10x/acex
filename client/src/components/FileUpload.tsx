import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, File, Trash2, AlertCircle, CheckCircle } from 'lucide-react';
import { uploadAPI, Assignment } from '../services/api';

const FileUpload: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAssignments = useCallback(async () => {
    try {
      const response = await uploadAPI.getAssignments();
      setAssignments(response.data.assignments);
    } catch (err) {
      console.error('Failed to fetch assignments:', err);
    }
  }, []);

  React.useEffect(() => {
    fetchAssignments();
  }, [fetchAssignments]);

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
          const response = await uploadAPI.uploadZip(file);
          console.log('ZIP upload response:', response.data);
          // Prepend extracted assignments
          if (response.data.assignments) {
            setAssignments(prev => [...response.data.assignments, ...prev]);
          }
        } else {
          console.log('Uploading single file:', file.name);
          const response = await uploadAPI.uploadSingle(file);
          console.log('Upload response:', response.data);
          setAssignments(prev => [response.data.assignment, ...prev]);
        }
      } else {
        console.log('Uploading multiple files:', acceptedFiles.map(f => f.name));
        const response = await uploadAPI.uploadMultiple(acceptedFiles);
        console.log('Upload response:', response.data);
        setAssignments(prev => [...response.data.assignments, ...prev]);
      }
    } catch (err: any) {
      console.error('Upload error:', err);
      console.error('Error response:', err.response?.data);
      setError(err.response?.data?.error || err.message || 'Failed to upload files');
    } finally {
      setLoading(false);
    }
  }, []);

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
