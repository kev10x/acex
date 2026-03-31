import React, { useState, useEffect, useRef } from 'react';
import { BookOpen, Loader2, Send, Award, Video } from 'lucide-react';
import { contentAPI } from '../services/api';
import type { GeneratedContent } from '../services/api';

type Step = 'code' | 'content' | 'submitting' | 'result';

const TakeContent: React.FC = () => {
  const [code, setCode] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [content, setContent] = useState<GeneratedContent | null>(null);
  const [videoStatus, setVideoStatus] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [studentName, setStudentName] = useState('');
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [step, setStep] = useState<Step>('code');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ total_score: number; feedback?: string; scores?: any[] } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoBlobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('code');
    if (q && q.trim()) {
      setCode(q.trim());
      setCodeInput(q.trim());
      loadContent(q.trim());
    }
  }, []);

  useEffect(() => {
    if (!code || step !== 'content') return;
    setVideoUrl(null);
    const loadVideoBlob = async () => {
      const videoRes = await contentAPI.getVideoContent(code);
      const blobUrl = URL.createObjectURL(videoRes.data as Blob);
      if (videoBlobUrlRef.current) {
        URL.revokeObjectURL(videoBlobUrlRef.current);
      }
      videoBlobUrlRef.current = blobUrl;
      setVideoUrl(blobUrl);
    };
    const poll = async () => {
      try {
        const res = await contentAPI.getVideoStatus(code);
        const st = res.data.status;
        setVideoStatus(st || null);
        if (st === 'completed') {
          await loadVideoBlob();
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch (_) {}
    };
    poll();
    pollRef.current = setInterval(poll, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (videoBlobUrlRef.current) {
        URL.revokeObjectURL(videoBlobUrlRef.current);
        videoBlobUrlRef.current = null;
      }
    };
  }, [code, step]);

  const loadContent = async (c: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await contentAPI.getByCode(c);
      if (res.data.success && res.data.content) {
        setContent(res.data.content);
        setStep('content');
      } else {
        setError('Content not found or link expired.');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load content.');
    } finally {
      setLoading(false);
    }
  };

  const handleEnterCode = (e: React.FormEvent) => {
    e.preventDefault();
    const c = codeInput.trim();
    if (!c) {
      setError('Please enter a content code.');
      return;
    }
    setCode(c);
    loadContent(c);
  };

  const setQuizAnswer = (questionNumber: number, value: string) => {
    setQuizAnswers((prev) => ({ ...prev, [questionNumber]: value }));
  };

  const handleSubmitQuiz = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!studentName.trim()) {
      setError('Please enter your name.');
      return;
    }
    if (!content || !content.quiz || !content.quiz.questions || !code) return;
    setStep('submitting');
    setError(null);
    try {
      const answersList = content.quiz.questions.map((q) => ({
        question_number: q.number,
        value: quizAnswers[q.number] ?? '',
      }));
      const res = await contentAPI.submitQuiz({
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
      setStep('content');
    }
  };

  const questions = content?.quiz?.questions || [];
  const hasQuiz = questions.length > 0;

  if (step === 'result' && result) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full bg-white rounded-xl shadow-lg p-6">
          <div className="flex items-center gap-3 text-green-600 mb-4">
            <Award className="w-8 h-8" />
            <h1 className="text-2xl font-bold text-gray-900">Quiz marked</h1>
          </div>
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
            <div className="text-3xl font-bold text-green-700">Score: {result.total_score}</div>
          </div>
          {result.feedback && (
            <div className="mb-6 p-4 bg-gray-50 rounded-lg text-gray-700 whitespace-pre-wrap">{result.feedback}</div>
          )}
          {result.scores && result.scores.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-700 mb-2">Breakdown</h2>
              <div className="space-y-2">
                {result.scores.map((s: any, i: number) => (
                  <div key={i} className="flex justify-between py-2 border-b border-gray-100 last:border-0">
                    <span className="text-gray-700">{s.criterion_name ?? s.name ?? `Q${i + 1}`}</span>
                    <span className="font-medium text-gray-900">{s.points_awarded ?? s.points ?? 0} / {s.max_points ?? '-'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (step === 'code' || (step === 'content' && !content)) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-6">
          <div className="flex items-center gap-3 mb-6">
            <BookOpen className="w-8 h-8 text-teal-600" />
            <h1 className="text-xl font-bold text-gray-900">View course content</h1>
          </div>
          <p className="text-gray-600 text-sm mb-4">Enter the code your teacher gave you to open the content and any quiz.</p>
          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
            </div>
          )}
          {!loading && (
            <form onSubmit={handleEnterCode} className="space-y-4">
              <input
                type="text"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="Content code"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
              />
              <button type="submit" className="w-full py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700">
                Open content
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h1 className="text-2xl font-bold text-gray-900">{content?.title}</h1>
            {content?.instructions && (
              <p className="mt-2 text-gray-600 text-sm">{content.instructions}</p>
            )}
          </div>

          {videoStatus && (
            <div className="p-6 border-b border-gray-200 bg-gray-50">
              <h2 className="flex items-center gap-2 font-semibold text-gray-800 mb-2">
                <Video className="w-5 h-5" /> Video
              </h2>
              {videoUrl ? (
                <video controls className="w-full rounded-lg" src={videoUrl}>
                  Your browser does not support the video tag.
                </video>
              ) : (
                <p className="text-sm text-gray-600">
                  {videoStatus === 'queued' || videoStatus === 'in_progress'
                    ? 'Video is being generated…'
                    : videoStatus === 'failed'
                    ? 'Video could not be generated.'
                    : 'Loading…'}
                </p>
              )}
            </div>
          )}

          <div className="p-6 space-y-10">
            {(content?.sections || []).map((sec, i) => {
              const assertion = (sec as any).heading || sec.title || 'Section';
              const support = (sec as any).support ? String((sec as any).support).trim() : '';
              const body = sec.body || '';
              return (
                <section key={i} className="max-w-[65ch]">
                  <h2 className="text-xl font-semibold text-gray-900 leading-snug mb-2">{assertion}</h2>
                  {support && <p className="text-gray-600 text-base mb-3">{support}</p>}
                  <div className="text-gray-700 whitespace-pre-wrap leading-relaxed">{body}</div>
                </section>
              );
            })}
          </div>

          {hasQuiz && (
            <div className="p-6 border-t border-gray-200 bg-gray-50">
              <h2 className="text-lg font-semibold text-gray-800 mb-4">Knowledge check</h2>
              <p className="text-sm text-gray-600 mb-4">Marking happens when you submit. Enter your name and answers below.</p>
              {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
              {step === 'submitting' && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
                </div>
              )}
              {step !== 'submitting' && (
                <form onSubmit={handleSubmitQuiz} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Your name</label>
                    <input
                      type="text"
                      value={studentName}
                      onChange={(e) => setStudentName(e.target.value)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                      placeholder="Full name"
                    />
                  </div>
                  {questions.map((q, idx) => (
                    <div key={idx} className="p-4 bg-white rounded-lg border border-gray-200">
                      <p className="font-medium text-gray-800 mb-2">
                        {q.number}. {q.question}
                        {q.points != null && <span className="text-gray-500 text-sm ml-1">({q.points} pts)</span>}
                      </p>
                      {q.options && q.options.length > 0 ? (
                        <div className="space-y-2">
                          {q.options.map((opt, i) => {
                            const letter = String.fromCharCode(65 + i);
                            return (
                              <label key={i} className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`q-${q.number}`}
                                  value={letter}
                                  checked={(quizAnswers[q.number] ?? '') === letter}
                                  onChange={() => setQuizAnswer(q.number, letter)}
                                  className="text-teal-600 border-gray-300 focus:ring-teal-500"
                                />
                                <span className="text-gray-700">{opt}</span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <textarea
                          value={quizAnswers[q.number] ?? ''}
                          onChange={(e) => setQuizAnswer(q.number, e.target.value)}
                          rows={3}
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                          placeholder="Your answer"
                        />
                      )}
                    </div>
                  ))}
                  <button type="submit" className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700">
                    <Send className="w-4 h-4" />
                    Submit quiz
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TakeContent;
