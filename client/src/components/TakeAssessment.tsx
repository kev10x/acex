import React, { useEffect, useState } from 'react';
import { Award, Clock3, FileQuestion, Loader2, Send } from 'lucide-react';
import { assessmentsAPI } from '../services/api';
import type { AssessmentSubmissionStatus, GeneratedAssessment } from '../services/api';

type Step = 'code' | 'form' | 'submitting' | 'pending' | 'result';
type DraggedMatch = {
  questionNumber: number;
  rightIndex: number;
  sourceLeftIndex: number | null;
};

const POLL_INTERVAL_MS = 5000;
const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const getOptionLetter = (index: number) => OPTION_LETTERS[index] || String(index + 1);

const stripOptionPrefix = (option: string, optionIndex: number) => {
  const letter = getOptionLetter(optionIndex);
  return String(option || '')
    .replace(new RegExp(`^\\s*\\(?${letter}\\)?[\\)\\].:\\-]?\\s+`, 'i'), '')
    .trim();
};

const parseMatchAnswer = (value: string, leftCount: number, rightCount: number) => {
  const assignments = Array.from({ length: leftCount }, () => null as number | null);
  const usedRightIndexes = new Set<number>();
  const matches = Array.from(String(value || '').matchAll(/(\d+)\s*[-:=]\s*([A-Z]|\d+)/gi));

  for (const match of matches) {
    const leftIndex = Number(match[1]) - 1;
    const rightToken = String(match[2]).trim().toUpperCase();
    const rightIndex = /^[A-Z]$/.test(rightToken)
      ? rightToken.charCodeAt(0) - 65
      : Number(rightToken) - 1;

    if (
      Number.isFinite(leftIndex) &&
      Number.isFinite(rightIndex) &&
      leftIndex >= 0 &&
      leftIndex < leftCount &&
      rightIndex >= 0 &&
      rightIndex < rightCount &&
      !usedRightIndexes.has(rightIndex)
    ) {
      assignments[leftIndex] = rightIndex;
      usedRightIndexes.add(rightIndex);
    }
  }

  return assignments;
};

