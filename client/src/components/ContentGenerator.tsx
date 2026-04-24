import React, { useState, useEffect, useRef, useMemo } from 'react';
import { FileText, Loader2, Video, Link2, Upload, X, Presentation, BookOpen, Trash2, CalendarClock, History, Images } from 'lucide-react';
import { contentAPI, rubricsAPI, modulesAPI, GeneratedContent, ContentPlannerJob, ContentTemplate, ContentHistoryItem as ApiContentHistoryItem, LearningModule, PublishedContentItem, GenerationTrace } from '../services/api';
import MermaidDiagram from './MermaidDiagram';
import RichTextEditor from './RichTextEditor';
import { EDUCATION_LEVEL_OPTIONS, normalizeEducationLevelValue } from '../constants/educationLevels';
import { getSectionBodyHtml, richHtmlToPlainText, sanitizeRichTextHtml } from '../utils/richText';

const LEGACY_CONTENT_HISTORY_KEY = 'content_generator_history_v1';
const isDiagramVisual = (visual: any) =>
  !!String(visual?.mermaid_code || '').trim() ||
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
    kind === 'illustration' && visual?.mermaid_code
      ? `Graph structure to visualize: ${String(visual.mermaid_code).replace(/\s+/g, ' ').slice(0, 420)}.`
      : '',
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
  if (window.location.protocol !== 'https:' || !raw.startsWith('http://')) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === window.location.hostname) {
      parsed.protocol = 'https:';
      return parsed.toString();
    }
  } catch (_) {}
  return raw;
};
const toSecureSrc = (value?: string) => normalizeSecureMediaUrl(String(value || ''));

