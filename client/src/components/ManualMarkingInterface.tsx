import React, { useState, useEffect } from 'react';
import { CheckCircle, AlertCircle, Loader, Save, Eye } from 'lucide-react';
import { uploadAPI, rubricsAPI, markingAPI, Assignment, Rubric } from '../services/api';

interface Score {
  criterion_name: string;
  points_awarded: number;
  max_points: number;
  feedback: string;
}

interface ManualMarkingData {
  assignment_id: number;
  rubric_id: number;
  student_name: string;
  scores: Score[];
  overall_feedback: string;
}

const ManualMarkingInterface: React.FC = () => {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<Assignment | null>(null);
  const [selectedRubric, setSelectedRubric] = useState<Rubric | null>(null);
  const [studentName, setStudentName] = useState('');
  const [scores, setScores] = useState<Score[]>([]);
  const [overallFeedback, setOverallFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showRubric, setShowRubric] = useState(false);

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

  const handleAssignmentSelect = (assignmentId: number) => {
    const assignment = assignments.find(a => a.id === assignmentId);
    if (assignment) {
      setSelectedAssignment(assignment);
      setStudentName('');
      setScores([]);
      setOverallFeedback('');
      setError(null);
      setSuccess(null);
    }
  };

  const handleRubricSelect = (rubricId: number) => {
    const rubric = rubrics.find(r => r.id === rubricId);
    if (rubric) {
      setSelectedRubric(rubric);
      // Initialize scores array based on rubric criteria
      const initialScores: Score[] = rubric.criteria.map((criterion: any) => ({
        criterion_name: criterion.name,
        points_awarded: 0,
        max_points: criterion.maxPoints,
        feedback: ''
      }));
      setScores(initialScores);
      setError(null);
      setSuccess(null);
    }
  };

  const handleScoreChange = (index: number, field: keyof Score, value: string | number) => {
    setScores(prev => prev.map((score, i) => 
      i === index ? { ...score, [field]: value } : score
    ));
  };

  const calculateTotalScore = () => {
    return scores.reduce((total, score) => total + (score.points_awarded || 0), 0);
  };

  const getTotalPossiblePoints = () => {
    return selectedRubric?.total_points || 0;
  };

  const handleSubmit = async () => {
    if (!selectedAssignment || !selectedRubric || !studentName.trim()) {
      setError('Please select an assignment, rubric, and enter a student name');
      return;
    }

    if (scores.length === 0) {
      setError('Please initialize scores by selecting a rubric');
      return;
    }

    const totalScore = calculateTotalScore();
    if (totalScore > getTotalPossiblePoints()) {
      setError(`Total score (${totalScore}) cannot exceed rubric total points (${getTotalPossiblePoints()})`);
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const markingData: ManualMarkingData = {
        assignment_id: selectedAssignment.id,
        rubric_id: selectedRubric.id,
        student_name: studentName,
        scores: scores,
        overall_feedback: overallFeedback || 'Manual marking completed'
      };

      const response = await markingAPI.markManual(markingData);
      const result = response.data;
      setSuccess(`Successfully marked assignment for ${studentName} (Score: ${totalScore}/${getTotalPossiblePoints()})`);
      
      // Reset form
      setSelectedAssignment(null);
      setSelectedRubric(null);
      setStudentName('');
      setScores([]);
      setOverallFeedback('');
      
      // Refresh assignments
      await fetchData();
    } catch (err: any) {
      setError(err.message || 'Failed to submit marking');
    } finally {
      setLoading(false);
    }
  };

  const availableAssignments = assignments.filter(a => a.status === 'uploaded');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Manual Marking</h2>
        <p className="mt-1 text-sm text-gray-600">
          Mark assignments manually using rubrics without AI assistance.
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Assignment Selection */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Assignment
            </label>
            <select
              value={selectedAssignment?.id || ''}
              onChange={(e) => handleAssignmentSelect(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Choose an assignment...</option>
              {availableAssignments.map(assignment => (
                <option key={assignment.id} value={assignment.id}>
                  {assignment.filename}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Rubric
            </label>
            <div className="flex gap-2">
              <select
                value={selectedRubric?.id || ''}
                onChange={(e) => handleRubricSelect(Number(e.target.value))}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Choose a rubric...</option>
                {rubrics.map(rubric => (
                  <option key={rubric.id} value={rubric.id}>
                    {rubric.name} ({rubric.total_points} points)
                  </option>
                ))}
              </select>
              {selectedRubric && (
                <button
                  type="button"
                  onClick={() => setShowRubric(!showRubric)}
                  className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
                >
                  <Eye className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Student Name
            </label>
            <input
              type="text"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              placeholder="Enter student name..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Rubric Preview */}
        {selectedRubric && showRubric && (
          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">
              {selectedRubric.name}
            </h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {selectedRubric.criteria.map((criterion: any, index: number) => (
                <div key={index} className="text-sm">
                  <div className="font-medium text-gray-700">
                    {criterion.name} ({criterion.maxPoints} points)
                  </div>
                  <div className="text-gray-600 text-xs">
                    {criterion.description}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Scoring Interface */}
      {selectedRubric && scores.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Scoring - {selectedRubric.name}
          </h3>
          
          <div className="space-y-4">
            {scores.map((score, index) => (
              <div key={index} className="border border-gray-200 rounded-lg p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h4 className="font-medium text-gray-900">
                      {score.criterion_name}
                    </h4>
                    <p className="text-sm text-gray-600">
                      Max Points: {score.max_points}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      max={score.max_points}
                      value={score.points_awarded}
                      onChange={(e) => handleScoreChange(index, 'points_awarded', Number(e.target.value))}
                      className="w-20 px-2 py-1 border border-gray-300 rounded text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-500">/ {score.max_points}</span>
                  </div>
                </div>
                <textarea
                  value={score.feedback}
                  onChange={(e) => handleScoreChange(index, 'feedback', e.target.value)}
                  placeholder="Enter feedback for this criterion..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  rows={2}
                />
              </div>
            ))}
          </div>

          {/* Overall Feedback */}
          <div className="mt-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Overall Feedback
            </label>
            <textarea
              value={overallFeedback}
              onChange={(e) => setOverallFeedback(e.target.value)}
              placeholder="Enter overall feedback for the assignment..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={3}
            />
          </div>

          {/* Score Summary */}
          <div className="mt-6 bg-gray-50 p-4 rounded-lg">
            <div className="flex justify-between items-center">
              <span className="text-lg font-medium text-gray-900">
                Total Score: {calculateTotalScore()} / {getTotalPossiblePoints()}
              </span>
              <span className="text-sm text-gray-600">
                {((calculateTotalScore() / getTotalPossiblePoints()) * 100).toFixed(1)}%
              </span>
            </div>
          </div>

          {/* Submit Button */}
          <div className="mt-6">
            <button
              onClick={handleSubmit}
              disabled={loading || !studentName.trim()}
              className="w-full flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <Loader className="w-4 h-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Submit Marking
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ManualMarkingInterface;
