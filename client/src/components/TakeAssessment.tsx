import React, { useEffect, useState } from 'react';
import { Award, Clock3, FileQuestion, Loader2, Send } from 'lucide-react';
import { assessmentsAPI } from '../services/api';
import type { AssessmentSubmissionStatus, GeneratedAssessment } from '../services/api';

type Step = 'code' | 'form' | 'submitting' | 'pending' | 'result';

const POLL_INTERVAL_MS = 5000;

const TakeAssessment: React.FC = () => {
  const [code, setCode] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [assessment, setAssessment] = useState<GeneratedAssessment | null>(null);
  const [studentName, setStudentName] = useState('');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [step, setStep] = useState<Step>('code');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissionCode, setSubmissionCode] = useState<string | null>(null);
  const [submissionStatus, setSubmissionStatus] = useState<AssessmentSubmissionStatus | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const codeParam = params.get('code');
    const submissionParam = params.get('submission');

    if (codeParam && codeParam.trim()) {
      const trimmedCode = codeParam.trim();
      setCode(trimmedCode);
      setCodeInput(trimmedCode);
      loadAssessment(trimmedCode, Boolean(submissionParam));
    }

    if (submissionParam && submissionParam.trim()) {
      setSubmissionCode(submissionParam.trim());
      setStep('pending');
    }
  }, []);

  useEffect(() => {
    if (step !== 'pending' || !submissionCode) {
      return undefined;
    }

    let cancelled = false;

    const pollStatus = async () => {
      try {
        const res = await assessmentsAPI.getSubmissionStatus(submissionCode);
        if (!res.data?.success || !res.data?.submission || cancelled) {
          return;
        }

        const nextStatus = res.data.submission as AssessmentSubmissionStatus;
        setSubmissionStatus(nextStatus);
        if (nextStatus.student_name && !studentName) {
          setStudentName(nextStatus.student_name);
        }

        if (nextStatus.status === 'completed' && nextStatus.result) {
          setStep('result');
          setError(null);
        } else if (nextStatus.status === 'failed') {
          setError(nextStatus.failure_reason || 'Marking failed. Please contact your lecturer.');
        }
      } catch (pollError: any) {
        if (!cancelled) {
          setError(pollError.response?.data?.error || pollError.message || 'Failed to check marking status.');
        }
      }
    };

    pollStatus();
    const intervalId = window.setInterval(pollStatus, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [step, submissionCode, studentName]);

  const loadAssessment = async (assessmentCode: string, keepPendingStep = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await assessmentsAPI.getByCode(assessmentCode);
      if (res.data.success && res.data.assessment) {
        setAssessment(res.data.assessment);
        if (!keepPendingStep) {
          setStep('form');
        }
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
    const enteredCode = codeInput.trim();
    if (!enteredCode) {
      setError('Please enter an assessment code.');
      return;
    }

    setCode(enteredCode);
    setSubmissionCode(null);
    setSubmissionStatus(null);
    loadAssessment(enteredCode);
  };

  const setAnswer = (questionNumber: number, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionNumber]: value }));
  };

  const updateSubmissionUrl = (assessmentCode: string, nextSubmissionCode: string) => {
    const params = new URLSearchParams();
    params.set('code', assessmentCode);
    params.set('submission', nextSubmissionCode);
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!studentName.trim()) {
      setError('Please enter your name.');
      return;
    }
    if (!assessment || !code) {
      return;
    }

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

      if (res.data.success && res.data.submission?.submission_code) {
        const nextSubmission = res.data.submission as AssessmentSubmissionStatus;
        setSubmissionCode(nextSubmission.submission_code);
        setSubmissionStatus(nextSubmission);
        updateSubmissionUrl(code, nextSubmission.submission_code);
        setStep('pending');
      } else {
        setError('Submission failed.');
        setStep('form');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to submit. Please try again.');
      setStep('form');
    }
  };

  if (step === 'result' && submissionStatus?.result) {
    const result = submissionStatus.result;
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
            {submissionStatus.student_name && (
              <p className="mt-2 text-sm text-green-800">Student: {submissionStatus.student_name}</p>
            )}
          </div>
          {result.scores && Array.isArray(result.scores) && result.scores.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-700 mb-2">Breakdown by question / criterion</h2>
              <div className="space-y-2">
                {result.scores.map((score: any, index: number) => (
                  <div key={index} className="flex justify-between items-center gap-4 py-2 border-b border-gray-100 last:border-0">
                    <span className="text-gray-700 break-words">{score.criterion_name ?? score.name ?? `Item ${index + 1}`}</span>
                    <span className="font-medium text-gray-900 shrink-0">
                      {score.points_awarded ?? score.points ?? 0} / {score.max_points ?? score.points ?? '?'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.feedback && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-700 mb-2">Feedback</h2>
              <div className="p-4 bg-gray-50 rounded-lg whitespace-pre-wrap text-gray-700 break-words">
                {result.feedback}
              </div>
            </div>
          )}
          <p className="text-sm text-gray-500">You can close this page.</p>
        </div>
      </div>
    );
  }

  if (step === 'pending' && submissionCode) {
    const isFailed = submissionStatus?.status === 'failed';
    const isProcessing = submissionStatus?.status === 'processing';

    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full bg-white rounded-xl shadow-lg p-6">
          <div className={`flex items-center gap-3 mb-4 ${isFailed ? 'text-red-600' : 'text-violet-600'}`}>
            {isFailed ? <FileQuestion className="w-8 h-8" /> : <Clock3 className="w-8 h-8" />}
            <h1 className="text-2xl font-bold text-gray-900">
              {isFailed ? 'Marking failed' : isProcessing ? 'Marking in progress' : 'Submission received'}
            </h1>
          </div>

          <div className={`mb-6 rounded-lg border p-4 ${isFailed ? 'bg-red-50 border-red-200' : 'bg-violet-50 border-violet-200'}`}>
            <p className="text-sm text-gray-700">
              {isFailed
                ? (submissionStatus?.failure_reason || error || 'Your submission was received, but marking could not be completed.')
                : 'Your answers have been stored in the assessment batch and queued for automatic marking. This page will update as soon as the result is ready.'}
            </p>
            <div className="mt-4 grid gap-2 text-sm text-gray-600 sm:grid-cols-2">
              <div>
                <span className="font-medium text-gray-700">Submission receipt:</span> {submissionCode}
              </div>
              <div>
                <span className="font-medium text-gray-700">Status:</span> {submissionStatus?.status || 'queued'}
              </div>
              {submissionStatus?.submitted_at && (
                <div>
                  <span className="font-medium text-gray-700">Submitted:</span> {new Date(submissionStatus.submitted_at).toLocaleString()}
                </div>
              )}
              {submissionStatus?.student_name && (
                <div>
                  <span className="font-medium text-gray-700">Student:</span> {submissionStatus.student_name}
                </div>
              )}
            </div>
          </div>

          {!isFailed && (
            <div className="flex items-center gap-3 rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <Loader2 className="w-4 h-4 animate-spin text-violet-600" />
              Checking for completed marking every few seconds.
            </div>
          )}

          {error && !isFailed && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
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
          <p className="text-gray-600 mb-4">
            Enter the assessment code your teacher gave you. When you submit your answers, your work is stored instantly and marked in the background.
          </p>
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

  if (!assessment) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
          <h1 className="text-2xl font-bold text-gray-900 mb-2 break-words">{assessment.title}</h1>
          {assessment.topic && (
            <p className="text-gray-600 text-sm mb-2 break-words">Topic: {assessment.topic}</p>
          )}
          {assessment.estimated_time && (
            <p className="text-gray-500 text-sm">Estimated time: {assessment.estimated_time}</p>
          )}
          {assessment.instructions && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg text-gray-700 whitespace-pre-wrap break-words">
              {assessment.instructions}
            </div>
          )}
          <p className="mt-3 text-sm text-violet-600 font-medium">
            When you are done, click &quot;Submit for marking&quot; below. Your answers will be saved immediately and the result will appear here once background marking finishes.
          </p>
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
                <p className="text-gray-700 mb-4 break-words">{(q as any).question}</p>

                {type === 'multiple_choice' && (q as any).options && Array.isArray((q as any).options) && (
                  <div className="space-y-2">
                    {((q as any).options as string[]).map((opt, optionIndex) => {
                      const letter = String.fromCharCode(65 + optionIndex);
                      return (
                        <label key={optionIndex} className="flex items-start gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name={`q-${qNum}`}
                            value={letter}
                            checked={value === letter || value === String(optionIndex + 1)}
                            onChange={() => setAnswer(qNum, letter)}
                            className="mt-1 text-violet-600 border-gray-300 focus:ring-violet-500"
                          />
                          <span className="text-gray-700 break-words">{opt}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {type === 'mix_and_match' && (q as any).left_column && (q as any).right_column && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600">Match each item on the left to the correct item on the right.</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <div className="font-medium text-gray-700 mb-2">Column A</div>
                        {((q as any).left_column as string[]).map((item, itemIndex) => (
                          <div key={itemIndex} className="mb-2 text-sm break-words">{itemIndex + 1}. {item}</div>
                        ))}
                      </div>
                      <div>
                        <div className="font-medium text-gray-700 mb-2">Column B</div>
                        {((q as any).right_column as string[]).map((item, itemIndex) => (
                          <div key={itemIndex} className="mb-2 text-sm break-words">{String.fromCharCode(65 + itemIndex)}. {item}</div>
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
                  Saving submission...
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
