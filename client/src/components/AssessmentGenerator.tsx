import React, { useState, useEffect } from 'react';
import { Sparkles, Loader2, Download, FileText, BookOpen, Clock, Target } from 'lucide-react';
import { assessmentsAPI, rubricsAPI, GeneratedAssessment } from '../services/api';

const AssessmentGenerator: React.FC = () => {
  const [selectedRubricId, setSelectedRubricId] = useState<number | null>(null);
  const [selectedRubric, setSelectedRubric] = useState<any | null>(null);
  const [topic, setTopic] = useState('');
  const [difficultyLevel, setDifficultyLevel] = useState<'beginner' | 'moderate' | 'advanced'>('moderate');
  const [questionCount, setQuestionCount] = useState(5);
  const [assessmentType, setAssessmentType] = useState<'assignment' | 'exam' | 'quiz' | 'essay'>('assignment');
  const [useExistingPatterns, setUseExistingPatterns] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedAssessment, setGeneratedAssessment] = useState<GeneratedAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [rubrics, setRubrics] = useState<any[]>([]);

  useEffect(() => {
    loadStats();
    loadRubrics();
  }, []);

  const loadStats = async () => {
    try {
      const response = await assessmentsAPI.getStats();
      if (response.data.success) {
        setStats(response.data.stats);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const loadRubrics = async () => {
    try {
      const response = await rubricsAPI.getRubrics();
      if (response.data.success) {
        setRubrics(response.data.rubrics || []);
      }
    } catch (error) {
      console.error('Failed to load rubrics:', error);
    }
  };

  const handleRubricChange = (rubricId: number | null) => {
    setSelectedRubricId(rubricId);
    if (rubricId !== null) {
      const rubric = rubrics.find(r => r.id === rubricId);
      setSelectedRubric(rubric || null);
    } else {
      setSelectedRubric(null);
    }
    setGeneratedAssessment(null);
  };

  const handleGenerate = async () => {
    if (!selectedRubricId) {
      setError('Please select a rubric');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setGeneratedAssessment(null);

    try {
      const response = await assessmentsAPI.generate({
        rubric_id: selectedRubricId,
        difficulty_level: difficultyLevel,
        question_count: questionCount,
        assessment_type: assessmentType,
        use_existing_patterns: useExistingPatterns,
        topic: topic.trim() || null
      });

      if (response.data.success) {
        setGeneratedAssessment(response.data.assessment);
        // Store rubric info if provided
        if (response.data.rubric) {
          setSelectedRubric(response.data.rubric);
        }
      } else {
        setError(response.data.error || 'Failed to generate assessment');
      }
    } catch (error: any) {
      console.error('Generation error:', error);
      setError(error.response?.data?.error || error.message || 'Failed to generate assessment');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!generatedAssessment) return;

    const content = `ASSESSMENT: ${generatedAssessment.title}
Topic: ${generatedAssessment.topic}
Difficulty: ${generatedAssessment.difficulty_level}
Type: ${generatedAssessment.assessment_type}
Estimated Time: ${generatedAssessment.estimated_time}
Total Points: ${generatedAssessment.total_points}

INSTRUCTIONS:
${generatedAssessment.instructions}

QUESTIONS:

${generatedAssessment.questions.map(q => `
${q.number}. [${q.type.toUpperCase()}] (${q.points} points)
${q.question}
${q.hints && q.hints.length > 0 ? `\nHints:\n${q.hints.map(h => `- ${h}`).join('\n')}` : ''}
`).join('\n')}

${generatedAssessment.suggested_rubric_criteria && generatedAssessment.suggested_rubric_criteria.length > 0 ? `SUGGESTED RUBRIC CRITERIA:

${generatedAssessment.suggested_rubric_criteria.map(c => `
- ${c.name} (${c.max_points} points)
  ${c.description}
`).join('\n')}` : ''}
`;

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${generatedAssessment.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <Sparkles className="w-8 h-8 text-purple-600" />
          <h1 className="text-3xl font-bold text-gray-800">AI Assessment Generator</h1>
        </div>
        <p className="text-gray-600 mb-6">
          Generate new assessments automatically based on your rubrics. The system creates questions that align with your rubric criteria, ensuring assessments match your marking standards.
        </p>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-blue-50 rounded-lg">
            <div>
              <div className="text-sm text-gray-600">Total Assignments</div>
              <div className="text-2xl font-bold text-blue-600">{stats.total_assignments}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">With Text</div>
              <div className="text-2xl font-bold text-green-600">{stats.assignments_with_text}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Marked</div>
              <div className="text-2xl font-bold text-purple-600">{stats.marked_assignments}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Rubrics</div>
              <div className="text-2xl font-bold text-orange-600">{stats.available_rubrics}</div>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Rubric * <span className="text-gray-500">(Select the rubric to base the assessment on)</span>
            </label>
            <select
              value={selectedRubricId || ''}
              onChange={(e) => handleRubricChange(e.target.value ? parseInt(e.target.value) : null)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              required
            >
              <option value="">Select a rubric...</option>
              {rubrics.map(rubric => (
                <option key={rubric.id} value={rubric.id}>
                  {rubric.name} ({rubric.total_points} points, {Array.isArray(rubric.criteria) ? rubric.criteria.length : 0} criteria)
                </option>
              ))}
            </select>
            {selectedRubric && (
              <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="text-sm font-semibold text-blue-900 mb-2">Selected Rubric: {selectedRubric.name}</div>
                <div className="text-sm text-blue-700">
                  <div>Total Points: {selectedRubric.total_points}</div>
                  <div>Criteria: {Array.isArray(selectedRubric.criteria) ? selectedRubric.criteria.length : 0}</div>
                  {Array.isArray(selectedRubric.criteria) && selectedRubric.criteria.length > 0 && (
                    <div className="mt-2">
                      <div className="font-medium mb-1">Criteria:</div>
                      <ul className="list-disc list-inside space-y-1">
                        {selectedRubric.criteria.slice(0, 5).map((criterion: any, idx: number) => (
                          <li key={idx} className="text-xs">
                            {criterion.name} ({criterion.max_points} points)
                          </li>
                        ))}
                        {selectedRubric.criteria.length > 5 && (
                          <li className="text-xs text-gray-600">... and {selectedRubric.criteria.length - 5} more</li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Topic/Subject Area <span className="text-gray-500">(optional - e.g., "World War II", "Photosynthesis")</span>
            </label>
            <input
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Enter a specific topic (optional)"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Difficulty Level
              </label>
              <select
                value={difficultyLevel}
                onChange={(e) => setDifficultyLevel(e.target.value as any)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              >
                <option value="beginner">Beginner</option>
                <option value="moderate">Moderate</option>
                <option value="advanced">Advanced</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Assessment Type
              </label>
              <select
                value={assessmentType}
                onChange={(e) => setAssessmentType(e.target.value as any)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              >
                <option value="assignment">Assignment</option>
                <option value="exam">Exam</option>
                <option value="quiz">Quiz</option>
                <option value="essay">Essay</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Number of Questions
            </label>
            <input
              type="number"
              min="1"
              max="20"
              value={questionCount}
              onChange={(e) => setQuestionCount(parseInt(e.target.value) || 5)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="usePatterns"
              checked={useExistingPatterns}
              onChange={(e) => setUseExistingPatterns(e.target.checked)}
              className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
            />
            <label htmlFor="usePatterns" className="text-sm text-gray-700">
              Use patterns from existing marked assignments and rubrics
            </label>
          </div>

          <button
            onClick={handleGenerate}
            disabled={isGenerating || !selectedRubricId}
            className="w-full bg-purple-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Generating Assessment...
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                Generate Assessment
              </>
            )}
          </button>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}
        </div>
      </div>

      {generatedAssessment && (
        <div className="bg-white rounded-lg shadow-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <FileText className="w-6 h-6 text-purple-600" />
              <h2 className="text-2xl font-bold text-gray-800">{generatedAssessment.title}</h2>
            </div>
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
            >
              <Download className="w-4 h-4" />
              Download
            </button>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="flex items-center gap-2 text-gray-600">
              <BookOpen className="w-5 h-5" />
              <span className="text-sm">{generatedAssessment.topic}</span>
            </div>
            <div className="flex items-center gap-2 text-gray-600">
              <Target className="w-5 h-5" />
              <span className="text-sm capitalize">{generatedAssessment.difficulty_level}</span>
            </div>
            <div className="flex items-center gap-2 text-gray-600">
              <FileText className="w-5 h-5" />
              <span className="text-sm capitalize">{generatedAssessment.assessment_type}</span>
            </div>
            <div className="flex items-center gap-2 text-gray-600">
              <Clock className="w-5 h-5" />
              <span className="text-sm">{generatedAssessment.estimated_time}</span>
            </div>
          </div>

          {selectedRubric && (
            <div className="mb-6 p-4 bg-purple-50 border border-purple-200 rounded-lg">
              <div className="text-sm font-semibold text-purple-900 mb-2">Based on Rubric: {selectedRubric.name}</div>
              <div className="text-sm text-purple-700">
                <div>Total Points: {selectedRubric.total_points} | Criteria: {selectedRubric.criteria_count}</div>
              </div>
            </div>
          )}

          {generatedAssessment.rubric_alignment && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h3 className="text-sm font-semibold text-blue-900 mb-2">Rubric Alignment</h3>
              <p className="text-sm text-blue-700">{generatedAssessment.rubric_alignment}</p>
            </div>
          )}

          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-2">Instructions</h3>
            <div className="bg-gray-50 p-4 rounded-lg whitespace-pre-wrap text-gray-700">
              {generatedAssessment.instructions}
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">
              Questions ({generatedAssessment.questions.length} questions, {generatedAssessment.total_points} points total)
            </h3>
            <div className="space-y-4">
              {generatedAssessment.questions.map((question, idx) => (
                <div key={idx} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-800">Question {question.number}</span>
                      <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
                        {question.type.replace('_', ' ').toUpperCase()}
                      </span>
                      <span className="text-sm text-gray-600">({question.points} points)</span>
                    </div>
                  </div>
                  <p className="text-gray-700 mb-2">{question.question}</p>
                  {question.related_criteria && question.related_criteria.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-200">
                      <div className="text-sm font-medium text-purple-600 mb-1">Assesses Rubric Criteria:</div>
                      <div className="flex flex-wrap gap-1">
                        {question.related_criteria.map((criterion, critIdx) => (
                          <span key={critIdx} className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
                            {criterion}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {question.hints && question.hints.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-200">
                      <div className="text-sm font-medium text-gray-600 mb-1">Hints:</div>
                      <ul className="list-disc list-inside text-sm text-gray-600">
                        {question.hints.map((hint, hintIdx) => (
                          <li key={hintIdx}>{hint}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {generatedAssessment.suggested_rubric_criteria && generatedAssessment.suggested_rubric_criteria.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-800 mb-4">Suggested Rubric Criteria</h3>
              <div className="space-y-3">
                {generatedAssessment.suggested_rubric_criteria.map((criterion, idx) => (
                  <div key={idx} className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold text-gray-800">{criterion.name}</span>
                      <span className="text-sm font-medium text-blue-600">{criterion.max_points} points</span>
                    </div>
                    <p className="text-sm text-gray-700">{criterion.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AssessmentGenerator;