const ContentGenerator: React.FC = () => {
  const [topics, setTopics] = useState('');
  const [level, setLevel] = useState('');
  const [numSections, setNumSections] = useState(5);
  const [rubricId, setRubricId] = useState<number | null>(null);
  const [includeVideo, setIncludeVideo] = useState(false);
  const [includeDiagrams, setIncludeDiagrams] = useState(true);
  const [includeImages, setIncludeImages] = useState(true);
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
  const [selectedVisualKey, setSelectedVisualKey] = useState<string | null>(null);
  const [templateImages, setTemplateImages] = useState<string[]>([]);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recoveredContentJobIdRef = useRef<number | null>(null);

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

  useEffect(() => {
    loadRubrics();
    loadMyContent();
    loadPlannerJobs();
    loadTemplates();
    loadHistory();
    loadModules();
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
        setIsGenerating(false);
        setError(null);
        setBackgroundGenerationNotice('Recovered your generated content from a background job.');
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
    level,
    num_sections: numSections,
    rubric_id: rubricId,
    template_id: templateId,
    include_diagrams: includeDiagrams,
    include_images: includeImages,
    include_video: includeVideo,
    tts_enabled: includeTextToSpeech,
  });

  const withGenerationSettings = (content: GeneratedContent): GeneratedContent => ({
    ...content,
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
    setLevel(normalizeEducationLevelValue(input.level || '', ''));
    setNumSections(input.num_sections || 5);
    setRubricId(input.rubric_id || null);
    setTemplateId(input.template_id || 'classroom');
    setIncludeDiagrams(input.include_diagrams !== false);
    setIncludeImages(input.include_images !== false);
    setIncludeVideo(!!input.include_video);
    setIncludeTextToSpeech(input.tts_enabled !== false && item.content?.tts_enabled !== false);
    setGeneratedContent({
      ...item.content,
      tts_enabled: item.content?.tts_enabled !== false && input.tts_enabled !== false,
    });
    setGenerationTrace(item.generation_trace || input.generation_trace || null);
    setSelectedVisualKey(null);
    setActiveHistoryId(item.id);
    setActivePublishedContentId(null);
    setActivePublishedContentCode(null);
    setPublishedLink(null);
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
      setGeneratedContent(item.content);
      setSelectedVisualKey(null);
      setRubricId(item.rubric_id ?? null);
      setIncludeTextToSpeech(item.content.tts_enabled !== false);
      setGenerationTrace(null);
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
          setGeneratedContent(res.data.item.content);
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
          setGeneratedContent(res.data.item.content);
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
    setError(null);
    setBackgroundGenerationNotice(null);
    setIsGenerating(true);
    setSelectedVisualKey(null);
    setActiveHistoryId(null);
    setActivePublishedContentId(null);
    setActivePublishedContentCode(null);
    setGeneratedContent(null);
    setGenerationTrace(null);
    try {
      let effectiveTemplateId = templateId;
      if (templateFile) {
        const uploadRes = await contentAPI.uploadTemplate(templateFile);
        const uploadedId = uploadRes?.data?.template?.id;
        if (uploadedId) {
          effectiveTemplateId = uploadedId;
          setTemplateId(uploadedId);
        }
      }
      const res = await contentAPI.generate({
        topics: topicsTrim,
        level: level || undefined,
        num_sections: numSections,
        rubric_id: rubricId || undefined,
        template_id: effectiveTemplateId || undefined,
        include_diagrams: includeDiagrams,
        include_images: includeImages,
      });
      if (res.data.success && res.data.content) {
        const contentWithSettings = withGenerationSettings(res.data.content);
        const trace = res.data.generation_trace || null;
        setGenerationTrace(trace);
        setGeneratedContent(contentWithSettings);
        await addToHistory(contentWithSettings, trace);
      } else {
        setError('Failed to generate content');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to generate content');
    } finally {
      setIsGenerating(false);
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
          setGeneratedContent(res.data.item.content);
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
            mermaid_code: 'graph TD\n  A[Start] --> B[Step]\n  B --> C[Outcome]',
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

  const handleRegenerateVisual = async (sectionIndex: number, visualIndex: number) => {
    if (!generatedContent) return;
    const section = generatedContent.sections?.[sectionIndex];
    const visual = section?.visuals?.[visualIndex];
    const canRegenerate = !!section && !!visual && hasVisualSource(visual);
    if (!canRegenerate) return;

    const key = `${sectionIndex}:${visualIndex}`;
    setRegeneratingVisualKey(key);
    setError(null);
    try {
      const res = await contentAPI.regenerateVisual({
        visual,
        content_title: generatedContent.title || '',
        section_heading: section.heading || section.title || '',
        section_body: section.body || '',
      });
      if (res.data?.success && res.data.visual) {
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
      } else {
        setError('Grok did not return a replacement visual.');
      }
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to regenerate visual with Grok');
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
      await contentAPI.schedulePlanner({
        topics: topicsTrim,
        level: level || undefined,
        num_sections: numSections,
        rubric_id: rubricId || undefined,
        template_id: templateId || undefined,
        scheduled_for: scheduledIso,
        include_diagrams: includeDiagrams,
        include_images: includeImages,
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
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Topics to cover *</label>
            <textarea
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              placeholder="e.g. Photosynthesis, Cell division, Genetics..."
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              <input
                type="number"
                min={1}
                max={20}
                value={numSections}
                onChange={(e) => setNumSections(parseInt(e.target.value, 10) || 5)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
              />
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
          <div>
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
          <div className="flex flex-wrap gap-4 items-center">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={includeDiagrams}
                onChange={(e) => setIncludeDiagrams(e.target.checked)}
                className="w-4 h-4 text-teal-600 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Include diagrams</span>
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
          <div className="flex flex-wrap items-end gap-3">
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50"
            >
              {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
              Generate content
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
      </div>

      {generatedContent && (
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
              <div
                key={i}
                className={`border rounded-xl p-4 transition ${dragOverKey === `section:${i}` ? 'border-teal-400 bg-teal-50' : 'border-slate-200 bg-white'}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverKey(`section:${i}`); }}
                onDragLeave={() => setDragOverKey(null)}
                onDrop={(e) => handleDropOnSection(i, e)}
                style={buildSectionBackgroundStyle((sec as any).background_image_url)}
              >
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="grid grid-cols-1 gap-2 mb-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
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
                  <RichTextEditor
                    value={getSectionBodyHtml(sec)}
                    onChange={(html) => updateSectionBodyRich(i, html)}
                    placeholder="Section body"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => addCustomVisual(i, 'illustration')}
                      className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                    >
                      Add custom diagram
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
                          {isDiagramVisual(visual) ? (
                            <textarea
                              value={visual.mermaid_code || ''}
                              onChange={(e) => updateVisualField(i, vIdx, 'mermaid_code', e.target.value)}
                              placeholder="Mermaid diagram code"
                              rows={4}
                              className="w-full px-2 py-1 border border-gray-300 rounded font-mono"
                            />
                          ) : (
                            <>
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
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Student preview</div>
                <h3 className="font-semibold text-gray-800 mb-1 text-base">{sec.heading || sec.title || 'Section'}</h3>
                {sec.support && <p className="text-teal-700 text-sm font-medium mb-2">{sec.support}</p>}

                {/* Illustration figure — shown before body text */}
                {(sectionFigures[i] || []).filter(({ visual }) => isDiagramVisual(visual)).map(({ visual, figNum, visualIndex, figureKey }) => (
                  <figure
                    key={figNum}
                    onClick={() => setSelectedVisualKey(figureKey)}
                    className={`my-4 border rounded-lg overflow-hidden bg-white cursor-pointer transition ${
                      selectedVisualKey === figureKey
                        ? 'border-emerald-400 ring-2 ring-emerald-200'
                        : 'border-gray-200 hover:border-emerald-300'
                    }`}
                  >
                    {visual.image_url ? (
                      <img
                        src={toSecureSrc(visual.image_url)}
                        alt={visual.alt_text || visual.title || `Figure ${figNum}`}
                        className="w-full object-contain max-h-64"
                      />
                    ) : visual.mermaid_code ? (
                      <div className="p-4 bg-gray-50">
                        <MermaidDiagram code={visual.mermaid_code} className="min-h-[160px]" />
                      </div>
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
                  dangerouslySetInnerHTML={{ __html: getSectionBodyHtml(sec) }}
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
                      }`}
                    >
                      <img
                        src={toSecureSrc(visual.image_url)}
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
                </div>
                </div>
              </div>
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

        {templateImages.length > 0 && (
          <div className="w-full xl:w-56 shrink-0 bg-white rounded-xl border border-slate-200 shadow-lg p-4 xl:sticky xl:top-4">
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
      )}

    </div>
  );
};

export default ContentGenerator;
