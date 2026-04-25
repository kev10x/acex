import React, { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  AlertCircle,
  BookOpen,
  CheckCircle,
  ChevronDown,
  ClipboardList,
  Download,
  FileQuestion,
  FileText,
  HelpCircle,
  Loader,
  Presentation,
  RefreshCw,
  Trophy,
  Upload,
  Zap,
} from 'lucide-react';
import { slideGenAPI, SlideAnalysis, SlideType } from '../services/api';

// ─── Constants ────────────────────────────────────────────────────────────────

const SLIDE_TYPE_META: Record<SlideType, { label: string; colour: string; icon: React.ReactNode }> = {
  title:               { label: 'Title',               colour: 'bg-indigo-100 text-indigo-700 border-indigo-200',  icon: <Presentation className="h-3.5 w-3.5" /> },
  learning_objectives: { label: 'Objectives',          colour: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: <BookOpen className="h-3.5 w-3.5" /> },
  content:             { label: 'Content',             colour: 'bg-blue-100 text-blue-700 border-blue-200',        icon: <FileText className="h-3.5 w-3.5" /> },
  question:            { label: 'Question',            colour: 'bg-amber-100 text-amber-700 border-amber-200',     icon: <HelpCircle className="h-3.5 w-3.5" /> },
  activity:            { label: 'Activity',            colour: 'bg-orange-100 text-orange-700 border-orange-200',  icon: <Zap className="h-3.5 w-3.5" /> },
  summary:             { label: 'Summary',             colour: 'bg-teal-100 text-teal-700 border-teal-200',        icon: <ClipboardList className="h-3.5 w-3.5" /> },
  quiz:                { label: 'Quiz',                colour: 'bg-rose-100 text-rose-700 border-rose-200',        icon: <Trophy className="h-3.5 w-3.5" /> },
  transition:          { label: 'Transition',          colour: 'bg-slate-100 text-slate-600 border-slate-200',     icon: <ChevronDown className="h-3.5 w-3.5" /> },
  unknown:             { label: 'Unknown',             colour: 'bg-gray-100 text-gray-600 border-gray-200',        icon: <FileQuestion className="h-3.5 w-3.5" /> },
};

const ALL_SLIDE_TYPES: SlideType[] = [
  'title', 'learning_objectives', 'content', 'question', 'activity', 'summary', 'quiz', 'transition', 'unknown'
];

const LEVELS = ['primary school', 'high school', 'undergraduate', 'postgraduate', 'professional'];

// ─── Component ────────────────────────────────────────────────────────────────

type Step = 'upload' | 'review' | 'done';

