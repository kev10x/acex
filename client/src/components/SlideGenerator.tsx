import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  Layers,
  Loader,
  Presentation,
  RefreshCw,
  Sparkles,
  Trophy,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { slideGenAPI, GeneratedSlide, SlideType, TemplateBackground, TemplateImageAsset, GeneratedContent } from '../services/api';
import { richHtmlToPlainText } from '../utils/richText';

function sectionsToSlides(content: GeneratedContent): GeneratedSlide[] {
  const slides: GeneratedSlide[] = [];

  // Title slide
  slides.push({
    slideIndex: 0,
    slideType: 'title',
    title: content.title,
    bullets: content.instructions ? [content.instructions.slice(0, 120)] : [],
  });

  // One slide per section
  for (const sec of content.sections) {
    const heading = String(sec.heading || sec.title || '').trim() || `Section ${slides.length}`;
    const bodyText = (
      richHtmlToPlainText(String(sec.body_html || '')) ||
      String(sec.body || '')
    ).trim();

    const bullets = bodyText
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 8)
      .slice(0, 5);

    slides.push({
      slideIndex: slides.length,
      slideType: 'content',
      title: heading,
      bullets: bullets.length ? bullets : [bodyText.slice(0, 140)].filter(Boolean),
    });
  }

  // Summary slide
  const summaryBullets = content.sections
    .map((s) => String(s.heading || s.title || '').trim())
    .filter(Boolean)
    .slice(0, 6);

  if (summaryBullets.length > 1) {
    slides.push({
      slideIndex: slides.length,
      slideType: 'summary',
      title: 'Key Takeaways',
      bullets: summaryBullets,
    });
  }

  return slides;
}

// ─── Preset background catalogue ─────────────────────────────────────────────

interface PresetBg {
  id: string;
  label: string;
  css: string;
  isDark: boolean;
  category: 'light' | 'dark' | 'gradient';
}

const PRESETS: PresetBg[] = [
  // Light
  { id: 'clean-white', label: 'Clean White',  css: '#FFFFFF',                                          isDark: false, category: 'light' },
  { id: 'warm-sand',   label: 'Warm Sand',    css: '#FEF9C3',                                          isDark: false, category: 'light' },
  { id: 'soft-blue',   label: 'Soft Blue',    css: '#EFF6FF',                                          isDark: false, category: 'light' },
  { id: 'soft-green',  label: 'Soft Green',   css: '#F0FDF4',                                          isDark: false, category: 'light' },
  { id: 'mint',        label: 'Mint',         css: 'linear-gradient(135deg,#F0FDF4,#CCFBF1)',          isDark: false, category: 'light' },
  { id: 'lavender',    label: 'Lavender',     css: 'linear-gradient(135deg,#F5F3FF,#EDE9FE)',          isDark: false, category: 'light' },
  // Dark
  { id: 'dark-navy',   label: 'Dark Navy',    css: '#0F172A',                                          isDark: true,  category: 'dark' },
  { id: 'charcoal',    label: 'Charcoal',     css: '#1F2937',                                          isDark: true,  category: 'dark' },
  { id: 'deep-purple', label: 'Deep Purple',  css: '#1E1B4B',                                          isDark: true,  category: 'dark' },
  { id: 'forest',      label: 'Forest',       css: '#052E16',                                          isDark: true,  category: 'dark' },
  // Gradient
  { id: 'ocean',       label: 'Ocean',        css: 'linear-gradient(135deg,#1E3A8A,#0E7490)',          isDark: true,  category: 'gradient' },
  { id: 'sunset',      label: 'Sunset',       css: 'linear-gradient(135deg,#92400E,#831843)',          isDark: true,  category: 'gradient' },
  { id: 'aurora',      label: 'Aurora',       css: 'linear-gradient(135deg,#312E81,#065F46)',          isDark: true,  category: 'gradient' },
  { id: 'slate-sky',   label: 'Slate Sky',    css: 'linear-gradient(135deg,#1E293B,#0369A1)',          isDark: true,  category: 'gradient' },
  { id: 'rose',        label: 'Rose',         css: 'linear-gradient(135deg,#881337,#9A3412)',          isDark: true,  category: 'gradient' },
];

