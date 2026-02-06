import React, { useState, useEffect, useRef } from 'react';
import { Play, CheckCircle, AlertCircle, Loader, ChevronDown, ChevronUp, RefreshCw, Folder, X } from 'lucide-react';
import { uploadAPI, rubricsAPI, markingAPI, batchesAPI, Assignment, Rubric, Batch } from '../services/api';

const MarkingInterface: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedRubric, setSelectedRubric] = useState<number | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<number | null>(null);
  const [selectedAssignments, setSelectedAssignments] = useState<number[]>([]);
  const [studentNames, setStudentNames] = useState<{ [key: number]: string }>({});
  const [outputType, setOutputType] = useState<'annotate' | 'report'>('annotate');
  const [assessmentType, setAssessmentType] = useState<'assignment' | 'test' | 'treatise' | 'thesis'>('assignment');
  const [level, setLevel] = useState<'primary_school' | 'high_school' | 'undergraduate' | 'postgraduate'>('high_school');
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('anthropic');
  const [strictnessLevel, setStrictnessLevel] = useState<'very_strict' | 'strict' | 'moderate' | 'lenient'>('strict');
  const [markAsImage, setMarkAsImage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isMarkedAssignmentsExpanded, setIsMarkedAssignmentsExpanded] = useState(true);
  const [retryingAssignment, setRetryingAssignment] = useState<number | null>(null);
  const [lastMarkingParams, setLastMarkingParams] = useState<{
    rubric_id: number;
    assessment_type: string;
    level: string;
    provider: string;
    output_type: string;
    strictness_level: string;
  } | null>(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [assignmentsRes, rubricsRes, batchesRes] = await Promise.all([
        uploadAPI.getAssignments(),
        rubricsAPI.getRubrics(),
        batchesAPI.getBatches()
      ]);
      setAssignments(assignmentsRes.data.assignments);
      setRubrics(rubricsRes.data.rubrics);
      setBatches(batchesRes.data.batches);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch data');
    }
  };

  const handleBatchSelect = (batchId: number | null) => {
    setSelectedBatch(batchId);
    
    // Get available assignments (unmarked)
    const available = assignments.filter(a => a.status === 'uploaded');
    
    if (batchId === null) {
      // Clear all selections when "None" is selected
      setSelectedAssignments([]);
      setStudentNames({});
      return;
    }
    
    // Get all assignments in the selected batch that are available for marking
    const batchAssignments = available.filter(a => a.batch_id === batchId);
    const batchAssignmentIds = batchAssignments.map(a => a.id);
    
    // Select all assignments in the batch
    setSelectedAssignments(batchAssignmentIds);
    
    // Clear student names for assignments not in the batch
    setStudentNames(prev => {
      const newNames: { [key: number]: string } = {};
      batchAssignmentIds.forEach(id => {
        if (prev[id]) {
          newNames[id] = prev[id];
        }
      });
      return newNames;
    });
  };

  const handleAssignmentSelect = (assignmentId: number, checked: boolean) => {
    if (checked) {
      setSelectedAssignments(prev => [...prev, assignmentId]);
    } else {
      setSelectedAssignments(prev => prev.filter(id => id !== assignmentId));
      setStudentNames(prev => {
        const newNames = { ...prev };
        delete newNames[assignmentId];
        return newNames;
      });
      // Clear batch selection if assignment is manually deselected
      if (selectedBatch) {
        const available = assignments.filter(a => a.status === 'uploaded');
        const batchAssignments = available.filter(a => a.batch_id === selectedBatch);
        const remainingSelected = selectedAssignments.filter(id => id !== assignmentId);
        const allBatchSelected = batchAssignments.every(a => remainingSelected.includes(a.id));
        if (!allBatchSelected) {
          setSelectedBatch(null);
        }
      }
    }
  };

  const handleStudentNameChange = (assignmentId: number, name: string) => {
    setStudentNames(prev => ({
      ...prev,
      [assignmentId]: name
    }));
  };

  const handleRemarkBatch = async (batchId: number) => {
    if (!selectedRubric) {
      setError('Please select a rubric first');
      return;
    }

    // Get all assignments in the batch (both marked and unmarked)
    const batchAssignments = assignments.filter(a => a.batch_id === batchId);
    
    if (batchAssignments.length === 0) {
      setError('No assignments found in this batch');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const batchAssignmentIds = batchAssignments.map(a => a.id);
      const studentNamesArray = batchAssignmentIds.map(id => studentNames[id] || null);
      
      // Store marking parameters for retry functionality
      setLastMarkingParams({
        rubric_id: selectedRubric,
        assessment_type: assessmentType,
        level: level,
        provider: provider,
        output_type: outputType,
        strictness_level: strictnessLevel,
        mark_as_image: markAsImage
      });

      const response = await markingAPI.markMultiple({
        assignment_ids: batchAssignmentIds,
        rubric_id: selectedRubric,
        student_names: studentNamesArray,
        output_type: outputType,
        assessment_type: assessmentType,
        level: level,
        provider: provider,
        strictness_level: strictnessLevel,
        mark_as_image: markAsImage
      });

      setSuccess(`Successfully remarked ${response.data.results.length} assignment(s) in batch`);
      
      if (response.data.errors.length > 0) {
        setError(`Some assignments failed: ${response.data.errors.map((e: any) => e.error).join(', ')}`);
      }
      
      // Refresh assignments to show updated status
      await fetchData();
      
      // Clear selections
      setSelectedAssignments([]);
      setSelectedBatch(null);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to remark batch');
    } finally {
      setLoading(false);
    }
  };

  const handleMarkAssignments = async () => {
    if (!selectedRubric || selectedAssignments.length === 0) {
      setError('Please select a rubric and at least one assignment');
      return;
    }

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const studentNamesArray = selectedAssignments.map(id => studentNames[id] || null);
      
      // Store marking parameters for retry functionality
      setLastMarkingParams({
        rubric_id: selectedRubric,
        assessment_type: assessmentType,
        level: level,
        provider: provider,
        output_type: outputType,
        strictness_level: strictnessLevel,
        mark_as_image: markAsImage
      });

      const response = await markingAPI.markMultiple({
        assignment_ids: selectedAssignments,
        rubric_id: selectedRubric,
        student_names: studentNamesArray,
        output_type: outputType,
        assessment_type: assessmentType,
        level: level,
        provider: provider,
        strictness_level: strictnessLevel,
        mark_as_image: markAsImage
      }, abortControllerRef.current.signal);

      // Check if request was aborted
      if (abortControllerRef.current.signal.aborted) {
        return;
      }

      setSuccess(`Successfully marked ${response.data.results.length} assignments`);
      
      if (response.data.errors.length > 0) {
        setError(`Some assignments failed: ${response.data.errors.map((e: any) => e.error).join(', ')}`);
      }

      // Refresh assignments to show updated status
      await fetchData();
      
      // Reset selections
      setSelectedAssignments([]);
      setStudentNames({});
      setSelectedRubric(null);
    } catch (err: any) {
      // Handle cancellation (both frontend abort and backend cancellation)
      if (err.name === 'AbortError' || err.code === 'ERR_CANCELED' || err.response?.status === 499) {
        setError('Marking cancelled');
        setSuccess(null);
        // If backend returned partial results, show them
        if (err.response?.data?.results && err.response.data.results.length > 0) {
          setSuccess(`Partially completed: ${err.response.data.results.length} assignment(s) marked before cancellation`);
        }
        // Refresh to see current status
        await fetchData();
      } else {
        setError(err.response?.data?.error || 'Failed to mark assignments');
      }
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  const handleCancelMarking = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setLoading(false);
      setError('Marking cancelled');
      setSuccess(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-red-500" />;
      case 'processing':
        return <Loader className="w-4 h-4 text-blue-500 animate-spin" />;
      default:
        return <div className="w-4 h-4 bg-gray-300 rounded" />;
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

  const handleRetryAssignment = async (assignmentId: number) => {
    if (!lastMarkingParams) {
      setError('Cannot retry: No previous marking parameters found. Please mark the assignment again with your settings.');
      return;
    }

    setRetryingAssignment(assignmentId);
    setError(null);
    setSuccess(null);

    try {
      // Find the assignment to get student name if it was set
      const assignment = assignments.find(a => a.id === assignmentId);
      const studentName = assignment ? studentNames[assignmentId] || undefined : undefined;

      const response = await markingAPI.markSingle({
        assignment_id: assignmentId,
        rubric_id: lastMarkingParams.rubric_id,
        student_name: studentName,
        output_type: lastMarkingParams.output_type as 'annotate' | 'report',
        assessment_type: lastMarkingParams.assessment_type as 'assignment' | 'test' | 'treatise' | 'thesis',
        level: lastMarkingParams.level as 'primary_school' | 'high_school' | 'undergraduate' | 'postgraduate',
        provider: lastMarkingParams.provider as 'openai' | 'anthropic',
        strictness_level: lastMarkingParams.strictness_level as 'very_strict' | 'strict' | 'moderate' | 'lenient',
        mark_as_image: lastMarkingParams.mark_as_image
      });

      setSuccess(`Successfully retried marking for ${response.data.result.filename || 'assignment'}`);
      
      // Refresh assignments to show updated status
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to retry marking assignment');
    } finally {
      setRetryingAssignment(null);
    }
  };

  const availableAssignments = assignments.filter(a => a.status === 'uploaded');
  const markedAssignments = assignments.filter(a => a.status === 'completed' || a.status === 'error');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Mark Assignments</h2>
        <p className="mt-1 text-sm text-gray-600">
          Select a rubric and assignments to mark using AI.
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

      {/* Assessment Type and Level Selection */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Assessment Settings</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Assessment Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Assessment Type
              </label>
              <select
                value={assessmentType}
                onChange={(e) => setAssessmentType(e.target.value as 'assignment' | 'test' | 'treatise' | 'thesis')}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="assignment">Assignment</option>
                <option value="test">Test</option>
                <option value="treatise">Treatise</option>
                <option value="thesis">Thesis</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                Select the type of assessment being marked
              </p>
            </div>

            {/* Level */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Educational Level
              </label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value as 'primary_school' | 'high_school' | 'undergraduate' | 'postgraduate')}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="primary_school">Primary School</option>
                <option value="high_school">High School</option>
                <option value="undergraduate">Undergraduate</option>
                <option value="postgraduate">Postgraduate</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                Select the educational level of the students
              </p>
            </div>

            {/* AI Provider */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                AI Model
              </label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as 'openai' | 'anthropic')}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="anthropic">Claude 3.5 Sonnet (Anthropic)</option>
                <option value="openai">GPT-4o (OpenAI)</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {provider === 'anthropic' 
                  ? 'Best for large documents and academic analysis'
                  : 'Fast and reliable for most assignments'}
              </p>
            </div>

            {/* Strictness Level */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Marking Strictness
              </label>
              <select
                value={strictnessLevel}
                onChange={(e) => setStrictnessLevel(e.target.value as 'very_strict' | 'strict' | 'moderate' | 'lenient')}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="very_strict">Very Strict</option>
                <option value="strict">Strict</option>
                <option value="moderate">Moderate</option>
                <option value="lenient">Lenient</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {strictnessLevel === 'very_strict' && 'Extremely rigorous - expect near-perfect work'}
                {strictnessLevel === 'strict' && 'High standards - award marks only when criteria are fully met'}
                {strictnessLevel === 'moderate' && 'Fair but firm - allow minor gaps'}
                {strictnessLevel === 'lenient' && 'Supportive - focus on learning and improvement'}
              </p>
            </div>

            {/* Mark as image (for handwritten/scanned PDFs) */}
            <div className="flex items-start">
              <input
                id="mark-as-image"
                type="checkbox"
                checked={markAsImage}
                onChange={(e) => setMarkAsImage(e.target.checked)}
                className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
              />
              <label htmlFor="mark-as-image" className="ml-2 block text-sm text-gray-700">
                Mark as image (handwritten/scanned PDFs)
              </label>
            </div>
            <p className="text-xs text-gray-500 -mt-2 ml-6">
              Send PDF pages as images to the AI instead of extracted text. Use for handwritten scripts or when text extraction fails.
            </p>
          </div>
        </div>
      </div>

      {/* Output Type Selection */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Output Type</h3>
          <div className="space-y-3">
            <label className="flex items-start">
              <input
                type="radio"
                name="outputType"
                value="annotate"
                checked={outputType === 'annotate'}
                onChange={(e) => setOutputType(e.target.value as 'annotate' | 'report')}
                className="mt-1 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
              />
              <div className="ml-3">
                <div className="text-sm font-medium text-gray-900">
                  Annotate PDF
                </div>
                <div className="text-sm text-gray-500">
                  Add feedback comments and highlights directly on the original PDF
                </div>
              </div>
            </label>
            <label className="flex items-start">
              <input
                type="radio"
                name="outputType"
                value="report"
                checked={outputType === 'report'}
                onChange={(e) => setOutputType(e.target.value as 'annotate' | 'report')}
                className="mt-1 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
              />
              <div className="ml-3">
                <div className="text-sm font-medium text-gray-900">
                  Create Assessment Report
                </div>
                <div className="text-sm text-gray-500">
                  Generate a separate PDF report with scores, feedback, and detailed analysis
                </div>
              </div>
            </label>
          </div>
        </div>
      </div>

      {/* Rubric Selection */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Select Rubric</h3>
          {rubrics.length === 0 ? (
            <p className="text-gray-500">No rubrics available. Please create a rubric first.</p>
          ) : (
            <div className="space-y-3">
              {rubrics.map((rubric) => (
                <label key={rubric.id} className="flex items-start">
                  <input
                    type="radio"
                    name="rubric"
                    value={rubric.id}
                    checked={selectedRubric === rubric.id}
                    onChange={(e) => setSelectedRubric(parseInt(e.target.value))}
                    className="mt-1 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                  />
                  <div className="ml-3">
                    <div className="text-sm font-medium text-gray-900">
                      {rubric.name}
                    </div>
                    <div className="text-sm text-gray-500">
                      {rubric.criteria.length} criteria • {rubric.total_points} total points
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Batch Selection */}
      {batches.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg font-medium text-gray-900 mb-4">
              Select Batch (Optional)
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              Select a batch to automatically select all assignments in that batch, or select individual assignments below. You can also remark entire batches.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => handleBatchSelect(null)}
                className={`inline-flex items-center px-4 py-2 border rounded-md text-sm font-medium transition-colors ${
                  selectedBatch === null
                    ? 'bg-primary-600 text-white border-primary-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                None
              </button>
              {batches.map((batch) => {
                const batchUnmarkedAssignments = availableAssignments.filter(a => a.batch_id === batch.id);
                const batchMarkedAssignments = markedAssignments.filter(a => a.batch_id === batch.id);
                const batchAllAssignments = assignments.filter(a => a.batch_id === batch.id);
                const hasUnmarked = batchUnmarkedAssignments.length > 0;
                const hasMarked = batchMarkedAssignments.length > 0;
                const hasAny = batchAllAssignments.length > 0;
                
                return (
                  <div key={batch.id} className="flex items-center gap-2">
                    <button
                      onClick={() => handleBatchSelect(batch.id)}
                      disabled={!hasUnmarked}
                      className={`inline-flex items-center px-4 py-2 border rounded-md text-sm font-medium transition-colors ${
                        selectedBatch === batch.id
                          ? 'bg-primary-600 text-white border-primary-600'
                          : !hasUnmarked
                          ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                          : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                      title={!hasUnmarked ? (hasMarked ? 'All assignments already marked. Use "Remark Batch" to re-mark them.' : 'No assignments in this batch') : `${batchUnmarkedAssignments.length} unmarked assignment(s) available`}
                    >
                      <Folder className="h-4 w-4 mr-2" />
                      {batch.name}
                      {hasUnmarked && (
                        <span className="ml-2 px-2 py-0.5 text-xs bg-white bg-opacity-30 rounded">
                          {batchUnmarkedAssignments.length}
                        </span>
                      )}
                      {!hasUnmarked && hasMarked && (
                        <span className="ml-2 px-2 py-0.5 text-xs bg-gray-200 text-gray-600 rounded">
                          {batchAllAssignments.length} marked
                        </span>
                      )}
                    </button>
                    {hasAny && selectedRubric && (
                      <button
                        onClick={() => handleRemarkBatch(batch.id)}
                        disabled={loading}
                        className="inline-flex items-center px-3 py-2 border border-orange-300 rounded-md text-sm font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={`Remark all ${batchAllAssignments.length} assignment(s) in this batch (including already marked ones)`}
                      >
                        <RefreshCw className="h-4 w-4 mr-1" />
                        Remark ({batchAllAssignments.length})
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {selectedBatch && (
              <div className="mt-4 p-3 bg-primary-50 border border-primary-200 rounded-md">
                <p className="text-sm text-primary-800">
                  <strong>Selected:</strong> {batches.find(b => b.id === selectedBatch)?.name} 
                  {' '}({availableAssignments.filter(a => a.batch_id === selectedBatch).length} unmarked assignment(s) selected)
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Assignment Selection */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            Select Assignments ({selectedAssignments.length} selected)
          </h3>
          
          {availableAssignments.length === 0 ? (
            <p className="text-gray-500">No unmarked assignments available.</p>
          ) : (
            <div className="space-y-4">
              {availableAssignments.map((assignment, index) => {
                const batch = assignment.batch_id ? batches.find(b => b.id === assignment.batch_id) : null;
                return (
                  <div key={assignment.id || `available-assignment-${index}`} className="flex items-center space-x-4 p-3 border border-gray-200 rounded-lg">
                    <input
                      type="checkbox"
                      checked={selectedAssignments.includes(assignment.id)}
                      onChange={(e) => handleAssignmentSelect(assignment.id, e.target.checked)}
                      className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                    />
                    <div className="flex-1">
                      <div className="flex items-center space-x-2">
                        <div className="text-sm font-medium text-gray-900">
                          {assignment.filename}
                        </div>
                        {batch && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                            <Folder className="h-3 w-3 mr-1" />
                            {batch.name}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">
                        Uploaded {new Date(assignment.uploaded_at).toLocaleDateString()}
                      </div>
                    </div>
                    {selectedAssignments.includes(assignment.id) && (
                      <div className="w-64">
                        <input
                          type="text"
                          placeholder="Student name (optional)"
                          value={studentNames[assignment.id] || ''}
                          onChange={(e) => handleStudentNameChange(assignment.id, e.target.value)}
                          className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Marked Assignments Status */}
      {markedAssignments.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <button
              onClick={() => setIsMarkedAssignmentsExpanded(!isMarkedAssignmentsExpanded)}
              className="flex items-center justify-between w-full text-left focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 rounded-md hover:bg-gray-50 p-2 -m-2 transition-colors duration-200"
            >
              <h3 className="text-lg font-medium text-gray-900">
                Marked Assignments ({markedAssignments.length})
              </h3>
              <div className="transform transition-transform duration-200">
                {isMarkedAssignmentsExpanded ? (
                  <ChevronUp className="w-5 h-5 text-gray-400" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-gray-400" />
                )}
              </div>
            </button>
            
            <div className={`transition-all duration-300 ease-in-out overflow-hidden ${
              isMarkedAssignmentsExpanded ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
            }`}>
              <div className="mt-4 space-y-3">
                {markedAssignments.map((assignment, index) => (
                  <div key={assignment.id || `marked-assignment-${index}`} className="flex items-center justify-between p-3 border border-gray-200 rounded-lg">
                    <div className="flex items-center space-x-3">
                      {getStatusIcon(assignment.status)}
                      <div>
                        <div className="text-sm font-medium text-gray-900">
                          {assignment.filename}
                        </div>
                        <div className="text-xs text-gray-500">
                          Uploaded {new Date(assignment.uploaded_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      {assignment.status === 'error' && (
                        <button
                          onClick={() => handleRetryAssignment(assignment.id)}
                          disabled={retryingAssignment === assignment.id || !lastMarkingParams}
                          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
                          title={!lastMarkingParams ? 'Cannot retry: Please mark an assignment first to save settings' : 'Retry marking this assignment'}
                        >
                          {retryingAssignment === assignment.id ? (
                            <>
                              <Loader className="w-3 h-3 mr-1 animate-spin" />
                              Retrying...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-3 h-3 mr-1" />
                              Retry
                            </>
                          )}
                        </button>
                      )}
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                          assignment.status
                        )}`}
                      >
                        {assignment.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mark Button */}
      <div className="flex justify-end gap-3">
        {loading && (
          <button
            onClick={handleCancelMarking}
            className="inline-flex items-center px-6 py-3 border border-red-300 text-base font-medium rounded-md shadow-sm text-red-700 bg-red-50 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            <X className="w-5 h-5 mr-2" />
            Cancel
          </button>
        )}
        <button
          onClick={handleMarkAssignments}
          disabled={loading || !selectedRubric || selectedAssignments.length === 0}
          className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <Loader className="w-5 h-5 mr-2 animate-spin" />
              Marking...
            </>
          ) : (
            <>
              <Play className="w-5 h-5 mr-2" />
              Mark Selected Assignments
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default MarkingInterface;
