import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Download,
  Loader,
  Presentation,
  RefreshCw,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { slideGenAPI, GeneratedSlide, GeneratedContent, TemplateBackground, TemplateImageAsset } from '../services/api';
import { EDUCATION_LEVEL_OPTIONS } from '../constants/educationLevels';

type Step = 'input' | 'generating' | 'preview' | 'done';

interface SlideGeneratorStudioProps {
  initialContent?: GeneratedContent | null;
  onClose?: () => void;
}

const SlideGeneratorStudio: React.FC<SlideGeneratorStudioProps> = ({ initialContent, onClose }) => {
  const [step, setStep] = useState<Step>('input');
  const [error, setError] = useState<string | null>(null);

  // Input state
  const [topic, setTopic] = useState('');
  const [teachingGoal, setTeachingGoal] = useState('');
  const [subject, setSubject] = useState('');
  const [level, setLevel] = useState('undergraduate');
  const [numSlides, setNumSlides] = useState(8);

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
        content: generatedSlides,
        backgrounds: slideBackgrounds,
        templateBgs: templateBackgrounds,
        templateImages,
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

  const reset = () => {
    setStep('input');
    setGeneratedSlides([]);
    setSlideBackgrounds({});
    setTopic('');
    setTeachingGoal('');
    setSubject('');
    setLevel('undergraduate');
    setNumSlides(8);
    setTemplateFile(null);
    setSessionId('');
    setTemplateBackgrounds([]);
    setTemplateImages([]);
    setError(null);
    setDownloadFilename('');
  };

  const currentSlide = generatedSlides[previewIndex];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Presentation Studio</h2>
          <p className="mt-1 text-sm text-gray-600">
            AI-powered presentation generation with automatic layout optimization and design assignment. Anthropic analyzes content and templates to create perfectly structured slides.
          </p>
        </div>
        {step !== 'input' && (
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

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Step 1: Input */}
      {step === 'input' && (
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
              <input
                type="text"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g., Climate Change, Photosynthesis, World War II"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-medium text-gray-700">Teaching Goal (optional)</label>
              <textarea
                value={teachingGoal}
                onChange={(e) => setTeachingGoal(e.target.value)}
                placeholder="What do students need to understand or be able to do?"
                rows={2}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Subject (optional)</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g., Biology, History"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Education Level</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
              >
                {EDUCATION_LEVEL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Number of Slides</label>
              <input
                type="number"
                min={1}
                max={20}
                value={numSlides}
                onChange={(e) => setNumSlides(Math.max(1, Math.min(20, parseInt(e.target.value) || 8)))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="mb-2 block text-xs font-medium text-gray-700">Template / Theme (optional)</label>
              <div className="flex gap-2 items-center">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pptx"
                  className="hidden"
                  onChange={(e) => handleTemplateFileChange(e.target.files?.[0] || null)}
                  disabled={isAnalyzingTemplate}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isAnalyzingTemplate}
                  className="inline-flex items-center gap-1.5 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white hover:bg-gray-50 whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isAnalyzingTemplate ? (
                    <>
                      <Loader className="w-4 h-4 animate-spin" />
                      Analyzing…
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      Upload .pptx Template
                    </>
                  )}
                </button>
                {templateFile && (
                  <button
                    type="button"
                    onClick={() => handleTemplateFileChange(null)}
                    className="text-red-500 hover:text-red-700"
                    title="Remove template"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              {templateFile && (
                <div className="mt-2 p-2 rounded bg-emerald-50 text-xs text-emerald-700">
                  ✓ {templateFile.name} ({templateBackgrounds.length} background{templateBackgrounds.length !== 1 ? 's' : ''} extracted)
                </div>
              )}
            </div>
          </div>

          <button
            onClick={handleGenerate}
            disabled={isGenerating || !topic.trim()}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-3 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isGenerating ? (
              <>
                <Loader className="h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Zap className="h-4 w-4" />
                Generate {numSlides} Slides
              </>
            )}
          </button>
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
                  Preparing Download…
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Download PPTX
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