const PRESET_CATEGORIES: { key: PresetBg['category']; label: string }[] = [
  { key: 'light',    label: 'Light' },
  { key: 'dark',     label: 'Dark' },
  { key: 'gradient', label: 'Gradient' },
];

// ─── Slide type metadata ──────────────────────────────────────────────────────

const SLIDE_TYPE_META: Record<SlideType, { label: string; colour: string; icon: React.ReactNode }> = {
  title:               { label: 'Title',       colour: 'bg-indigo-100 text-indigo-700 border-indigo-200',    icon: <Presentation className="h-3 w-3" /> },
  learning_objectives: { label: 'Objectives',  colour: 'bg-emerald-100 text-emerald-700 border-emerald-200', icon: <BookOpen className="h-3 w-3" /> },
  content:             { label: 'Content',     colour: 'bg-primary-100 text-primary-700 border-primary-200',          icon: <FileText className="h-3 w-3" /> },
  question:            { label: 'Question',    colour: 'bg-amber-100 text-amber-700 border-amber-200',       icon: <HelpCircle className="h-3 w-3" /> },
  activity:            { label: 'Activity',    colour: 'bg-orange-100 text-orange-700 border-orange-200',    icon: <Zap className="h-3 w-3" /> },
  summary:             { label: 'Summary',     colour: 'bg-teal-100 text-teal-700 border-teal-200',          icon: <ClipboardList className="h-3 w-3" /> },
  quiz:                { label: 'Quiz',        colour: 'bg-rose-100 text-rose-700 border-rose-200',          icon: <Trophy className="h-3 w-3" /> },
  transition:          { label: 'Transition',  colour: 'bg-slate-100 text-slate-600 border-slate-200',       icon: <ChevronDown className="h-3 w-3" /> },
  unknown:             { label: 'Unknown',     colour: 'bg-gray-100 text-gray-500 border-gray-200',          icon: <FileQuestion className="h-3 w-3" /> },
};

const LEVELS = ['primary school', 'high school', 'undergraduate', 'postgraduate', 'professional'];

const API_BASE = import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://localhost:3001/api' : '/tools/api');

// ─── Component ────────────────────────────────────────────────────────────────

type Step = 'upload' | 'generate' | 'style' | 'done';

