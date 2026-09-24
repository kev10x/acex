import React, { useState, useEffect } from 'react';
import { CheckCircle, AlertCircle, Loader, FileText, ClipboardCheck, Download } from 'lucide-react';
import { mcqAPI, uploadAPI } from '../services/api';

interface MCQAnswerKey {
  [questionNumber: string]: string; // e.g., { "1": "A", "2": "B", ... }
}

interface MCQResult {
  assignment_id: number;
  filename: string;
  student_name?: string;
  answers: { [questionNumber: string]: string };
  correct: number;
  incorrect: number;
  total: number;
  score: number;
  percentage: number;
}

const MCQInterface: React.FC = () => {
  const [answerKey, setAnswerKey] = useState<MCQAnswerKey>({});
  const [answerKeyText, setAnswerKeyText] = useState('');
  const [selectedForms, setSelectedForms] = useState<number[]>([]);
  const [studentNames, setStudentNames] = useState<{ [key: number]: string }>({});
  const [assignments, setAssignments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [results, setResults] = useState<MCQResult[]>([]);
  const [showResults, setShowResults] = useState(false);

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

  const parseAnswerKey = (text: string): MCQAnswerKey => {
    const key: MCQAnswerKey = {};
    const lines = text.split('\n').filter(line => line.trim());
    
    lines.forEach(line => {
      // Support formats: "1. A", "1:A", "Q1: A", "Question 1: A", "1. Answer: A"
      const match = line.match(/^(?:Q(?:uestion)?\s*)?(\d+)[:.)\s]+([A-E])/i);
      if (match) {
        const questionNum = match[1];
        const answer = match[2].toUpperCase();
        key[questionNum] = answer;
      }
    });

    return key;
  };

  const handleAnswerKeyChange = (text: string) => {
    setAnswerKeyText(text);
    const parsed = parseAnswerKey(text);
    setAnswerKey(parsed);
  };

  const handleFormSelect = (assignmentId: number, checked: boolean) => {
    if (checked) {
      setSelectedForms(prev => [...prev, assignmentId]);
    } else {
      setSelectedForms(prev => prev.filter(id => id !== assignmentId));
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

  const handleProcessMCQ = async () => {
    if (Object.keys(answerKey).length === 0) {
      setError('Please provide an answer key');
      return;
    }

    if (selectedForms.length === 0) {
      setError('Please select at least one MCQ form to process');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await mcqAPI.process({
        answer_key: answerKey,
        assignment_ids: selectedForms,
        student_names: selectedForms.map(id => studentNames[id] || null)
      });
      const data = response.data;

      setResults(data.results);
      setShowResults(true);
      setSuccess(`Successfully processed ${data.results.length} MCQ form(s)`);
      
      // Clear selections
      setSelectedForms([]);
      setStudentNames({});
      
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to process MCQ forms');
    } finally {
      setLoading(false);
    }
  };

  const handleExportResults = () => {
    if (results.length === 0) return;

    const csv = [
      ['Student Name', 'Filename', 'Score', 'Percentage', 'Correct', 'Incorrect', 'Total'].join(','),
      ...results.map(r => [
        r.student_name || 'Unknown',
        r.filename,
        r.score,
        r.percentage.toFixed(1),
        r.correct,
        r.incorrect,
        r.total
      ].join(','))
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mcq-results-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  const availableForms = assignments.filter(a => !results.some(r => r.assignment_id === a.id));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center space-x-3 mb-2">
            <ClipboardCheck className="h-6 w-6 text-primary-600" />
            <h2 className="text-2xl font-bold text-gray-900">MCQ Form Processor</h2>
          </div>
          <p className="text-gray-600">
            Process scanned multiple-choice question (MCQ) forms automatically. Upload answer key and scanned forms to get instant results.
          </p>
        </div>
      </div>

      {/* Answer Key Section */}
      <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
            <FileText className="h-5 w-5 mr-2" />
            Answer Key
          </h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Enter answer key (one per line):
              </label>
              <textarea
                value={answerKeyText}
                onChange={(e) => handleAnswerKeyChange(e.target.value)}
                placeholder="Example formats:&#10;1. A&#10;2. B&#10;3. C&#10;Q4: D&#10;Question 5: E"
                className="w-full h-40 border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                rows={10}
              />
            </div>
            {Object.keys(answerKey).length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-md p-4">
                <p className="text-sm font-medium text-green-800 mb-2">
                  ✓ Parsed {Object.keys(answerKey).length} answer(s)
                </p>
                <div className="text-xs text-green-700 space-y-1">
                  {Object.entries(answerKey).slice(0, 10).map(([q, a]) => (
                    <div key={q}>Q{q}: {a}</div>
                  ))}
                  {Object.keys(answerKey).length > 10 && (
                    <div>... and {Object.keys(answerKey).length - 10} more</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Form Selection */}
      <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            Select MCQ Forms ({selectedForms.length} selected)
          </h3>
          
          {availableForms.length === 0 ? (
            <p className="text-gray-500">No forms available. Upload scanned MCQ forms first.</p>
          ) : (
            <div className="space-y-4">
              {availableForms.map((assignment, index) => (
                <div key={assignment.id || `form-${index}`} className="flex items-center space-x-4 p-3 border border-gray-200 rounded-lg">
                  <input
                    type="checkbox"
                    checked={selectedForms.includes(assignment.id)}
                    onChange={(e) => handleFormSelect(assignment.id, e.target.checked)}
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
                  {selectedForms.includes(assignment.id) && (
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

      {/* Process Button */}
      <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
        <div className="px-4 py-5 sm:p-6">
          <button
            onClick={handleProcessMCQ}
            disabled={loading || Object.keys(answerKey).length === 0 || selectedForms.length === 0}
            className="w-full flex items-center justify-center px-4 py-3 border border-transparent rounded-lg shadow-sm text-base font-semibold text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <>
                <Loader className="animate-spin h-5 w-5 mr-2" />
                Processing MCQ Forms...
              </>
            ) : (
              <>
                <ClipboardCheck className="h-5 w-5 mr-2" />
                Process {selectedForms.length} MCQ Form(s)
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error/Success Messages */}
      {(error || success) && (
        <div className={`rounded-md p-4 ${error ? 'bg-red-50' : 'bg-green-50'}`}>
          <div className="flex">
            <div className="flex-shrink-0">
              {error ? (
                <AlertCircle className="h-5 w-5 text-red-400" />
              ) : (
                <CheckCircle className="h-5 w-5 text-green-400" />
              )}
            </div>
            <div className="ml-3">
              <p className={`text-sm font-medium ${error ? 'text-red-800' : 'text-green-800'}`}>
                {error || success}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {showResults && results.length > 0 && (
        <div className="bg-white shadow-sm rounded-2xl border border-gray-200/70">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <CheckCircle className="h-5 w-5 mr-2 text-green-500" />
                Results ({results.length} form(s))
              </h3>
              <button
                onClick={handleExportResults}
                className="flex items-center px-3 py-2 text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                <Download className="h-4 w-4 mr-1" />
                Export CSV
              </button>
            </div>
            
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                      Student Name
                    </th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                      Filename
                    </th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                      Score
                    </th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                      Percentage
                    </th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                      Correct / Total
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {results.map((result, index) => (
                    <tr key={index} className={result.percentage >= 70 ? 'bg-green-50' : result.percentage >= 50 ? 'bg-yellow-50' : 'bg-red-50'}>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                        {result.student_name || 'Unknown'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        {result.filename}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                        {result.score} / {result.total}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
                        {result.percentage.toFixed(1)}%
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                        {result.correct} / {result.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MCQInterface;

