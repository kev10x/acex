import React, { useState, useEffect } from 'react';
import { Play, CheckCircle, AlertCircle, Loader, ChevronDown, ChevronUp } from 'lucide-react';
import { uploadAPI, rubricsAPI, markingAPI, Assignment, Rubric } from '../services/api';

const MarkingInterface: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [selectedRubric, setSelectedRubric] = useState<number | null>(null);
  const [selectedAssignments, setSelectedAssignments] = useState<number[]>([]);
  const [studentNames, setStudentNames] = useState<{ [key: number]: string }>({});
  const [outputType, setOutputType] = useState<'annotate' | 'report'>('annotate');
  const [assessmentType, setAssessmentType] = useState<'assignment' | 'test' | 'treatise' | 'thesis'>('assignment');
  const [level, setLevel] = useState<'primary_school' | 'high_school' | 'undergraduate' | 'postgraduate'>('high_school');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isMarkedAssignmentsExpanded, setIsMarkedAssignmentsExpanded] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [assignmentsRes, rubricsRes] = await Promise.all([
        uploadAPI.getAssignments(),
        rubricsAPI.getRubrics()
      ]);
      setAssignments(assignmentsRes.data.assignments);
      setRubrics(rubricsRes.data.rubrics);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch data');
    }
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
    }
  };

  const handleStudentNameChange = (assignmentId: number, name: string) => {
    setStudentNames(prev => ({
      ...prev,
      [assignmentId]: name
    }));
  };

  const handleMarkAssignments = async () => {
    if (!selectedRubric || selectedAssignments.length === 0) {
      setError('Please select a rubric and at least one assignment');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const studentNamesArray = selectedAssignments.map(id => studentNames[id] || null);
      
      const response = await markingAPI.markMultiple({
        assignment_ids: selectedAssignments,
        rubric_id: selectedRubric,
        student_names: studentNamesArray,
        output_type: outputType,
        assessment_type: assessmentType,
        level: level
      });

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
      setError(err.response?.data?.error || 'Failed to mark assignments');
    } finally {
      setLoading(false);
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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
              {availableAssignments.map((assignment, index) => (
                <div key={assignment.id || `available-assignment-${index}`} className="flex items-center space-x-4 p-3 border border-gray-200 rounded-lg">
                  <input
                    type="checkbox"
                    checked={selectedAssignments.includes(assignment.id)}
                    onChange={(e) => handleAssignmentSelect(assignment.id, e.target.checked)}
                    className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">
                      {assignment.filename}
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
              ))}
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
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(
                        assignment.status
                      )}`}
                    >
                      {assignment.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mark Button */}
      <div className="flex justify-end">
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
