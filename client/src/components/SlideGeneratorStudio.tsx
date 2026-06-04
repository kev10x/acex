import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Download,
  Layers,
  Loader,
  Plus,
  Presentation,
  RefreshCw,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { slideGenAPI, GeneratedSlide, GeneratedContent, TemplateBackground, TemplateImageAsset, DetailLevel, SlideBatchUnit, SlideBatchStatus } from '../services/api';
import { EDUCATION_LEVEL_OPTIONS } from '../constants/educationLevels';

type Step = 'input' | 'generating' | 'preview' | 'done';
type Mode = 'single' | 'batch';

const DETAIL_LEVEL_OPTIONS: { value: DetailLevel; label: string; hint: string }[] = [
  { value: 'minimal',       label: 'Minimal',       hint: '2-3 keywords per slide' },
  { value: 'standard',      label: 'Standard',      hint: '3-5 concise phrases' },
  { value: 'detailed',      label: 'Detailed',      hint: '5-7 clauses with context' },
  { value: 'comprehensive', label: 'Comprehensive',  hint: '6-8 full sentences' },
];

interface SlideGeneratorStudioProps {
  initialContent?: GeneratedContent | null;
  onClose?: () => void;
}

const SlideGeneratorStudio: React.FC<SlideGeneratorStudioProps> = ({ initialContent, onClose }) => {
  const [mode, setMode] = useState<Mode>('single');
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState<string | null>(null);

  // Shared settings
  const [subject, setSubject] = useState('');
  const [level, setLevel] = useState('undergraduate');
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('standard');

  // Single mode state
  const [topic, setTopic] = useState('');
  const [teachingGoal, setTeachingGoal] = useState('');
  const [numSlides, setNumSlides] = useState(8);

  // Image generation
  const [generateImages, setGenerateImages] = useState(false);

  // Batch mode state
  const [batchUnits, setBatchUnits] = useState<SlideBatchUnit[]>([
    { title: '', slideCount: 8, includeQuiz: false },
  ]);
  const [scheduledFor, setScheduledFor] = useState('');
  const [batchJobId, setBatchJobId] = useState<number | null>(null);
  const [batchStatus, setBatchStatus] = useState<SlideBatchStatus | null>(null);
  const [isBatchPolling, setIsBatchPolling] = useState(false);
  const [isDownloadingBatch, setIsDownloadingBatch] = useState(false);
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Template state
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [templateBackgrounds, setTemplateBackgrounds] = useState<TemplateBackground[]>([]);
  const [templateImages, setTemplateImages] = useState<TemplateImageAsset[]>([]);
  const [isAnalyzingTemplate, setIsAnalyzingTemplate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialContent?.title) {
      setTopic(initialContent.title);
      if (Array.isArray(initialContent.sections) && initialContent.sections.length) {
        setNumSlides(Math.max(1, Math.min(20, initialContent.sections.length + 2)));
      }
    }
  }, [initialContent]);

  // Generation state
  const [generatedSlides, setGeneratedSlides] = useState<GeneratedSlide[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // Preview state
  const [previewIndex, setPreviewIndex] = useState(0);
  const [slideBackgrounds, setSlideBackgrounds] = useState<Record<number, string>>({});
  const [isExporting, setIsExporting] = useState(false);
  const [downloadFilename, setDownloadFilename] = useState('');

  // Load template and extract backgrounds
  const handleTemplateFileChange = async (file: File | null) => {
    if (!file) {
      setTemplateFile(null);
      setSessionId('');
      setTemplateBackgrounds([]);
      setTemplateImages([]);
      return;
    }

    if (file.size > 30 * 1024 * 1024) {
      setError('Template file must be 30 MB or smaller.');
      return;
    }

    setTemplateFile(file);
    setError(null);
    setIsAnalyzingTemplate(true);

    try {
      const result = await slideGenAPI.analyse(file);
      setSessionId(result.sessionId);
      setTemplateBackgrounds(result.backgrounds);
      setTemplateImages(Array.isArray(result.images) ? result.images : []);
      setError(null);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to analyze template');
      setTemplateFile(null);
      setSessionId('');
      setTemplateBackgrounds([]);
      setTemplateImages([]);
    } finally {
      setIsAnalyzingTemplate(false);
    }
  };

  const handleGenerate = async () => {
    if (!topic.trim()) {
      setError('Please enter a topic');
      return;
    }

    setError(null);
    setIsGenerating(true);
    setStep('generating');

    try {
      const { content } = await slideGenAPI.generateContent({
        topic: topic.trim(),
        teachingGoal: teachingGoal.trim() || undefined,
        subject: subject.trim() || undefined,
        level,
        slideCount: numSlides,
        detailLevel,
        backgrounds: templateBackgrounds,
      });

      setGeneratedSlides(content);
      
      // Auto-assign backgrounds based on AI recommendations
      const autoBackgrounds: Record<number, string> = {};
      content.forEach(slide => {
        if (slide.backgroundId && templateBackgrounds.find(b => b.id === slide.backgroundId)) {
          autoBackgrounds[slide.slideIndex] = slide.backgroundId;
        }
      });
      setSlideBackgrounds(autoBackgrounds);
      setPreviewIndex(0);
      setStep('preview');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to generate slides');
      setStep('input');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleExport = async () => {
    setError(null);
    setIsExporting(true);

    try {
      const blob = await slideGenAPI.populate({
        sessionId,
        topic,
        subject: subject || undefined,
        level,
        content: generatedSlides,
        backgrounds: slideBackgrounds,
        templateBgs: templateBackgrounds,
        templateImages,
        generateImages,
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeTopic = topic
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 60) || 'presentation';
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
      setIsExporting(false);
    }
  };

  // ── Batch handlers ────────────────────────────────────────────────────────

  const addUnit = () => setBatchUnits((u) => [...u, { title: '', slideCount: 8, includeQuiz: false }]);

  const removeUnit = (i: number) => setBatchUnits((u) => u.filter((_, idx) => idx !== i));

  const updateUnit = (i: number, patch: Partial<SlideBatchUnit>) =>
    setBatchUnits((u) => u.map((unit, idx) => (idx === i ? { ...unit, ...patch } : unit)));

  const handleBatchSubmit = async () => {
    const validUnits = batchUnits.filter((u) => u.title.trim());
    if (!validUnits.length) {
      setError('Add at least one unit with a title');
      return;
    }
    setError(null);
    setIsBatchPolling(true);
    try {
      const { jobId } = await slideGenAPI.createBatch({
        units: validUnits,
        subject: subject.trim() || undefined,
        level,
        detailLevel,
        scheduledFor: scheduledFor || null,
        sessionId: sessionId || undefined,
        backgrounds: templateBackgrounds,
        templateBgs: templateBackgrounds,
        templateImages,
        generateImages,
      });
      setBatchJobId(jobId);
      startBatchPolling(jobId);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to submit batch');
      setIsBatchPolling(false);
    }
  };

  const startBatchPolling = (jobId: number) => {
    if (batchPollRef.current) clearInterval(batchPollRef.current);
    const poll = async () => {
      try {
        const status = await slideGenAPI.getBatchStatus(jobId);
        setBatchStatus(status);
        if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
          if (batchPollRef.current) clearInterval(batchPollRef.current);
          setIsBatchPolling(false);
        }
      } catch (_) {}
    };
    poll();
    batchPollRef.current = setInterval(poll, 5000);
  };

  useEffect(() => () => { if (batchPollRef.current) clearInterval(batchPollRef.current); }, []);

  const handleBatchDownload = async () => {
    if (!batchJobId) return;
    setIsDownloadingBatch(true);
    try {
      const blob = await slideGenAPI.downloadBatch(batchJobId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `slide_batch_${batchJobId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Download failed');
    } finally {
      setIsDownloadingBatch(false);
    }
  };

  const resetBatch = () => {
    if (batchPollRef.current) clearInterval(batchPollRef.current);
    setBatchJobId(null);
    setBatchStatus(null);
    setIsBatchPolling(false);
    setBatchUnits([{ title: '', slideCount: 8, includeQuiz: false }]);
    setScheduledFor('');
    setGenerateImages(false);
    setError(null);
  };

  // ── Single mode reset ─────────────────────────────────────────────────────

  const reset = () => {
    setStep('input');
    setGeneratedSlides([]);
    setSlideBackgrounds({});
    setTopic('');
    setTeachingGoal('');
    setSubject('');
    setLevel('undergraduate');
    setDetailLevel('standard');
    setNumSlides(8);
    setTemplateFile(null);
    setSessionId('');
    setTemplateBackgrounds([]);
    setTemplateImages([]);
    setError(null);
    setDownloadFilename('');
  };

  const currentSlide = generatedSlides[previewIndex];

  // ── Batch status helpers ──────────────────────────────────────────────────

  const batchStatusLabel: Record<string, string> = {
    scheduled: 'Scheduled',
    queued: 'Queued',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };

  const batchDone = batchStatus?.status === 'completed';
  const batchFailed = batchStatus?.status === 'failed';
  const batchScheduled = batchStatus?.status === 'scheduled';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Presentation Studio</h2>
          <p className="mt-1 text-sm text-gray-600">
            AI-powered presentation generation with automatic layout optimization and design assignment.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {step !== 'input' && mode === 'single' && (
            <button
              onClick={reset}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <RefreshCw className="h-4 w-4" /> Start over
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Mode toggle */}
      {(step === 'input' || mode === 'batch') && !batchJobId && (
        <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-1 w-fit gap-1">
          <button
            onClick={() => { setMode('single'); setError(null); }}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${mode === 'single' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <Presentation className="h-3.5 w-3.5" /> Single
          </button>
          <button
            onClick={() => { setMode('batch'); setError(null); }}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${mode === 'batch' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <Layers className="h-3.5 w-3.5" /> Batch
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── SHARED: Template upload + image options ──────────────────────── */}
      {(step === 'input' || mode === 'batch') && !batchJobId && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
          <p className="text-xs font-medium text-gray-700">Template / Theme (optional — shared across all slides)</p>
          <div className="flex gap-2 items-center flex-wrap">
            <input ref={fileInputRef} type="file" accept=".pptx" className="hidden"
              onChange={(e) => handleTemplateFileChange(e.target.files?.[0] || null)}
              disabled={isAnalyzingTemplate} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isAnalyzingTemplate}
              className="inline-flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white hover:bg-gray-50 whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed">
              {isAnalyzingTemplate ? <><Loader className="w-4 h-4 animate-spin" /> Analyzing…</> : <><Upload className="w-4 h-4" /> Upload .pptx Template</>}
            </button>
            {templateFile && (
              <button type="button" onClick={() => handleTemplateFileChange(null)} className="text-red-500 hover:text-red-700" title="Remove template">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          {templateFile && (
            <p className="text-xs text-emerald-700">✓ {templateFile.name} ({templateBackgrounds.length} background{templateBackgrounds.length !== 1 ? 's' : ''} extracted)</p>
          )}

          {/* Grok image generation toggle */}
          <label className="flex items-start gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={generateImages}
              onChange={(e) => setGenerateImages(e.target.checked)}
              className="mt-0.5 rounded border-gray-300 text-violet-600 focus:ring-violet-400"
            />
            <div>
              <span className="text-xs font-medium text-gray-800 group-hover:text-gray-900">
                Generate images with Grok
              </span>
              <p className="text-xs text-gray-500 mt-0.5">
                Aurora AI generates relevant illustrations for content, title, and activity slides (up to 6 per deck). Added at download time.
              </p>
            </div>
          </label>
        </div>
      )}

      {/* ── SINGLE MODE INPUT ────────────────────────────────────────────── */}
      {mode === 'single' && step === 'input' && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Presentation className="h-4 w-4 text-amber-600" />
            <h3 className="text-sm font-semibold text-gray-900">Presentation Details</h3>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Topic <span className="text-red-500">*</span>
              </label>
              <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g., Climate Change, Photosynthesis, World War II"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400" />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-700">Teaching Goal (optional)</label>
              <textarea value={teachingGoal} onChange={(e) => setTeachingGoal(e.target.value)}
                placeholder="What do students need to understand or be able to do?" rows={2}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400" />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Subject (optional)</label>
              <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g., Biology, History"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400" />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Education Level</label>
              <select value={level} onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400">
                {EDUCATION_LEVEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Number of Slides</label>
              <input type="number" min={1} max={20} value={numSlides}
                onChange={(e) => setNumSlides(Math.max(1, Math.min(20, parseInt(e.target.value) || 8)))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400" />
            </div>

            {/* Detail level */}
            <div className="sm:col-span-2">
              <label className="mb-2 block text-xs font-medium text-gray-700">Detail Level</label>
              <div className="flex gap-2 flex-wrap">
                {DETAIL_LEVEL_OPTIONS.map((opt) => (
                  <button key={opt.value} type="button" onClick={() => setDetailLevel(opt.value)}
                    className={`flex flex-col items-start px-3 py-2 rounded-lg border text-left transition-colors ${detailLevel === opt.value ? 'border-amber-400 bg-amber-50 text-amber-800' : 'border-gray-200 bg-white text-gray-700 hover:border-amber-200'}`}>
                    <span className="text-xs font-medium">{opt.label}</span>
                    <span className="text-xs text-gray-500 mt-0.5">{opt.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button onClick={handleGenerate} disabled={isGenerating || !topic.trim()}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-3 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60">
            {isGenerating ? <><Loader className="h-4 w-4 animate-spin" /> Generating…</> : <><Zap className="h-4 w-4" /> Generate {numSlides} Slides</>}
          </button>
        </div>
      )}

      {/* ── BATCH MODE UI ────────────────────────────────────────────────── */}
      {mode === 'batch' && !batchJobId && (
        <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-6 space-y-5">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-indigo-600" />
            <h3 className="text-sm font-semibold text-gray-900">Batch Generation</h3>
            <span className="ml-auto text-xs text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">50% cheaper via Anthropic Batch API</span>
          </div>

          {/* Global settings */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Subject (optional)</label>
              <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g., Biology, History"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Education Level</label>
              <select value={level} onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white">
                {EDUCATION_LEVEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-2 block text-xs font-medium text-gray-700">Detail Level</label>
              <div className="flex gap-2 flex-wrap">
                {DETAIL_LEVEL_OPTIONS.map((opt) => (
                  <button key={opt.value} type="button" onClick={() => setDetailLevel(opt.value)}
                    className={`flex flex-col items-start px-3 py-2 rounded-lg border text-left transition-colors ${detailLevel === opt.value ? 'border-indigo-400 bg-indigo-100 text-indigo-800' : 'border-gray-200 bg-white text-gray-700 hover:border-indigo-200'}`}>
                    <span className="text-xs font-medium">{opt.label}</span>
                    <span className="text-xs text-gray-500 mt-0.5">{opt.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Unit list */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-700">Units</label>
              <span className="text-xs text-gray-500">{batchUnits.length} / 30</span>
            </div>

            {batchUnits.map((unit, i) => (
              <div key={i} className="flex gap-2 items-start rounded-lg border border-gray-200 bg-white p-3">
                <div className="flex-1 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_80px_auto]">
                  <input type="text" value={unit.title} onChange={(e) => updateUnit(i, { title: e.target.value })}
                    placeholder={`Unit ${i + 1} heading`}
                    className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                  <div className="flex items-center gap-1.5">
                    <input type="number" min={1} max={20} value={unit.slideCount}
                      onChange={(e) => updateUnit(i, { slideCount: Math.max(1, Math.min(20, parseInt(e.target.value) || 8)) })}
                      className="w-16 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 text-center" />
                    <span className="text-xs text-gray-500 whitespace-nowrap">slides</span>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer whitespace-nowrap">
                    <input type="checkbox" checked={unit.includeQuiz} onChange={(e) => updateUnit(i, { includeQuiz: e.target.checked })}
                      className="rounded border-gray-300 text-indigo-600" />
                    Quiz
                  </label>
                </div>
                <button type="button" onClick={() => removeUnit(i)} disabled={batchUnits.length === 1}
                  className="text-gray-400 hover:text-red-500 disabled:opacity-30 pt-1.5">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}

            <button type="button" onClick={addUnit} disabled={batchUnits.length >= 30}
              className="inline-flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 disabled:opacity-40">
              <Plus className="h-4 w-4" /> Add unit
            </button>
          </div>

          {/* Schedule */}
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-700">
              <Clock className="h-3.5 w-3.5" /> Schedule for later (optional)
            </label>
            <input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)}
              min={new Date().toISOString().slice(0, 16)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white" />
            {scheduledFor && (
              <p className="mt-1 text-xs text-indigo-700">Batch will be submitted to Anthropic at the scheduled time for off-peak savings.</p>
            )}
          </div>

          <button onClick={handleBatchSubmit} disabled={isBatchPolling || !batchUnits.some((u) => u.title.trim())}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
            {isBatchPolling ? <><Loader className="h-4 w-4 animate-spin" /> Submitting…</> : scheduledFor ? <><Clock className="h-4 w-4" /> Schedule Batch</> : <><Zap className="h-4 w-4" /> Submit Batch ({batchUnits.filter((u) => u.title.trim()).length} units)</>}
          </button>
        </div>
      )}

      {/* ── BATCH STATUS ─────────────────────────────────────────────────── */}
      {mode === 'batch' && batchJobId && (
        <div className="rounded-xl border border-indigo-200 bg-white p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {batchDone ? <CheckCircle className="h-5 w-5 text-emerald-500" /> :
               batchFailed ? <AlertCircle className="h-5 w-5 text-red-500" /> :
               <Loader className="h-5 w-5 text-indigo-500 animate-spin" />}
              <h3 className="text-sm font-semibold text-gray-900">
                Batch Job #{batchJobId}
              </h3>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${
              batchDone ? 'bg-emerald-100 text-emerald-700' :
              batchFailed ? 'bg-red-100 text-red-700' :
              batchScheduled ? 'bg-yellow-100 text-yellow-700' :
              'bg-indigo-100 text-indigo-700'
            }`}>
              {batchStatusLabel[batchStatus?.status || ''] || batchStatus?.status || 'Pending'}
            </span>
          </div>

          {batchStatus && (
            <div className="space-y-2 text-sm text-gray-600">
              <p>{batchStatus.unitCount} unit{batchStatus.unitCount !== 1 ? 's' : ''}</p>
              {batchScheduled && batchStatus.scheduledFor && (
                <p className="text-yellow-700">Scheduled for {new Date(batchStatus.scheduledFor).toLocaleString()}</p>
              )}
              {batchStatus.progress?.requestCounts && (
                <div className="flex gap-4 text-xs">
                  <span className="text-emerald-600">✓ {batchStatus.progress.requestCounts.succeeded} done</span>
                  <span className="text-indigo-600">⟳ {batchStatus.progress.requestCounts.processing} processing</span>
                  {batchStatus.progress.requestCounts.errored > 0 && (
                    <span className="text-red-600">✗ {batchStatus.progress.requestCounts.errored} errored</span>
                  )}
                </div>
              )}
              {batchFailed && batchStatus.errorMessage && (
                <p className="text-red-600 text-xs">{batchStatus.errorMessage}</p>
              )}
            </div>
          )}

          {!batchDone && !batchFailed && (
            <p className="text-xs text-gray-500">Anthropic processes batch requests asynchronously — polling every 5 seconds.</p>
          )}

          <div className="flex gap-3">
            {batchDone && (
              <button onClick={handleBatchDownload} disabled={isDownloadingBatch}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed">
                {isDownloadingBatch ? <><Loader className="h-4 w-4 animate-spin" /> Preparing…</> : <><Download className="h-4 w-4" /> Download All as ZIP</>}
              </button>
            )}
            <button onClick={resetBatch}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
              <RefreshCw className="h-4 w-4" /> New Batch
            </button>
          </div>
        </div>
      )}

      {step === 'generating' && (
        <div className="rounded-xl border border-amber-200 bg-white p-10 text-center">
          <Loader className="mx-auto mb-4 h-10 w-10 animate-spin text-amber-500" />
          <h3 className="text-base font-semibold text-gray-900">Designing your presentation</h3>
          <p className="mt-2 text-sm text-gray-600">
            Anthropic is planning the slide flow and matching each slide to the best available template style.
          </p>
        </div>
      )}

      {/* Step 2: AI-Generated Preview */}
      {step === 'preview' && currentSlide && (
        <div className="space-y-4">
          {/* Generation Summary */}
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-4 w-4 text-emerald-600" />
              <h3 className="text-sm font-semibold text-gray-900">Presentation Generated with AI</h3>
            </div>
            <p className="text-xs text-gray-700 mb-2">
              Anthropic has analyzed your content and template to create an optimized presentation with intelligent layout and design assignments.
            </p>
            {templateBackgrounds.length > 0 && (
              <p className="text-xs text-emerald-700">
                ✓ All {generatedSlides.length} slides have been matched with optimal backgrounds from your template
              </p>
            )}
          </div>

          {/* Slide Preview */}
          <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm" style={{ aspectRatio: '16/9' }}>
            <div className="flex flex-col h-full justify-between">
              <div>
                <div className="text-xs text-gray-400 mb-2">Slide {previewIndex + 1} • {currentSlide.slideType}</div>
                <h3 className="text-3xl font-bold text-gray-900 mb-6">{currentSlide.title}</h3>
                <ul className="space-y-3">
                  {currentSlide.bullets.map((bullet, i) => (
                    <li key={i} className="flex items-start gap-3 text-base text-gray-700">
                      <span className="text-amber-600 font-bold text-lg mt-1">•</span>
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Navigation Controls */}
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={() => setPreviewIndex(Math.max(0, previewIndex - 1))}
              disabled={previewIndex === 0}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ← Previous
            </button>
            <div className="flex-1 text-center">
              <div className="inline-block px-4 py-2 rounded-lg bg-gray-100 text-sm font-medium text-gray-700">
                Slide {previewIndex + 1} of {generatedSlides.length}
              </div>
            </div>
            <button
              onClick={() => setPreviewIndex(Math.min(generatedSlides.length - 1, previewIndex + 1))}
              disabled={previewIndex === generatedSlides.length - 1}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3">
            <button
              onClick={handleExport}
              disabled={isExporting}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 shadow-sm"
            >
              {isExporting ? (
                <>
                  <Loader className="h-4 w-4 animate-spin" />
                  {generateImages ? 'Generating images…' : 'Preparing Download…'}
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Download PPTX{generateImages ? ' + Images' : ''}
                </>
              )}
            </button>
            <button
              onClick={reset}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <RefreshCw className="h-4 w-4" />
              Create New
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Done */}
      {step === 'done' && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-10 text-center">
          <CheckCircle className="mx-auto mb-4 h-12 w-12 text-emerald-500" />
          <h3 className="text-lg font-semibold text-gray-900">Presentation ready to download!</h3>
          <p className="mt-2 text-sm text-gray-700 mb-1">
            <span className="font-medium">{downloadFilename}</span>
          </p>
          <p className="text-xs text-gray-600 mb-6">
            Your presentation has been optimized with Anthropic AI for content flow and design alignment.
          </p>
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <RefreshCw className="h-4 w-4" /> Create Another Presentation
          </button>
        </div>
      )}
    </div>
  );
};

export default SlideGeneratorStudio;
