import React, { useState, useEffect } from 'react';
import { FileQuestion, Loader2, Send, Award, ArrowLeft } from 'lucide-react';
import { assessmentsAPI } from '../services/api';
import type { GeneratedAssessment } from '../services/api';

type Step = 'code' | 'form' | 'submitting' | 'result';

const TakeAssessment: React.FC = () => {
  const [code, setCode] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [assessment, setAssessment] = useState<GeneratedAssessment | null>(null);
  const [studentName, setStudentName] = useState('');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [step, setStep] = useState<Step>('code');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ total_score: number; feedback?: string; scores?: any[] } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('code');
    if (q && q.trim()) {
      setCode(q.trim());
      setCodeInput(q.trim());
      loadAssessment(q.trim());
    }
  }, []);

  const loadAssessment = async (c: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await assessmentsAPI.getByCode(c);
      if (res.data.success && res.data.assessment) {
        setAssessment(res.data.assessment);
        setStep('form');
      } else {
        setError('Assessment not found or link expired.');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load assessment.');
    } finally {
      setLoading(false);
    }
  };

  const handleEnterCode = (e: React.FormEvent) => {
    e.preventDefault();
    const c = codeInput.trim();
    if (!c) {
      setError('Please enter an assessment code.');
      return;
    }
    setCode(c);
    loadAssessment(c);
  };

  const setAnswer = (questionNumber: number, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionNumber]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!studentName.trim()) {
      setError('Please enter your name.');
      return;
    }
    if (!assessment || !code) return;
    setStep('submitting');
    setError(null);
    try {
      const answersList = assessment.questions.map((q) => {
        const num = (q as any).number != null ? (q as any).number : (q as any).question_number;
        return { question_number: num, value: answers[num] ?? '' };
      });
      const res = await assessmentsAPI.submit({
        code,
        student_name: studentName.trim(),
        answers: answersList,
      });
      if (res.data.success && res.data.result) {
        setResult({
          total_score: res.data.result.total_score ?? 0,
          feedback: res.data.result.feedback,
          scores: res.data.result.scores,
        });
        setStep('result');
      } else {
        setError('Submission failed.');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to submit. Please try again.');
      setStep('form');
    }
  };

  if (step === 'result' && result) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full bg-white rounded-xl shadow-lg p-6">
          <div className="flex items-center gap-3 text-green-600 mb-4">
            <Award className="w-8 h-8" />
            <h1 className="text-2xl font-bold text-gray-900">Submission marked</h1>
          </div>
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
            <div className="text-3xl font-bold text-green-700">
              Score: {result.total_score}
              {assessment?.total_points != null && (
                <span className="text-lg font-normal text-gray-600"> / {assessment.total_points}</span>
              )}
            </div>
          </div>
          {result.scores && Array.isArray(result.scores) && result.scores.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-700 mb-2">Breakdown by question / criterion</h2>
              <div className="space-y-2">
                {result.scores.map((s: any, i: number) => (
                  <div key={i} className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
                    <span className="text-gray-700">{s.criterion_name ?? s.name ?? `Item ${i + 1}`}</span>
                    <span className="font-medium text-gray-900">
                      {s.points_awarded ?? s.points ?? 0} / {s.max_points ?? s.points ?? '?'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.feedback && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-700 mb-2">Feedback</h2>
              <div className="p-4 bg-gray-50 rounded-lg whitespace-pre-wrap text-gray-700">
                {result.feedback}
              </div>
            </div>
          )}
          <p className="text-sm text-gray-500">You can close this page.</p>
        </div>
      </div>
    );
  }

  if (step === 'code' || (step === 'form' && !assessment)) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-6">
          <div className="flex items-center gap-3 mb-6">
            <FileQuestion className="w-8 h-8 text-violet-600" />
            <h1 className="text-xl font-bold text-gray-900">Take assessment</h1>
          </div>
          <p className="text-gray-600 mb-4">Enter the assessment code your teacher gave you. When you submit your answers, the assessment is marked automatically and you will see your score and feedback.</p>
          <form onSubmit={handleEnterCode} className="space-y-4">
            <input
              type="text"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="e.g. Ab12Cd34"
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-violet-500 focus:border-transparent"
              autoFocus
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-violet-600 text-white rounded-lg font-semibold hover:bg-violet-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
              Continue
            </button>
          </form>
          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!assessment) return null;

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">{assessment.title}</h1>
          {assessment.topic && (
            <p className="text-gray-600 text-sm mb-2">Topic: {assessment.topic}</p>
          )}
          {assessment.estimated_time && (
            <p className="text-gray-500 text-sm">Estimated time: {assessment.estimated_time}</p>
          )}
          {assessment.instructions && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg text-gray-700 whitespace-pre-wrap">
              {assessment.instructions}
            </div>
          )}
          <p className="mt-3 text-sm text-violet-600 font-medium">When you are done, click &quot;Submit for marking&quot; below. Your answers will be marked automatically and you will see your score and feedback.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="bg-white rounded-xl shadow-lg p-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">Your name *</label>
            <input
              type="text"
              value={studentName}
              onChange={(e) => setStudentName(e.target.value)}
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-violet-500"
              placeholder="Enter your full name"
            />
          </div>

          {assessment.questions.map((q, idx) => {
            const qNum = (q as any).number != null ? (q as any).number : idx + 1;
            const rawType = ((q as any).type || 'short_answer').replace(/-/g, '_');
            const type = rawType === 'mcq' ? 'multiple_choice' : rawType;
            const value = answers[qNum] ?? '';

            return (
              <div key={idx} className="bg-white rounded-xl shadow-lg p-6">
                <div className="flex items-start gap-2 mb-3">
                  <span className="font-semibold text-gray-800">Question {qNum}</span>
                  <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded">
                    {(q as any).points != null ? `${(q as any).points} pts` : ''} {type.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="text-gray-700 mb-4">{(q as any).question}</p>

                {(type === 'multiple_choice') && (q as any).options && Array.isArray((q as any).options) && (
                  <div className="space-y-2">
                    {((q as any).options as string[]).map((opt, i) => {
                      const letter = String.fromCharCode(65 + i);
                      return (
                        <label key={i} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name={`q-${qNum}`}
                            value={letter}
                            checked={value === letter || value === String(i + 1)}
                            onChange={() => setAnswer(qNum, letter)}
                            className="text-violet-600 border-gray-300 focus:ring-violet-500"
                          />
                          <span className="text-gray-700">{opt}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {(type === 'mix_and_match') && (q as any).left_column && (q as any).right_column && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600">Match each item on the left to the correct item on the right.</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <div className="font-medium text-gray-700 mb-2">Column A</div>
                        {((q as any).left_column as string[]).map((item, i) => (
                          <div key={i} className="mb-2 text-sm">{i + 1}. {item}</div>
                        ))}
                      </div>
                      <div>
                        <div className="font-medium text-gray-700 mb-2">Column B</div>
                        {((q as any).right_column as string[]).map((item, i) => (
                          <div key={i} className="mb-2 text-sm">{String.fromCharCode(65 + i)}. {item}</div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm text-gray-600 mb-1">Your answer (e.g. 1-A, 2-B, 3-C)</label>
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => setAnswer(qNum, e.target.value)}
                        placeholder="1-A, 2-B, ..."
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                      />
                    </div>
                  </div>
                )}

                {type === 'essay' && (
                  <textarea
                    value={value}
                    onChange={(e) => setAnswer(qNum, e.target.value)}
                    rows={5}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                    placeholder="Type your answer here..."
                  />
                )}

                {(type === 'short_answer' || type === 'problem') && (
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setAnswer(qNum, e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-violet-500"
                    placeholder="Your answer"
                  />
                )}
              </div>
            );
          })}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={step === 'submitting'}
              className="flex-1 py-3 bg-violet-600 text-white rounded-lg font-semibold hover:bg-violet-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {step === 'submitting' ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Submitting and marking...
                </>
              ) : (
                <>
                  <Send className="w-5 h-5" />
                  Submit for marking
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TakeAssessment;
