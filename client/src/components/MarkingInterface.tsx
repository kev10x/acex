import React, { useState, useEffect, useRef } from 'react';
import { Play, CheckCircle, AlertCircle, Loader, ChevronDown, ChevronUp, RefreshCw, Folder, X } from 'lucide-react';
import { uploadAPI, rubricsAPI, markingAPI, batchesAPI, Assignment, Rubric, Batch, MarkingAssessmentType, MarkingOutputType } from '../services/api';
import { DEFAULT_MARKING_LEVEL, EDUCATION_LEVEL_OPTIONS, normalizeEducationLevelValue } from '../constants/educationLevels';

const MarkingInterface: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedRubric, setSelectedRubric] = useState<number | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<number | null>(null);
  const [selectedAssignments, setSelectedAssignments] = useState<number[]>([]);
  const [studentNames, setStudentNames] = useState<{ [key: number]: string }>({});
  const [outputType, setOutputType] = useState<MarkingOutputType>('annotate');
  const [assessmentType, setAssessmentType] = useState<MarkingAssessmentType>('assignment');
  const [level, setLevel] = useState<string>(DEFAULT_MARKING_LEVEL);
  const [provider] = useState<'openai' | 'anthropic'>('openai');
  const [strictnessLevel, setStrictnessLevel] = useState<'very_strict' | 'strict' | 'moderate' | 'lenient'>('strict');
  const [feedbackType, setFeedbackType] = useState<'standard' | 'prescriptive' | 'reflective' | 'critical' | 'genie'>('standard');
  const [feedbackVerbosity, setFeedbackVerbosity] = useState<'brief' | 'standard' | 'comprehensive'>('standard');
  const [criterionFeedbackTypes, setCriterionFeedbackTypes] = useState<Record<string, string>>({});
  const [showCriterionOverrides, setShowCriterionOverrides] = useState(false);
  const [markAsImage, setMarkAsImage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isMarkedAssignmentsExpanded, setIsMarkedAssignmentsExpanded] = useState(true);
  const [retryingAssignment, setRetryingAssignment] = useState<number | null>(null);
  const [failedAssignmentIds, setFailedAssignmentIds] = useState<number[]>([]);
  const [lastMarkingParams, setLastMarkingParams] = useState<{
    rubric_id: number;
    assessment_type: string;
    level: string;
    provider: string;
    output_type: string;
    strictness_level: string;
    mark_as_image?: boolean;
    feedback_type?: string;
    feedback_verbosity?: string;
    criterion_feedback_types?: Record<string, string> | null;
  } | null>(null);

  const isDocxAssignment = (assignment?: Assignment) => /\.docx$/i.test(assignment?.filename || '');
  const isPdfAssignment = (assignment?: Assignment) => /\.pdf$/i.test(assignment?.filename || '');
  const isCodeAssignment = (assignment?: Assignment) => /\.(py|js|jsx|ts|tsx|java|c|h|cpp|cc|cxx|hpp|cs|php|rb|go|rs|swift|kt|kts|scala|r|m|sql|sh|bash|zsh|ps1|pl|lua|dart|html|css|scss|sass|json|xml|ya?ml|toml|ini|cfg|md|txt)$/i.test(assignment?.filename || '');
  const selectedAssignmentObjects = selectedAssignments
    .map((id) => assignments.find((assignment) => assignment.id === id))
    .filter((assignment): assignment is Assignment => Boolean(assignment));
  const hasSelectedAssignments = selectedAssignmentObjects.length > 0;
  const selectedOnlyDocx = hasSelectedAssignments && selectedAssignmentObjects.every(isDocxAssignment);
  const selectedOnlyPdf = hasSelectedAssignments && selectedAssignmentObjects.every(isPdfAssignment);
  const selectedOnlyCode = hasSelectedAssignments && selectedAssignmentObjects.every(isCodeAssignment);
  const selectedMixedDocumentTypes = hasSelectedAssignments && !selectedOnlyDocx && !selectedOnlyPdf && !selectedOnlyCode;
  const hasAvailableDocxAssignments = assignments.some((assignment) => (
    (assignment.status === 'uploaded' || assignment.status === 'error') && isDocxAssignment(assignment)
  ));
  const showWordCommentsOption = selectedOnlyDocx || (!hasSelectedAssignments && hasAvailableDocxAssignments);

  useEffect(() => {
    if (!hasSelectedAssignments) return;
    if (selectedOnlyDocx && outputType === 'annotate') {
      setOutputType('word_comments');
      return;
    }
    if (selectedOnlyPdf && outputType === 'word_comments') {
      setOutputType('annotate');
      return;
    }
    if (selectedOnlyCode && outputType !== 'report') {
      setOutputType('report');
      return;
    }
    if (selectedOnlyCode && assessmentType === 'assignment') {
      setAssessmentType('code');
      return;
    }
    if (selectedMixedDocumentTypes && outputType !== 'report') {
      setOutputType('report');
    }
  }, [assessmentType, hasSelectedAssignments, outputType, selectedMixedDocumentTypes, selectedOnlyCode, selectedOnlyDocx, selectedOnlyPdf]);

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
    
    // Get available assignments (unmarked or previously failed so they can retry)
    const available = assignments.filter(a => a.status === 'uploaded' || a.status === 'error');
    
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
        const available = assignments.filter(a => a.status === 'uploaded' || a.status === 'error');
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

    // Only the scripts still needing marking (unmarked or failed); already-marked ones are left alone
    const batchAssignments = assignments.filter(a => a.batch_id === batchId && (a.status === 'uploaded' || a.status === 'error'));

    if (batchAssignments.length === 0) {
      setError('Nothing left to retry in this batch - all scripts are already marked');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const batchAssignmentIds = batchAssignments.map(a => a.id);
      const studentNamesArray = batchAssignmentIds.map(id => studentNames[id] || null);
      
      const activeCriterionTypes = Object.keys(criterionFeedbackTypes).length > 0 ? criterionFeedbackTypes : null;

      // Store marking parameters for retry functionality
      setLastMarkingParams({
        rubric_id: selectedRubric,
        assessment_type: assessmentType,
        level: level,
        provider: provider,
        output_type: outputType,
        strictness_level: strictnessLevel,
        mark_as_image: markAsImage,
        feedback_type: feedbackType,
        feedback_verbosity: feedbackVerbosity,
        criterion_feedback_types: activeCriterionTypes
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
        mark_as_image: markAsImage,
        feedback_type: feedbackType,
        feedback_verbosity: feedbackVerbosity,
        criterion_feedback_types: activeCriterionTypes
      });

      setSuccess(`Marked ${response.data.results.length} assignment(s) in batch`);

      const failedIds: number[] = response.data.failed_assignment_ids || [];
      setFailedAssignmentIds(failedIds);
      if (failedIds.length > 0) {
        setError(`${failedIds.length} assignment(s) failed and are highlighted below for retry: ${response.data.errors.map((e: any) => e.error).join(', ')}`);
      }

      // Refresh assignments to show updated status
      await fetchData();

      // Leave only the failed scripts selected so one click retries just those
      setSelectedAssignments(failedIds);
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
      const activeCriterionTypes = Object.keys(criterionFeedbackTypes).length > 0 ? criterionFeedbackTypes : null;

      // Store marking parameters for retry functionality
      setLastMarkingParams({
        rubric_id: selectedRubric,
        assessment_type: assessmentType,
        level: level,
        provider: provider,
        output_type: outputType,
        strictness_level: strictnessLevel,
        mark_as_image: markAsImage,
        feedback_type: feedbackType,
        feedback_verbosity: feedbackVerbosity,
        criterion_feedback_types: activeCriterionTypes
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
        mark_as_image: markAsImage,
        feedback_type: feedbackType,
        feedback_verbosity: feedbackVerbosity,
        criterion_feedback_types: activeCriterionTypes
      }, abortControllerRef.current.signal);

      // Check if request was aborted
      if (abortControllerRef.current.signal.aborted) {
        return;
      }

      setSuccess(`Successfully marked ${response.data.results.length} assignments`);

      const failedIds: number[] = response.data.failed_assignment_ids || [];
      setFailedAssignmentIds(failedIds);
      if (failedIds.length > 0) {
        setError(`${failedIds.length} assignment(s) failed and are highlighted below for retry: ${response.data.errors.map((e: any) => e.error).join(', ')}`);
      }

      // Refresh assignments to show updated status
      await fetchData();

      if (failedIds.length > 0) {
        // Keep the rubric/names and leave only the failed scripts selected for a one-click retry
        setSelectedAssignments(failedIds);
        setStudentNames((prev) => {
          const kept: { [key: number]: string } = {};
          failedIds.forEach((id) => { if (prev[id]) kept[id] = prev[id]; });
          return kept;
        });
      } else {
        setSelectedAssignments([]);
        setStudentNames({});
        setSelectedRubric(null);
      }
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
        return <Loader className="w-4 h-4 text-primary-500 animate-spin" />;
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
        return 'text-primary-600 bg-primary-50';
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
        output_type: lastMarkingParams.output_type as MarkingOutputType,
        assessment_type: lastMarkingParams.assessment_type as MarkingAssessmentType,
        level: lastMarkingParams.level,
        provider: lastMarkingParams.provider as 'openai' | 'anthropic',
        strictness_level: lastMarkingParams.strictness_level as 'very_strict' | 'strict' | 'moderate' | 'lenient',
        mark_as_image: lastMarkingParams.mark_as_image,
        feedback_type: (lastMarkingParams.feedback_type || 'standard') as 'standard' | 'prescriptive' | 'reflective' | 'critical' | 'genie',
        feedback_verbosity: (lastMarkingParams.feedback_verbosity || 'standard') as 'brief' | 'standard' | 'comprehensive',
        criterion_feedback_types: lastMarkingParams.criterion_feedback_types || null
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

  // Include 'error' so previously failed assignments can be retried without re-uploading
  const availableAssignments = assignments.filter(a => a.status === 'uploaded' || a.status === 'error');
  const markedAssignments = assignments.filter(a => a.status === 'completed');

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
      <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
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
                onChange={(e) => setAssessmentType(e.target.value as MarkingAssessmentType)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="assignment">Assignment</option>
                <option value="test">Test</option>
                <option value="exam">Exam</option>
                <option value="code">Code</option>
                <option value="project_proposal">Project Proposal</option>
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
                onChange={(e) => setLevel(normalizeEducationLevelValue(e.target.value, DEFAULT_MARKING_LEVEL))}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                {EDUCATION_LEVEL_OPTIONS.filter((option) => option.value).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                Select the grade/qualification level band of the students
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

            {/* Feedback Type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Feedback Type
              </label>
              <select
                value={feedbackType}
                onChange={(e) => setFeedbackType(e.target.value as typeof feedbackType)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="standard">Standard</option>
                <option value="prescriptive">Prescriptive (table)</option>
                <option value="reflective">Reflective (questions)</option>
                <option value="critical">Critical Analysis (table)</option>
                <option value="genie">Genie (AI rewrite)</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {feedbackType === 'standard' && 'Comprehensive narrative feedback per criterion'}
                {feedbackType === 'prescriptive' && 'Table of exact issues to fix, with location and priority'}
                {feedbackType === 'reflective' && 'Thought-provoking questions to prompt self-reflection'}
                {feedbackType === 'critical' && 'Table of weaknesses with evidence and severity rating'}
                {feedbackType === 'genie' && 'AI-rewritten corrected version of weak sections'}
              </p>
            </div>

            {/* Feedback Verbosity */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Feedback Verbosity
              </label>
              <select
                value={feedbackVerbosity}
                onChange={(e) => setFeedbackVerbosity(e.target.value as typeof feedbackVerbosity)}
                className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="brief">Brief</option>
                <option value="standard">Standard</option>
                <option value="comprehensive">Comprehensive</option>
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {feedbackVerbosity === 'brief' && '1-2 sentences per criterion, top-level overview only'}
                {feedbackVerbosity === 'standard' && '3-5 sentences per criterion with examples and guidance'}
                {feedbackVerbosity === 'comprehensive' && '6-10 sentences per criterion, exhaustive analysis'}
              </p>
            </div>

            {/* Per-criterion feedback type overrides */}
            {selectedRubric && (() => {
              const rubric = rubrics.find(r => r.id === selectedRubric);
              if (!rubric?.criteria?.length) return null;
              return (
                <div className="col-span-1 md:col-span-2 lg:col-span-4">
                  <button
                    type="button"
                    onClick={() => setShowCriterionOverrides(v => !v)}
                    className="flex items-center text-sm text-indigo-600 hover:text-indigo-800 font-medium mb-2"
                  >
                    <ChevronDown className={`w-4 h-4 mr-1 transition-transform ${showCriterionOverrides ? 'rotate-180' : ''}`} />
                    Per-criterion feedback type overrides
                    {Object.keys(criterionFeedbackTypes).length > 0 && (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-800">
                        {Object.keys(criterionFeedbackTypes).length} override{Object.keys(criterionFeedbackTypes).length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </button>
                  {showCriterionOverrides && (
                    <div className="overflow-x-auto border border-gray-200 rounded-lg">
                      <table className="min-w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Criterion</th>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Max pts</th>
                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Feedback type</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 bg-white">
                          {rubric.criteria.map((criterion) => (
                            <tr key={criterion.name}>
                              <td className="px-4 py-2 text-gray-800 font-medium">{criterion.name}</td>
                              <td className="px-4 py-2 text-gray-500">{criterion.max_points}</td>
                              <td className="px-4 py-2">
                                <select
                                  value={criterionFeedbackTypes[criterion.name] || ''}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setCriterionFeedbackTypes(prev => {
                                      const next = { ...prev };
                                      if (val) next[criterion.name] = val;
                                      else delete next[criterion.name];
                                      return next;
                                    });
                                  }}
                                  className="text-sm border-gray-300 rounded shadow-sm focus:ring-primary-500 focus:border-primary-500"
                                >
                                  <option value="">Same as overall ({feedbackType})</option>
                                  <option value="standard">Standard</option>
                                  <option value="prescriptive">Prescriptive (table)</option>
                                  <option value="reflective">Reflective (questions)</option>
                                  <option value="critical">Critical Analysis (table)</option>
                                  <option value="genie">Genie (rewrite)</option>
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {Object.keys(criterionFeedbackTypes).length > 0 && (
                        <div className="px-4 py-2 bg-gray-50 border-t border-gray-100">
                          <button
                            type="button"
                            onClick={() => setCriterionFeedbackTypes({})}
                            className="text-xs text-gray-500 hover:text-red-600"
                          >
                            Clear all overrides
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

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
      <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Output Type</h3>
          <div className="space-y-3">
            {(!hasSelectedAssignments || selectedOnlyPdf) && (
              <label className="flex items-start">
                <input
                  type="radio"
                  name="outputType"
                  value="annotate"
                  checked={outputType === 'annotate'}
                  onChange={(e) => setOutputType(e.target.value as MarkingOutputType)}
                  className="mt-1 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                />
                <div className="ml-3">
                  <div className="text-sm font-medium text-gray-900">
                    Annotate PDF
                  </div>
                  <div className="text-sm text-gray-500">
                    Add feedback comments and highlights directly on the original PDF.
                  </div>
                </div>
              </label>
            )}
            {showWordCommentsOption && (
              <label className={`flex items-start ${hasSelectedAssignments && !selectedOnlyDocx ? 'opacity-60' : ''}`}>
                <input
                  type="radio"
                  name="outputType"
                  value="word_comments"
                  checked={outputType === 'word_comments'}
                  onChange={(e) => setOutputType(e.target.value as MarkingOutputType)}
                  disabled={hasSelectedAssignments && !selectedOnlyDocx}
                  className="mt-1 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300"
                />
                <div className="ml-3">
                  <div className="text-sm font-medium text-gray-900">
                    Commented Word Document
                  </div>
                  <div className="text-sm text-gray-500">
                    Insert Acexen feedback as native comments into the uploaded DOCX file.
                  </div>
                  {!hasSelectedAssignments && (
                    <div className="text-xs text-primary-700 mt-1">
                      Select one or more Word documents below to use this output.
                    </div>
                  )}
                </div>
              </label>
            )}
            <label className="flex items-start">
              <input
                type="radio"
                name="outputType"
                value="report"
                checked={outputType === 'report'}
                onChange={(e) => setOutputType(e.target.value as MarkingOutputType)}
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
            {selectedMixedDocumentTypes && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                Select only PDF files for PDF annotation, or only DOCX files for commented Word output. Mixed selections can use the assessment report.
              </p>
            )}
            {selectedOnlyCode && (
              <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                Code files are marked from source text and use the assessment report output.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Rubric Selection */}
      <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
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
        <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
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
                    {hasAny && hasUnmarked && selectedRubric && (
                      <button
                        onClick={() => handleRemarkBatch(batch.id)}
                        disabled={loading}
                        className="inline-flex items-center px-3 py-2 border border-orange-300 rounded-md text-sm font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={`Mark the ${batchUnmarkedAssignments.length} remaining assignment(s) in this batch (already marked ones are left alone)`}
                      >
                        <RefreshCw className="h-4 w-4 mr-1" />
                        Retry remaining ({batchUnmarkedAssignments.length})
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
      <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            Select Assignments ({selectedAssignments.length} selected)
          </h3>
          
          {availableAssignments.length === 0 ? (
            <p className="text-gray-500">No assignments available to mark. Upload PDF or DOCX files, or retry failed ones from above.</p>
          ) : (
            <div className="space-y-4">
              {availableAssignments.map((assignment, index) => {
                const batch = assignment.batch_id ? batches.find(b => b.id === assignment.batch_id) : null;
                const needsRetry = assignment.status === 'error' || failedAssignmentIds.includes(assignment.id);
                return (
                  <div key={assignment.id || `available-assignment-${index}`} className={`flex items-center space-x-4 p-3 border rounded-lg ${needsRetry ? 'border-red-300 bg-red-50 ring-1 ring-red-200' : 'border-gray-200'}`}>
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
                        {needsRetry && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800" title="Marking failed - already selected so you can retry it">
                            Needs retry
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
        <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
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
                          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-semibold rounded-lg text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition-colors"
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
          className="inline-flex items-center px-6 py-3 border border-transparent text-base font-semibold rounded-lg shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
