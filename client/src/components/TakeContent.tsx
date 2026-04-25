import React, { useState, useEffect, useRef, useMemo } from 'react';
import { BookOpen, Loader2, Send, Award, Video, Lock, CheckCircle2, Volume2 } from 'lucide-react';
import { contentAPI } from '../services/api';
import type { GeneratedContent } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { getSectionBodyHtml } from '../utils/richText';

type Step = 'code' | 'content' | 'submitting' | 'result';

const buildSectionBackgroundStyle = (backgroundUrl?: string) => {
  const trimmed = String(backgroundUrl || '').trim();
  if (!trimmed) return {};
  return {
    backgroundImage: `linear-gradient(rgba(255,255,255,0.92), rgba(255,255,255,0.94)), url("${trimmed}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  } as React.CSSProperties;
};
const toSecureSrc = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw || typeof window === 'undefined') return raw;
  const basePath = window.location.pathname.startsWith('/tools') ? '/tools' : '';
  const normalizePath = (pathname: string) => {
    if (!basePath) return pathname;
    if (pathname.startsWith('/uploads/')) return `${basePath}${pathname}`;
    return pathname;
  };
  if (raw.startsWith('/')) {
    return normalizePath(raw);
  }
  if (window.location.protocol !== 'https:' && !raw.startsWith('http://') && !raw.startsWith('https://')) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.origin === window.location.origin) {
      parsed.pathname = normalizePath(parsed.pathname);
    }
    if (parsed.hostname === window.location.hostname) {
      parsed.protocol = 'https:';
      return parsed.toString();
    }
    return parsed.toString();
  } catch (_) {}
  return raw;
};
const getAlternateUploadPath = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('/tools/uploads/')) return raw.replace('/tools/uploads/', '/uploads/');
  if (raw.includes('/uploads/')) return raw.replace('/uploads/', '/tools/uploads/');
  return '';
};
const handleImageFallback = (e: React.SyntheticEvent<HTMLImageElement>) => {
  const img = e.currentTarget;
  if (img.dataset.fallbackTried === 'true') return;
  const alt = getAlternateUploadPath(img.currentSrc || img.src);
  if (!alt) return;
  img.dataset.fallbackTried = 'true';
  img.src = alt;
};
const pickPlayfulCompanion = (sectionIndex: number, pool: string[]) => {
  const uniquePool = pool
    .map((url) => String(url || '').trim())
    .filter(Boolean)
    .filter((url, i, arr) => arr.indexOf(url) === i);
  if (!uniquePool.length) return '';
  return uniquePool[(sectionIndex * 7) % uniquePool.length];
};

const TakeContent: React.FC = () => {
  const { user } = useAuth();
  const isEmbedded = useMemo(() => new URLSearchParams(window.location.search).get('embedded') === 'true', []);
  const [code, setCode] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [requestedSection, setRequestedSection] = useState<number | null>(null);
  const [content, setContent] = useState<GeneratedContent | null>(null);
  const [videoStatus, setVideoStatus] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [studentName, setStudentName] = useState('');
  const [quizAnswers, setQuizAnswers] = useState<Record<number, string>>({});
  const [currentSection, setCurrentSection] = useState(0);
  const [visitedSections, setVisitedSections] = useState<number[]>([]);
  const [step, setStep] = useState<Step>('code');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ total_score: number; feedback?: string; scores?: any[] } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoBlobUrlRef = useRef<string | null>(null);
  const audioBlobUrlRef = useRef<string | null>(null);
  const progressSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedProgressKeyRef = useRef<string>('');
  const defaultStudentName = user?.name?.trim() || user?.email?.trim() || '';
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioVoice, setAudioVoice] = useState('eve');
  const [audioLanguage, setAudioLanguage] = useState('en');
  const [cpAudioLoading, setCpAudioLoading] = useState<number | null>(null);
  const [cpAudioIdx, setCpAudioIdx] = useState<number | null>(null);
  const [cpAudioUrl, setCpAudioUrl] = useState<string | null>(null);
  const [cpAudioError, setCpAudioError] = useState<string | null>(null);

  const sections = content?.sections || [];
  const sectionCount = sections.length;
  const figOffset = useMemo(
    () => sections.slice(0, currentSection).reduce((acc: number, s: any) => acc + (Array.isArray(s.visuals) ? s.visuals.length : 0), 0),
    [currentSection, sections]
  );
  const questions = content?.quiz?.questions || [];
  const hasQuiz = questions.length > 0;
  const checkpointIndex = sectionCount;
  const maxContentIndex = Math.max(0, sectionCount - 1);
  const isCheckpointView = hasQuiz && currentSection >= checkpointIndex;
  const currentSectionViewed = currentSection < sectionCount ? visitedSections.includes(currentSection) : true;
  const ttsEnabled = content?.tts_enabled !== false;
  const activeSection = !isCheckpointView && sectionCount > 0 ? sections[Math.min(Math.max(currentSection, 0), maxContentIndex)] : null;
  const isPlayfulTemplate = String(content?.template_id || '').trim().toLowerCase() === 'playful';
  const playfulAssetPool = useMemo(() => {
    const templatePool = Array.isArray(content?.template_images) ? content.template_images : [];
    const visualPool = (content?.sections || [])
      .flatMap((sec: any) => Array.isArray(sec?.visuals) ? sec.visuals : [])
      .filter((visual: any) => String(visual?.kind || '').toLowerCase() !== 'illustration')
      .map((visual: any) => String(visual?.image_url || '').trim())
      .filter(Boolean);
    return [...templatePool, ...visualPool]
      .filter((url, i, arr) => arr.indexOf(url) === i)
      .slice(0, 12);
  }, [content?.template_images, content?.sections]);

  const getContiguousViewedIndex = () => {
    if (sectionCount === 0) return -1;
    const visited = new Set(visitedSections);
    let idx = -1;
    while (visited.has(idx + 1)) idx += 1;
    return idx;
  };
  const contiguousViewedIndex = getContiguousViewedIndex();
  const maxUnlockedSection = Math.min(sectionCount - 1, Math.max(0, contiguousViewedIndex + 1));
  const checkpointUnlocked = sectionCount === 0 || contiguousViewedIndex >= sectionCount - 1;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('code');
    const sectionParam = params.get('section');
    const parsedSection = sectionParam !== null ? Number(sectionParam) : null;
    const initialSection = Number.isFinite(parsedSection) ? Math.max(0, parsedSection as number) : null;
    setRequestedSection(initialSection);
    if (q && q.trim()) {
      setCode(q.trim());
      setCodeInput(q.trim());
      loadContent(q.trim(), initialSection);
    }
  }, []);

  useEffect(() => {
    if (!defaultStudentName || studentName.trim()) return;
    setStudentName(defaultStudentName);
  }, [defaultStudentName, studentName]);

  useEffect(() => {
    if (!code || step !== 'content') return;
    setVideoUrl(null);
    const loadVideoBlob = async () => {
      const videoRes = await contentAPI.getVideoContent(code);
      const blobUrl = URL.createObjectURL(videoRes.data as Blob);
      if (videoBlobUrlRef.current) URL.revokeObjectURL(videoBlobUrlRef.current);
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
      if (audioBlobUrlRef.current) {
        URL.revokeObjectURL(audioBlobUrlRef.current);
        audioBlobUrlRef.current = null;
      }
    };
  }, [code, step]);

  useEffect(() => {
    if (audioBlobUrlRef.current) {
      URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = null;
    }
    setAudioUrl(null);
    setAudioError(null);
    setAudioLoading(false);
  }, [code, currentSection]);

  const loadContent = async (c: string, initialSection: number | null = requestedSection) => {
    setLoading(true);
    setError(null);
    try {
      const res = await contentAPI.getByCode(c);
      if (res.data.success && res.data.content) {
        const loaded = res.data.content as GeneratedContent;
        const targetSection = initialSection !== null
          ? Math.min(Math.max(initialSection, 0), Math.max(0, (loaded.sections || []).length - 1))
          : 0;
        const initialVisitedSections = (loaded.sections || []).length > 0
          ? Array.from({ length: targetSection + 1 }, (_, index) => index)
          : [];
        setContent(loaded);
        setCurrentSection(targetSection);
        setVisitedSections(initialVisitedSections);
        setStep('content');
        setResult(null);
        loadedProgressKeyRef.current = '';
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

  const markSectionVisited = (index: number) => {
    if (index < 0 || index >= sectionCount) return;
    setVisitedSections((prev) => (prev.includes(index) ? prev : [...prev, index]));
  };

  const canOpenSection = (index: number) => {
    if (index < 0 || index >= sectionCount) return false;
    return index <= maxUnlockedSection;
  };

  const handleOpenSection = (index: number) => {
    if (!canOpenSection(index)) return;
    setCurrentSection(index);
  };

  const goToPrevious = () => {
    setCurrentSection((prev) => Math.max(0, prev - 1));
  };

  const goToNext = () => {
    if (!currentSectionViewed && currentSection < sectionCount) return;
    if (hasQuiz) {
      setCurrentSection((prev) => {
        const next = Math.min(checkpointIndex, prev + 1);
        if (next < sectionCount) markSectionVisited(next);
        return next;
      });
      return;
    }
    setCurrentSection((prev) => {
      const next = Math.min(maxContentIndex, prev + 1);
      markSectionVisited(next);
      return next;
    });
  };

  useEffect(() => {
    if (step !== 'content') return;
    if (currentSection < sectionCount) {
      const timer = setTimeout(() => {
        markSectionVisited(currentSection);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [currentSection, sectionCount, step]);

  useEffect(() => {
    if (!code || !studentName.trim() || step !== 'content') return;
    const key = `${code}::${studentName.trim().toLowerCase()}`;
    if (loadedProgressKeyRef.current === key) return;

    const loadProgress = async () => {
      try {
        const res = await contentAPI.getProgress(code, studentName.trim());
        const saved = res.data?.progress;
        if (!saved) {
          loadedProgressKeyRef.current = key;
          return;
        }
        if (saved.checkpoint_answers && typeof saved.checkpoint_answers === 'object') {
          setQuizAnswers(saved.checkpoint_answers);
        }
        const savedProgress = saved.progress || {};
        const savedVisitedRaw = Array.isArray(savedProgress.visited_sections) ? savedProgress.visited_sections : [];
        const cleanedVisited = savedVisitedRaw
          .map((n: any) => Number(n))
          .filter((n: number) => Number.isFinite(n) && n >= 0 && n < sectionCount);
        if (cleanedVisited.length > 0) setVisitedSections(cleanedVisited);

        const candidateSection = Number(saved.current_section || 0);
        if (Number.isFinite(candidateSection)) {
          const maxIndex = hasQuiz ? checkpointIndex : maxContentIndex;
          setCurrentSection(Math.min(Math.max(candidateSection, 0), Math.max(0, maxIndex)));
        }
      } catch (_) {
        // ignore restore errors
      } finally {
        loadedProgressKeyRef.current = key;
      }
    };

    loadProgress();
  }, [code, studentName, step, sectionCount, hasQuiz, checkpointIndex, maxContentIndex]);

  useEffect(() => {
    if (!code || !studentName.trim() || step !== 'content') return;
    if (progressSaveRef.current) clearTimeout(progressSaveRef.current);
    progressSaveRef.current = setTimeout(async () => {
      try {
        const payload = {
          code,
          student_name: studentName.trim(),
          current_section: currentSection,
          checkpoint_answers: quizAnswers,
          completed: !!result,
          score: result ? Number(result.total_score || 0) : null,
          progress: {
            visited_sections: visitedSections,
            answered_count: Object.keys(quizAnswers).length,
            section_count: sectionCount,
            at_checkpoint: isCheckpointView,
          },
        };
        await contentAPI.saveProgress(payload);
      } catch (_) {
        // ignore save errors
      }
    }, 700);

    return () => {
      if (progressSaveRef.current) clearTimeout(progressSaveRef.current);
    };
  }, [code, studentName, step, currentSection, quizAnswers, visitedSections, sectionCount, isCheckpointView, result]);

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
        try {
          await contentAPI.saveProgress({
            code,
            student_name: studentName.trim(),
            current_section: checkpointIndex,
            checkpoint_answers: quizAnswers,
            completed: true,
            score: Number(res.data.result.total_score ?? 0),
            progress: { submitted: true, visited_sections: visitedSections },
          });
        } catch (_) {}
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

  const handlePlaySectionAudio = async () => {
    if (!code || currentSection >= sectionCount) return;
    setAudioLoading(true);
    setAudioError(null);
    try {
      const res = await contentAPI.getSectionAudio(code, currentSection, audioVoice, audioLanguage);
      const blobUrl = URL.createObjectURL(res.data as Blob);
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = blobUrl;
      setAudioUrl(blobUrl);
    } catch (e: any) {
      setAudioError(e.response?.data?.error || e.message || 'Failed to load audio for this section.');
      setAudioUrl(null);
    } finally {
      setAudioLoading(false);
    }
  };

  const handlePlayCheckpointAudio = async (questionIdx: number) => {
    if (!code) return;
    setCpAudioLoading(questionIdx);
    setCpAudioIdx(questionIdx);
    setCpAudioError(null);
    setCpAudioUrl(null);
    try {
      const res = await contentAPI.getCheckpointQuestionAudio(code, questionIdx, audioVoice, audioLanguage);
      const blobUrl = URL.createObjectURL(res.data as Blob);
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = blobUrl;
      setCpAudioUrl(blobUrl);
    } catch (e: any) {
      setCpAudioError(e.response?.data?.error || e.message || 'Failed to load audio.');
    } finally {
      setCpAudioLoading(null);
    }
  };

  useEffect(() => {
    if (!isEmbedded || step !== 'content' || !content) return;
    window.parent.postMessage({
      type: 'mm:sections',
      sections: (content.sections || []).map((s: any, i: number) => ({
        idx: i,
        title: s.heading || s.title || `Section ${i + 1}`,
      })),
      hasCheckpoint: hasQuiz,
    }, '*');
  }, [isEmbedded, content, step, hasQuiz]);

  useEffect(() => {
    if (!isEmbedded || step !== 'content') return;
    window.parent.postMessage({
      type: 'mm:sectionChange',
      currentSection: isCheckpointView ? -1 : currentSection,
    }, '*');
  }, [isEmbedded, currentSection, isCheckpointView, step]);

  useEffect(() => {
    if (!isEmbedded) return;
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== 'mm:goToSection') return;
      const idx = e.data.section;
      if (idx === -1) {
        setCurrentSection(checkpointIndex);
      } else {
        handleOpenSection(idx);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [isEmbedded, checkpointIndex]);

  const visitedCount = visitedSections.length + (isCheckpointView ? 1 : 0);
  const totalTrackable = Math.max(1, sectionCount + (hasQuiz ? 1 : 0));
  const progressPercent = Math.round((Math.min(visitedCount, totalTrackable) / totalTrackable) * 100);

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
          {result.feedback && <div className="mb-6 p-4 bg-gray-50 rounded-lg text-gray-700 whitespace-pre-wrap">{result.feedback}</div>}
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
          <p className="text-gray-600 text-sm mb-4">Enter the code your teacher gave you to open the content and checkpoint.</p>
          {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
            </div>
          ) : (
            <form onSubmit={handleEnterCode} className="space-y-4">
              <input
                type="text"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="Content code"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
              />
              <button type="submit" className="w-full py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700">Open content</button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen py-8 px-4"
      style={{
        background: content?.theme?.bg_color || '#F9FAFB',
        color: content?.theme?.text_color || '#111827',
        fontFamily: content?.theme?.font_family || undefined,
      }}
    >
      <div className="max-w-6xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h1 className="text-2xl font-bold" style={{ color: content?.theme?.heading_color || '#111827' }}>{content?.title}</h1>
            {content?.instructions && <p className="mt-2 text-sm" style={{ color: content?.theme?.text_color || '#4B5563' }}>{content.instructions}</p>}
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Your name (for save/resume)</label>
                <input
                  type="text"
                  value={studentName}
                  onChange={(e) => setStudentName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                  placeholder="Full name"
                />
              </div>
              <div className="flex flex-col justify-end">
                <div className="text-xs text-gray-600 mb-1">Progress: {progressPercent}%</div>
                <div className="w-full h-2 rounded-full bg-gray-200 overflow-hidden">
                  <div className="h-full bg-teal-500" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            </div>
          </div>

          {videoStatus && (
            <div className="p-6 border-b border-gray-200 bg-gray-50">
              <h2 className="flex items-center gap-2 font-semibold text-gray-800 mb-2"><Video className="w-5 h-5" /> Video</h2>
              {videoUrl ? (
                <video controls className="w-full rounded-lg" src={videoUrl}>Your browser does not support the video tag.</video>
              ) : (
                <p className="text-sm text-gray-600">
                  {videoStatus === 'queued' || videoStatus === 'in_progress' ? 'Video is being generated...' : videoStatus === 'failed' ? 'Video could not be generated.' : 'Loading...'}
                </p>
              )}
            </div>
          )}

          <div className="p-6">
            <div className={isEmbedded ? '' : 'grid grid-cols-1 lg:grid-cols-[280px,1fr] gap-6'}>
              {!isEmbedded && <aside className="bg-gray-50 border border-gray-200 rounded-lg p-3 h-fit">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Lesson Navigation</h3>
                <ul className="space-y-1">
                  {sections.map((sec, idx) => {
                    const viewed = visitedSections.includes(idx);
                    const locked = !canOpenSection(idx);
                    const active = !isCheckpointView && currentSection === idx;
                    return (
                      <li key={idx}>
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => handleOpenSection(idx)}
                          className={`w-full text-left px-2 py-2 rounded-md text-sm flex items-center justify-between gap-2 ${
                            active ? 'bg-teal-100 text-teal-900' : locked ? 'bg-gray-100 text-gray-400' : 'hover:bg-gray-100 text-gray-700'
                          }`}
                        >
                          <span className="truncate">{idx + 1}. {(sec as any).heading || sec.title || `Section ${idx + 1}`}</span>
                          {viewed ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" /> : locked ? <Lock className="w-4 h-4 shrink-0" /> : null}
                        </button>
                      </li>
                    );
                  })}
                  {hasQuiz && (
                    <li>
                      <button
                        type="button"
                        disabled={!checkpointUnlocked}
                        onClick={() => checkpointUnlocked && setCurrentSection(checkpointIndex)}
                        className={`w-full text-left px-2 py-2 rounded-md text-sm flex items-center justify-between gap-2 ${
                          isCheckpointView ? 'bg-amber-100 text-amber-900' : checkpointUnlocked ? 'hover:bg-gray-100 text-gray-700' : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        <span>Knowledge checkpoint</span>
                        {!checkpointUnlocked ? <Lock className="w-4 h-4 shrink-0" /> : null}
                      </button>
                    </li>
                  )}
                </ul>
              </aside>}

              <div>
            {!isCheckpointView && activeSection && (
              <section
                className="w-full min-w-0 rounded-xl border border-gray-200 p-4"
                style={buildSectionBackgroundStyle((activeSection as any).background_image_url)}
              >
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Section {Math.min(currentSection + 1, sectionCount)} of {sectionCount}</div>
                <h2 className="text-xl font-semibold leading-snug mb-2" style={{ color: content?.theme?.heading_color || '#111827' }}>
                  {(activeSection as any).heading || activeSection.title || 'Section'}
                </h2>
                {(activeSection as any).support && (
                  <p className="text-base mb-3" style={{ color: content?.theme?.text_color || '#4B5563' }}>{String((activeSection as any).support).trim()}</p>
                )}
                {ttsEnabled && (
                  <>
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handlePlaySectionAudio}
                        disabled={audioLoading}
                        className="inline-flex items-center gap-2 px-3 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
                      >
                        {audioLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                        {audioLoading ? 'Generating audio...' : 'Listen to this section'}
                      </button>
                      <select
                        value={audioVoice}
                        onChange={(e) => setAudioVoice(e.target.value)}
                        className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      >
                        <option value="eve">Eve</option>
                        <option value="ara">Ara</option>
                        <option value="leo">Leo</option>
                        <option value="rex">Rex</option>
                        <option value="sal">Sal</option>
                      </select>
                      <select
                        value={audioLanguage}
                        onChange={(e) => setAudioLanguage(e.target.value)}
                        className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      >
                        <option value="en">English</option>
                        <option value="af">Afrikaans</option>
                        <option value="zu">isiZulu</option>
                        <option value="xh">Xhosa</option>
                      </select>
                    </div>
                    {audioError && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{audioError}</div>}
                    {audioUrl && (
                      <div className="mb-4">
                        <audio controls autoPlay className="w-full" src={audioUrl}>
                          Your browser does not support audio playback.
                        </audio>
                      </div>
                    )}
                  </>
                )}
                {(() => {
                  const visuals: any[] = Array.isArray((activeSection as any).visuals) ? (activeSection as any).visuals : [];
                  const illustrations = visuals.map((v, i) => ({ visual: v, figNum: figOffset + i + 1 })).filter(({ visual }) => visual.kind === 'illustration');
                  const images = visuals
                    .map((v, i) => ({ visual: v, figNum: figOffset + i + 1 }))
                    .filter(({ visual }) => visual.kind !== 'illustration' && visual?.image_url);
                  const keyPoint = String((activeSection as any).support || (activeSection as any).heading || activeSection.title || 'Remember this point').trim();
                  const companionSrc = pickPlayfulCompanion(currentSection, playfulAssetPool) || images[0]?.visual?.image_url || '';

                  if (isPlayfulTemplate) {
                    const mainFigure = illustrations[0] || images[0] || null;
                    const sideFigure = images.find((img) => img.figNum !== mainFigure?.figNum) || null;
                    const extraFigures = [...illustrations, ...images].filter((fig) => fig.figNum !== mainFigure?.figNum && fig.figNum !== sideFigure?.figNum);
                    return (
                      <>
                        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_250px]">
                          <div>
                            {mainFigure?.visual?.image_url ? (
                              <figure className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
                                <img src={toSecureSrc(mainFigure.visual.image_url)} onError={handleImageFallback} alt={mainFigure.visual.alt_text || mainFigure.visual.title || `Figure ${mainFigure.figNum}`} className="w-full object-contain max-h-[360px]" />
                                <figcaption className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs" style={{ color: content?.theme?.text_color || '#6B7280' }}>
                                  <span className="font-semibold">Figure {mainFigure.figNum}:</span> {mainFigure.visual.title}
                                </figcaption>
                              </figure>
                            ) : (
                              <div className="h-40 rounded-lg border border-dashed border-orange-300 text-xs text-orange-700 flex items-center justify-center">
                                Image placeholder
                              </div>
                            )}
                          </div>
                          <aside className="space-y-3">
                            <div className="border border-orange-200 rounded-lg bg-orange-50 p-2">
                              {sideFigure?.visual?.image_url ? (
                                <figure className="rounded-lg overflow-hidden">
                                  <img src={toSecureSrc(sideFigure.visual.image_url)} onError={handleImageFallback} alt={sideFigure.visual.alt_text || sideFigure.visual.title || `Figure ${sideFigure.figNum}`} className="w-full object-cover max-h-44" />
                                  <figcaption className="px-3 py-2 text-xs text-slate-700 bg-white">
                                    <span className="font-semibold">Figure {sideFigure.figNum}:</span> {sideFigure.visual.title}
                                  </figcaption>
                                </figure>
                              ) : (
                                <div className="h-24 rounded-lg border border-dashed border-orange-300 text-xs text-orange-700 flex items-center justify-center">
                                  Image placeholder
                                </div>
                              )}
                            </div>
                            <div className="relative border border-amber-200 rounded-lg bg-amber-50 p-3 min-h-[130px]">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1">Key point</div>
                              <p className="text-sm font-medium text-amber-900 pr-16">{keyPoint}</p>
                              {companionSrc ? (
                                <img
                                  src={toSecureSrc(companionSrc)}
                                  onError={handleImageFallback}
                                  alt=""
                                  aria-hidden="true"
                                  className="pointer-events-none select-none absolute bottom-1 right-1 w-14 md:w-16 drop-shadow"
                                  draggable={false}
                                />
                              ) : null}
                            </div>
                          </aside>
                        </div>
                        <div
                          className="mt-4 leading-relaxed [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:mb-3"
                          style={{ color: content?.theme?.text_color || '#374151' }}
                          dangerouslySetInnerHTML={{ __html: getSectionBodyHtml(activeSection as any) }}
                        />
                        {extraFigures.map(({ visual, figNum }) => (
                          <figure key={figNum} className="mt-4 border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
                            <img src={toSecureSrc(visual.image_url)} onError={handleImageFallback} alt={visual.alt_text || visual.title || `Figure ${figNum}`} className="w-full object-contain" />
                            <figcaption className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs" style={{ color: content?.theme?.text_color || '#6B7280' }}>
                              <span className="font-semibold">Figure {figNum}:</span> {visual.title}
                            </figcaption>
                          </figure>
                        ))}
                      </>
                    );
                  }

                  return (
                    <>
                      {illustrations.map(({ visual, figNum }) => (
                        <figure key={figNum} className={`my-4 border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm ${figNum % 2 === 0 ? 'md:-rotate-[0.35deg]' : 'md:rotate-[0.35deg]'}`}>
                          {visual.image_url ? (
                            <img src={toSecureSrc(visual.image_url)} onError={handleImageFallback} alt={visual.alt_text || visual.title || `Figure ${figNum}`} className="w-full object-contain" />
                          ) : null}
                          <figcaption className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs" style={{ color: content?.theme?.text_color || '#6B7280' }}>
                            <span className="font-semibold">Figure {figNum}:</span> {visual.title}
                          </figcaption>
                        </figure>
                      ))}
                      <div
                        className="leading-relaxed [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_h3]:text-lg [&_h3]:font-semibold [&_p]:mb-3"
                        style={{ color: content?.theme?.text_color || '#374151' }}
                        dangerouslySetInnerHTML={{ __html: getSectionBodyHtml(activeSection as any) }}
                      />
                      {images.map(({ visual, figNum }) => (
                        <figure key={figNum} className={`mt-4 border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm ${figNum % 2 === 0 ? 'md:-rotate-[0.25deg]' : 'md:rotate-[0.25deg]'}`}>
                          <img src={toSecureSrc(visual.image_url)} onError={handleImageFallback} alt={visual.alt_text || visual.title || `Figure ${figNum}`} className="w-full object-contain" />
                          <figcaption className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs" style={{ color: content?.theme?.text_color || '#6B7280' }}>
                            <span className="font-semibold">Figure {figNum}:</span> {visual.title}
                          </figcaption>
                        </figure>
                      ))}
                    </>
                  );
                })()}

                <div className="mt-6 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={goToPrevious}
                    disabled={currentSection <= 0}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={goToNext}
                    disabled={(!hasQuiz && currentSection >= maxContentIndex) || (!currentSectionViewed && currentSection < sectionCount)}
                    className="px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-40"
                  >
                    {!currentSectionViewed && currentSection < sectionCount
                      ? 'View this section to continue'
                      : hasQuiz && currentSection >= maxContentIndex
                      ? 'Go to checkpoint'
                      : 'Next section'}
                  </button>
                </div>
              </section>
            )}

            {isCheckpointView && hasQuiz && (
              <div className="max-w-[65ch]">
                <h2 className="text-lg font-semibold text-gray-800 mb-4">Knowledge checkpoint</h2>
                <p className="text-sm text-gray-600 mb-4">Complete this checkpoint to finish the lesson.</p>
                {ttsEnabled && (
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <select
                      value={audioVoice}
                      onChange={(e) => setAudioVoice(e.target.value)}
                      className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                    >
                      <option value="eve">Eve</option>
                      <option value="ara">Ara</option>
                      <option value="leo">Leo</option>
                      <option value="rex">Rex</option>
                      <option value="sal">Sal</option>
                    </select>
                    <select
                      value={audioLanguage}
                      onChange={(e) => setAudioLanguage(e.target.value)}
                      className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm"
                    >
                      <option value="en">English</option>
                      <option value="af">Afrikaans</option>
                      <option value="zu">isiZulu</option>
                      <option value="xh">Xhosa</option>
                    </select>
                  </div>
                )}
                {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

                {step === 'submitting' ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
                  </div>
                ) : (
                  <form onSubmit={handleSubmitQuiz} className="space-y-4">
                    {questions.map((q, idx) => (
                      <div key={idx} className="p-4 bg-white rounded-lg border border-gray-200">
                        <p className="font-medium text-gray-800 mb-2">
                          {q.number}. {q.question}
                          {q.points != null && <span className="text-gray-500 text-sm ml-1">({q.points} pts)</span>}
                        </p>
                        {ttsEnabled && (
                          <div className="mb-3">
                            <button
                              type="button"
                              onClick={() => handlePlayCheckpointAudio(idx)}
                              disabled={cpAudioLoading === idx}
                              className="inline-flex items-center gap-2 px-3 py-1.5 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 text-sm"
                            >
                              {cpAudioLoading === idx ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
                              {cpAudioLoading === idx ? 'Generating audio...' : 'Listen to question'}
                            </button>
                            {cpAudioIdx === idx && cpAudioError && (
                              <p className="mt-1 text-sm text-red-600">{cpAudioError}</p>
                            )}
                            {cpAudioIdx === idx && cpAudioUrl && (
                              <audio controls autoPlay className="mt-2 w-full" src={cpAudioUrl}>
                                Your browser does not support audio playback.
                              </audio>
                            )}
                          </div>
                        )}
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
                    <div className="flex items-center justify-between">
                      <button type="button" onClick={goToPrevious} className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700">Back to content</button>
                      <button type="submit" className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700">
                        <Send className="w-4 h-4" />
                        Submit checkpoint
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TakeContent;
