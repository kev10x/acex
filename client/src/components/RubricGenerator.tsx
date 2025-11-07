import React, { useState, useEffect } from 'react';
import { FileText, Wand2, Save, Loader, AlertCircle, CheckCircle } from 'lucide-react';
import { uploadAPI, rubricGeneratorAPI, Assignment, Rubric, RubricCriterion } from '../services/api';

type RubricType = 'auto' | 'rubric' | 'answer_key';

const RubricGenerator: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<number | null>(null);
  const [rubricName, setRubricName] = useState('');
  const [rubricType, setRubricType] = useState<RubricType>('auto');
  const [generatedRubric, setGeneratedRubric] = useState<Rubric | null>(null);
  const [loading, setLoading] = useState(false);
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

  const handleGenerateRubric = async () => {
    if (!selectedAssignment) {
      setError('Please select an assignment');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await rubricGeneratorAPI.generateFromPDF({
        assignment_id: selectedAssignment,
        rubric_name: rubricName || undefined,
        rubric_type: rubricType
      });

      setGeneratedRubric(response.data.rubric);
      const message = response.data.is_answer_key 
        ? 'Answer key generated successfully! Review and save if you like it.'
        : 'Rubric generated successfully! Review and save if you like it.';
      setSuccess(message);
    } catch (err: any) {
      setError(err.response?.data?.error || err.response?.data?.message || 'Failed to generate rubric');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRubric = async () => {
    if (!generatedRubric) return;

    setLoading(true);
    setError(null);

    try {
      await rubricGeneratorAPI.saveGenerated({
        name: generatedRubric.name,
        criteria: generatedRubric.criteria,
        total_points: generatedRubric.total_points
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
          
          {assignments.length === 0 ? (
            <p className="text-gray-500">No PDF documents available. Please upload some first.</p>
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
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  {rubricType === 'auto' && 'AI will detect the document type and generate appropriately'}
                  {rubricType === 'rubric' && 'Generate a marking rubric with criteria and performance levels'}
                  {rubricType === 'answer_key' && 'Generate an answer key with model answers for each question'}
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
                  {generatedRubric.criteria.length} criteria • {generatedRubric.total_points} total points
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

              <div className="bg-primary-50 px-4 py-3 rounded-md">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-primary-700">
                    Total Points: {generatedRubric.total_points}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RubricGenerator;
