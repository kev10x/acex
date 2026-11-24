import { PublicBrand } from './BrandMark';
import React, { useEffect, useRef, useState } from 'react';
import { Award, Clock3, FileQuestion, Loader2, LogOut, Maximize, Send, ShieldCheck, Volume2 } from 'lucide-react';
import { assessmentsAPI, integrityAPI } from '../services/api';
import type { AssessmentSubmissionStatus, GeneratedAssessment, IntegrityClientEvent, IntegritySettings } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { enterFullscreen, getAttemptSessionId, isFullscreenSupported, useIntegrityMonitor } from '../hooks/useIntegrityMonitor';
import { describeEvent } from '../utils/integrityText';

export const POST_LOGIN_REDIRECT_KEY = 'acex-post-login-redirect';

// What a student is told is recorded before they opt in to a monitored assessment.
const describeMonitoring = (settings: IntegritySettings) => [
  settings.require_fullscreen ? 'The assessment runs in full screen. Leaving full screen is recorded.' : null,
  'Switching to another tab or app, and for how long, is recorded.',
  settings.hide_questions_on_leave ? 'Questions are hidden while you are away from the assessment.' : null,
  settings.copy_paste === 'block'
    ? 'Copying and pasting are blocked. Attempts are recorded.'
    : 'Copying and pasting are allowed, but how much text is copied or pasted is recorded (not the text itself).',
  settings.right_click === 'block' ? 'Right-click is blocked.' : null,
  settings.screenshots === 'block'
    ? 'Screenshot keys are recorded, and questions are briefly hidden when one is pressed.'
    : 'Screenshot keys (such as Print Screen) are recorded.',
  'Text that appears faster than it can be typed is recorded.',
  'Your IP address is recorded when you start and while you work.',
  settings.allowed_ip_ranges.length ? 'You can only start this assessment from the exam venue network.' : null,
  'You must choose to submit or exit when you finish. Closing the page does not end the assessment.'
].filter(Boolean) as string[];

type Step = 'code' | 'form' | 'submitting' | 'pending' | 'result';
type DraggedMatch = {
  questionNumber: number;
  rightIndex: number;
  sourceLeftIndex: number | null;
};

