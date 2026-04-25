import React, { useState, useEffect, useRef, useMemo } from 'react';
import { FileText, Loader2, Video, Link2, Upload, X, Presentation, BookOpen, Trash2, CalendarClock, History, Images } from 'lucide-react';
import { contentAPI, rubricsAPI, modulesAPI, GeneratedContent, ContentPlannerJob, ContentTemplate, ContentHistoryItem as ApiContentHistoryItem, LearningModule, PublishedContentItem, GenerationTrace, GenerationJobItem } from '../services/api';
import RichTextEditor from './RichTextEditor';
import { EDUCATION_LEVEL_OPTIONS, normalizeEducationLevelValue } from '../constants/educationLevels';
import {
  buildContextualSectionBodyHtml,
  ContextualBlockLayout,
  getSectionBodyHtml,
  richHtmlToPlainText,
  sanitizeRichTextHtml,
} from '../utils/richText';

const LEGACY_CONTENT_HISTORY_KEY = 'content_generator_history_v1';
const SECTION_COUNT_MAX = 120;
const CONTEXTUAL_LAYOUT_OPTIONS: Array<{ value: ContextualBlockLayout; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'science', label: 'Science' },
  { value: 'history', label: 'History' },
  { value: 'language', label: 'Language' },
  { value: 'business', label: 'Business' },
  { value: 'plain', label: 'Plain' },
];
const isDiagramVisual = (visual: any) =>
  ['illustration', 'diagram', 'flowchart', 'graph', 'graphs', 'chart'].includes(String(visual?.kind || '').trim().toLowerCase());
const hasVisualSource = (visual: any) =>
  !!String(visual?.image_url || '').trim() || isDiagramVisual(visual);