const SlideGenerator: React.FC<{ initialContent?: GeneratedContent | null }> = ({ initialContent }) => {
  const [step, setStep]             = useState<Step>('upload');
  const [analysing, setAnalysing]   = useState(false);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting]   = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const [sessionId, setSessionId]                   = useState('');
  const [templateBackgrounds, setTemplateBgs]       = useState<TemplateBackground[]>([]);
  const [templateImages, setTemplateImages]         = useState<TemplateImageAsset[]>([]);

  const [topic, setTopic]         = useState('');
  const [subject, setSubject]     = useState('');
  const [level, setLevel]         = useState('undergraduate');
  const [slideCount, setSlideCount] = useState(8);

  const [generatedContent, setGeneratedContent] = useState<GeneratedSlide[]>([]);
  const [slideBackgrounds, setSlideBackgrounds] = useState<Record<number, string>>({});
  const [dragOverSlide, setDragOverSlide]       = useState<number | null>(null);
  const [activeBgCategory, setActiveBgCategory] = useState<PresetBg['category']>('dark');

  const [downloadFilename, setDownloadFilename] = useState('');

  // When content arrives from ContentGenerator, pre-fill the topic
  useEffect(() => {
    if (initialContent?.title) {
      setTopic(initialContent.title);
    }
  }, [initialContent]);

  const handleUseExistingContent = () => {
    if (!initialContent) return;
    setGeneratedContent(sectionsToSlides(initialContent));
    setSlideBackgrounds({});
    setStep('style');
  };

  // Unified bg lookup: preset + template backgrounds
  const allBgMap = useMemo(() => {
    const map = new Map<string, { css: string; isDark: boolean; label: string; isImage: boolean }>();
    for (const b of PRESETS) {
      map.set(b.id, { css: b.css, isDark: b.isDark, label: b.label, isImage: false });
    }
    for (const b of templateBackgrounds) {
      const css = b.imageFilename
        ? `url('${API_BASE}/slide-gen/bg-asset/${sessionId}/${b.imageFilename}')`
        : b.previewCss;
      map.set(b.id, { css, isDark: b.isDark, label: b.label, isImage: !!b.imageFilename });
    }
    return map;
  }, [templateBackgrounds, sessionId]);

  // ── Upload ────────────────────────────────────────────────────────────────

  const onDrop = useCallback(async (accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    setError(null);
    setAnalysing(true);
    try {
      const result = await slideGenAPI.analyse(file);
      setSessionId(result.sessionId);
      setTemplateBgs(result.backgrounds);
      setTemplateImages(Array.isArray(result.images) ? result.images : []);
      setStep('generate');
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

  // ── Generate content ──────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!topic.trim()) { setError('Please enter a topic'); return; }
    setError(null);
    setGenerating(true);
    try {
      const { content } = await slideGenAPI.generateContent({ topic, subject, level, slideCount, backgrounds: templateBackgrounds });
      setGeneratedContent(content);
      // Auto-assign backgrounds based on AI recommendations
      const autoBackgrounds: Record<number, string> = {};
      content.forEach(slide => {
        if (slide.backgroundId && templateBackgrounds.find(b => b.id === slide.backgroundId)) {
          autoBackgrounds[slide.slideIndex] = slide.backgroundId;
        }
      });
      setSlideBackgrounds(autoBackgrounds);
      setStep('style');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to generate content');
    } finally {
      setGenerating(false);
    }
  };

  // ── Drag and drop ─────────────────────────────────────────────────────────

  const handleBgDragStart = (e: React.DragEvent, bgId: string) => {
    e.dataTransfer.setData('bg-id', bgId);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleSlideDragOver = (e: React.DragEvent, slideIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOverSlide(slideIndex);
  };

  const handleSlideDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverSlide(null);
  };

  const handleSlideDrop = (e: React.DragEvent, slideIndex: number) => {
    e.preventDefault();
    const bgId = e.dataTransfer.getData('bg-id');
    if (bgId) setSlideBackgrounds((prev) => ({ ...prev, [slideIndex]: bgId }));
    setDragOverSlide(null);
  };

  const clearBackground = (slideIndex: number) => {
    setSlideBackgrounds((prev) => { const n = { ...prev }; delete n[slideIndex]; return n; });
  };

  const applyToAll = (bgId: string) => {
    const all: Record<number, string> = {};
    generatedContent.forEach((s) => { all[s.slideIndex] = bgId; });
    setSlideBackgrounds(all);
  };

  // ── Export ────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    setError(null);
    setExporting(true);
    try {
      const blob = await slideGenAPI.populate({
        sessionId,
        topic,
        content: generatedContent,
        backgrounds: slideBackgrounds,
        templateBgs: templateBackgrounds,
        templateImages,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeTopic = topic.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'presentation';
      const filename = `${safeTopic}_slides.pptx`;
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setDownloadFilename(filename);
      setStep('done');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  // ── Reset ─────────────────────────────────────────────────────────────────

  const reset = () => {
    setStep('upload');
    setSessionId('');
    setTemplateBgs([]);
    setTemplateImages([]);
    setGeneratedContent([]);
    setSlideBackgrounds({});
    setTopic('');
    setSubject('');
    setLevel('undergraduate');
    setSlideCount(8);
    setError(null);
    setDownloadFilename('');
  };

  // ── Step labels ───────────────────────────────────────────────────────────

  const STEP_LABELS: Record<Step, string> = {
    upload:   '1. Upload template',
    generate: '2. Generate slides',
    style:    '3. Apply backgrounds',
    done:     '4. Download',
  };
  const stepOrder: Step[] = ['upload', 'generate', 'style', 'done'];
  const currentIdx = stepOrder.indexOf(step);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Slide Template Populator</h2>
          <p className="mt-1 text-sm text-gray-600">
            Upload a PPTX template to extract its backgrounds, generate fresh AI slides, apply styles, and export.
          </p>
        </div>
        {step !== 'upload' && (
          <button onClick={reset} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            <RefreshCw className="h-4 w-4" /> Start over
          </button>
        )}
      </div>

      {/* Progress breadcrumb */}
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        {stepOrder.map((s, i) => (
          <React.Fragment key={s}>
            {i > 0 && <span className="text-gray-300">›</span>}
            <span className={`font-medium ${step === s ? 'text-amber-700' : i < currentIdx ? 'text-emerald-600' : 'text-gray-400'}`}>
              {STEP_LABELS[s]}
            </span>
          </React.Fragment>
        ))}
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
          className={`cursor-pointer rounded-xl border-2 border-dashed p-14 text-center transition-colors ${
            isDragActive ? 'border-amber-400 bg-amber-50' : 'border-gray-300 bg-gray-50 hover:border-amber-300 hover:bg-amber-50/40'
          } ${analysing ? 'pointer-events-none opacity-60' : ''}`}
        >
          <input {...getInputProps()} />
          {analysing ? (
            <div className="flex flex-col items-center gap-3">
              <Loader className="h-8 w-8 animate-spin text-amber-500" />
              <p className="text-sm font-medium text-gray-700">Extracting backgrounds from template…</p>
              <p className="text-xs text-gray-500">Reading each slide to pull out unique background styles</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-full bg-amber-100 p-4"><Upload className="h-7 w-7 text-amber-600" /></div>
              <div>
                <p className="text-sm font-semibold text-gray-900">{isDragActive ? 'Drop your PPTX here' : 'Drag & drop a PowerPoint template'}</p>
                <p className="mt-1 text-xs text-gray-500">.pptx only · up to 20 MB · backgrounds will be extracted into your gallery</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Step 2: Generate ── */}
      {step === 'generate' && (
        <div className="space-y-4">

        {/* Use existing content shortcut */}
        {initialContent && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-900">Use content from Content Generator</p>
              <p className="mt-0.5 truncate text-xs text-emerald-700">
                "{initialContent.title}" · {initialContent.sections.length} section{initialContent.sections.length !== 1 ? 's' : ''} → {initialContent.sections.length + 2} slides
              </p>
            </div>
            <button
              onClick={handleUseExistingContent}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
            >
              <Sparkles className="h-4 w-4" />
              Use this content
            </button>
          </div>
        )}

        <div className="rounded-xl border border-amber-100 bg-amber-50 p-6">
          <div className="mb-4 flex items-center gap-2">
            <Layers className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold text-gray-900">{initialContent ? 'Or generate new AI content' : 'Lesson details'}</h3>
            {templateBackgrounds.length > 0 && (
              <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                {templateBackgrounds.length} background{templateBackgrounds.length > 1 ? 's' : ''} extracted from template
              </span>
            )}
            {templateImages.length > 0 && (
              <span className="rounded-full bg-primary-100 px-2 py-0.5 text-xs font-medium text-primary-700">
                {templateImages.length} image asset{templateImages.length > 1 ? 's' : ''} auto-reused on export
              </span>
            )}
            {templateBackgrounds.length === 0 && (
              <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                No custom backgrounds found — preset styles available
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-700">Topic <span className="text-red-500">*</span></label>
              <input
                type="text" value={topic} onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Photosynthesis, World War II, Algebraic Expressions"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 bg-white shadow-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Subject (optional)</label>
              <input
                type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Biology, History"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 bg-white shadow-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Education level</label>
              <select
                value={level} onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 bg-white shadow-sm"
              >
                {LEVELS.map((l) => <option key={l} value={l}>{l.charAt(0).toUpperCase() + l.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Number of slides</label>
              <input
                type="number" min={1} max={20} value={slideCount}
                onChange={(e) => setSlideCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 8)))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 bg-white shadow-sm"
              />
            </div>
            <div className="flex items-end lg:col-span-3">
              <button
                onClick={handleGenerate} disabled={generating || !topic.trim()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {generating ? <><Loader className="h-4 w-4 animate-spin" />Generating…</> : <><Zap className="h-4 w-4" />Generate {slideCount} slides</>}
              </button>
            </div>
          </div>
        </div>
        </div>
      )}

      {/* ── Step 3: Style ── */}
      {step === 'style' && (
        <div className="flex gap-5" style={{ minHeight: '600px' }}>

          {/* Left — generated slides */}
          <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1" style={{ maxHeight: '78vh' }}>
            <div className="shrink-0">
              <p className="text-xs text-gray-500">
                Anthropic AI has automatically assigned backgrounds based on slide content and type.
                You can drag to reassign or click "Apply to all" for manual control.
              </p>
              {Object.keys(slideBackgrounds).length > 0 && (
                <p className="mt-1 text-xs text-emerald-600">
                  ✓ {Object.keys(slideBackgrounds).length} slide{Object.keys(slideBackgrounds).length !== 1 ? 's' : ''} auto-styled by AI
                </p>
              )}
            </div>
            {generatedContent.map((slide) => {
              const bgId = slideBackgrounds[slide.slideIndex];
              const bg = bgId ? allBgMap.get(bgId) : null;
              const isOver = dragOverSlide === slide.slideIndex;
              const typeMeta = SLIDE_TYPE_META[slide.slideType] || SLIDE_TYPE_META.unknown;
              const textClass = bg?.isDark ? 'text-white' : 'text-gray-900';
              const subTextClass = bg?.isDark ? 'text-white/75' : 'text-gray-600';

              const bgStyle: React.CSSProperties = bg
                ? bg.isImage
                  ? { backgroundImage: bg.css, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : { background: bg.css }
                : { background: '#FFFFFF' };

              return (
                <div
                  key={slide.slideIndex}
                  onDragOver={(e) => handleSlideDragOver(e, slide.slideIndex)}
                  onDragLeave={handleSlideDragLeave}
                  onDrop={(e) => handleSlideDrop(e, slide.slideIndex)}
                  className={`shrink-0 overflow-hidden rounded-xl border-2 shadow-sm transition-all ${
                    isOver
                      ? 'border-amber-400 ring-2 ring-amber-300 ring-offset-1'
                      : bg ? 'border-transparent' : 'border-dashed border-gray-300'
                  }`}
                  style={{ ...bgStyle, aspectRatio: '16/9' }}
                >
                  <div className="flex h-full flex-col justify-between p-5">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium opacity-60 ${textClass}`}>{slide.slideIndex + 1}</span>
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
                          bg ? (bg.isDark ? 'border-white/20 bg-white/10 text-white' : 'border-black/10 bg-black/5 text-gray-700') : typeMeta.colour
                        }`}>
                          {typeMeta.icon}{typeMeta.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {bg && <span className={`text-xs opacity-60 ${textClass}`}>{bg.label}</span>}
                        {bg && (
                          <button
                            onClick={() => clearBackground(slide.slideIndex)}
                            className={`rounded p-0.5 transition-opacity hover:opacity-100 ${bg.isDark ? 'text-white/60 hover:bg-white/10' : 'text-gray-400 hover:bg-black/5'}`}
                            title="Remove background"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex-1 py-3">
                      {slide.title && <p className={`text-sm font-bold leading-snug ${textClass}`}>{slide.title}</p>}
                      <ul className={`mt-2 space-y-0.5 ${subTextClass}`}>
                        {(slide.bullets || []).slice(0, 4).map((b, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-xs">
                            <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-current opacity-60" />
                            <span className="line-clamp-1">{b}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {!bg && (
                      <p className="text-center text-xs text-gray-400">
                        {isOver ? '⬇ Drop background here' : 'Drop a background here'}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right — gallery + export */}
          <div className="flex w-64 shrink-0 flex-col gap-4">
            <div className="overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 shadow-sm" style={{ maxHeight: 'calc(78vh - 80px)' }}>
              <h3 className="mb-1 text-sm font-semibold text-gray-800">Background Gallery</h3>
              <p className="mb-3 text-xs text-gray-500">Drag a style onto a slide, or click "Apply to all".</p>

              {/* Template backgrounds section */}
              {templateBackgrounds.length > 0 && (
                <div className="mb-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">From your template</p>
                  <div className="grid grid-cols-2 gap-2">
                    {templateBackgrounds.map((bg) => {
                      const usedCount = Object.values(slideBackgrounds).filter((id) => id === bg.id).length;
                      const previewStyle: React.CSSProperties = bg.imageFilename
                        ? { backgroundImage: `url('${API_BASE}/slide-gen/bg-asset/${sessionId}/${bg.imageFilename}')`, backgroundSize: 'cover', backgroundPosition: 'center' }
                        : { background: bg.previewCss };
                      return (
                        <div
                          key={bg.id}
                          draggable
                          onDragStart={(e) => handleBgDragStart(e, bg.id)}
                          className="group cursor-grab select-none rounded-lg border border-gray-200 p-1.5 transition-shadow hover:shadow-md active:cursor-grabbing"
                          title={`Drag onto a slide${usedCount ? ` · applied to ${usedCount}` : ''}`}
                        >
                          <div className="mb-1.5 w-full rounded" style={{ ...previewStyle, aspectRatio: '16/9' }} />
                          <p className="truncate text-center text-xs font-medium text-gray-700">{bg.label}</p>
                          {usedCount > 0 && (
                            <p className="text-center text-[10px] text-amber-600">{usedCount} slide{usedCount > 1 ? 's' : ''}</p>
                          )}
                          <button
                            onClick={() => applyToAll(bg.id)}
                            className="mt-1 hidden w-full rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-600 hover:bg-amber-100 hover:text-amber-700 group-hover:block"
                          >
                            Apply to all
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="my-3 border-t border-gray-100" />
                </div>
              )}

              {/* Preset styles section */}
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Preset styles</p>
                {/* Category tabs */}
                <div className="mb-3 flex rounded-lg bg-gray-100 p-0.5">
                  {PRESET_CATEGORIES.map((cat) => (
                    <button
                      key={cat.key}
                      onClick={() => setActiveBgCategory(cat.key)}
                      className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                        activeBgCategory === cat.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-800'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {PRESETS.filter((b) => b.category === activeBgCategory).map((bg) => {
                    const usedCount = Object.values(slideBackgrounds).filter((id) => id === bg.id).length;
                    return (
                      <div
                        key={bg.id}
                        draggable
                        onDragStart={(e) => handleBgDragStart(e, bg.id)}
                        className="group cursor-grab select-none rounded-lg border border-gray-200 p-1.5 transition-shadow hover:shadow-md active:cursor-grabbing"
                        title={`Drag onto a slide${usedCount ? ` · applied to ${usedCount}` : ''}`}
                      >
                        <div className="mb-1.5 w-full rounded" style={{ background: bg.css, aspectRatio: '16/9' }} />
                        <p className="truncate text-center text-xs font-medium text-gray-700">{bg.label}</p>
                        {usedCount > 0 && (
                          <p className="text-center text-[10px] text-amber-600">{usedCount} slide{usedCount > 1 ? 's' : ''}</p>
                        )}
                        <button
                          onClick={() => applyToAll(bg.id)}
                          className="mt-1 hidden w-full rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-600 hover:bg-amber-100 hover:text-amber-700 group-hover:block"
                        >
                          Apply to all
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Export button */}
            <button
              onClick={handleExport}
              disabled={exporting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {exporting
                ? <><Loader className="h-4 w-4 animate-spin" />Building PPTX…</>
                : <><Download className="h-4 w-4" />Export PPTX</>}
            </button>
            <p className="text-center text-xs text-gray-400">
              {Object.keys(slideBackgrounds).length}/{generatedContent.length} slides styled
            </p>
          </div>
        </div>
      )}

      {/* ── Step 4: Done ── */}
      {step === 'done' && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-10 text-center">
          <CheckCircle className="mx-auto mb-4 h-12 w-12 text-emerald-500" />
          <h3 className="text-lg font-semibold text-gray-900">Presentation ready</h3>
          <p className="mt-1 text-sm text-gray-600">
            Downloaded as <span className="font-medium">{downloadFilename}</span>.
          </p>
          <p className="mt-2 text-xs text-gray-500">
            Open in PowerPoint or LibreOffice to review the generated slides and their applied backgrounds.
          </p>
          <button
            onClick={reset}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <RefreshCw className="h-4 w-4" /> Create another presentation
          </button>
        </div>
      )}
    </div>
  );
};

export default SlideGenerator;