const SlideGenerator: React.FC = () => {
  const [step, setStep] = useState<Step>('upload');
  const [analysing, setAnalysing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sessionId, setSessionId] = useState<string>('');
  const [slides, setSlides] = useState<SlideAnalysis[]>([]);

  const [topic, setTopic] = useState('');
  const [subject, setSubject] = useState('');
  const [level, setLevel] = useState('undergraduate');

  const [downloadFilename, setDownloadFilename] = useState('');

  // ── Upload ────────────────────────────────────────────────────────────────

  const onDrop = useCallback(async (accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    setError(null);
    setAnalysing(true);
    try {
      const result = await slideGenAPI.analyse(file);
      setSessionId(result.sessionId);
      setSlides(result.slides);
      setStep('review');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to analyse template');
    } finally {
      setAnalysing(false);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'] },
    maxFiles: 1,
    disabled: analysing,
  });

  // ── Slide type correction ─────────────────────────────────────────────────

  const updateSlideType = (slideIndex: number, newType: SlideType) => {
    setSlides((prev) =>
      prev.map((s) => (s.slideIndex === slideIndex ? { ...s, slideType: newType } : s))
    );
  };

  // ── Generate ──────────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!topic.trim()) { setError('Please enter a topic'); return; }
    setError(null);
    setGenerating(true);
    try {
      const blob = await slideGenAPI.populate({ sessionId, topic, subject, level, slides });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeTopic = topic.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'presentation';
      const filename = `${safeTopic}_populated.pptx`;
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setDownloadFilename(filename);
      setStep('done');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to generate presentation');
    } finally {
      setGenerating(false);
    }
  };

  // ── Reset ─────────────────────────────────────────────────────────────────

  const reset = () => {
    setStep('upload');
    setSessionId('');
    setSlides([]);
    setTopic('');
    setSubject('');
    setLevel('undergraduate');
    setError(null);
    setDownloadFilename('');
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Slide Template Populator</h2>
          <p className="mt-1 text-sm text-gray-600">
            Upload a PowerPoint template, let AI detect the purpose of each slide, then auto-fill it with content for your topic.
          </p>
        </div>
        {step !== 'upload' && (
          <button
            onClick={reset}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            Start over
          </button>
        )}
      </div>

      {/* Progress steps */}
      <div className="flex items-center gap-2 text-sm">
        {(['upload', 'review', 'done'] as Step[]).map((s, i) => {
          const labels: Record<Step, string> = { upload: '1. Upload template', review: '2. Review & generate', done: '3. Download' };
          const isDone = (step === 'review' && s === 'upload') || (step === 'done');
          const isActive = step === s;
          return (
            <React.Fragment key={s}>
              {i > 0 && <span className="text-gray-300">›</span>}
              <span className={`font-medium ${isActive ? 'text-amber-700' : isDone ? 'text-emerald-600' : 'text-gray-400'}`}>
                {labels[s]}
              </span>
            </React.Fragment>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Step 1: Upload ── */}
      {step === 'upload' && (
        <div
          {...getRootProps()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-12 text-center transition-colors ${
            isDragActive ? 'border-amber-400 bg-amber-50' : 'border-gray-300 bg-gray-50 hover:border-amber-300 hover:bg-amber-50/40'
          } ${analysing ? 'pointer-events-none opacity-60' : ''}`}
        >
          <input {...getInputProps()} />
          {analysing ? (
            <div className="flex flex-col items-center gap-3">
              <Loader className="h-8 w-8 animate-spin text-amber-500" />
              <p className="text-sm font-medium text-gray-700">Analysing your template…</p>
              <p className="text-xs text-gray-500">AI is reading each slide to identify its purpose</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-full bg-amber-100 p-4">
                <Upload className="h-7 w-7 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">
                  {isDragActive ? 'Drop your PPTX template here' : 'Drag & drop your PPTX template'}
                </p>
                <p className="mt-1 text-xs text-gray-500">or click to browse — .pptx files only, up to 20 MB</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: Review ── */}
      {step === 'review' && (
        <div className="space-y-6">
          {/* Slide analysis grid */}
          <div>
            <h3 className="mb-3 text-sm font-semibold text-gray-800">
              Detected slides — {slides.length} slide{slides.length !== 1 ? 's' : ''}
            </h3>
            <p className="mb-4 text-xs text-gray-500">
              AI has classified each slide below. Correct any misclassifications using the dropdowns before generating.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {slides.map((slide) => {
                const meta = SLIDE_TYPE_META[slide.slideType] || SLIDE_TYPE_META.unknown;
                return (
                  <div key={slide.slideIndex} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-400">Slide {slide.slideIndex + 1}</span>
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.colour}`}>
                        {meta.icon}
                        {meta.label}
                      </span>
                    </div>
                    {slide.detectedText && (
                      <p className="mb-3 line-clamp-2 text-xs text-gray-500 italic">
                        "{slide.detectedText.slice(0, 120)}{slide.detectedText.length > 120 ? '…' : ''}"
                      </p>
                    )}
                    {slide.description && (
                      <p className="mb-3 text-xs text-gray-600">{slide.description}</p>
                    )}
                    {/* Type override */}
                    <select
                      value={slide.slideType}
                      onChange={(e) => updateSlideType(slide.slideIndex, e.target.value as SlideType)}
                      className="w-full rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-700 focus:border-amber-400 focus:outline-none"
                    >
                      {ALL_SLIDE_TYPES.map((t) => (
                        <option key={t} value={t}>{SLIDE_TYPE_META[t].label}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Topic / subject / level inputs */}
          <div className="rounded-xl border border-amber-100 bg-amber-50 p-6">
            <h3 className="mb-4 text-sm font-semibold text-gray-900">Lesson details</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  Topic <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. Photosynthesis, World War II, Algebraic Expressions"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Subject (optional)</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="e.g. Biology, History"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Education level</label>
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <button
                  onClick={handleGenerate}
                  disabled={generating || !topic.trim()}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {generating ? (
                    <>
                      <Loader className="h-4 w-4 animate-spin" />
                      Generating…
                    </>
                  ) : (
                    <>
                      <Zap className="h-4 w-4" />
                      Generate content
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Step 3: Done ── */}
      {step === 'done' && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center">
          <CheckCircle className="mx-auto mb-4 h-12 w-12 text-emerald-500" />
          <h3 className="text-lg font-semibold text-gray-900">Your presentation is ready</h3>
          <p className="mt-1 text-sm text-gray-600">
            The populated PPTX has been downloaded as <span className="font-medium">{downloadFilename}</span>.
          </p>
          <p className="mt-2 text-xs text-gray-500">
            Open it in PowerPoint or LibreOffice — the original design is preserved and each slide has been filled with content matched to its purpose.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              onClick={reset}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              <RefreshCw className="h-4 w-4" />
              Populate another template
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SlideGenerator;