const buildVisualPromptFromContext = (visual: any, section: any) => {
  const kind = isDiagramVisual(visual) ? 'illustration' : 'image';
  const parts = [
    section?.heading || section?.title ? `Section: ${String(section.heading || section.title).trim()}.` : '',
    visual?.title ? `Visual title: ${String(visual.title).trim()}.` : '',
    visual?.alt_text ? `Description: ${String(visual.alt_text).trim()}.` : '',
    section?.support ? `Key idea: ${String(section.support).trim()}.` : '',
    section?.body ? `Lesson context: ${String(section.body).replace(/\s+/g, ' ').slice(0, 280)}.` : '',
    kind === 'illustration'
      ? 'Create a clean educational diagram or infographic for this concept.'
      : 'Create a clean educational supporting image for this concept.',
  ].filter(Boolean);
  return parts.join(' ').trim().slice(0, 360);
};
const shouldAutoSyncVisualPrompt = (visual: any, section: any) => {
  const currentPrompt = String(visual?.prompt || '').trim();
  if (!currentPrompt) return true;
  return currentPrompt === buildVisualPromptFromContext(visual, section);
};
const buildSectionBackgroundStyle = (backgroundUrl?: string) => {
  const trimmed = String(backgroundUrl || '').trim();
  if (!trimmed) return {};
  return {
    backgroundImage: `linear-gradient(rgba(255,255,255,0.9), rgba(255,255,255,0.92)), url("${trimmed}")`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  } as React.CSSProperties;
};
const normalizeSecureMediaUrl = (value: string) => {
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
const toSecureSrc = (value?: string) => normalizeSecureMediaUrl(String(value || ''));
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

const dedupeFigureEntries = (entries: Array<{ visual: any; figNum: number; visualIndex: number; figureKey: string }>) => {
  const seen = new Set<string>();
  return entries.filter(({ visual }) => {
    const key = [
      String(visual?.kind || '').trim().toLowerCase(),
      String(visual?.image_url || '').trim(),
      String(visual?.title || '').trim().toLowerCase(),
    ].join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const isPlaceholderFigure = (visual: any) =>
  String(visual?.image_url || '').trim().startsWith('data:image/svg+xml');

const ContentGenerator: React.FC = () => {
  type StudioStep = 'plan' | 'generate' | 'polish';
  type SectionMode = 'manual' | 'auto';
  const [topics, setTopics] = useState('');
  const [teachingGoal, setTeachingGoal] = useState('');
  const [studioStep, setStudioStep] = useState<StudioStep>('plan');
  const [sectionMode, setSectionMode] = useState<SectionMode>('manual');
  const [autoSectionSuggestion, setAutoSectionSuggestion] = useState<number | null>(null);
  const [autoSectionNote, setAutoSectionNote] = useState('');
  const [planConfirmed, setPlanConfirmed] = useState(false);
  const [level, setLevel] = useState('');
  const [numSections, setNumSections] = useState(5);
  const [rubricId, setRubricId] = useState<number | null>(null);
  const [includeVideo, setIncludeVideo] = useState(false);
  const [includeDiagrams, setIncludeDiagrams] = useState(true);
  const [includeImages, setIncludeImages] = useState(true);
  const [includeMascot, setIncludeMascot] = useState(true);
  const [includeTextToSpeech, setIncludeTextToSpeech] = useState(true);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateId, setTemplateId] = useState('classroom');
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<GeneratedContent | null>(null);
  const [generationTrace, setGenerationTrace] = useState<GenerationTrace | null>(null);
  const [publishedLink, setPublishedLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backgroundGenerationNotice, setBackgroundGenerationNotice] = useState<string | null>(null);
  const [rubrics, setRubrics] = useState<any[]>([]);
  const [myContent, setMyContent] = useState<PublishedContentItem[]>([]);
  const [plannerJobs, setPlannerJobs] = useState<ContentPlannerJob[]>([]);
  const [history, setHistory] = useState<ApiContentHistoryItem[]>([]);
  const [selectedModuleId, setSelectedModuleId] = useState<number | null>(null);
  const [newModuleName, setNewModuleName] = useState('');
  const [modules, setModules] = useState<LearningModule[]>([]);
  const [scheduledFor, setScheduledFor] = useState('');
  const [isScheduling, setIsScheduling] = useState(false);
  const [cancellingPlannerJobId, setCancellingPlannerJobId] = useState<number | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [deletingContentId, setDeletingContentId] = useState<number | null>(null);
  const [isMigratingHistory, setIsMigratingHistory] = useState(false);
  const [activeHistoryId, setActiveHistoryId] = useState<number | null>(null);
  const [activePublishedContentId, setActivePublishedContentId] = useState<number | null>(null);
  const [activePublishedContentCode, setActivePublishedContentCode] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [loadingPublishedContentId, setLoadingPublishedContentId] = useState<number | null>(null);
  const [regeneratingVisualKey, setRegeneratingVisualKey] = useState<string | null>(null);
  const [generationProgress, setGenerationProgress] = useState<{
    active: boolean;
    task: 'content' | 'visual' | 'mascot';
    percent: number;
    label: string;
    detail: string;
  }>({
    active: false,
    task: 'content',
    percent: 0,
    label: '',
    detail: '',
  });
  const [selectedVisualKey, setSelectedVisualKey] = useState<string | null>(null);
  const [templateImages, setTemplateImages] = useState<string[]>([]);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);
  const [isUploadingTopicsFile, setIsUploadingTopicsFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const topicsFileInputRef = useRef<HTMLInputElement>(null);
  const recoveredContentJobIdRef = useRef<number | null>(null);
  const generationProgressTimerRef = useRef<number | null>(null);
  const generationProgressHideTimerRef = useRef<number | null>(null);
  const generationJobPollTimerRef = useRef<number | null>(null);
  const activeGenerationJobIdRef = useRef<number | null>(null);
  const generationJobPollBusyRef = useRef(false);

  const sectionFigures = useMemo<{ visual: any; figNum: number; visualIndex: number; figureKey: string }[][]>(() => {
    const sections = generatedContent?.sections || [];
    let counter = 0;
    return sections.map((sec: any, sectionIndex: number) =>
      (Array.isArray(sec.visuals) ? sec.visuals : []).map((v: any, visualIndex: number) => ({
        visual: v,
        visualIndex,
        figNum: ++counter,
        figureKey: `${sectionIndex}:${visualIndex}`,
      }))
    );
  }, [generatedContent?.sections]);
  const isPlayfulTemplate = useMemo(
    () => String(generatedContent?.template_id || templateId || '').trim().toLowerCase() === 'playful',
    [generatedContent?.template_id, templateId]
  );
  const playfulAssetPool = useMemo(() => {
    const fromContent = Array.isArray(generatedContent?.template_images) ? generatedContent.template_images : [];
    const fromTemplate = Array.isArray(templateImages) ? templateImages : [];
    const fromVisuals = (generatedContent?.sections || [])
      .flatMap((sec: any) => Array.isArray(sec?.visuals) ? sec.visuals : [])
      .filter((visual: any) => !isDiagramVisual(visual))
      .map((visual: any) => String(visual?.image_url || '').trim())
      .filter(Boolean);
    return [...fromContent, ...fromTemplate, ...fromVisuals]
      .filter((url, i, arr) => arr.indexOf(url) === i)
      .slice(0, 12);
  }, [generatedContent?.template_images, generatedContent?.sections, templateImages]);

  const planOutline = useMemo(() => {
    const chunks = String(topics || '')
      .split(/\r?\n|,/)
      .map((t) => t.trim())
      .filter(Boolean);
    const fallback = chunks.length
      ? chunks
      : ['Introduction', 'Core concepts', 'Applications', 'Common mistakes', 'Review'];
    return Array.from({ length: Math.max(1, numSections) }, (_, i) => fallback[i] || `Section ${i + 1}`);
  }, [topics, numSections]);

  const qualityChecks = useMemo(() => {
    const sections = Array.isArray(generatedContent?.sections) ? generatedContent.sections : [];
    const wordsPerSection = sections.map((s: any) =>
      String(s?.body || '')
        .replace(/<[^>]+>/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length
    );
    const shortCount = wordsPerSection.filter((w) => w < 90).length;
    const missingSupportCount = sections.filter((s: any) => !String(s?.support || '').trim()).length;
    const duplicateHeadingCount = (() => {
      const seen = new Set<string>();
      let duplicates = 0;
      sections.forEach((s: any) => {
        const h = String(s?.heading || s?.title || '').trim().toLowerCase();
        if (!h) return;
        if (seen.has(h)) duplicates += 1;
        else seen.add(h);
      });
      return duplicates;
    })();
    const avgWords = wordsPerSection.length
      ? Math.round(wordsPerSection.reduce((a, b) => a + b, 0) / wordsPerSection.length)
      : 0;
    return {
      sectionCount: sections.length,
      avgWords,
      shortCount,
      missingSupportCount,
      duplicateHeadingCount,
      passRate: sections.length
        ? Math.max(0, Math.round(((sections.length - shortCount - duplicateHeadingCount) / sections.length) * 100))
        : 0,
    };
  }, [generatedContent?.sections]);

  useEffect(() => {
    setPlanConfirmed(false);
  }, [
    topics,
    teachingGoal,
    level,
    numSections,
    sectionMode,
    templateId,
    rubricId,
    includeDiagrams,
    includeImages,
    includeMascot,
  ]);

  useEffect(() => {
    loadRubrics();
    loadMyContent();
    loadPlannerJobs();
    loadTemplates();
    loadHistory();
    loadModules();
  }, []);

  const clearGenerationProgressTimer = () => {
    if (generationProgressTimerRef.current) {
      window.clearInterval(generationProgressTimerRef.current);
      generationProgressTimerRef.current = null;
    }
    if (generationProgressHideTimerRef.current) {
      window.clearTimeout(generationProgressHideTimerRef.current);
      generationProgressHideTimerRef.current = null;
    }
  };

  const clearGenerationJobPoller = () => {
    if (generationJobPollTimerRef.current) {
      window.clearInterval(generationJobPollTimerRef.current);
      generationJobPollTimerRef.current = null;
    }
    generationJobPollBusyRef.current = false;
  };

  const startGenerationProgress = (task: 'content' | 'visual' | 'mascot', opts?: { includeImages?: boolean; includeMascot?: boolean }) => {
    clearGenerationProgressTimer();
    const includeHeavyVisuals = !!opts?.includeImages || !!opts?.includeMascot;
    const cap = task === 'content' ? 94 : 90;
    const startLabel = task === 'content'
      ? 'Preparing generation request'
      : task === 'visual'
        ? 'Preparing visual regeneration'
        : 'Preparing mascot regeneration';
    const startDetail = task === 'content'
      ? 'Building prompt and context'
      : 'Gathering section context';

    setGenerationProgress({
      active: true,
      task,
      percent: 6,
      label: startLabel,
      detail: startDetail,
    });

    generationProgressTimerRef.current = window.setInterval(() => {
      setGenerationProgress((prev) => {
        if (!prev.active || prev.task !== task) return prev;
        if (prev.percent >= cap) return prev;

        const deltaBase = task === 'content' ? (includeHeavyVisuals ? 1.8 : 2.6) : 3.2;
        const slowdown = prev.percent > 75 ? 0.45 : prev.percent > 55 ? 0.7 : 1;
        const jitter = Math.random() * 0.9;
        const nextPercent = Math.min(cap, prev.percent + (deltaBase + jitter) * slowdown);

        let label = prev.label;
        let detail = prev.detail;
        if (task === 'content') {
          if (nextPercent < 22) {
            label = 'Preparing generation request';
            detail = 'Building prompt and context';
          } else if (nextPercent < 52) {
            label = 'Generating sections';
            detail = 'Writing content and quiz';
          } else if (nextPercent < 80) {
            label = includeHeavyVisuals ? 'Generating visuals' : 'Finalizing response';
            detail = includeHeavyVisuals ? 'Creating figures and images' : 'Formatting the lesson output';
          } else {
            label = 'Finalizing response';
            detail = 'Saving and rendering generated content';
          }
        } else if (task === 'visual') {
          if (nextPercent < 45) {
            label = 'Regenerating visual';
            detail = 'Sending visual prompt to image model';
          } else {
            label = 'Finalizing visual';
            detail = 'Updating section preview';
          }
        } else {
          if (nextPercent < 45) {
            label = 'Regenerating mascot';
            detail = 'Sending mascot prompt to image model';
          } else {
            label = 'Finalizing mascot';
            detail = 'Updating key point companion';
          }
        }

        return { ...prev, percent: nextPercent, label, detail };
      });
    }, 900);
  };

  const updateGenerationProgress = (percent: number, label: string, detail = '') => {
    setGenerationProgress((prev) => ({
      ...prev,
      active: true,
      percent: Math.max(prev.percent, Math.min(96, percent)),
      label,
      detail,
    }));
  };

  const mapBackendProgressToUi = (progress: any) => {
    if (!progress || typeof progress !== 'object') return;
    const percent = Number(progress.percent || 0);
    const label = String(progress.label || '').trim();
    const detail = String(progress.detail || '').trim();
    const taskRaw = String(progress.task || '').toLowerCase();
    const task: 'content' | 'visual' | 'mascot' =
      taskRaw === 'mascot' ? 'mascot' : taskRaw === 'visual' ? 'visual' : 'content';
    setGenerationProgress((prev) => ({
      ...prev,
      active: true,
      task,
      percent: Math.max(prev.percent, Math.min(99, Number.isFinite(percent) ? percent : prev.percent)),
      label: label || prev.label || 'Generating content',
      detail: detail || prev.detail,
    }));
  };

  const chooseLikelyActiveContentJob = (items: GenerationJobItem[]) => {
    const now = Date.now();
    const candidates = (Array.isArray(items) ? items : [])
      .filter((job) => job?.job_type === 'content_generation')
      .filter((job) => ['scheduled', 'processing', 'retrying', 'completed'].includes(String(job?.status || '')))
      .sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
    if (!candidates.length) return null;
    if (activeGenerationJobIdRef.current) {
      const exact = candidates.find((job) => Number(job.id) === Number(activeGenerationJobIdRef.current));
      if (exact) return exact;
    }
    const fresh = candidates.find((job) => {
      const createdAt = new Date(job?.created_at || 0).getTime();
      return Number.isFinite(createdAt) && createdAt > now - 15 * 60 * 1000;
    });
    return fresh || candidates[0];
  };

  const pollGenerationJobProgress = async () => {
    if (generationJobPollBusyRef.current) return;
    generationJobPollBusyRef.current = true;
    try {
      const res = await modulesAPI.getGenerationJobs({ limit: 20, scope: 'mine' });
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      const job = chooseLikelyActiveContentJob(items);
      if (!job) return;
      activeGenerationJobIdRef.current = Number(job.id) || activeGenerationJobIdRef.current;
      mapBackendProgressToUi(job?.result?.progress || null);
    } catch (_) {
      // best effort polling only
    } finally {
      generationJobPollBusyRef.current = false;
    }
  };

  const startGenerationJobPoller = () => {
    clearGenerationJobPoller();
    pollGenerationJobProgress();
    generationJobPollTimerRef.current = window.setInterval(() => {
      pollGenerationJobProgress();
    }, 1500);
  };

  const completeGenerationProgress = (success: boolean, message?: string) => {
    clearGenerationProgressTimer();
    clearGenerationJobPoller();
    setGenerationProgress((prev) => ({
      ...prev,
      active: true,
      percent: success ? 100 : Math.max(prev.percent, 12),
      label: success ? 'Done' : 'Generation interrupted',
      detail: message || (success ? 'Your content is ready' : 'Please try again'),
    }));
    generationProgressHideTimerRef.current = window.setTimeout(() => {
      setGenerationProgress({
        active: false,
        task: 'content',
        percent: 0,
        label: '',
        detail: '',
      });
      generationProgressHideTimerRef.current = null;
    }, success ? 900 : 2200);
  };

  useEffect(() => {
    return () => {
      clearGenerationProgressTimer();
      clearGenerationJobPoller();
    };
  }, []);

  const recoverBackgroundContentGeneration = async () => {
    try {
      const res = await modulesAPI.getGenerationJobs({ limit: 40, scope: 'mine' });
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      const jobs = items
        .filter((job: any) => job?.job_type === 'content_generation')
        .sort((a: any, b: any) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
      const latest = jobs[0];
      if (!latest) return;

      if (['scheduled', 'processing', 'retrying'].includes(String(latest.status || ''))) {
        setBackgroundGenerationNotice('A content generation is still running in the background. This page will auto-recover it when it finishes.');
        return;
      }

      if (
        latest.status === 'completed' &&
        latest.result?.content &&
        recoveredContentJobIdRef.current !== Number(latest.id || 0) &&
        (isGenerating || !generatedContent)
      ) {
        const recoveredContent = withGenerationSettings(latest.result.content);
        const recoveredTrace = latest.result?.generation_trace || null;
        recoveredContentJobIdRef.current = Number(latest.id || 0);
        setGeneratedContent(recoveredContent);
        setGenerationTrace(recoveredTrace);
        setActiveSectionIndex(0);
        setStudioStep('polish');
        setIsGenerating(false);
        setError(null);
        setBackgroundGenerationNotice('Recovered your generated content from a background job.');
        completeGenerationProgress(true, 'Recovered generated content from background job');
        await addToHistory(recoveredContent, recoveredTrace);
      }
    } catch (_) {
      // Best-effort recovery only; ignore poll failures.
    }
  };

  useEffect(() => {
    recoverBackgroundContentGeneration();
    const timer = setInterval(() => {
      recoverBackgroundContentGeneration();
    }, 15000);
    return () => clearInterval(timer);
  }, [isGenerating, generatedContent]);

  const loadHistory = async () => {
    try {
      const res = await contentAPI.getHistory();
      if (res.data.success) setHistory(res.data.items || []);
    } catch (_) {
      setHistory([]);
    }
  };

  const buildContentInput = () => ({
    topics: topics.trim(),
    teaching_goal: teachingGoal.trim(),
    section_mode: sectionMode,
    auto_section_suggestion: autoSectionSuggestion,
    auto_section_note: autoSectionNote,
    level,
    num_sections: numSections,
    rubric_id: rubricId,
    template_id: templateId,
    include_diagrams: includeDiagrams,
    include_images: includeImages,
    include_mascot: includeMascot,
    include_video: includeVideo,
    tts_enabled: includeTextToSpeech,
  });

  const normalizeContentForEditor = (content: GeneratedContent): GeneratedContent => ({
    ...content,
    sections: Array.isArray(content.sections)
      ? content.sections.map((sec: any) => {
          const bodyHtml = getSectionBodyHtml(sec);
          const plainBody = richHtmlToPlainText(bodyHtml) || String(sec?.body || '').trim();
          return {
            ...sec,
            body_html: bodyHtml,
            body: plainBody,
          };
        })
      : [],
  });

  const withGenerationSettings = (content: GeneratedContent): GeneratedContent => ({
    ...normalizeContentForEditor(content),
    tts_enabled: content.tts_enabled !== false && includeTextToSpeech,
  });

  const addToHistory = async (content: GeneratedContent, trace: GenerationTrace | null) => {
    try {
      const normalizedContent = withGenerationSettings(content);
      const res = await contentAPI.saveHistory({
        content: normalizedContent,
        input: {
          ...buildContentInput(),
          generation_trace: trace,
        },
      });
      if (res.data?.item?.id) {
        setActiveHistoryId(res.data.item.id);
      }
      await loadHistory();
    } catch (_) {}
  };

  const loadFromHistory = (item: ApiContentHistoryItem) => {
    const input = item.input || {};
    setTopics(input.topics || '');
    setTeachingGoal(input.teaching_goal || '');
    setLevel(normalizeEducationLevelValue(input.level || '', ''));
    setNumSections(Math.max(1, Math.min(SECTION_COUNT_MAX, input.num_sections || 5)));
    setRubricId(input.rubric_id || null);
    setTemplateId(input.template_id || 'classroom');
    setIncludeDiagrams(input.include_diagrams !== false);
    setIncludeImages(input.include_images !== false);
    setIncludeMascot(input.include_mascot !== false);
    setIncludeVideo(!!input.include_video);
    setIncludeTextToSpeech(input.tts_enabled !== false && item.content?.tts_enabled !== false);
    setSectionMode(input.section_mode === 'auto' ? 'auto' : 'manual');
    setAutoSectionSuggestion(Number.isFinite(Number(input.auto_section_suggestion)) ? Number(input.auto_section_suggestion) : null);
    setAutoSectionNote(String(input.auto_section_note || ''));
    setGeneratedContent(normalizeContentForEditor({
      ...item.content,
      tts_enabled: item.content?.tts_enabled !== false && input.tts_enabled !== false,
    }));
    setGenerationTrace(item.generation_trace || input.generation_trace || null);
    setSelectedVisualKey(null);
    setActiveHistoryId(item.id);
    setActivePublishedContentId(null);
    setActivePublishedContentCode(null);
    setPublishedLink(null);
    setStudioStep('polish');
    setActiveSectionIndex(0);
    setError(null);
  };

  const handleEditPublishedContent = async (id: number) => {
    setLoadingPublishedContentId(id);
    setError(null);
    try {
      const res = await contentAPI.getMyItem(id);
      const item = res.data?.item;
      if (!item?.content) {
        throw new Error('Published content could not be loaded');
      }
      setGeneratedContent(normalizeContentForEditor(item.content));
      setSelectedVisualKey(null);
      setRubricId(item.rubric_id ?? null);
      setIncludeTextToSpeech(item.content.tts_enabled !== false);
      setGenerationTrace(null);
      setStudioStep('polish');
      setActiveSectionIndex(0);
      setActivePublishedContentId(item.id);
      setActivePublishedContentCode(item.code);
      setActiveHistoryId(null);
      const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/tools') ? '/tools' : '';
      setPublishedLink(`${window.location.origin}${base}/take-content?code=${item.code}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load published content');
    } finally {
      setLoadingPublishedContentId(null);
    }
  };

  const persistContent = async (content: GeneratedContent, { showSavingState = true } = {}) => {
    if (showSavingState) {
      setIsSavingDraft(true);
    }
    setError(null);
    try {
      const contentToSave = withGenerationSettings(content);
      if (activePublishedContentId) {
        const res = await contentAPI.updateMy(activePublishedContentId, {
          content: contentToSave,
          rubric_id: rubricId ?? null,
        });
        if (res.data?.item?.content) {
          setGeneratedContent(normalizeContentForEditor(res.data.item.content));
          setActivePublishedContentCode(res.data.item.code);
          const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/tools') ? '/tools' : '';
          setPublishedLink(`${window.location.origin}${base}/take-content?code=${res.data.item.code}`);
          await loadMyContent();
          return res.data.item.content as GeneratedContent;
        }
      } else {
        const payload = {
          content: contentToSave,
          input: {
            ...buildContentInput(),
            generation_trace: generationTrace,
          },
        };
        const res = activeHistoryId
          ? await contentAPI.updateHistoryItem(activeHistoryId, payload)
          : await contentAPI.saveHistory(payload);
        if (res.data?.item?.content) {
          setActiveHistoryId(res.data.item.id);
          setGeneratedContent(normalizeContentForEditor(res.data.item.content));
          await loadHistory();
          return res.data.item.content as GeneratedContent;
        }
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || (activePublishedContentId ? 'Failed to save published content' : 'Failed to save content draft'));
    } finally {
      if (showSavingState) {
        setIsSavingDraft(false);
      }
    }
    return null;
  };

  const handleSaveDraft = async () => {
    if (!generatedContent) return;
    await persistContent(generatedContent, { showSavingState: true });
  };

  const removeHistoryItem = async (id: number) => {
    try {
      await contentAPI.deleteHistoryItem(id);
      await loadHistory();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to remove history item');
    }
  };

  const clearHistory = async () => {
    try {
      await contentAPI.clearHistory();
      await loadHistory();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to clear history');
    }
  };

  const migrateLegacyHistory = async () => {
    setError(null);
    setIsMigratingHistory(true);
    try {
      const raw = localStorage.getItem(LEGACY_CONTENT_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const legacyItems = Array.isArray(parsed) ? parsed : [];
      const validItems = legacyItems.filter((item: any) => item && item.content && item.content.title);
      if (validItems.length === 0) {
        setError('No legacy local content history found to migrate.');
        return;
      }

      for (const item of validItems) {
        await contentAPI.saveHistory({
          content: item.content,
          input: {
            topics: item.topics || '',
            level: normalizeEducationLevelValue(item.level || '', ''),
            num_sections: item.num_sections || 5,
            rubric_id: item.rubric_id || null,
            template_id: item.template_id || 'classroom',
            include_diagrams: item.include_diagrams !== false,
            include_images: item.include_images !== false,
            include_mascot: item.include_mascot !== false,
            include_video: !!item.include_video,
            tts_enabled: item.tts_enabled !== false,
          }
        });
      }

      localStorage.removeItem(LEGACY_CONTENT_HISTORY_KEY);
      await loadHistory();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to migrate legacy history');
    } finally {
      setIsMigratingHistory(false);
    }
  };

  const loadRubrics = async () => {
    try {
      const res = await rubricsAPI.getRubrics();
      if (res.data.success) setRubrics(res.data.rubrics || []);
    } catch (_) {}
  };

  const loadMyContent = async () => {
    try {
      const res = await contentAPI.getMy();
      if (res.data.success) setMyContent(res.data.items || []);
    } catch (_) {}
  };

  const loadPlannerJobs = async () => {
    try {
      const res = await contentAPI.getPlannerJobs();
      if (res.data.success) setPlannerJobs(res.data.jobs || []);
    } catch (_) {}
  };
  const loadTemplates = async () => {
    try {
      const res = await contentAPI.getTemplates();
      if (res.data.success) {
        const list = res.data.templates || [];
        setTemplates(list);
        if (list.length > 0 && !list.find((t) => t.id === templateId)) {
          setTemplateId(list[0].id);
        }
      }
    } catch (_) {}
  };

  useEffect(() => {
    const tmpl = templates.find((t) => t.id === templateId);
    setTemplateImages((tmpl?.images || []).map((url) => normalizeSecureMediaUrl(url)));
  }, [templateId, templates]);

  const loadModules = async () => {
    try {
      const res = await modulesAPI.list();
      if (res.data.success && res.data.modules) setModules(res.data.modules);
    } catch (_) {
      setModules([]);
    }
  };

  useEffect(() => {
    const activeJobs = plannerJobs.some((job) => job.status === 'scheduled' || job.status === 'processing');
    if (!activeJobs) return;
    const timer = setInterval(() => {
      loadPlannerJobs();
      loadMyContent();
    }, 15000);
    return () => clearInterval(timer);
  }, [plannerJobs]);

  const handleGenerate = async () => {
    const topicsTrim = topics.trim();
    if (!topicsTrim) {
      setError('Please enter topics to cover.');
      return;
    }
    if (studioStep === 'generate' && !planConfirmed) {
      setError('Please confirm the generation plan before starting.');
      return;
    }
    setError(null);
    setBackgroundGenerationNotice(null);
    setStudioStep('generate');
    setIsGenerating(true);
    setSelectedVisualKey(null);
    setActiveHistoryId(null);
    setActivePublishedContentId(null);
    setActivePublishedContentCode(null);
    setGeneratedContent(null);
    setGenerationTrace(null);
    activeGenerationJobIdRef.current = null;
    startGenerationProgress('content', { includeImages, includeMascot });
    startGenerationJobPoller();
    try {
      let effectiveTemplateId = templateId;
      if (templateFile) {
        updateGenerationProgress(14, 'Uploading template', 'Extracting template assets and theme');
        const uploadRes = await contentAPI.uploadTemplate(templateFile);
        const uploadedId = uploadRes?.data?.template?.id;
        if (uploadedId) {
          effectiveTemplateId = uploadedId;
          setTemplateId(uploadedId);
        }
      }
      updateGenerationProgress(28, 'Generating sections', 'Drafting sections and quiz');
      const generationTopics = teachingGoal.trim()
        ? `${topicsTrim}\n\nTeaching goal: ${teachingGoal.trim()}`
        : topicsTrim;
      const res = await contentAPI.generate({
        topics: generationTopics,
        level: level || undefined,
        num_sections: numSections,
        rubric_id: rubricId || undefined,
        template_id: effectiveTemplateId || undefined,
        include_diagrams: includeDiagrams,
        include_images: includeImages,
        include_mascot: includeMascot,
      });
      if (Number.isFinite(Number(res.data?.generation_job_id))) {
        activeGenerationJobIdRef.current = Number(res.data?.generation_job_id);
      }
      if (res.data.success && res.data.content) {
        updateGenerationProgress(92, 'Finalizing response', 'Preparing editor preview');
        const contentWithSettings = withGenerationSettings(res.data.content);
        const trace = res.data.generation_trace || null;
        setGenerationTrace(trace);
        setGeneratedContent(contentWithSettings);
        setActiveSectionIndex(0);
        setStudioStep('polish');
        await addToHistory(contentWithSettings, trace);
        completeGenerationProgress(true, 'Content generated successfully');
      } else {
        setError('Failed to generate content');
        completeGenerationProgress(false, 'Generation did not return content');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to generate content');
      completeGenerationProgress(false, e.response?.data?.error || e.message || 'Failed to generate content');
    } finally {
      clearGenerationJobPoller();
      setIsGenerating(false);
    }
  };

  const handleTopicsFileSelected = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setIsUploadingTopicsFile(true);
    try {
      const res = await contentAPI.uploadTopicsFile(file);
      const parsedTopics = String(res.data?.topics || '').trim();
      if (!parsedTopics) {
        setError('No readable topics were extracted from the uploaded file.');
        return;
      }
      setTopics(parsedTopics);
      const suggestedSections = Number(res.data?.suggested_sections || 0);
      if (Number.isFinite(suggestedSections) && suggestedSections > 0) {
        const clamped = Math.max(1, Math.min(SECTION_COUNT_MAX, suggestedSections));
        setAutoSectionSuggestion(clamped);
        const method = String(res.data?.inference_method || '').trim();
        const confidence = String(res.data?.confidence || '').trim();
        const prefix = method
          ? `${method.toUpperCase()}${confidence ? ` (${confidence})` : ''}: `
          : '';
        setAutoSectionNote(`${prefix}${String(res.data?.inference_note || '')}`.trim());
        if (sectionMode === 'auto') {
          setNumSections(clamped);
        }
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to extract topics from uploaded file');
    } finally {
      setIsUploadingTopicsFile(false);
      if (topicsFileInputRef.current) {
        topicsFileInputRef.current.value = '';
      }
    }
  };

  const handleExport = async (type: 'pptx' | 'lecture-notes') => {
    if (!generatedContent) return;
    setExporting(type);
    setError(null);
    try {
      const api = type === 'pptx' ? contentAPI.exportPptx : contentAPI.exportLectureNotes;
      const res = await api(generatedContent);
      const blob = res.data as Blob;
      const ext = type === 'pptx' ? 'pptx' : 'html';
      const filename = `${(generatedContent.title || 'content').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || `Failed to export ${type}`);
    } finally {
      setExporting(null);
    }
  };

  const handlePublish = async (withVideo: boolean) => {
    if (!generatedContent) return;
    setError(null);
    try {
      if (activePublishedContentId) {
        const res = await contentAPI.updateMy(activePublishedContentId, {
          content: withGenerationSettings(generatedContent),
          rubric_id: rubricId ?? null,
        });
        if (res.data?.item?.content) {
          setGeneratedContent(normalizeContentForEditor(res.data.item.content));
          setActivePublishedContentCode(res.data.item.code);
          const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/tools') ? '/tools' : '';
          setPublishedLink(`${window.location.origin}${base}/take-content?code=${res.data.item.code}`);
          await loadMyContent();
        }
        return;
      }

      const payload: { content: GeneratedContent; rubric_id?: number; include_video?: boolean; module_id?: number; module_name?: string } = {
        content: withGenerationSettings(generatedContent),
        rubric_id: rubricId || undefined,
        include_video: withVideo,
      };
      if (newModuleName.trim()) {
        payload.module_name = newModuleName.trim();
      } else if (selectedModuleId) {
        payload.module_id = selectedModuleId;
      }
      const res = await contentAPI.publish(payload);
      if (res.data.success && res.data.code) {
        const link = res.data.link;
        const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/tools') ? '/tools' : '';
        setPublishedLink(link && link.startsWith('http') ? link : `${window.location.origin}${base}/take-content?code=${res.data.code}`);
        loadMyContent();
        loadModules();
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to publish');
    }
  };

  const handleExportScorm = async () => {
    if (!generatedContent) return;
    setExporting('scorm');
    setError(null);
    try {
      const res = await contentAPI.exportScorm(generatedContent);
      const blob = res.data as Blob;
      const filename = `${(generatedContent.title || 'content').replace(/[^a-z0-9]/gi, '_').toLowerCase()}_scorm.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to export SCORM');
    } finally {
      setExporting(null);
    }
  };

  const updateGeneratedContent = (updater: (current: GeneratedContent) => GeneratedContent) => {
    setGeneratedContent((prev) => (prev ? updater(prev) : prev));
  };

  const updateSectionField = (sectionIndex: number, field: 'heading' | 'support' | 'body', value: string) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
      const nextSection = { ...section, [field]: value } as any;
      if (field === 'body') {
        nextSection.body_html = sanitizeRichTextHtml(String((section as any).body_html || ''));
      }
      const visuals = Array.isArray((section as any).visuals) ? [...(section as any).visuals] : [];
      nextSection.visuals = visuals.map((visual: any) =>
        shouldAutoSyncVisualPrompt(visual, section)
          ? { ...visual, prompt: buildVisualPromptFromContext(visual, nextSection) }
          : visual
      );
      sections[sectionIndex] = nextSection;
      return { ...current, sections };
    });
  };

  const addSection = () => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      sections.push({
        heading: `New section ${sections.length + 1}`,
        support: '',
        body: '',
        visuals: [],
      } as any);
      return { ...current, sections };
    });
  };

  const removeSection = (sectionIndex: number) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      sections.splice(sectionIndex, 1);
      return { ...current, sections };
    });
  };

  const setSectionBackground = (sectionIndex: number, url: string) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
      sections[sectionIndex] = {
        ...section,
        background_image_url: String(url || '').trim(),
      };
      return { ...current, sections };
    });
  };

  const updateSectionBodyRich = (sectionIndex: number, html: string) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
      const safeHtml = sanitizeRichTextHtml(html);
      const plainBody = richHtmlToPlainText(safeHtml);
      const nextSection = {
        ...section,
        body: plainBody,
        body_html: safeHtml,
      } as any;
      const visuals = Array.isArray((section as any).visuals) ? [...(section as any).visuals] : [];
      nextSection.visuals = visuals.map((visual: any) =>
        shouldAutoSyncVisualPrompt(visual, section)
          ? { ...visual, prompt: buildVisualPromptFromContext(visual, nextSection) }
          : visual
      );
      sections[sectionIndex] = nextSection;
      return { ...current, sections };
    });
  };

  const updateSectionTextLayoutMode = (sectionIndex: number, mode: ContextualBlockLayout) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
      sections[sectionIndex] = {
        ...section,
        text_layout_mode: mode,
      } as any;
      return { ...current, sections };
    });
  };

  const applyContextualLayoutToEditor = (sectionIndex: number) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex];
      if (!section) return current;
      const mode = String((section as any).text_layout_mode || 'auto') as ContextualBlockLayout;
      const contextualHtml = buildContextualSectionBodyHtml(section, mode);
      sections[sectionIndex] = {
        ...section,
        body_html: contextualHtml,
        body: richHtmlToPlainText(contextualHtml),
      } as any;
      return { ...current, sections };
    });
  };

  const getSectionDisplayHtml = (section: any) => {
    const mode = String(section?.text_layout_mode || 'auto') as ContextualBlockLayout;
    if (mode === 'plain') return getSectionBodyHtml(section);
    return buildContextualSectionBodyHtml(section, mode);
  };

  const getSectionEditorHtml = (section: any) => {
    const rich = getSectionBodyHtml(section);
    if (String(rich || '').trim()) return rich;
    return getSectionDisplayHtml(section);
  };

  const uploadSectionBackground = (sectionIndex: number, file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      setSectionBackground(sectionIndex, dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const addCustomVisual = (sectionIndex: number, kind: 'illustration' | 'image') => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
      const visuals = Array.isArray((section as any).visuals) ? [...(section as any).visuals] : [];
      const newVisual = kind === 'illustration'
        ? {
            kind: 'illustration',
            title: 'Custom diagram',
            alt_text: 'Custom diagram',
            prompt: '',
            image_url: '',
          }
        : {
            kind: 'image',
            title: 'Custom image',
            alt_text: 'Custom image',
            prompt: '',
            image_url: '',
          };
      visuals.push({
        ...newVisual,
        prompt: buildVisualPromptFromContext(newVisual, section),
      });
      sections[sectionIndex] = { ...section, visuals };
      return { ...current, sections };
    });
  };

  const updateVisualField = (sectionIndex: number, visualIndex: number, field: string, value: string) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
      const visuals = Array.isArray((section as any).visuals) ? [...(section as any).visuals] : [];
      const visual = visuals[visualIndex] || {};
      const nextVisual = { ...visual, [field]: value };
      visuals[visualIndex] =
        field === 'prompt' || !shouldAutoSyncVisualPrompt(visual, section)
          ? nextVisual
          : { ...nextVisual, prompt: buildVisualPromptFromContext(nextVisual, section) };
      sections[sectionIndex] = { ...section, visuals };
      return { ...current, sections };
    });
  };

  const refreshVisualPrompt = (sectionIndex: number, visualIndex: number) => {
    if (!generatedContent) return;
    const section = generatedContent.sections?.[sectionIndex];
    const visual = section?.visuals?.[visualIndex];
    if (!section || !visual) return;
    updateVisualField(sectionIndex, visualIndex, 'prompt', buildVisualPromptFromContext(visual, section));
  };

  const removeVisual = (sectionIndex: number, visualIndex: number) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
      const visuals = Array.isArray((section as any).visuals) ? [...(section as any).visuals] : [];
      visuals.splice(visualIndex, 1);
      sections[sectionIndex] = { ...section, visuals };
      return { ...current, sections };
    });
  };

  const uploadVisualImage = (sectionIndex: number, visualIndex: number, file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      updateVisualField(sectionIndex, visualIndex, 'image_url', dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const updateMascotField = (sectionIndex: number, field: string, value: string) => {
    updateGeneratedContent((current) => {
      const sections = Array.isArray(current.sections) ? [...current.sections] : [];
      const section = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
      const mascot = { ...(section as any).mascot, [field]: value };
      sections[sectionIndex] = { ...section, mascot };
      return { ...current, sections };
    });
  };

  const uploadMascotImage = (sectionIndex: number, file: File | null) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl) return;
      updateMascotField(sectionIndex, 'image_url', dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const handleRegenerateMascot = async (sectionIndex: number) => {
    if (!generatedContent) return;
    const section = generatedContent.sections?.[sectionIndex];
    if (!section) return;
    const mascot = {
      title: String((section as any)?.mascot?.title || `Mascot for ${section.heading || section.title || `Section ${sectionIndex + 1}`}`).trim(),
      alt_text: String((section as any)?.mascot?.alt_text || 'Playful educational mascot').trim(),
      prompt: String((section as any)?.mascot?.prompt || '').trim(),
      image_url: String((section as any)?.mascot?.image_url || '').trim(),
    };
    const key = `mascot:${sectionIndex}`;
    setRegeneratingVisualKey(key);
    setError(null);
    startGenerationProgress('mascot');
    try {
      const res = await contentAPI.regenerateMascot({
        mascot,
        content_title: generatedContent.title || '',
        section_heading: section.heading || section.title || '',
        section_body: section.body || '',
      });
      if (res.data?.success && res.data.mascot) {
        updateGenerationProgress(90, 'Finalizing mascot', 'Refreshing section preview');
        const nextContent = (() => {
          const sections = Array.isArray(generatedContent.sections) ? [...generatedContent.sections] : [];
          const currentSection = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
          sections[sectionIndex] = { ...currentSection, mascot: { ...(currentSection as any).mascot, ...res.data.mascot } };
          return { ...generatedContent, sections };
        })();
        await persistContent(nextContent, { showSavingState: false });
        completeGenerationProgress(true, 'Mascot regenerated');
      } else {
        setError('Grok did not return a replacement mascot.');
        completeGenerationProgress(false, 'No mascot image was returned');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to regenerate mascot with Grok');
      completeGenerationProgress(false, e.response?.data?.error || e.message || 'Failed to regenerate mascot');
    } finally {
      setRegeneratingVisualKey(null);
    }
  };

  const handleRegenerateVisual = async (sectionIndex: number, visualIndex: number) => {
    if (!generatedContent) return;
    const section = generatedContent.sections?.[sectionIndex];
    const visual = section?.visuals?.[visualIndex];
    const canRegenerate = !!section && !!visual && hasVisualSource(visual);
    if (!canRegenerate) return;

    const key = `${sectionIndex}:${visualIndex}`;
    setRegeneratingVisualKey(key);
    setError(null);
    startGenerationProgress('visual');
    try {
      const res = await contentAPI.regenerateVisual({
        visual,
        content_title: generatedContent.title || '',
        section_heading: section.heading || section.title || '',
        section_body: section.body || '',
      });
      if (res.data?.success && res.data.visual) {
        updateGenerationProgress(90, 'Finalizing visual', 'Refreshing section preview');
        const nextContent = (() => {
          const sections = Array.isArray(generatedContent.sections) ? [...generatedContent.sections] : [];
          const currentSection = sections[sectionIndex] || { heading: '', support: '', body: '', visuals: [] };
          const visuals = Array.isArray((currentSection as any).visuals) ? [...(currentSection as any).visuals] : [];
          visuals[visualIndex] = { ...visuals[visualIndex], ...res.data.visual };
          sections[sectionIndex] = { ...currentSection, visuals };
          return { ...generatedContent, sections };
        })();
        await persistContent(nextContent, { showSavingState: false });
        setSelectedVisualKey(key);
        completeGenerationProgress(true, 'Visual regenerated');
      } else {
        setError('Grok did not return a replacement visual.');
        completeGenerationProgress(false, 'No visual image was returned');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to regenerate visual with Grok');
      completeGenerationProgress(false, e.response?.data?.error || e.message || 'Failed to regenerate visual');
    } finally {
      setRegeneratingVisualKey(null);
    }
  };

  const handleSchedulePlanner = async () => {
    const topicsTrim = topics.trim();
    if (!topicsTrim) {
      setError('Please enter topics to cover before scheduling.');
      return;
    }
    if (!scheduledFor) {
      setError('Please choose a planner date and time.');
      return;
    }
    setError(null);
    setIsScheduling(true);
    try {
      const scheduledIso = new Date(scheduledFor).toISOString();
      const scheduledTopics = teachingGoal.trim()
        ? `${topicsTrim}\n\nTeaching goal: ${teachingGoal.trim()}`
        : topicsTrim;
      await contentAPI.schedulePlanner({
        topics: scheduledTopics,
        level: level || undefined,
        num_sections: numSections,
        rubric_id: rubricId || undefined,
        template_id: templateId || undefined,
        scheduled_for: scheduledIso,
        include_diagrams: includeDiagrams,
        include_images: includeImages,
        include_mascot: includeMascot,
      });
      await loadPlannerJobs();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to schedule planner content');
    } finally {
      setIsScheduling(false);
    }
  };

  const handleCancelPlannerJob = async (id: number) => {
    setCancellingPlannerJobId(id);
    setError(null);
    try {
      await contentAPI.cancelPlannerJob(id);
      await loadPlannerJobs();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to cancel planner job');
    } finally {
      setCancellingPlannerJobId(null);
    }
  };

  const handleDeleteContent = async (id: number, title: string) => {
    if (!window.confirm(`Delete published content "${title || id}"? This cannot be undone.`)) return;
    setDeletingContentId(id);
    setError(null);
    try {
      await contentAPI.deleteMy(id);
      await loadMyContent();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to delete content');
    } finally {
      setDeletingContentId(null);
    }
  };

  const basePath = typeof window !== 'undefined' && window.location.pathname.startsWith('/tools') ? '/tools' : '';
  const selectedVisualLocation = useMemo(() => {
    if (!selectedVisualKey || !generatedContent?.sections) return null;
    const [sectionPart, visualPart] = selectedVisualKey.split(':');
    const sectionIndex = Number(sectionPart);
    const visualIndex = Number(visualPart);
    if (!Number.isFinite(sectionIndex) || !Number.isFinite(visualIndex)) return null;
    const section = generatedContent.sections[sectionIndex];
    const visual = section?.visuals?.[visualIndex];
    if (!section || !visual) return null;
    return { sectionIndex, visualIndex, section, visual };
  }, [generatedContent?.sections, selectedVisualKey]);

  const handleDropOnVisual = (sectionIndex: number, visualIndex: number, e: React.DragEvent) => {
    e.preventDefault();
    const url = e.dataTransfer.getData('text/plain');
    if (url) updateVisualField(sectionIndex, visualIndex, 'image_url', url);
    setDragOverKey(null);
  };

  const handleDropOnSection = (sectionIndex: number, e: React.DragEvent) => {
    e.preventDefault();
    const url = e.dataTransfer.getData('text/plain');
    if (!url) return;
    setDragOverKey(null);
    updateGeneratedContent((c) => {
      const sections = [...(c.sections || [])];
      const visuals = [...(sections[sectionIndex]?.visuals || []), {
        kind: 'image',
        title: 'Template image',
        alt_text: '',
        prompt: '',
        image_url: url,
      }];
      sections[sectionIndex] = { ...sections[sectionIndex], visuals };
      return { ...c, sections };
    });
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <Presentation className="w-8 h-8 text-teal-600" />
          <h1 className="text-3xl font-bold text-gray-800">Lesson Generator</h1>
        </div>
        <p className="text-gray-600 mb-6">
          Create course content from topics: slide decks, lecture notes, and an interactive student view. Optionally add AI-generated video and upload a PowerPoint template for slides.
        </p>
        <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {[
              { id: 'plan' as const, label: '1. Plan', note: 'Set goals, level, and outline' },
              { id: 'generate' as const, label: '2. Generate', note: 'Run AI generation in phases' },
              { id: 'polish' as const, label: '3. Polish', note: 'Edit sections and quality-check' },
            ].map((step) => (
              <button
                key={step.id}
                type="button"
                onClick={() => setStudioStep(step.id)}
                className={`text-left rounded-lg border px-3 py-2 transition ${
                  studioStep === step.id
                    ? 'border-teal-400 bg-white shadow-sm'
                    : 'border-slate-200 bg-white/60 hover:bg-white'
                }`}
              >
                <div className="text-sm font-semibold text-slate-800">{step.label}</div>
                <div className="text-xs text-slate-500">{step.note}</div>
              </button>
            ))}
          </div>
        </div>

        <details className="mb-6 bg-teal-50 border border-teal-200 rounded-lg overflow-hidden" open={myContent.length > 0}>
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-teal-900">
            My published content links ({myContent.length})
          </summary>
          <div className="px-4 pb-4">
            {myContent.length === 0 ? (
              <p className="text-sm text-teal-900">No published content yet.</p>
            ) : (
              <ul className="space-y-2">
                {myContent.map((item) => {
                  const link = `${typeof window !== 'undefined' ? window.location.origin : ''}${basePath}/take-content?code=${item.code}`;
                  return (
                    <li key={item.id} className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-gray-700 truncate max-w-[200px]" title={item.title}>{item.title || item.code}</span>
                      <input readOnly value={link} className="flex-1 min-w-[180px] px-2 py-1 border border-gray-300 rounded text-sm bg-white" />
                      <button
                        type="button"
                        onClick={() => navigator.clipboard.writeText(link)}
                        className="px-2 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700"
                      >
                        Copy link
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEditPublishedContent(item.id)}
                        disabled={loadingPublishedContentId === item.id}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-slate-700 text-white rounded hover:bg-slate-800 disabled:opacity-50"
                      >
                        {loadingPublishedContentId === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteContent(item.id, item.title)}
                        disabled={deletingContentId === item.id}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                        title="Delete published content"
                      >
                        {deletingContentId === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        Delete
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>

        <details className="mb-6 bg-amber-50 border border-amber-200 rounded-lg overflow-hidden" open={history.length > 0}>
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-amber-900 inline-flex items-center gap-2">
            <History className="w-4 h-4" />
            Content generator history ({history.length})
          </summary>
          <div className="px-4 pb-4">
            <div className="flex items-center gap-2 mb-3">
              <button
                type="button"
                onClick={migrateLegacyHistory}
                disabled={isMigratingHistory}
                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {isMigratingHistory ? 'Migrating...' : 'Migrate local history'}
              </button>
              <button
                type="button"
                onClick={clearHistory}
                disabled={history.length === 0}
                className="px-2 py-1 text-xs bg-gray-700 text-white rounded hover:bg-gray-800 disabled:opacity-50"
              >
                Clear all
              </button>
            </div>
            {history.length === 0 ? (
              <p className="text-sm text-amber-900">No history yet. Generate content and it will appear here.</p>
            ) : (
              <ul className="space-y-2">
                {history.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 flex-wrap text-sm text-gray-700 bg-white border border-amber-100 rounded p-2">
                    <span className="font-medium truncate max-w-[260px]" title={item.content?.title || ''}>
                      {item.content?.title || item.title || 'Untitled content'}
                    </span>
                    {(item.generation_trace || item.input?.generation_trace) && (
                      <span className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-100 rounded px-2 py-0.5">
                        Prompt v{(item.generation_trace || item.input?.generation_trace)?.prompt_version ?? '?'} / {(item.generation_trace || item.input?.generation_trace)?.model || 'unknown model'}
                      </span>
                    )}
                    <span className="text-xs text-gray-500">{new Date(item.created_at).toLocaleString()}</span>
                    <button
                      type="button"
                      onClick={() => loadFromHistory(item)}
                      className="px-2 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700"
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      onClick={() => removeHistoryItem(item.id)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>

        {plannerJobs.length > 0 && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h3 className="text-sm font-semibold text-blue-900 mb-2">Planner queue</h3>
            <ul className="space-y-2">
              {plannerJobs.map((job) => {
                const link = job.published_code
                  ? `${typeof window !== 'undefined' ? window.location.origin : ''}${basePath}/take-content?code=${job.published_code}`
                  : null;
                const statusColor =
                  job.status === 'completed' ? 'text-green-700' :
                  job.status === 'failed' ? 'text-red-700' :
                  job.status === 'cancelled' ? 'text-gray-700' :
                  'text-blue-700';
                return (
                  <li key={job.id} className="text-sm text-gray-700 border border-blue-100 rounded p-2 bg-white">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="font-medium truncate max-w-[380px]" title={job.topics}>{job.topics}</span>
                      <span className={`text-xs font-semibold uppercase ${statusColor}`}>{job.status}</span>
                    </div>
                    <div className="text-xs text-gray-600 mt-1">
                      Planned for: {new Date(job.scheduled_for).toLocaleString()}
                    </div>
                    {job.error_message && <div className="text-xs text-red-700 mt-1">{job.error_message}</div>}
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      {link && (
                        <>
                          <input readOnly value={link} className="flex-1 min-w-[180px] px-2 py-1 border border-gray-300 rounded text-xs bg-white" />
                          <button
                            type="button"
                            onClick={() => navigator.clipboard.writeText(link)}
                            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                          >
                            Copy link
                          </button>
                        </>
                      )}
                      {job.status === 'scheduled' && (
                        <button
                          type="button"
                          onClick={() => handleCancelPlannerJob(job.id)}
                          disabled={cancellingPlannerJobId === job.id}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-gray-700 text-white rounded hover:bg-gray-800 disabled:opacity-50"
                        >
                          {cancellingPlannerJobId === job.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Cancel'}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}
        {backgroundGenerationNotice && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">{backgroundGenerationNotice}</div>
        )}

        <div className="space-y-4">
          <div className={studioStep === 'plan' ? '' : 'hidden'}>
            <div className="mb-2 flex items-center justify-between gap-2 flex-wrap">
              <label className="block text-sm font-medium text-gray-700">Topics to cover *</label>
              <input
                ref={topicsFileInputRef}
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
                onChange={(e) => handleTopicsFileSelected(e.target.files?.[0] || null)}
              />
              <button
                type="button"
                onClick={() => topicsFileInputRef.current?.click()}
                disabled={isUploadingTopicsFile}
                className="inline-flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                title="Upload a PDF or DOCX file with topic lists"
              >
                {isUploadingTopicsFile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {isUploadingTopicsFile ? 'Extracting topics...' : 'Upload topic list (PDF/DOCX)'}
              </button>
            </div>
            <textarea
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="e.g. Photosynthesis, Cell division, Genetics..."
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
            />
          </div>
          <div className={studioStep === 'plan' ? '' : 'hidden'}>
            <label className="block text-sm font-medium text-gray-700 mb-2">Teaching goal</label>
            <input
              value={teachingGoal}
              onChange={(e) => setTeachingGoal(e.target.value)}
              placeholder="e.g. exam readiness, conceptual mastery, discussion prep, project readiness"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
            />
          </div>
          {studioStep === 'plan' && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Planned Outline</div>
              <ol className="list-decimal list-inside text-sm text-slate-700 space-y-1">
                {planOutline.map((item, idx) => (
                  <li key={`${item}-${idx}`}>{item}</li>
                ))}
              </ol>
            </div>
          )}
          <div className={`grid grid-cols-1 md:grid-cols-2 gap-4 ${studioStep === 'plan' ? '' : 'hidden'}`}>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Level</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
              >
                {EDUCATION_LEVEL_OPTIONS.map((o) => (
                  <option key={o.value || 'any'} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Number of sections</label>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSectionMode('manual')}
                    className={`px-3 py-1.5 text-xs rounded border ${sectionMode === 'manual' ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-slate-700 border-slate-300'}`}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSectionMode('auto');
                      if (autoSectionSuggestion) setNumSections(autoSectionSuggestion);
                    }}
                    className={`px-3 py-1.5 text-xs rounded border ${sectionMode === 'auto' ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-slate-700 border-slate-300'}`}
                  >
                    Auto from upload
                  </button>
                </div>
                <input
                  type="number"
                  min={1}
                  max={SECTION_COUNT_MAX}
                  value={numSections}
                  onChange={(e) => {
                    const value = parseInt(e.target.value, 10) || 5;
                    setNumSections(Math.max(1, Math.min(SECTION_COUNT_MAX, value)));
                  }}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                />
                {sectionMode === 'auto' && (
                  <p className="text-xs text-slate-600">
                    {autoSectionSuggestion
                      ? `Auto suggestion: ${autoSectionSuggestion} sections. ${autoSectionNote || ''}`
                      : 'Upload a PDF/DOCX topic list to detect suggested section count.'}
                  </p>
                )}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Template / theme</label>
              <div className="flex gap-2 items-center">
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
                >
                  {(templates.length > 0 ? templates : [{ id: 'classroom', name: 'Classroom Fresh', theme: {} }]).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pptx"
                  className="hidden"
                  onChange={(e) => setTemplateFile(e.target.files?.[0] || null)}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white hover:bg-gray-50 whitespace-nowrap"
                  title="Upload a .pptx file to use its theme and images"
                >
                  <Upload className="w-4 h-4" />
                  Upload .pptx
                </button>
              </div>
              {templateFile && (
                <div className="mt-1 flex items-center gap-1 text-sm text-gray-600">
                  <span className="truncate max-w-[260px]">{templateFile.name}</span>
                  <button type="button" onClick={() => setTemplateFile(null)} className="text-red-500 hover:text-red-700"><X className="w-4 h-4" /></button>
                </div>
              )}
            </div>
          </div>
          <div className={studioStep === 'plan' ? '' : 'hidden'}>
            <label className="block text-sm font-medium text-gray-700 mb-2">Rubric / memo (optional)</label>
            <select
              value={rubricId ?? ''}
              onChange={(e) => setRubricId(e.target.value ? Number(e.target.value) : null)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
            >
              <option value="">None</option>
              {rubrics.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className={`flex flex-wrap gap-4 items-center ${studioStep === 'plan' ? '' : 'hidden'}`}>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeDiagrams}
                onChange={(e) => setIncludeDiagrams(e.target.checked)}
                className="w-4 h-4 text-teal-600 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Include charts/diagrams <span className="text-gray-400 text-xs">(AI-generated)</span></span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeImages}
                onChange={(e) => setIncludeImages(e.target.checked)}
                className="w-4 h-4 text-teal-600 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Include images <span className="text-gray-400 text-xs">(AI-generated, adds time)</span></span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeMascot}
                onChange={(e) => setIncludeMascot(e.target.checked)}
                className="w-4 h-4 text-teal-600 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Generate mascots per section <span className="text-gray-400 text-xs">(AI-generated)</span></span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeVideo}
                onChange={(e) => setIncludeVideo(e.target.checked)}
                className="w-4 h-4 text-teal-600 border-gray-300 rounded"
              />
              <Video className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-700">Include AI video (Sora) when publishing</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeTextToSpeech}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setIncludeTextToSpeech(enabled);
                  setGeneratedContent((prev) => (prev ? { ...prev, tts_enabled: enabled } : prev));
                }}
                className="w-4 h-4 text-teal-600 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Enable text-to-speech for students</span>
            </label>
          </div>
          {studioStep === 'plan' && (
            <div className="flex flex-wrap items-end gap-3">
              <button
                type="button"
                onClick={() => setStudioStep('generate')}
                className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-900"
              >
                Continue to Generate
              </button>
            </div>
          )}

          {studioStep === 'generate' && (
            <div className="space-y-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <div className="font-semibold text-slate-800 mb-1">Generation Summary</div>
                <div>Level: {level || 'Any'} | Sections: {numSections} ({sectionMode}) | Template: {templateId || 'classroom'}</div>
                <div>Teaching goal: {teachingGoal || 'Not specified'}</div>
                {sectionMode === 'auto' && autoSectionSuggestion ? (
                  <div className="text-xs text-slate-600 mt-1">Detected from file: {autoSectionSuggestion} sections. You can edit below.</div>
                ) : null}
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Confirm before generation</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <label className="text-sm text-slate-700">
                    Final section count
                    <input
                      type="number"
                      min={1}
                      max={SECTION_COUNT_MAX}
                      value={numSections}
                      onChange={(e) => {
                        const value = parseInt(e.target.value, 10) || 5;
                        setNumSections(Math.max(1, Math.min(SECTION_COUNT_MAX, value)));
                      }}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500 text-sm"
                    />
                  </label>
                  <label className="md:col-span-2 flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={planConfirmed}
                      onChange={(e) => setPlanConfirmed(e.target.checked)}
                      className="w-4 h-4 text-teal-600 border-gray-300 rounded"
                    />
                    I confirm these settings and want to start generation now.
                  </label>
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating || !planConfirmed}
                  className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
                >
                  {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                  Generate content
                </button>
                <button
                  type="button"
                  onClick={() => setStudioStep('plan')}
                  className="px-3 py-2 border border-slate-300 bg-white text-slate-700 rounded-lg hover:bg-slate-100"
                >
                  Back to Plan
                </button>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-700">Planner time</label>
                  <input
                    type="datetime-local"
                    value={scheduledFor}
                    onChange={(e) => setScheduledFor(e.target.value)}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                  />
                </div>
                <button
                  onClick={handleSchedulePlanner}
                  disabled={isScheduling}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {isScheduling ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarClock className="w-4 h-4" />}
                  Schedule planner generation
                </button>
              </div>
            </div>
          )}

          {studioStep === 'polish' && (
            <div className="flex flex-wrap items-end gap-3">
              <button
                type="button"
                onClick={() => setStudioStep('plan')}
                className="px-3 py-2 border border-slate-300 bg-white text-slate-700 rounded-lg hover:bg-slate-100"
              >
                Back to Plan
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isGenerating}
                className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
              >
                {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                Regenerate from current plan
              </button>
            </div>
          )}
          {generationProgress.active && (
            <div className="rounded-lg border border-teal-100 bg-teal-50 px-3 py-3">
              <div className="mb-1 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-wide text-teal-800">
                <span>{generationProgress.label}</span>
                <span>{Math.round(generationProgress.percent)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-teal-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-teal-500 to-cyan-500 transition-all duration-700 ease-out"
                  style={{ width: `${Math.max(0, Math.min(100, generationProgress.percent))}%` }}
                />
              </div>
              {generationProgress.detail && (
                <p className="mt-2 text-xs text-teal-900/80">{generationProgress.detail}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {generatedContent && studioStep === 'polish' && (
        <div className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="flex-1 min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-lg md:p-6">
          <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Edit and preview content</h2>
                <p className="mt-1 text-sm text-slate-600">Refine this version before students see it.</p>
              </div>
              <span className="rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700">
                {generatedContent.sections?.length || 0} sections
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleSaveDraft}
                disabled={isSavingDraft}
                className="flex items-center gap-2 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
              >
                {isSavingDraft ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                {activePublishedContentId ? 'Save published content' : activeHistoryId ? 'Save changes' : 'Save draft'}
              </button>
              <button
                onClick={() => handleExport('pptx')}
                disabled={!!exporting}
                className="flex items-center gap-2 px-3 py-2 border border-slate-300 bg-white text-slate-700 rounded-lg hover:bg-slate-100 disabled:opacity-50"
              >
                {exporting === 'pptx' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Presentation className="w-4 h-4" />}
                Download PPTX
              </button>
              <button
                onClick={() => handleExport('lecture-notes')}
                disabled={!!exporting}
                className="flex items-center gap-2 px-3 py-2 border border-slate-300 bg-white text-slate-700 rounded-lg hover:bg-slate-100 disabled:opacity-50"
              >
                {exporting === 'lecture-notes' ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookOpen className="w-4 h-4" />}
                Lecture notes
              </button>
              <button
                onClick={handleExportScorm}
                disabled={!!exporting}
                className="flex items-center gap-2 px-3 py-2 border border-slate-300 bg-white text-slate-700 rounded-lg hover:bg-slate-100 disabled:opacity-50"
              >
                {exporting === 'scorm' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Presentation className="w-4 h-4" />}
                SCORM package
              </button>
              <button
                onClick={() => handlePublish(false)}
                className="flex items-center gap-2 px-3 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
              >
                <Link2 className="w-4 h-4" />
                {activePublishedContentId ? 'Update student version' : 'Publish for students'}
              </button>
              <button
                onClick={() => handlePublish(true)}
                className="flex items-center gap-2 px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                <Video className="w-4 h-4" />
                {activePublishedContentId ? 'Update with video kept' : 'Publish with video'}
              </button>
            </div>
          </div>
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Module folder</label>
                <select
                  value={selectedModuleId ?? ''}
                  onChange={(e) => setSelectedModuleId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                >
                  <option value="">Do not assign</option>
                  {modules.map((module) => (
                    <option key={module.id} value={module.id}>{module.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Create new module folder</label>
                <input
                  value={newModuleName}
                  onChange={(e) => setNewModuleName(e.target.value)}
                  placeholder="New module name"
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                />
              </div>
            </div>
          </div>
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 grid grid-cols-1 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Title</label>
              <input
                value={generatedContent.title || ''}
                onChange={(e) => updateGeneratedContent((current) => ({ ...current, title: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Instructions</label>
              <textarea
                value={generatedContent.instructions || ''}
                onChange={(e) => updateGeneratedContent((current) => ({ ...current, instructions: e.target.value }))}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              />
            </div>
            <div>
              <button
                type="button"
                onClick={addSection}
                className="px-3 py-2 text-xs bg-teal-600 text-white rounded hover:bg-teal-700"
              >
                Add section
              </button>
            </div>
          </div>
          {publishedLink && (
            <div className="mb-4 p-4 bg-violet-50 border border-violet-200 rounded-lg">
              <div className="font-semibold text-violet-900 mb-1">Student link</div>
              <div className="flex gap-2 flex-wrap">
                <input readOnly value={publishedLink} className="flex-1 min-w-[200px] px-3 py-2 border border-violet-300 rounded bg-white text-sm" />
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(publishedLink)}
                  className="px-3 py-2 bg-violet-600 text-white rounded text-sm hover:bg-violet-700"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
          {generatedContent.instructions && (
            <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm text-gray-700">{generatedContent.instructions}</div>
          )}
          {selectedVisualLocation && (
            <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-emerald-900">
                Selected figure: <span className="font-semibold">{selectedVisualLocation.visual.title || `Section ${selectedVisualLocation.sectionIndex + 1} visual ${selectedVisualLocation.visualIndex + 1}`}</span>
              </div>
              <button
                type="button"
                onClick={() => handleRegenerateVisual(selectedVisualLocation.sectionIndex, selectedVisualLocation.visualIndex)}
                disabled={regeneratingVisualKey === selectedVisualKey}
                className="px-3 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 text-sm"
              >
                {regeneratingVisualKey === selectedVisualKey ? 'Regenerating selected figure...' : 'Regenerate selected figure'}
              </button>
            </div>
          )}
          {activePublishedContentId && (
            <div className="mb-4 p-3 bg-teal-50 border border-teal-200 rounded-lg text-sm text-teal-800">
              Editing published content{activePublishedContentCode ? ` (${activePublishedContentCode})` : ''}. Use `Save published content` to update the existing student-facing item.
            </div>
          )}
          <div className="mb-4 text-xs text-gray-600">
            Text-to-speech status: <span className={`font-semibold ${generatedContent.tts_enabled !== false ? 'text-teal-700' : 'text-slate-500'}`}>{generatedContent.tts_enabled !== false ? 'Enabled' : 'Disabled'}</span>
          </div>
          {(() => {
            const sections = generatedContent.sections || [];
            return (
          <div className="space-y-6">
            {sections.map((sec: any, i: number) => (
              (studioStep === 'polish' && i !== activeSectionIndex) ? null : (
              <div
                key={i}
                className={`border rounded-xl p-4 transition ${dragOverKey === `section:${i}` ? 'border-teal-400 bg-teal-50' : 'border-slate-200 bg-white'}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverKey(`section:${i}`); }}
                onDragLeave={() => setDragOverKey(null)}
                onDrop={(e) => handleDropOnSection(i, e)}
                style={buildSectionBackgroundStyle((sec as any).background_image_url)}
              >
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="relative z-10 grid grid-cols-1 gap-2 mb-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">Section {i + 1} editor</span>
                    <button
                      type="button"
                      onClick={() => removeSection(i)}
                      className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                    >
                      Remove section
                    </button>
                  </div>
                  <input
                    value={sec.heading || sec.title || ''}
                    onChange={(e) => updateSectionField(i, 'heading', e.target.value)}
                    placeholder="Section heading"
                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                  />
                  <input
                    value={sec.support || ''}
                    onChange={(e) => updateSectionField(i, 'support', e.target.value)}
                    placeholder="Support line"
                    className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs text-slate-600">
                      Text layout
                    </label>
                    <select
                      value={String((sec as any).text_layout_mode || 'auto')}
                      onChange={(e) => updateSectionTextLayoutMode(i, e.target.value as ContextualBlockLayout)}
                      className="px-2 py-1 border border-gray-300 rounded text-xs bg-white"
                    >
                      {CONTEXTUAL_LAYOUT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => applyContextualLayoutToEditor(i)}
                      className="px-2 py-1 text-xs bg-slate-700 text-white rounded hover:bg-slate-800"
                    >
                      Apply contextual blocks
                    </button>
                  </div>
                  <RichTextEditor
                    value={getSectionEditorHtml(sec)}
                    onChange={(html) => updateSectionBodyRich(i, html)}
                    placeholder="Section body"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => addCustomVisual(i, 'illustration')}
                      className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                    >
                      Add custom chart/diagram
                    </button>
                    <button
                      type="button"
                      onClick={() => addCustomVisual(i, 'image')}
                      className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                    >
                      Add custom image
                    </button>
                    <label className="px-2 py-1 text-xs bg-slate-700 text-white rounded hover:bg-slate-800 cursor-pointer">
                      Add section background
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => uploadSectionBackground(i, e.target.files?.[0] || null)}
                        className="hidden"
                      />
                    </label>
                    {!!String((sec as any).background_image_url || '').trim() && (
                      <button
                        type="button"
                        onClick={() => setSectionBackground(i, '')}
                        className="px-2 py-1 text-xs bg-rose-600 text-white rounded hover:bg-rose-700"
                      >
                        Remove background
                      </button>
                    )}
                  </div>
                  <input
                    value={(sec as any).background_image_url || ''}
                    onChange={(e) => setSectionBackground(i, e.target.value)}
                    placeholder="Section background image URL (optional)"
                    className="w-full px-2 py-1 border border-gray-300 rounded text-xs"
                  />
                  {includeMascot && (
                    <div className="p-2 bg-white border border-orange-200 rounded text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-orange-700">Mascot</span>
                        <button
                          type="button"
                          onClick={() => handleRegenerateMascot(i)}
                          disabled={regeneratingVisualKey === `mascot:${i}`}
                          className="px-2 py-0.5 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                        >
                          {regeneratingVisualKey === `mascot:${i}` ? 'Regenerating mascot...' : 'Regenerate mascot'}
                        </button>
                      </div>
                      <input
                        value={(sec as any)?.mascot?.title || ''}
                        onChange={(e) => updateMascotField(i, 'title', e.target.value)}
                        placeholder="Mascot title"
                        className="w-full px-2 py-1 border border-gray-300 rounded"
                      />
                      <input
                        value={(sec as any)?.mascot?.alt_text || ''}
                        onChange={(e) => updateMascotField(i, 'alt_text', e.target.value)}
                        placeholder="Mascot alt text"
                        className="w-full px-2 py-1 border border-gray-300 rounded"
                      />
                      <textarea
                        value={(sec as any)?.mascot?.prompt || ''}
                        onChange={(e) => updateMascotField(i, 'prompt', e.target.value)}
                        placeholder="Mascot generation prompt"
                        rows={2}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-[11px]"
                      />
                      <input
                        value={(sec as any)?.mascot?.image_url || ''}
                        onChange={(e) => updateMascotField(i, 'image_url', e.target.value)}
                        placeholder="Mascot image URL or data URL"
                        className="w-full px-2 py-1 border border-gray-300 rounded"
                      />
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => uploadMascotImage(i, e.target.files?.[0] || null)}
                        className="w-full"
                      />
                    </div>
                  )}
                  {Array.isArray(sec.visuals) && sec.visuals.length > 0 && (
                    <div className="space-y-2">
                      {sec.visuals.map((visual: any, vIdx: number) => (
                        <div key={`${i}-${vIdx}`} className="p-2 bg-white border border-gray-200 rounded text-xs">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-semibold text-gray-700 capitalize">{visual.kind || 'visual'}</span>
                            <div className="flex items-center gap-2">
                              {hasVisualSource(visual) && (
                                <button
                                  type="button"
                                  onClick={() => handleRegenerateVisual(i, vIdx)}
                                  disabled={regeneratingVisualKey === `${i}:${vIdx}`}
                                  className="px-2 py-0.5 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  {regeneratingVisualKey === `${i}:${vIdx}` ? 'Regenerating visual...' : 'Regenerate visual'}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => removeVisual(i, vIdx)}
                                className="px-2 py-0.5 bg-red-600 text-white rounded hover:bg-red-700"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          <input
                            value={visual.title || ''}
                            onChange={(e) => updateVisualField(i, vIdx, 'title', e.target.value)}
                            placeholder="Caption title"
                            className="w-full mb-1 px-2 py-1 border border-gray-300 rounded"
                          />
                          <input
                            value={visual.alt_text || ''}
                            onChange={(e) => updateVisualField(i, vIdx, 'alt_text', e.target.value)}
                            placeholder="Alt text"
                            className="w-full mb-1 px-2 py-1 border border-gray-300 rounded"
                          />
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[11px] font-medium text-gray-500">
                              {isDiagramVisual(visual) ? 'Graph generation prompt' : 'Image generation prompt'}
                            </span>
                            <button
                              type="button"
                              onClick={() => refreshVisualPrompt(i, vIdx)}
                              className="px-2 py-0.5 bg-slate-200 text-slate-700 rounded hover:bg-slate-300"
                            >
                              {isDiagramVisual(visual) ? 'Refresh graph prompt' : 'Refresh prompt'}
                            </button>
                          </div>
                          <textarea
                            value={visual.prompt || ''}
                            onChange={(e) => updateVisualField(i, vIdx, 'prompt', e.target.value)}
                            placeholder={isDiagramVisual(visual)
                              ? 'Prompt used for graph / diagram generation'
                              : 'Prompt used for image generation'}
                            rows={3}
                            className="w-full mb-1 px-2 py-1 border border-gray-300 rounded text-[11px]"
                          />
                          <input
                            value={visual.image_url || ''}
                            onChange={(e) => updateVisualField(i, vIdx, 'image_url', e.target.value)}
                            placeholder="Image URL or data URL"
                            className="w-full mb-1 px-2 py-1 border border-gray-300 rounded"
                          />
                          <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => uploadVisualImage(i, vIdx, e.target.files?.[0] || null)}
                            className="w-full"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="relative z-10 rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Student preview</div>
                <h3 className="font-semibold text-gray-800 mb-1 text-base">{sec.heading || sec.title || 'Section'}</h3>
                {sec.support && <p className="text-teal-700 text-sm font-medium mb-2">{sec.support}</p>}
                {isPlayfulTemplate && (() => {
                  const figureList = sectionFigures[i] || [];
                  const imageFigures = dedupeFigureEntries(figureList.filter(({ visual }) => visual?.image_url));
                  const contextualFigures = imageFigures.filter(({ visual }) => !isPlaceholderFigure(visual));
                  const candidateFigures = contextualFigures.length ? contextualFigures : imageFigures;
                  const diagramFigures = candidateFigures.filter(({ visual }) => isDiagramVisual(visual));
                  const sceneFigures = candidateFigures.filter(({ visual }) => !isDiagramVisual(visual));
                  const mainFigure = diagramFigures[0] || sceneFigures[0] || candidateFigures[0] || null;
                  const extraFigures = candidateFigures.filter((f) => f.figureKey !== mainFigure?.figureKey && f.visual?.extra_figure === true);
                  const keyPoint = String(sec.support || sec.heading || sec.title || 'Remember this point').trim();
                  const mascotHeroSrc = String((sec as any)?.mascot?.image_url || '').trim() || pickPlayfulCompanion(i * 2, playfulAssetPool) || '';
                  return (
                    <>
                      <div className="mb-4 space-y-3">
                          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_260px]">
                            <div className="border border-slate-200 rounded-lg bg-transparent p-2">
                              {mainFigure?.visual?.image_url ? (
                                <figure
                                  onClick={() => setSelectedVisualKey(mainFigure.figureKey)}
                                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverKey(mainFigure.figureKey); }}
                                  onDragLeave={() => setDragOverKey(null)}
                                  onDrop={(e) => { e.stopPropagation(); handleDropOnVisual(i, mainFigure.visualIndex, e); }}
                                  className={`rounded-lg overflow-hidden cursor-pointer transition ${
                                    dragOverKey === mainFigure.figureKey
                                      ? 'ring-2 ring-teal-300'
                                      : selectedVisualKey === mainFigure.figureKey
                                      ? 'ring-2 ring-emerald-300'
                                      : 'hover:ring-2 hover:ring-slate-200'
                                  }`}
                                >
                                  <img
                                    src={toSecureSrc(mainFigure.visual.image_url)}
                                    onError={handleImageFallback}
                                    alt={mainFigure.visual.alt_text || mainFigure.visual.title || `Figure ${mainFigure.figNum}`}
                                    className="w-full object-contain max-h-52"
                                  />
                                  <figcaption className="px-3 py-2 text-xs text-slate-700 bg-white">
                                    <span className="font-semibold">Figure {mainFigure.figNum}:</span> {mainFigure.visual.title}
                                  </figcaption>
                                </figure>
                              ) : (
                                <div className="h-32 rounded-lg border border-dashed border-slate-300 text-xs text-slate-600 flex items-center justify-center">
                                  Add a main figure image
                                </div>
                              )}
                            </div>
                            <div className="space-y-3">
                              <div className="border border-slate-200 rounded-lg bg-transparent p-2">
                                {mascotHeroSrc ? (
                                  <figure className="rounded-lg overflow-hidden">
                                    <img
                                      src={toSecureSrc(mascotHeroSrc)}
                                      onError={handleImageFallback}
                                      alt="Mascot visual"
                                      className="w-full object-contain max-h-28"
                                    />
                                  </figure>
                                ) : (
                                  <div className="h-24 rounded-lg border border-dashed border-slate-300 text-xs text-slate-600 flex items-center justify-center">
                                    Add a mascot image
                                  </div>
                                )}
                              </div>
                              <div className="relative border border-slate-200 rounded-lg bg-white p-3 min-h-[170px]">
                                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600 mb-1">Key point</div>
                                <p className="text-sm font-medium text-slate-900">{keyPoint}</p>
                              </div>
                            </div>
                          </div>
                          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3 min-h-[240px]">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">Text</div>
                            <div
                              className="text-gray-700 text-sm leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h3]:text-base [&_h3]:font-semibold [&_p]:mb-2"
                              dangerouslySetInnerHTML={{ __html: getSectionDisplayHtml(sec) }}
                            />
                          </section>
                      </div>
                      {extraFigures.map(({ visual, figNum, visualIndex, figureKey }) => (
                        <figure
                          key={figNum}
                          onClick={() => setSelectedVisualKey(figureKey)}
                          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverKey(figureKey); }}
                          onDragLeave={() => setDragOverKey(null)}
                          onDrop={(e) => { e.stopPropagation(); handleDropOnVisual(i, visualIndex, e); }}
                          className={`mt-4 border rounded-lg overflow-hidden bg-white cursor-pointer transition ${
                            dragOverKey === figureKey
                              ? 'border-teal-400 ring-2 ring-teal-200'
                              : selectedVisualKey === figureKey
                              ? 'border-emerald-400 ring-2 ring-emerald-200'
                              : 'border-gray-200 hover:border-emerald-300'
                          }`}
                        >
                          <img
                            src={toSecureSrc(visual.image_url)}
                            onError={handleImageFallback}
                            alt={visual.alt_text || visual.title || `Figure ${figNum}`}
                            className="w-full object-cover max-h-48"
                          />
                          <figcaption className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-600">
                            <span className="font-semibold text-gray-700">Figure {figNum}:</span> {visual.title}
                          </figcaption>
                        </figure>
                      ))}
                    </>
                  );
                })()}
                {!isPlayfulTemplate && (
                  <>

                {/* Illustration figure — shown before body text */}
                {(sectionFigures[i] || []).filter(({ visual }) => isDiagramVisual(visual)).map(({ visual, figNum, visualIndex, figureKey }) => (
                  <figure
                    key={figNum}
                    onClick={() => setSelectedVisualKey(figureKey)}
                    className={`my-4 border rounded-lg overflow-hidden bg-white cursor-pointer transition ${
                      selectedVisualKey === figureKey
                        ? 'border-emerald-400 ring-2 ring-emerald-200'
                        : 'border-gray-200 hover:border-emerald-300'
                    } ${visualIndex % 2 === 0 ? 'md:-rotate-[0.35deg]' : 'md:rotate-[0.35deg]'}`}
                  >
                    {visual.image_url ? (
                      <img
                        src={toSecureSrc(visual.image_url)}
                        onError={handleImageFallback}
                        alt={visual.alt_text || visual.title || `Figure ${figNum}`}
                        className="w-full object-contain max-h-64"
                      />
                    ) : null}
                    <figcaption className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-600">
                      <span className="font-semibold text-gray-700">Figure {figNum}:</span> {visual.title}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedVisualKey(figureKey);
                        }}
                        className="ml-3 text-emerald-700 hover:text-emerald-900 font-semibold"
                      >
                        Select
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedVisualKey(figureKey);
                          handleRegenerateVisual(i, visualIndex);
                        }}
                        disabled={regeneratingVisualKey === figureKey}
                        className="ml-3 text-emerald-700 hover:text-emerald-900 font-semibold disabled:opacity-50"
                      >
                        {regeneratingVisualKey === figureKey ? 'Regenerating...' : 'Regenerate'}
                      </button>
                    </figcaption>
                  </figure>
                ))}

                {/* Body text */}
                <div
                  className="text-gray-700 text-sm leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h3]:text-base [&_h3]:font-semibold [&_p]:mb-2"
                  dangerouslySetInnerHTML={{ __html: getSectionDisplayHtml(sec) }}
                />

                {/* Image figure — shown after body text */}
                {(sectionFigures[i] || []).filter(({ visual }) => !isDiagramVisual(visual)).map(({ visual, figNum, visualIndex, figureKey }) => (
                  visual.image_url ? (
                    <figure
                      key={figNum}
                      onClick={() => setSelectedVisualKey(figureKey)}
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverKey(figureKey); }}
                      onDragLeave={() => setDragOverKey(null)}
                      onDrop={(e) => { e.stopPropagation(); handleDropOnVisual(i, visualIndex, e); }}
                      className={`mt-4 border rounded-lg overflow-hidden bg-white cursor-pointer transition ${
                        dragOverKey === figureKey
                          ? 'border-teal-400 ring-2 ring-teal-200'
                          : selectedVisualKey === figureKey
                          ? 'border-emerald-400 ring-2 ring-emerald-200'
                          : 'border-gray-200 hover:border-emerald-300'
                      } ${visualIndex % 2 === 0 ? 'md:-rotate-[0.25deg]' : 'md:rotate-[0.25deg]'}`}
                    >
                      <img
                        src={toSecureSrc(visual.image_url)}
                        onError={handleImageFallback}
                        alt={visual.alt_text || visual.title || `Figure ${figNum}`}
                        className="w-full object-cover max-h-48"
                      />
                      <figcaption className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-600">
                        <span className="font-semibold text-gray-700">Figure {figNum}:</span> {visual.title}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedVisualKey(figureKey);
                          }}
                          className="ml-3 text-emerald-700 hover:text-emerald-900 font-semibold"
                        >
                          Select
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedVisualKey(figureKey);
                            handleRegenerateVisual(i, visualIndex);
                          }}
                          disabled={regeneratingVisualKey === figureKey}
                          className="ml-3 text-emerald-700 hover:text-emerald-900 font-semibold disabled:opacity-50"
                        >
                          {regeneratingVisualKey === figureKey ? 'Regenerating...' : 'Regenerate'}
                        </button>
                      </figcaption>
                    </figure>
                  ) : null
                ))}
                  </>
                )}
                </div>
                </div>
              </div>
              )
            ))}
            {generatedContent.quiz && generatedContent.quiz.questions && generatedContent.quiz.questions.length > 0 && (
              <div className="border border-gray-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-800 mb-2">Knowledge check ({generatedContent.quiz.questions.length} questions)</h3>
                <ul className="list-disc list-inside text-sm text-gray-700">
                  {generatedContent.quiz.questions.map((q, i) => (
                    <li key={i}>{q.question}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
            );
          })()}
        </div>

        <div className="w-full xl:w-64 shrink-0 space-y-4 xl:sticky xl:top-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-lg p-4">
            <div className="text-sm font-semibold text-slate-800 mb-2">Section Navigator</div>
            <div className="space-y-2 max-h-[320px] overflow-auto pr-1">
              {(generatedContent.sections || []).map((sec: any, idx: number) => (
                <button
                  key={`nav-${idx}`}
                  type="button"
                  onClick={() => {
                    setActiveSectionIndex(idx);
                    setStudioStep('polish');
                  }}
                  className={`w-full text-left rounded-lg border px-2 py-2 text-xs transition ${
                    activeSectionIndex === idx
                      ? 'border-teal-400 bg-teal-50 text-teal-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="font-semibold">Section {idx + 1}</div>
                  <div className="truncate">{String(sec?.heading || sec?.title || 'Untitled')}</div>
                </button>
              ))}
            </div>
          </div>

          {studioStep === 'polish' && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-lg p-4">
              <div className="text-sm font-semibold text-slate-800 mb-2">Academic Quality</div>
              <div className="text-xs text-slate-600 space-y-2">
                <div className="flex items-center justify-between"><span>Sections</span><span className="font-semibold">{qualityChecks.sectionCount}</span></div>
                <div className="flex items-center justify-between"><span>Avg words/section</span><span className="font-semibold">{qualityChecks.avgWords}</span></div>
                <div className="flex items-center justify-between"><span>Short sections (&lt;90 words)</span><span className={qualityChecks.shortCount ? 'font-semibold text-amber-700' : 'font-semibold text-emerald-700'}>{qualityChecks.shortCount}</span></div>
                <div className="flex items-center justify-between"><span>Missing key points</span><span className={qualityChecks.missingSupportCount ? 'font-semibold text-amber-700' : 'font-semibold text-emerald-700'}>{qualityChecks.missingSupportCount}</span></div>
                <div className="flex items-center justify-between"><span>Duplicate headings</span><span className={qualityChecks.duplicateHeadingCount ? 'font-semibold text-amber-700' : 'font-semibold text-emerald-700'}>{qualityChecks.duplicateHeadingCount}</span></div>
                <div className="pt-2 border-t border-slate-200 flex items-center justify-between"><span>Quality score</span><span className="font-bold text-teal-700">{qualityChecks.passRate}%</span></div>
              </div>
            </div>
          )}

          {templateImages.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Images className="w-4 h-4 text-teal-600" />
                <span className="text-sm font-semibold text-gray-700">Template assets</span>
              </div>
              <p className="text-xs text-gray-500 mb-3">Drag an image onto a section or visual slot to use it.</p>
              <div className="grid grid-cols-2 gap-2">
                {templateImages.map((url, idx) => (
                  <div
                    key={idx}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', url)}
                    className="cursor-grab active:cursor-grabbing border border-slate-200 rounded overflow-hidden hover:border-teal-400 hover:shadow-sm transition"
                    title={`Drag to use this image`}
                  >
                    <img
                      src={toSecureSrc(url)}
                      onError={handleImageFallback}
                      alt={`Template image ${idx + 1}`}
                      className="w-full h-16 object-cover"
                      draggable={false}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        </div>
      )}

    </div>
  );
};

export default ContentGenerator;
