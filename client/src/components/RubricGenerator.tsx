import React, { useState, useEffect, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { FileText, Wand2, Save, Loader, AlertCircle, CheckCircle, Upload } from 'lucide-react';
import { uploadAPI, rubricGeneratorAPI, Assignment, Rubric, RubricCriterion } from '../services/api';

type RubricType = 'auto' | 'rubric' | 'answer_key' | 'memorandum';

const RubricGenerator: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<number | null>(null);
  const [rubricName, setRubricName] = useState('');
  const [rubricType, setRubricType] = useState<RubricType>('auto');
  const [generatedRubric, setGeneratedRubric] = useState<Rubric | null>(null);
  const [generatedRubricType, setGeneratedRubricType] = useState<'rubric' | 'answer_key'>('rubric');
  const [detectedDocumentType, setDetectedDocumentType] = useState<string | null>(null);
  /** User override for total marks when they don't match the document (e.g. AI misread total) */
  const [totalMarksOverride, setTotalMarksOverride] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetchAssignments();
  }, []);

  const fetchAssignments = async () => {
    try {
      const response = await uploadAPI.getAssignments();
      setAssignments(response.data.assignments);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch assignments');
    }
  };

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await uploadAPI.uploadSingle(file);
      const newAssignment = response.data.assignment as Assignment;
      setAssignments((prev) => [newAssignment, ...prev]);
      setSelectedAssignment(newAssignment.id);
      setSuccess(`"${newAssignment.filename}" uploaded. You can generate a rubric from it below.`);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to upload PDF');
    } finally {
      setUploading(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    disabled: uploading
  });

  const handleGenerateRubric = async () => {
    if (!selectedAssignment) {
      setError('Please select an assignment');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      setDetectedDocumentType(null);
      setGeneratedRubricType('rubric');
      const response = await rubricGeneratorAPI.generateFromPDF({
        assignment_id: selectedAssignment,
        rubric_name: rubricName || undefined,
        rubric_type: rubricType
      });

      setGeneratedRubric({
        ...response.data.rubric,
        rubric_type: response.data.rubric?.rubric_type || (response.data.final_type === 'answer_key' ? 'answer_key' : 'rubric')
      });
      setTotalMarksOverride(null);
      const resolvedType = response.data.final_type === 'answer_key' || response.data.is_answer_key ? 'answer_key' : 'rubric';
      setGeneratedRubricType(resolvedType);
      setDetectedDocumentType(response.data.detected_type || null);

      const message =
        response.data.message ||
        (resolvedType === 'answer_key'
          ? `Answer key generated successfully${rubricType === 'auto' && response.data.detected_type ? ` (auto-detected ${response.data.detected_type})` : ''}. Review and save if you like it.`
          : `Rubric generated successfully${rubricType === 'auto' && response.data.detected_type ? ` (auto-detected ${response.data.detected_type})` : ''}. Review and save if you like it.`);
      setSuccess(message);
    } catch (err: any) {
      setError(err.response?.data?.error || err.response?.data?.message || 'Failed to generate rubric');
    } finally {
      setLoading(false);
    }
  };

  const effectiveTotalPoints = totalMarksOverride ?? generatedRubric?.total_points ?? 0;
  const criteriaSum = generatedRubric?.criteria?.reduce((s, c) => s + (c.max_points || 0), 0) ?? 0;
  const totalMismatch = Boolean(generatedRubric && criteriaSum > 0 && (totalMarksOverride != null) && totalMarksOverride !== criteriaSum);

  const handleSaveRubric = async () => {
    if (!generatedRubric) return;

    setLoading(true);
    setError(null);

    try {
      await rubricGeneratorAPI.saveGenerated({
        name: generatedRubric.name,
        criteria: generatedRubric.criteria,
        total_points: totalMarksOverride ?? generatedRubric.total_points,
        rubric_type: generatedRubricType
      });

      setSuccess('Rubric saved successfully!');
      setGeneratedRubric(null);
      setRubricName('');
      setSelectedAssignment(null);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save rubric');
    } finally {
      setLoading(false);
    }
  };

  const selectedAssignmentData = assignments.find(a => a.id === selectedAssignment);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">AI Rubric Generator</h2>
        <p className="mt-1 text-sm text-gray-600">
          Generate a marking rubric based on a PDF document using AI analysis.
        </p>
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">Error</h3>
              <p className="mt-1 text-sm text-red-700">{error}</p>
            </div>
          </div>
        </div>
      )}

      {success && (
        <div className="bg-green-50 border border-green-200 rounded-md p-4">
          <div className="flex">
            <CheckCircle className="h-5 w-5 text-green-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-green-800">Success</h3>
              <p className="mt-1 text-sm text-green-700">{success}</p>
            </div>
          </div>
        </div>
      )}

      {/* Assignment Selection */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Select PDF Document</h3>

          {/* Upload PDF directly */}
          <div
            {...getRootProps()}
            className={`mb-4 border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
              isDragActive ? 'border-primary-400 bg-primary-50' : 'border-gray-300 hover:border-gray-400'
            } ${uploading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            <input {...getInputProps()} />
            <Upload className="mx-auto h-8 w-8 text-gray-400" />
            <p className="mt-2 text-sm font-medium text-gray-700">
              {isDragActive ? 'Drop PDF here' : 'Upload a PDF here'}
            </p>
            <p className="text-xs text-gray-500">or choose from existing uploads below</p>
            {uploading && (
              <div className="mt-2 flex items-center justify-center gap-2 text-primary-600">
                <Loader className="h-4 w-4 animate-spin" />
                <span className="text-sm">Uploading...</span>
              </div>
            )}
          </div>
          
          {assignments.length === 0 ? (
            <p className="text-gray-500">No PDF documents yet. Upload one above or add files from the Upload page.</p>
          ) : (
            <div className="space-y-4">
              <div>
                <label htmlFor="assignment" className="block text-sm font-medium text-gray-700">
                  Choose a PDF to analyze
                </label>
                <select
                  id="assignment"
                  value={selectedAssignment || ''}
                  onChange={(e) => setSelectedAssignment(parseInt(e.target.value) || null)}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                >
                  <option value="">Select a PDF document...</option>
                  {assignments.map((assignment, index) => (
                    <option key={assignment.id || `assignment-option-${index}`} value={assignment.id}>
                      {assignment.filename}
                    </option>
                  ))}
                </select>
              </div>

              {selectedAssignmentData && (
                <div className="bg-gray-50 p-3 rounded-md">
                  <p className="text-sm text-gray-600">
                    <strong>Selected:</strong> {selectedAssignmentData.filename}
                  </p>
                  <p className="text-xs text-gray-500">
                    Uploaded: {new Date(selectedAssignmentData.uploaded_at).toLocaleDateString()}
                  </p>
                </div>
              )}

              <div>
                <label htmlFor="rubricType" className="block text-sm font-medium text-gray-700">
                  Rubric Type
                </label>
                <select
                  id="rubricType"
                  value={rubricType}
                  onChange={(e) => setRubricType(e.target.value as RubricType)}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                >
                  <option value="auto">Auto-detect (Recommended)</option>
                  <option value="rubric">Regular Rubric (from content/document)</option>
                  <option value="answer_key">Answer Key (from question paper)</option>
                  <option value="memorandum">Memorandum (document is the memo)</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  {rubricType === 'auto' && 'AI will detect the document type and generate appropriately'}
                  {rubricType === 'rubric' && 'Generate a marking rubric with criteria and performance levels'}
                  {rubricType === 'answer_key' && 'Generate an answer key with model answers for each question'}
                  {rubricType === 'memorandum' && 'Document is already a marking memorandum — extract structure to use as rubric'}
                </p>
              </div>

              <div>
                <label htmlFor="rubricName" className="block text-sm font-medium text-gray-700">
                  Rubric Name (optional)
                </label>
                <input
                  type="text"
                  id="rubricName"
                  value={rubricName}
                  onChange={(e) => setRubricName(e.target.value)}
                  placeholder="Leave empty for AI-generated name"
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                />
              </div>

              <button
                onClick={handleGenerateRubric}
                disabled={loading || !selectedAssignment}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <Loader className="w-4 h-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Wand2 className="w-4 h-4 mr-2" />
                    Generate Rubric
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Generated Rubric Preview */}
      {generatedRubric && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h3 className="text-lg font-medium text-gray-900">
                  {generatedRubric.name?.toLowerCase().includes('answer key') || generatedRubric.name?.toLowerCase().includes('memo')
                    ? 'Generated Answer Key Preview'
                    : 'Generated Rubric Preview'}
                </h3>
                {(generatedRubric.name?.toLowerCase().includes('answer key') || generatedRubric.name?.toLowerCase().includes('memo')) && (
                  <p className="text-xs text-gray-500 mt-1">
                    This will be detected as a memo when used for marking
                  </p>
                )}
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => setGeneratedRubric(null)}
                  className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm font-medium rounded text-gray-700 bg-white hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveRubric}
                  disabled={loading}
                  className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded shadow-sm text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
                >
                  <Save className="w-4 h-4 mr-1" />
                  Save Rubric
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h4 className="text-md font-medium text-gray-900">{generatedRubric.name}</h4>
                <p className="text-sm text-gray-500">
                  {generatedRubric.criteria.length} criteria • {effectiveTotalPoints} total points
                  {totalMismatch && ' (overridden to match document)'}
                </p>
              </div>

              <div className="space-y-3">
                {generatedRubric.criteria.map((criterion, index) => (
                  <div key={`generated-criterion-${index}`} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex justify-between items-start mb-2">
                      <h5 className="text-sm font-medium text-gray-900">
                        {criterion.name}
                      </h5>
                      <span className="text-sm text-gray-500">
                        {criterion.max_points} points
                      </span>
                    </div>
                    <p className="text-sm text-gray-600">
                      {criterion.description}
                    </p>
                  </div>
                ))}
              </div>

              <div className="bg-primary-50 px-4 py-3 rounded-md space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm font-medium text-primary-700">
                    Total marks:
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={totalMarksOverride ?? generatedRubric.total_points ?? ''}
                    onChange={(e) => {
                      const v = e.target.value === '' ? null : parseInt(e.target.value, 10);
                      if (v !== null && !Number.isNaN(v) && v >= 1) setTotalMarksOverride(v);
                      else if (e.target.value === '') setTotalMarksOverride(null);
                    }}
                    className="w-24 rounded border border-primary-200 bg-white px-2 py-1 text-sm text-primary-900 focus:ring-primary-500 focus:border-primary-500"
                  />
                  {criteriaSum > 0 && (
                    <span className="text-xs text-gray-600">
                      (Sum of criteria: {criteriaSum}
                      {(totalMarksOverride ?? generatedRubric.total_points) !== criteriaSum && (
                        <span className="text-amber-600"> — override if your document total differs</span>
                      )}
                      )
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-600">
                  Override the total if it does not match your document’s stated total marks.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RubricGenerator;