const POLL_INTERVAL_MS = 5000;
const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const AUDIO_LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'af', label: 'Afrikaans' },
  { value: 'zu', label: 'isiZulu' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'pt', label: 'Portuguese' },
];

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
  const { user } = useAuth();
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
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const questionAudioBlobUrlRef = useRef<string | null>(null);
  const [questionAudioUrl, setQuestionAudioUrl] = useState<string | null>(null);
  const [questionAudioLoading, setQuestionAudioLoading] = useState(false);
  const [questionAudioError, setQuestionAudioError] = useState<string | null>(null);
  const [questionAudioVoice, setQuestionAudioVoice] = useState('eve');
  const [questionAudioLanguage, setQuestionAudioLanguage] = useState('en');
  const [questionAudioTarget, setQuestionAudioTarget] = useState<string | null>(null);
  const defaultStudentName = user?.name?.trim() || user?.email?.trim() || '';
  const [monitored, setMonitored] = useState(false);
  const [integritySettings, setIntegritySettings] = useState<IntegritySettings | null>(null);
  const [attemptToken, setAttemptToken] = useState<string | null>(null);
  const [attemptEnded, setAttemptEnded] = useState<string | null>(null);
  const [consentGiven, setConsentGiven] = useState(false);
  const [startingAttempt, setStartingAttempt] = useState(false);
  const [exitDialog, setExitDialog] = useState<'closed' | 'choose' | 'confirm_exit'>('closed');
  // Staff preview (?preview=1): the student view with nothing recorded or submitted.
  const [previewMode] = useState(() => new URLSearchParams(window.location.search).get('preview') === '1');
  const [previewLog, setPreviewLog] = useState<IntegrityClientEvent[]>([]);
  // Monitoring was switched on after this page loaded: submitting needs a reload into a monitored attempt.
  const [needsReload, setNeedsReload] = useState(false);
  const addPreviewEvents = (events: IntegrityClientEvent[]) => {
    if (events.length) setPreviewLog((prev) => [...prev, ...events].slice(-100));
  };
  const attemptActive = monitored && Boolean(attemptToken) && !attemptEnded && step === 'form';
  const sessionId = code ? getAttemptSessionId(code) : '';
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const monitor = useIntegrityMonitor({
    active: attemptActive,
    token: attemptToken,
    sessionId,
    settings: integritySettings,
    getAnswers: () => answersRef.current,
    dryRun: previewMode,
    onPreviewEvents: addPreviewEvents
  });
  const fullscreenRequired = Boolean(integritySettings?.require_fullscreen) && isFullscreenSupported();
  const showFullscreenGate = attemptActive && fullscreenRequired && !monitor.isFullscreen;
  const hideQuestions = attemptActive && (
    showFullscreenGate
    || monitor.screenshotHidden
    || (Boolean(integritySettings?.hide_questions_on_leave) && monitor.away)
  );

  // Closing or reloading the page does not end a monitored attempt; warn before leaving.
  useEffect(() => {
    if (!attemptActive || previewMode) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [attemptActive]);

  const leaveFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  const handleStartAttempt = async () => {
    if (!code) return;
    setStartingAttempt(true);
    setError(null);
    if (integritySettings?.require_fullscreen) await enterFullscreen();
    if (previewMode) {
      try {
        const res = await integrityAPI.preview(code);
        setAssessment(res.data.assessment);
        setIntegritySettings(res.data.settings);
        setAnswers({});
        setCurrentQuestionIndex(0);
        setPreviewLog([]);
        setAttemptToken('preview');
      } catch (e: any) {
        leaveFullscreen();
        setError(e.response?.data?.error || 'Only the lecturer who published this assessment, or management, can preview it.');
      } finally {
        setStartingAttempt(false);
      }
      return;
    }
    try {
      const res = await integrityAPI.start(code, getAttemptSessionId(code));
      setAssessment(res.data.assessment);
      setIntegritySettings(res.data.settings);
      const draft = res.data.draft_answers || {};
      setAnswers(Object.fromEntries(Object.entries(draft).map(([key, value]) => [Number(key), String(value)])));
      setCurrentQuestionIndex(0);
      setAttemptToken(res.data.attempt.token);
    } catch (e: any) {
      leaveFullscreen();
      if (e.response?.status === 409) {
        setAttemptEnded(e.response?.data?.error || 'This attempt has ended.');
      } else {
        setError(e.response?.data?.error || e.message || 'Could not start the assessment.');
      }
    } finally {
      setStartingAttempt(false);
    }
  };

  const endPreview = () => {
    addPreviewEvents(monitor.drain());
    setAttemptEnded('Preview finished. Nothing was recorded or submitted.');
    setExitDialog('closed');
    leaveFullscreen();
  };

  const handleExitWithoutSubmitting = async () => {
    if (!attemptToken) return;
    if (previewMode) {
      endPreview();
      return;
    }
    try {
      await integrityAPI.exit(attemptToken, { session_id: sessionId, events: monitor.drain(), answers });
      setAttemptEnded('You exited the assessment without submitting. Ask your lecturer if you need it reopened.');
      setExitDialog('closed');
      leaveFullscreen();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Could not exit. Check your connection and try again.');
      setExitDialog('closed');
    }
  };

  const goToSignIn = () => {
    try {
      window.sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, `${window.location.pathname}${window.location.search}`);
    } catch (_) {
      // Without storage the student lands on the home page after signing in.
    }
    window.location.href = window.location.pathname.replace(/take-assessment\/?$/, '') || '/';
  };

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

  useEffect(() => {
    if (!defaultStudentName || studentName.trim()) return;
    setStudentName(defaultStudentName);
  }, [defaultStudentName, studentName]);

  useEffect(() => {
    return () => {
      if (questionAudioBlobUrlRef.current) {
        URL.revokeObjectURL(questionAudioBlobUrlRef.current);
        questionAudioBlobUrlRef.current = null;
      }
    };
  }, []);

  const loadAssessment = async (assessmentCode: string, keepPendingStep = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await assessmentsAPI.getByCode(assessmentCode);
      if (res.data.success && res.data.assessment) {
        setMonitored(Boolean(res.data.monitored));
        setIntegritySettings(res.data.monitored ? res.data.integrity : null);
        setAttemptToken(null);
        setAttemptEnded(null);
        setAssessment(res.data.assessment);
        setCurrentQuestionIndex(0);
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

  const handlePlayQuestionAudio = async (questionIndex: number) => {
    if (!code) return;
    setQuestionAudioLoading(true);
    setQuestionAudioError(null);
    setQuestionAudioTarget(`question-${questionIndex}`);
    try {
      const sourceIndex = assessment?.questions[questionIndex]?.source_index ?? questionIndex;
      // Monitored attempts number questions in the order shown, so the narration says the same number.
      const displayNumber = monitored ? questionIndex + 1 : null;
      const res = await assessmentsAPI.getQuestionAudio(code, sourceIndex, questionAudioVoice, questionAudioLanguage, attemptToken, displayNumber);
      const blobUrl = URL.createObjectURL(res.data as Blob);
      if (questionAudioBlobUrlRef.current) {
        URL.revokeObjectURL(questionAudioBlobUrlRef.current);
      }
      questionAudioBlobUrlRef.current = blobUrl;
      setQuestionAudioUrl(blobUrl);
    } catch (e: any) {
      setQuestionAudioError(e.response?.data?.error || e.message || 'Failed to load audio for this question.');
    } finally {
      setQuestionAudioLoading(false);
    }
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
    if (previewMode) {
      if (monitored) endPreview();
      else setError('Preview mode: answers are not submitted.');
      return;
    }

    setStep('submitting');
    setError(null);

    try {
      const answersList = assessment.questions.map((q) => {
        const num = (q as any).number != null ? (q as any).number : (q as any).question_number;
        return { question_number: num, value: answers[num] ?? '' };
      });
      const res = monitored && attemptToken
        ? await integrityAPI.submit(attemptToken, { session_id: sessionId, events: monitor.drain(), answers: answersList })
        : await assessmentsAPI.submit({
            code,
            student_name: studentName.trim(),
            answers: answersList,
          });
      if (monitored) {
        setExitDialog('closed');
        leaveFullscreen();
      }

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
      setNeedsReload(e.response?.data?.code === 'assessment_monitored');
      setError(e.response?.data?.error || e.message || 'Failed to submit. Please try again.');
      setStep('form');
    }
  };

  if (step === 'result' && submissionStatus?.result) {
    const result = submissionStatus.result;
    return (
      <div className="min-h-screen bg-app flex flex-col items-center justify-center gap-6 p-4"><PublicBrand />
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
      <div className="min-h-screen bg-app flex flex-col items-center justify-center gap-6 p-4"><PublicBrand />
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
      <div className="min-h-screen bg-app flex flex-col items-center justify-center gap-6 p-4"><PublicBrand />
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
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              autoFocus
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2"
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

  if (monitored && attemptEnded) {
    return (
      <div className="min-h-screen bg-app flex flex-col items-center justify-center gap-6 p-4"><PublicBrand />
        {previewMode && (
          <div className="fixed inset-x-0 top-0 z-[70] bg-amber-400 py-1.5 text-center text-sm font-medium text-amber-950">
            Preview: you are seeing what students see. Nothing is recorded or submitted.
          </div>
        )}
        {previewMode && previewLog.length > 0 && (
          <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-5 order-last">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">What would have been recorded</h2>
            <ul className="space-y-1 text-sm text-gray-700 list-disc pl-5">
              {previewLog.map((event, index) => (
                <li key={index}>{describeEvent({ type: event.type, duration_ms: event.duration_ms ?? null, question_number: event.question_number ?? null, details: { chars: event.chars, blocked: event.blocked, source: event.source, signature: event.signature, combo: event.combo } })}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-6 text-center">
          <ShieldCheck className="w-10 h-10 text-violet-600 mx-auto mb-3" />
          <h1 className="text-xl font-bold text-gray-900 mb-2">{assessment.title}</h1>
          <p className="text-gray-600">{attemptEnded}</p>
        </div>
      </div>
    );
  }

  if (monitored && !attemptToken) {
    const settings = integritySettings;
    return (
      <div className="min-h-screen bg-app flex flex-col items-center justify-center gap-6 p-4"><PublicBrand />
        {previewMode && (
          <div className="fixed inset-x-0 top-0 z-[70] bg-amber-400 py-1.5 text-center text-sm font-medium text-amber-950">
            Preview: you are seeing what students see. Nothing is recorded or submitted.
          </div>
        )}
        <div className="max-w-xl w-full bg-white rounded-xl shadow-lg p-6">
          <div className="flex items-center gap-3 mb-2">
            <ShieldCheck className="w-8 h-8 text-violet-600" />
            <h1 className="text-xl font-bold text-gray-900 break-words">{assessment.title}</h1>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Monitored assessment{(assessment as any).question_count ? ` · ${(assessment as any).question_count} questions` : ''}
            {assessment.estimated_time ? ` · ${assessment.estimated_time}` : ''}
          </p>
          {!user ? (
            <>
              <p className="text-gray-700 mb-4">Sign in with your student account to take this assessment.</p>
              <button
                type="button"
                onClick={goToSignIn}
                className="w-full py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700"
              >
                Sign in to continue
              </button>
            </>
          ) : (
            <>
              {assessment.instructions && (
                <div className="mb-4 p-4 bg-gray-50 rounded-lg text-sm text-gray-700 whitespace-pre-wrap break-words">
                  {assessment.instructions}
                </div>
              )}
              <h2 className="text-sm font-semibold text-gray-900 mb-2">Before you start</h2>
              <ul className="mb-4 space-y-1.5 text-sm text-gray-700 list-disc pl-5">
                {settings && describeMonitoring(settings).map((line) => <li key={line}>{line}</li>)}
              </ul>
              <p className="mb-4 text-xs text-gray-500">
                Your lecturer sees a summary of this record with your submission. Nothing you type or paste is recorded apart from your answers.
              </p>
              <label className="flex items-start gap-2 mb-4 text-sm text-gray-800">
                <input
                  type="checkbox"
                  checked={consentGiven}
                  onChange={(e) => setConsentGiven(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                I am {defaultStudentName}, I understand what is recorded, and I want to start the assessment now.
              </label>
              <button
                type="button"
                onClick={handleStartAttempt}
                disabled={!consentGiven || startingAttempt}
                className="w-full py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {startingAttempt ? <Loader2 className="w-5 h-5 animate-spin" /> : <ShieldCheck className="w-5 h-5" />}
                Start assessment
              </button>
            </>
          )}
          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  const totalQuestions = assessment.questions.length;
  const safeQuestionIndex = Math.min(Math.max(currentQuestionIndex, 0), Math.max(0, totalQuestions - 1));
  const activeQuestion = assessment.questions[safeQuestionIndex];
  const activeQuestionNumber = activeQuestion
    ? ((activeQuestion as any).number != null ? (activeQuestion as any).number : safeQuestionIndex + 1)
    : null;
  const answeredCount = assessment.questions.reduce((count, q, idx) => {
    const num = (q as any).number != null ? (q as any).number : idx + 1;
    return answers[num] && String(answers[num]).trim() ? count + 1 : count;
  }, 0);

  return (
    <div className="min-h-screen bg-app py-8 px-4">
      {hideQuestions && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900 p-4">
          <div className="max-w-md w-full rounded-xl bg-white p-6 text-center shadow-xl">
            <ShieldCheck className="w-10 h-10 text-violet-600 mx-auto mb-3" />
            <h2 className="text-lg font-semibold text-gray-900 mb-2">
              {showFullscreenGate
                ? 'Return to full screen to continue'
                : monitor.screenshotHidden && !monitor.away
                  ? 'Screenshots are not allowed in this assessment'
                  : 'Return to the assessment to continue'}
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              {monitor.screenshotHidden && !monitor.away && !showFullscreenGate
                ? 'The questions will reappear in a moment. Screenshot keys are recorded.'
                : 'Questions are hidden while you are away. Time away from the assessment is recorded.'}
            </p>
            {showFullscreenGate && (
              <button
                type="button"
                onClick={() => { void enterFullscreen(); }}
                className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 font-semibold text-white hover:bg-primary-700"
              >
                <Maximize className="w-4 h-4" />
                Return to full screen
              </button>
            )}
          </div>
        </div>
      )}
      {exitDialog !== 'closed' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 p-4">
          <div className="max-w-md w-full rounded-xl bg-white p-6 shadow-xl">
            {exitDialog === 'choose' ? (
              <>
                <h2 className="text-lg font-semibold text-gray-900 mb-2">Finish the assessment</h2>
                <p className="text-sm text-gray-600 mb-4">
                  You have answered {Object.values(answers).filter((value) => String(value || '').trim()).length} of {assessment.questions.length} questions.
                </p>
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={(event) => { void handleSubmit(event as unknown as React.FormEvent); }}
                    disabled={step === 'submitting'}
                    className="w-full py-2.5 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 disabled:opacity-50"
                  >
                    Submit and exit
                  </button>
                  <button
                    type="button"
                    onClick={() => setExitDialog('confirm_exit')}
                    className="w-full py-2.5 border border-red-200 text-red-700 rounded-lg font-semibold hover:bg-red-50"
                  >
                    Exit without submitting
                  </button>
                  <button
                    type="button"
                    onClick={() => setExitDialog('closed')}
                    className="w-full py-2.5 text-gray-600 rounded-lg font-medium hover:bg-gray-50"
                  >
                    Keep working
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold text-gray-900 mb-2">Exit without submitting?</h2>
                <p className="text-sm text-gray-600 mb-4">
                  Your answers will not be marked, and you cannot come back unless your lecturer reopens the assessment.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setExitDialog('choose')}
                    className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50"
                  >
                    Go back
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleExitWithoutSubmitting(); }}
                    className="flex-1 py-2.5 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700"
                  >
                    Exit
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {previewMode && (
        <div className="fixed inset-x-0 top-0 z-[70] bg-amber-400 py-1.5 text-center text-sm font-medium text-amber-950">
          Preview: you are seeing what students see. Nothing is recorded or submitted.
        </div>
      )}
      {previewMode && attemptActive && (
        <div className="fixed bottom-4 right-4 z-[60] w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-amber-200 bg-white shadow-xl">
          <div className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-900">What would be recorded</div>
          <ul className="max-h-60 space-y-1 overflow-y-auto px-4 py-2 text-xs text-gray-700">
            {previewLog.length === 0 ? (
              <li className="text-gray-400">Nothing yet. Try switching tabs, pasting, or leaving full screen.</li>
            ) : (
              previewLog.slice().reverse().map((event, index) => (
                <li key={index}>{describeEvent({ type: event.type, duration_ms: event.duration_ms ?? null, question_number: event.question_number ?? null, details: { chars: event.chars, blocked: event.blocked, source: event.source, signature: event.signature, combo: event.combo } })}</li>
              ))
            )}
          </ul>
        </div>
      )}
      <div className={`max-w-3xl mx-auto ${previewMode ? 'pt-6' : ''}`}>
        <PublicBrand className="mb-6" />
        {monitored && attemptToken && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-200 bg-white px-4 py-3 shadow-sm">
            <span className="flex items-center gap-2 text-sm font-medium text-violet-800">
              <ShieldCheck className="w-4 h-4" />
              Monitored assessment
              {monitor.connectionProblem && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Reconnecting... keep working</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setExitDialog('choose')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <LogOut className="w-4 h-4" />
              Finish / exit
            </button>
          </div>
        )}
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
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-violet-50 px-4 py-3 text-sm">
            <span className="font-medium text-violet-800">
              Question {safeQuestionIndex + 1} of {totalQuestions}
            </span>
            <span className="text-violet-700">
              Answered: {answeredCount} / {totalQuestions}
            </span>
          </div>
          <p className="mt-3 text-sm text-violet-600 font-medium">
            When you are done, click &quot;Submit for marking&quot; below. Your answers will be saved immediately and the result will appear here once background marking finishes.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          // Enter in a one-line answer must not hand in the whole assessment.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'submit') {
              event.preventDefault();
            }
          }}
          className="space-y-6"
        >
          {/* Logged-in students are identified by their account; only anonymous visitors are asked. */}
          {!defaultStudentName && (
            <div className="bg-white rounded-xl shadow-lg p-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Your name *</label>
              <input
                type="text"
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
                placeholder="Enter your full name"
              />
            </div>
          )}

          {activeQuestion && (() => {
            const q = activeQuestion;
            const idx = safeQuestionIndex;
            const qNum = activeQuestionNumber as number;
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
              <div key={idx} data-question-number={qNum} className="bg-white rounded-xl shadow-lg p-6">
                <div className="flex items-start gap-2 mb-3">
                  {/* Shuffled monitored attempts read 1, 2, 3...; answers and reports keep the paper's numbers. */}
                  <span className="font-semibold text-gray-800">Question {monitored ? idx + 1 : qNum}</span>
                  <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded">
                    {(q as any).points != null ? `${(q as any).points} pts` : ''} {type.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handlePlayQuestionAudio(idx)}
                    disabled={questionAudioLoading}
                    className="inline-flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
                  >
                    {questionAudioLoading && questionAudioTarget === `question-${idx}` ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Volume2 className="w-4 h-4" />
                    )}
                    {questionAudioLoading && questionAudioTarget === `question-${idx}` ? 'Generating audio...' : 'Listen to question'}
                  </button>
                  <select
                    value={questionAudioVoice}
                    onChange={(e) => setQuestionAudioVoice(e.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 bg-white shadow-sm"
                  >
                    <option value="eve">Eve</option>
                    <option value="ara">Ara</option>
                    <option value="leo">Leo</option>
                    <option value="rex">Rex</option>
                    <option value="sal">Sal</option>
                  </select>
                  <select
                    value={questionAudioLanguage}
                    onChange={(e) => setQuestionAudioLanguage(e.target.value)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 bg-white shadow-sm"
                  >
                    {AUDIO_LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                {questionAudioError && (
                  <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    {questionAudioError}
                  </div>
                )}
                {questionAudioUrl && (
                  <div className="mb-4">
                    <audio controls autoPlay className="w-full" src={questionAudioUrl}>
                      Your browser does not support audio playback.
                    </audio>
                  </div>
                )}
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
                            className="mt-1 text-violet-600 border-gray-300 focus:ring-primary-500"
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
                    autoComplete="off"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
                    placeholder="Type your answer here..."
                  />
                )}

                {(type === 'short_answer' || type === 'problem') && (
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setAnswer(qNum, e.target.value)}
                    autoComplete="off"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
                    placeholder="Your answer"
                  />
                )}
              </div>
            );
          })()}

          {error && (
            <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg">
              {error}
              {needsReload && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-3 block rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700"
                >
                  Reload the assessment
                </button>
              )}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setCurrentQuestionIndex((prev) => Math.max(0, prev - 1))}
              disabled={safeQuestionIndex === 0}
              className="flex-1 py-3 border border-gray-300 text-gray-700 rounded-lg font-semibold hover:bg-gray-50 disabled:opacity-50"
            >
              Previous question
            </button>
            {/* Distinct keys: otherwise React reuses this button as the submit button mid-click,
                and the browser submits the form when moving to the last question. */}
            {safeQuestionIndex < totalQuestions - 1 ? (
              <button
                key="next-question"
                type="button"
                onClick={() => setCurrentQuestionIndex((prev) => Math.min(totalQuestions - 1, prev + 1))}
                className="flex-1 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700"
              >
                Next question
              </button>
            ) : (
              <button
                key="submit-assessment"
                type="submit"
                disabled={step === 'submitting'}
                className="flex-1 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2"
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
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

export default TakeAssessment;