const serializeMatchAnswer = (assignments: Array<number | null>) =>
  assignments
    .map((rightIndex, leftIndex) => (
      rightIndex === null ? null : `${leftIndex + 1}-${getOptionLetter(rightIndex)}`
    ))
    .filter(Boolean)
    .join(', ');

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
  const [draggedMatch, setDraggedMatch] = useState<DraggedMatch | null>(null);

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

  const updateMatchAnswer = (
    questionNumber: number,
    leftCount: number,
    rightCount: number,
    updater: (assignments: Array<number | null>) => Array<number | null>
  ) => {
    const current = parseMatchAnswer(answers[questionNumber] ?? '', leftCount, rightCount);
    const next = updater([...current]);
    setAnswer(questionNumber, serializeMatchAnswer(next));
  };

  const handleMatchDragStart = (questionNumber: number, rightIndex: number, sourceLeftIndex: number | null) => {
    setDraggedMatch({ questionNumber, rightIndex, sourceLeftIndex });
  };

  const handleMatchDrop = (
    questionNumber: number,
    targetLeftIndex: number,
    leftCount: number,
    rightCount: number
  ) => {
    if (!draggedMatch || draggedMatch.questionNumber !== questionNumber) return;

    updateMatchAnswer(questionNumber, leftCount, rightCount, (assignments) => {
      const next = [...assignments];
      const { rightIndex, sourceLeftIndex } = draggedMatch;
      const displaced = next[targetLeftIndex];

      next[targetLeftIndex] = rightIndex;
      if (sourceLeftIndex !== null && sourceLeftIndex !== targetLeftIndex) {
        next[sourceLeftIndex] = displaced ?? null;
      }

      return next;
    });

    setDraggedMatch(null);
  };

  const handleMatchPoolDrop = (questionNumber: number, leftCount: number, rightCount: number) => {
    if (!draggedMatch || draggedMatch.questionNumber !== questionNumber || draggedMatch.sourceLeftIndex === null) return;

    updateMatchAnswer(questionNumber, leftCount, rightCount, (assignments) => {
      const next = [...assignments];
      next[draggedMatch.sourceLeftIndex as number] = null;
      return next;
    });

    setDraggedMatch(null);
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
            const leftColumn = Array.isArray((q as any).left_column) ? ((q as any).left_column as string[]) : [];
            const rightColumn = Array.isArray((q as any).right_column) ? ((q as any).right_column as string[]) : [];
            const matchAssignments = type === 'mix_and_match'
              ? parseMatchAnswer(value, leftColumn.length, rightColumn.length)
              : [];
            const assignedRightIndexes = new Set(
              matchAssignments.filter((assignment): assignment is number => assignment !== null)
            );
            const unassignedRightItems = rightColumn
              .map((item, itemIndex) => ({ item, itemIndex }))
              .filter(({ itemIndex }) => !assignedRightIndexes.has(itemIndex));

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
                      const letter = getOptionLetter(optionIndex);
                      const label = stripOptionPrefix(opt, optionIndex) || String(opt || '').trim();
                      return (
                        <label key={optionIndex} className="flex items-start gap-3 cursor-pointer rounded-lg border border-gray-200 px-3 py-2 hover:border-violet-300 hover:bg-violet-50">
                          <input
                            type="radio"
                            name={`q-${qNum}`}
                            value={letter}
                            checked={value === letter || value === String(optionIndex + 1)}
                            onChange={() => setAnswer(qNum, letter)}
                            className="mt-1 text-violet-600 border-gray-300 focus:ring-violet-500"
                          />
                          <span className="inline-flex w-7 shrink-0 justify-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                            {letter}
                          </span>
                          <span className="text-gray-700 break-words">{label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {type === 'mix_and_match' && leftColumn.length > 0 && rightColumn.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray-600">
                      Drag choices from the pool into the matching slots. Drag an assigned choice back to the pool to remove it.
                    </p>
                    <div
                      className="rounded-xl border border-dashed border-violet-300 bg-violet-50/60 p-4"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => handleMatchPoolDrop(qNum, leftColumn.length, rightColumn.length)}
                    >
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-violet-800">Choice pool</div>
                        <div className="text-xs text-violet-700">{unassignedRightItems.length} unassigned</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {unassignedRightItems.length === 0 && (
                          <div className="rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm text-violet-700">
                            All choices have been assigned.
                          </div>
                        )}
                        {unassignedRightItems.map(({ item, itemIndex }) => (
                          <button
                            key={itemIndex}
                            type="button"
                            draggable
                            onDragStart={() => handleMatchDragStart(qNum, itemIndex, null)}
                            onDragEnd={() => setDraggedMatch(null)}
                            className="flex items-center gap-2 rounded-lg border border-violet-200 bg-white px-3 py-2 text-left text-sm text-gray-700 shadow-sm"
                          >
                            <span className="inline-flex w-7 shrink-0 justify-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                              {getOptionLetter(itemIndex)}
                            </span>
                            <span className="break-words">{item}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-3">
                      {leftColumn.map((item, leftIndex) => {
                        const assignedRightIndex = matchAssignments[leftIndex];
                        const assignedRightText = assignedRightIndex !== null ? rightColumn[assignedRightIndex] : null;

                        return (
                          <div
                            key={leftIndex}
                            className="grid gap-3 rounded-xl border border-gray-200 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                          >
                            <div>
                              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                                Prompt {leftIndex + 1}
                              </div>
                              <div className="text-sm text-gray-800 break-words">{item}</div>
                            </div>
                            <div
                              className={`rounded-lg border-2 border-dashed p-3 transition-colors ${
                                draggedMatch?.questionNumber === qNum
                                  ? 'border-violet-300 bg-violet-50'
                                  : 'border-gray-200 bg-gray-50'
                              }`}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={() => handleMatchDrop(qNum, leftIndex, leftColumn.length, rightColumn.length)}
                            >
                              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                                Match
                              </div>
                              {assignedRightIndex !== null && assignedRightText ? (
                                <button
                                  type="button"
                                  draggable
                                  onDragStart={() => handleMatchDragStart(qNum, assignedRightIndex, leftIndex)}
                                  onDragEnd={() => setDraggedMatch(null)}
                                  className="flex w-full items-start gap-2 rounded-lg border border-violet-200 bg-white px-3 py-2 text-left text-sm text-gray-700 shadow-sm"
                                >
                                  <span className="inline-flex w-7 shrink-0 justify-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                                    {getOptionLetter(assignedRightIndex)}
                                  </span>
                                  <span className="break-words">{assignedRightText}</span>
                                </button>
                              ) : (
                                <div className="text-sm text-gray-500">
                                  Drop the correct match here.
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
                      Saved as: {value || 'No matches selected yet'}
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
