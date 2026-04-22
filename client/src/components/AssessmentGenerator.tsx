import React, { useState, useEffect, useRef } from 'react';
import type { AxiosResponse } from 'axios';
import { Sparkles, Loader2, Download, FileText, BookOpen, Clock, Target, Link2, Upload, X, Trash2, History } from 'lucide-react';
import { assessmentsAPI, rubricsAPI, modulesAPI, contentAPI, GeneratedAssessment, AssessmentHistoryItem as ApiAssessmentHistoryItem, LearningModule, GenerationTrace } from '../services/api';

export type QuestionTypeOption = 'mcq' | 'essay' | 'short_answer' | 'mix_and_match';

const QUESTION_TYPE_LABELS: Record<QuestionTypeOption, string> = {
  mcq: 'Multiple choice (MCQ)',
  essay: 'Essay',
  short_answer: 'Short answer',
  mix_and_match: 'Mix and match',
};

const LEVEL_OPTIONS = [
  { value: '', label: 'Any level' },
  { value: 'Grade 8', label: 'Grade 8' },
  { value: 'Grade 9', label: 'Grade 9' },
  { value: 'Grade 10', label: 'Grade 10' },
  { value: 'Grade 11', label: 'Grade 11' },
  { value: 'Grade 12', label: 'Grade 12' },
  { value: 'Year 1', label: 'Year 1 (tertiary)' },
  { value: 'Year 2', label: 'Year 2 (tertiary)' },
  { value: 'Year 3', label: 'Year 3 (tertiary)' },
  { value: 'Undergraduate', label: 'Undergraduate' },
  { value: 'Postgraduate', label: 'Postgraduate' },
];
const LEGACY_ASSESSMENT_HISTORY_KEY = 'assessment_generator_history_v1';
const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PUBLISHED_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 8;

const stripOptionPrefix = (option: string, optionIndex: number) => {
  const letter = OPTION_LETTERS[optionIndex] || String(optionIndex + 1);
  return String(option || '')
    .replace(new RegExp(`^\\s*\\(?${letter}\\)?[\\)\\].:\\-]?\\s+`, 'i'), '')
    .trim();
};

const AssessmentGenerator: React.FC = () => {
  const [useCustomTopics, setUseCustomTopics] = useState(false);
  const [customTopicsText, setCustomTopicsText] = useState('');
  const [customTopicsFile, setCustomTopicsFile] = useState<File | null>(null);
  const [level, setLevel] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedRubricId, setSelectedRubricId] = useState<number | null>(null);
  const [selectedRubric, setSelectedRubric] = useState<any | null>(null);
  const [myContentItems, setMyContentItems] = useState<any[]>([]);
  const [selectedContentId, setSelectedContentId] = useState<number | null>(null);
  const [topic, setTopic] = useState('');
  const [difficultyLevel, setDifficultyLevel] = useState<'beginner' | 'moderate' | 'advanced'>('moderate');
  const [questionCount, setQuestionCount] = useState(5);
  const [assessmentType, setAssessmentType] = useState<'assignment' | 'exam' | 'quiz' | 'essay'>('assignment');
  const [questionTypeMode, setQuestionTypeMode] = useState<'mix' | 'custom'>('mix');
  const [selectedQuestionTypes, setSelectedQuestionTypes] = useState<QuestionTypeOption[]>(['mcq', 'short_answer']);
  const [useExistingPatterns, setUseExistingPatterns] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedAssessment, setGeneratedAssessment] = useState<GeneratedAssessment | null>(null);
  const [savedRubricId, setSavedRubricId] = useState<number | null>(null);
  const [savedRubricName, setSavedRubricName] = useState<string | null>(null);
  const [publishedLink, setPublishedLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<'text' | 'moodle' | 'scorm' | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [modules, setModules] = useState<LearningModule[]>([]);
  const [selectedModuleId, setSelectedModuleId] = useState<number | null>(null);
  const [newModuleName, setNewModuleName] = useState('');
  const [rubrics, setRubrics] = useState<any[]>([]);
  const [publishedList, setPublishedList] = useState<{ id: number; code: string; title: string; link: string; created_at: string }[]>([]);
  const [deletingPublishedId, setDeletingPublishedId] = useState<number | null>(null);
  const [history, setHistory] = useState<ApiAssessmentHistoryItem[]>([]);
  const [isMigratingHistory, setIsMigratingHistory] = useState(false);
  const [publishedPage, setPublishedPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);

  useEffect(() => {
    loadStats();
    loadRubrics();
    loadMyContent();
    loadModules();
    loadPublished();
    loadHistory();
  }, []);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(publishedList.length / PUBLISHED_PAGE_SIZE));
    setPublishedPage((prev) => Math.min(prev, maxPage));
  }, [publishedList.length]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
    setHistoryPage((prev) => Math.min(prev, maxPage));
  }, [history.length]);

  const loadHistory = async () => {
    try {
      const res = await assessmentsAPI.getHistory();
      if (res.data.success) setHistory(res.data.items || []);
    } catch (_) {
      setHistory([]);
    }
  };

  const addToHistory = async (
    assessment: GeneratedAssessment,
    nextSavedRubricId: number | null,
    nextSavedRubricName: string | null,
    nextSelectedRubric: any | null,
    trace: GenerationTrace | null
  ) => {
    try {
      await assessmentsAPI.saveHistory({
        assessment,
        input: {
          use_custom_topics: useCustomTopics,
          custom_topics_text: customTopicsText,
          level,
          topic,
          difficulty_level: difficultyLevel,
          question_count: questionCount,
          assessment_type: assessmentType,
          question_type_mode: questionTypeMode,
          selected_question_types: selectedQuestionTypes,
          selected_rubric_id: selectedRubricId,
          selected_rubric: nextSelectedRubric,
          selected_content_id: selectedContentId,
          saved_rubric_id: nextSavedRubricId,
          saved_rubric_name: nextSavedRubricName,
          generation_trace: trace,
        }
      });
      await loadHistory();
    } catch (_) {}
  };

  const loadFromHistory = (item: ApiAssessmentHistoryItem) => {
    const input = item.input || {};
    setUseCustomTopics(!!input.use_custom_topics);
    setCustomTopicsText(input.custom_topics_text || '');
    setCustomTopicsFile(null);
    setLevel(input.level || '');
    setTopic(input.topic || '');
    setDifficultyLevel(input.difficulty_level || 'moderate');
    setQuestionCount(input.question_count || 5);
    setAssessmentType(input.assessment_type || 'assignment');
    setQuestionTypeMode(input.question_type_mode || 'mix');
    setSelectedQuestionTypes(Array.isArray(input.selected_question_types) ? input.selected_question_types : ['mcq', 'short_answer']);
    setSelectedRubricId(input.selected_rubric_id || null);
    setSelectedRubric(input.selected_rubric || null);
    setSelectedContentId(input.selected_content_id || null);
    setGeneratedAssessment(item.assessment);
    setSavedRubricId(input.saved_rubric_id || null);
    setSavedRubricName(input.saved_rubric_name || null);
    setPublishedLink(null);
    setError(null);
  };

  const removeHistoryItem = async (id: number) => {
    try {
      await assessmentsAPI.deleteHistoryItem(id);
      await loadHistory();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to remove history item');
    }
  };

  const clearHistory = async () => {
    try {
      await assessmentsAPI.clearHistory();
      await loadHistory();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to clear history');
    }
  };

  const migrateLegacyHistory = async () => {
    setError(null);
    setIsMigratingHistory(true);
    try {
      const raw = localStorage.getItem(LEGACY_ASSESSMENT_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const legacyItems = Array.isArray(parsed) ? parsed : [];
      const validItems = legacyItems.filter((item: any) => item && item.generated_assessment && item.generated_assessment.title);
      if (validItems.length === 0) {
        setError('No legacy local assessment history found to migrate.');
        return;
      }

      for (const item of validItems) {
        await assessmentsAPI.saveHistory({
          assessment: item.generated_assessment,
          input: {
            use_custom_topics: !!item.use_custom_topics,
            custom_topics_text: item.custom_topics_text || '',
            level: item.level || '',
            topic: item.topic || '',
            difficulty_level: item.difficulty_level || 'moderate',
            question_count: item.question_count || 5,
            assessment_type: item.assessment_type || 'assignment',
            question_type_mode: item.question_type_mode || 'mix',
            selected_question_types: Array.isArray(item.selected_question_types) ? item.selected_question_types : ['mcq', 'short_answer'],
            selected_rubric_id: item.selected_rubric_id || null,
            selected_rubric: item.selected_rubric || null,
            saved_rubric_id: item.saved_rubric_id || null,
            saved_rubric_name: item.saved_rubric_name || null,
          }
        });
      }

      localStorage.removeItem(LEGACY_ASSESSMENT_HISTORY_KEY);
      await loadHistory();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to migrate legacy history');
    } finally {
      setIsMigratingHistory(false);
    }
  };

  const loadPublished = async () => {
    try {
      const res = await assessmentsAPI.getPublished();
      if (res.data.success && res.data.items) {
        setPublishedList(res.data.items);
        setPublishedPage(1);
      }
    } catch (_) {}
  };

  const loadModules = async () => {
    try {
      const res = await modulesAPI.list();
      if (res.data.success && res.data.modules) setModules(res.data.modules);
    } catch (_) {
      setModules([]);
    }
  };

  const loadStats = async () => {
    try {
      const response = await assessmentsAPI.getStats();
      if (response.data.success) {
        setStats(response.data.stats);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  };

  const loadRubrics = async () => {
    try {
      const response = await rubricsAPI.getRubrics();
      if (response.data.success) {
        setRubrics(response.data.rubrics || []);
      }
    } catch (error) {
      console.error('Failed to load rubrics:', error);
    }
  };

  const loadMyContent = async () => {
    try {
      const response = await contentAPI.getMy();
      if (response.data.success) {
        setMyContentItems(response.data.items || []);
      }
    } catch (error) {
      console.error('Failed to load content items:', error);
    }
  };

  const handleRubricChange = (rubricId: number | null) => {
    setSelectedRubricId(rubricId);
    if (rubricId !== null) {
      const rubric = rubrics.find(r => r.id === rubricId);
      setSelectedRubric(rubric || null);
    } else {
      setSelectedRubric(null);
    }
    setGeneratedAssessment(null);
  };

  const getCustomTopicsString = async (): Promise<string> => {
    if (customTopicsFile) {
      const text = await customTopicsFile.text();
      return text.trim();
    }
    return customTopicsText.trim();
  };

  const handleGenerate = async () => {
    const hasCustomTopics = useCustomTopics && (customTopicsText.trim() || customTopicsFile);
    if (!hasCustomTopics && !selectedRubricId && !selectedContentId) {
      setError('Select a rubric/memo, a content item, or use custom topics');
      return;
    }
    if (hasCustomTopics) {
      const topicsStr = await getCustomTopicsString();
      if (!topicsStr || topicsStr.length < 10) {
        setError('Please enter or upload a topic list (at least a few words)');
        return;
      }
    }

    setIsGenerating(true);
    setError(null);
    setGeneratedAssessment(null);
    setSavedRubricId(null);
    setSavedRubricName(null);

    try {
      const question_types = questionTypeMode === 'mix' ? ['mix'] : selectedQuestionTypes;
      const payload: any = {
        difficulty_level: difficultyLevel,
        question_count: questionCount,
        assessment_type: assessmentType,
        use_existing_patterns: useCustomTopics ? false : useExistingPatterns,
        topic: topic.trim() || null,
        question_types,
        level: level.trim() || null,
      };
      if (hasCustomTopics) {
        payload.custom_topics = await getCustomTopicsString();
      } else {
        payload.rubric_id = selectedRubricId;
      }
      if (selectedContentId) {
        payload.content_id = selectedContentId;
      }
      const response = await assessmentsAPI.generate(payload);

      if (response.data.success) {
        setGeneratedAssessment(response.data.assessment);
        const responseTrace = response.data.generation_trace || null;
        const responseRubric = response.data.rubric || selectedRubric || null;
        if (responseRubric) {
          setSelectedRubric(responseRubric);
        }
        const nextSavedRubricId = response.data.saved_rubric_id ?? null;
        const nextSavedRubricName = response.data.saved_rubric_name ?? null;
        setSavedRubricId(nextSavedRubricId);
        setSavedRubricName(nextSavedRubricName);
        await addToHistory(response.data.assessment, nextSavedRubricId, nextSavedRubricName, responseRubric, responseTrace);
        setPublishedLink(null);
      } else {
        setError(response.data.error || 'Failed to generate assessment');
      }
    } catch (error: any) {
      console.error('Generation error:', error);
      setError(error.response?.data?.error || error.message || 'Failed to generate assessment');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!generatedAssessment) return;

    const lines: string[] = [
      `ASSESSMENT: ${generatedAssessment.title}`,
      `Topic: ${generatedAssessment.topic}`,
      `Difficulty: ${generatedAssessment.difficulty_level}`,
      `Type: ${generatedAssessment.assessment_type}`,
      `Estimated Time: ${generatedAssessment.estimated_time}`,
      `Total Points: ${generatedAssessment.total_points}`,
      '',
      'INSTRUCTIONS:',
      generatedAssessment.instructions,
      '',
      'QUESTIONS:',
      '',
    ];

    generatedAssessment.questions.forEach((q) => {
      lines.push(`${q.number}. [${(q.type || '').replace(/_/g, ' ').toUpperCase()}] (${q.points} points)`);
      lines.push(q.question);
      if (q.options && q.options.length > 0) {
        q.options.forEach((opt, i) => lines.push(`   ${String.fromCharCode(65 + i)}) ${opt}`));
      }
      if (q.left_column && q.right_column && q.left_column.length > 0) {
        lines.push('   Column A:');
        q.left_column.forEach((item, i) => lines.push(`     ${i + 1}. ${item}`));
        lines.push('   Column B:');
        q.right_column.forEach((item, i) => lines.push(`     ${String.fromCharCode(65 + i)}. ${item}`));
        lines.push('   (Match items from Column A to Column B)');
      }
      if (q.hints && q.hints.length > 0) {
        lines.push('   Hints: ' + q.hints.join('; '));
      }
      lines.push('');
    });

    lines.push('---');
    lines.push('ANSWER KEY (for teacher):');
    generatedAssessment.questions.forEach((q) => {
      if (q.correct_answer !== undefined) {
        lines.push(`Q${q.number}: ${q.correct_answer}`);
      }
      if (q.correct_pairings && Array.isArray(q.correct_pairings) && q.correct_pairings.length > 0) {
        const pairStr = q.correct_pairings.map((p: any) =>
          typeof p === 'object' && p.left_index != null ? `${p.left_index}-${p.right_index}` : String(p)
        ).join(', ');
        lines.push(`Q${q.number} (match): ${pairStr}`);
      }
    });

    const content = lines.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${generatedAssessment.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExportBlob = async (
    format: 'moodle' | 'scorm',
    getBlob: () => Promise<AxiosResponse<Blob>>,
    extension: string
  ) => {
    if (!generatedAssessment) return;
    setExportingFormat(format);
    setError(null);
    try {
      const res = await getBlob();
      const contentType = (res.headers && (res.headers as Record<string, string>)['content-type']) || '';
      if (res.status >= 400 || contentType.includes('application/json')) {
        const text = await (res.data as Blob).text();
        const json = JSON.parse(text);
        throw new Error(json.error || 'Export failed');
      }
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${generatedAssessment.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${extension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      let errMsg = e.message || `Failed to export ${format}`;
      if (e.response?.data instanceof Blob) {
        try {
          const text = await e.response.data.text();
          const json = JSON.parse(text);
          if (json.error) errMsg = json.error;
        } catch (_) { /* ignore */ }
      } else if (e.response?.data?.error) {
        errMsg = e.response.data.error;
      }
      setError(errMsg);
    } finally {
      setExportingFormat(null);
    }
  };

  const handleDeletePublished = async (id: number, title: string) => {
    if (!window.confirm(`Delete published assessment "${title || id}"? This cannot be undone.`)) return;
    setDeletingPublishedId(id);
    setError(null);
    try {
      await assessmentsAPI.deletePublished(id);
      await loadPublished();
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to delete published assessment');
    } finally {
      setDeletingPublishedId(null);
    }
  };

  const publishedPageCount = Math.max(1, Math.ceil(publishedList.length / PUBLISHED_PAGE_SIZE));
  const historyPageCount = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const publishedPageItems = publishedList.slice((publishedPage - 1) * PUBLISHED_PAGE_SIZE, publishedPage * PUBLISHED_PAGE_SIZE);
  const historyPageItems = history.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <Sparkles className="w-8 h-8 text-purple-600" />
          <h1 className="text-3xl font-bold text-gray-800">AI Assessment Generator</h1>
        </div>
        <p className="text-gray-600 mb-6">
          Generate new assessments automatically based on your rubrics. The system creates questions that align with your rubric criteria, ensuring assessments match your marking standards.
        </p>

        <details className="mb-6 bg-violet-50 border border-violet-200 rounded-lg overflow-hidden" open={publishedList.length > 0}>
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-violet-900">
            My published assessment links ({publishedList.length})
          </summary>
          <div className="px-4 pb-4">
            {publishedList.length === 0 ? (
              <p className="text-sm text-violet-900">No published assessments yet.</p>
            ) : (
              <>
                <ul className="space-y-2">
                {publishedPageItems.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-gray-700 truncate max-w-[200px]" title={item.title}>{item.title || item.code}</span>
                    <input readOnly value={item.link} className="flex-1 min-w-[180px] px-2 py-1 border border-gray-300 rounded text-sm bg-white" />
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(item.link)}
                      className="px-2 py-1 text-xs bg-violet-600 text-white rounded hover:bg-violet-700"
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeletePublished(item.id, item.title)}
                      disabled={deletingPublishedId === item.id}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                      title="Delete published assessment"
                    >
                      {deletingPublishedId === item.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                      Delete
                    </button>
                  </li>
                ))}
                </ul>
                {publishedPageCount > 1 && (
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-violet-900">
                    <span>
                      Page {publishedPage} of {publishedPageCount}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPublishedPage((prev) => Math.max(1, prev - 1))}
                        disabled={publishedPage === 1}
                        className="px-2 py-1 bg-white border border-violet-200 rounded hover:bg-violet-100 disabled:opacity-50"
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        onClick={() => setPublishedPage((prev) => Math.min(publishedPageCount, prev + 1))}
                        disabled={publishedPage === publishedPageCount}
                        className="px-2 py-1 bg-white border border-violet-200 rounded hover:bg-violet-100 disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </details>

        <details className="mb-6 bg-amber-50 border border-amber-200 rounded-lg overflow-hidden" open={history.length > 0}>
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-amber-900 inline-flex items-center gap-2">
            <History className="w-4 h-4" />
            Assessment generator history ({history.length})
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
              <p className="text-sm text-amber-900">No history yet. Generate an assessment and it will appear here.</p>
            ) : (
              <>
                <ul className="space-y-2">
                {historyPageItems.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 flex-wrap text-sm text-gray-700 bg-white border border-amber-100 rounded p-2">
                    <span className="font-medium truncate max-w-[260px]" title={item.assessment?.title || ''}>
                      {item.assessment?.title || item.title || 'Untitled assessment'}
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
                {historyPageCount > 1 && (
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-amber-900">
                    <span>
                      Page {historyPage} of {historyPageCount}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setHistoryPage((prev) => Math.max(1, prev - 1))}
                        disabled={historyPage === 1}
                        className="px-2 py-1 bg-white border border-amber-200 rounded hover:bg-amber-100 disabled:opacity-50"
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        onClick={() => setHistoryPage((prev) => Math.min(historyPageCount, prev + 1))}
                        disabled={historyPage === historyPageCount}
                        className="px-2 py-1 bg-white border border-amber-200 rounded hover:bg-amber-100 disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </details>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-blue-50 rounded-lg">
            <div>
              <div className="text-sm text-gray-600">Total Assignments</div>
              <div className="text-2xl font-bold text-blue-600">{stats.total_assignments}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">With Text</div>
              <div className="text-2xl font-bold text-green-600">{stats.assignments_with_text}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Marked</div>
              <div className="text-2xl font-bold text-purple-600">{stats.marked_assignments}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Rubrics</div>
              <div className="text-2xl font-bold text-orange-600">{stats.available_rubrics}</div>
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="useCustomTopics"
              checked={useCustomTopics}
              onChange={(e) => {
                setUseCustomTopics(e.target.checked);
                if (!e.target.checked) {
                  setCustomTopicsFile(null);
                  setCustomTopicsText('');
                }
                setGeneratedAssessment(null);
              }}
              className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
            />
            <label htmlFor="useCustomTopics" className="text-sm font-medium text-gray-700">
              Use custom topic list (and level) instead of a memo/rubric
            </label>
          </div>

          {useCustomTopics ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Topic list * <span className="text-gray-500">(one topic per line or comma-separated; or upload a .txt file)</span>
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) setCustomTopicsFile(f);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white hover:bg-gray-50"
                  >
                    <Upload className="w-4 h-4" />
                    Upload topic list (.txt or .csv)
                  </button>
                  {customTopicsFile && (
                    <span className="inline-flex items-center gap-1 text-sm text-gray-600">
                      {customTopicsFile.name}
                      <button type="button" onClick={() => setCustomTopicsFile(null)} className="text-red-600 hover:text-red-800">
                        <X className="w-4 h-4" />
                      </button>
                    </span>
                  )}
                </div>
                <textarea
                  value={customTopicsText}
                  onChange={(e) => setCustomTopicsText(e.target.value)}
                  placeholder="e.g. Photosynthesis, Cell division, Genetics, Evolution..."
                  rows={4}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Level</label>
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                >
                  {LEVEL_OPTIONS.map((opt) => (
                    <option key={opt.value || 'any'} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Memo / Rubric <span className="text-gray-500">(Select to base the assessment on)</span>
                </label>
                <select
                  value={selectedRubricId || ''}
                  onChange={(e) => handleRubricChange(e.target.value ? parseInt(e.target.value) : null)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                >
                  <option value="">Select a memo or rubric...</option>
                  {rubrics.map(rubric => (
                    <option key={rubric.id} value={rubric.id}>
                      {rubric.rubric_type === 'answer_key' ? '📋 Memo: ' : '📌 '}{rubric.name} ({rubric.total_points} pts, {Array.isArray(rubric.criteria) ? rubric.criteria.length : 0} criteria)
                    </option>
                  ))}
                </select>
                {selectedRubric && (
                  <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="text-sm font-semibold text-blue-900 mb-2">Selected: {selectedRubric.name}</div>
                    <div className="text-sm text-blue-700">
                      <div>Total Points: {selectedRubric.total_points}</div>
                      <div>Criteria: {Array.isArray(selectedRubric.criteria) ? selectedRubric.criteria.length : 0}</div>
                      {Array.isArray(selectedRubric.criteria) && selectedRubric.criteria.length > 0 && (
                        <div className="mt-2">
                          <div className="font-medium mb-1">Criteria:</div>
                          <ul className="list-disc list-inside space-y-1">
                            {selectedRubric.criteria.slice(0, 5).map((criterion: any, idx: number) => (
                              <li key={idx} className="text-xs">
                                {criterion.name} ({criterion.max_points} points)
                              </li>
                            ))}
                            {selectedRubric.criteria.length > 5 && (
                              <li className="text-xs text-gray-600">... and {selectedRubric.criteria.length - 5} more</li>
                            )}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Topic/Subject Area <span className="text-gray-500">(optional)</span>
                </label>
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. World War II, Photosynthesis"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Level</label>
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                >
                  {LEVEL_OPTIONS.map((opt) => (
                    <option key={opt.value || 'any'} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Base on existing content item <span className="text-gray-500">(optional)</span>
            </label>
            <select
              value={selectedContentId || ''}
              onChange={(e) => setSelectedContentId(e.target.value ? parseInt(e.target.value, 10) : null)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            >
              <option value="">None</option>
              {myContentItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title || item.code} ({item.sections?.length ?? 0} sections)
                </option>
              ))}
            </select>
            {selectedContentId && myContentItems.find((item) => item.id === selectedContentId) && (
              <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">
                <div className="font-semibold mb-1">Selected content preview</div>
                <div>{myContentItems.find((item) => item.id === selectedContentId)?.title}</div>
                {myContentItems.find((item) => item.id === selectedContentId)?.sections?.slice(0, 2).map((section: any, idx: number) => (
                  <div key={idx} className="mt-2">
                    <div className="font-medium">{section.heading}</div>
                    <div className="text-xs text-gray-600">{section.preview}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Difficulty Level
              </label>
              <select
                value={difficultyLevel}
                onChange={(e) => setDifficultyLevel(e.target.value as any)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              >
                <option value="beginner">Beginner</option>
                <option value="moderate">Moderate</option>
                <option value="advanced">Advanced</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Assessment Type
              </label>
              <select
                value={assessmentType}
                onChange={(e) => setAssessmentType(e.target.value as any)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
              >
                <option value="assignment">Assignment</option>
                <option value="exam">Exam</option>
                <option value="quiz">Quiz</option>
                <option value="essay">Essay</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Number of Questions
            </label>
            <input
              type="number"
              min="1"
              max="20"
              value={questionCount}
              onChange={(e) => setQuestionCount(parseInt(e.target.value) || 5)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Question types
            </label>
            <div className="flex flex-wrap gap-3 items-center">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="questionTypeMode"
                  checked={questionTypeMode === 'mix'}
                  onChange={() => setQuestionTypeMode('mix')}
                  className="text-purple-600 border-gray-300 focus:ring-purple-500"
                />
                <span className="text-sm">Mix (AI chooses variety)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="questionTypeMode"
                  checked={questionTypeMode === 'custom'}
                  onChange={() => setQuestionTypeMode('custom')}
                  className="text-purple-600 border-gray-300 focus:ring-purple-500"
                />
                <span className="text-sm">Select types:</span>
              </label>
              {questionTypeMode === 'custom' && (
                (['mcq', 'essay', 'short_answer', 'mix_and_match'] as QuestionTypeOption[]).map((t) => (
                  <label key={t} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedQuestionTypes.includes(t)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedQuestionTypes((prev) => [...prev, t]);
                        } else {
                          setSelectedQuestionTypes((prev) => prev.filter((x) => x !== t));
                        }
                      }}
                      className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    />
                    <span className="text-sm">{QUESTION_TYPE_LABELS[t]}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="usePatterns"
              checked={useExistingPatterns}
              onChange={(e) => setUseExistingPatterns(e.target.checked)}
              className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
            />
            <label htmlFor="usePatterns" className="text-sm text-gray-700">
              Use patterns from existing marked assignments and rubrics
            </label>
          </div>

          {questionTypeMode === 'custom' && selectedQuestionTypes.length === 0 && (
            <p className="text-amber-700 text-sm">Select at least one question type.</p>
          )}
          <button
            onClick={handleGenerate}
            disabled={
              isGenerating ||
              (!useCustomTopics && !selectedRubricId && !selectedContentId) ||
              (questionTypeMode === 'custom' && selectedQuestionTypes.length === 0)
            }
            className="w-full bg-purple-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Generating Assessment...
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                Generate Assessment
              </>
            )}
          </button>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
              {error}
            </div>
          )}
        </div>
      </div>

      {generatedAssessment && (
        <div className="bg-white rounded-lg shadow-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <FileText className="w-6 h-6 text-purple-600" />
              <h2 className="text-2xl font-bold text-gray-800">{generatedAssessment.title}</h2>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-gray-600 mr-1">Export (includes answers):</span>
              <button
                onClick={handleDownload}
                disabled={!!exportingFormat}
                className="flex items-center gap-2 px-3 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                Text
              </button>
              <button
                onClick={() => handleExportBlob(
                  'moodle',
                  () => assessmentsAPI.exportMoodleXml(generatedAssessment),
                  'xml'
                )}
                disabled={!!exportingFormat}
                className="flex items-center gap-2 px-3 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
              >
                {exportingFormat === 'moodle' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                Moodle XML
              </button>
              <button
                onClick={() => handleExportBlob(
                  'scorm',
                  () => assessmentsAPI.exportScorm(generatedAssessment),
                  'zip'
                )}
                disabled={!!exportingFormat}
                className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {exportingFormat === 'scorm' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                SCORM
              </button>
              {savedRubricId && (
                <>
                  <div className="flex flex-col gap-3 w-full md:w-auto md:flex-row md:items-center">
                    <div className="flex-1 min-w-[220px]">
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
                    <div className="flex-1 min-w-[220px]">
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Create new module folder</label>
                      <input
                        value={newModuleName}
                        onChange={(e) => setNewModuleName(e.target.value)}
                        placeholder="New module name"
                        className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                      />
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      if (!generatedAssessment || !savedRubricId) return;
                      try {
                        const payload: { assessment: GeneratedAssessment; rubric_id: number; module_id?: number; module_name?: string } = {
                          assessment: generatedAssessment,
                          rubric_id: savedRubricId,
                        };
                        if (newModuleName.trim()) {
                          payload.module_name = newModuleName.trim();
                        } else if (selectedModuleId) {
                          payload.module_id = selectedModuleId;
                        }
                        const res = await assessmentsAPI.publish(payload);
                        if (res.data.success && res.data.code) {
                          const path = window.location.pathname.replace(/\/$/, '');
                          const base = path.startsWith('/tools') ? '/tools' : (path.split('/').filter(Boolean)[0] ? '/' + path.split('/').filter(Boolean)[0] : '');
                          const link = `${window.location.origin}${base}/take-assessment?code=${res.data.code}`;
                          setPublishedLink(link);
                          loadPublished();
                          loadModules();
                        }
                      } catch (e: any) {
                        setError(e.response?.data?.error || 'Failed to publish');
                      }
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
                  >
                    <Link2 className="w-4 h-4" />
                    Publish for students
                  </button>
                </>
              )}
            </div>
          </div>

          {publishedLink && (
            <div className="mb-6 p-4 bg-violet-50 border border-violet-200 rounded-lg">
              <div className="font-semibold text-violet-900 mb-1">Share link with students</div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  readOnly
                  value={publishedLink}
                  className="flex-1 min-w-[200px] px-3 py-2 border border-violet-300 rounded bg-white text-sm"
                />
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(publishedLink); }}
                  className="px-3 py-2 bg-violet-600 text-white rounded text-sm hover:bg-violet-700"
                >
                  Copy link
                </button>
              </div>
              <p className="text-sm text-violet-700 mt-2">Students open this link to take the assessment; marking runs when they submit.</p>
            </div>
          )}

          {savedRubricId && savedRubricName && (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-3">
              <Link2 className="w-5 h-5 text-green-600 flex-shrink-0" />
              <div>
                <div className="font-semibold text-green-900">Rubric saved</div>
                <div className="text-sm text-green-700">
                  &quot;{savedRubricName}&quot; has been stored. Use it in Marking to mark scripts against this assessment.
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="flex items-center gap-2 text-gray-600">
              <BookOpen className="w-5 h-5" />
              <span className="text-sm">{generatedAssessment.topic}</span>
            </div>
            <div className="flex items-center gap-2 text-gray-600">
              <Target className="w-5 h-5" />
              <span className="text-sm capitalize">{generatedAssessment.difficulty_level}</span>
            </div>
            <div className="flex items-center gap-2 text-gray-600">
              <FileText className="w-5 h-5" />
              <span className="text-sm capitalize">{generatedAssessment.assessment_type}</span>
            </div>
            <div className="flex items-center gap-2 text-gray-600">
              <Clock className="w-5 h-5" />
              <span className="text-sm">{generatedAssessment.estimated_time}</span>
            </div>
          </div>

          {selectedRubric && (
            <div className="mb-6 p-4 bg-purple-50 border border-purple-200 rounded-lg">
              <div className="text-sm font-semibold text-purple-900 mb-2">Based on Rubric: {selectedRubric.name}</div>
              <div className="text-sm text-purple-700">
                <div>Total Points: {selectedRubric.total_points} | Criteria: {selectedRubric.criteria_count}</div>
              </div>
            </div>
          )}

          {generatedAssessment.rubric_alignment && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h3 className="text-sm font-semibold text-blue-900 mb-2">Rubric Alignment</h3>
              <p className="text-sm text-blue-700">{generatedAssessment.rubric_alignment}</p>
            </div>
          )}

          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-2">Instructions</h3>
            <div className="bg-gray-50 p-4 rounded-lg whitespace-pre-wrap text-gray-700">
              {generatedAssessment.instructions}
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">
              Questions ({generatedAssessment.questions.length} questions, {generatedAssessment.total_points} points total)
            </h3>
            <div className="space-y-4">
              {generatedAssessment.questions.map((question, idx) => (
                <div key={idx} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-800">Question {question.number}</span>
                      <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
                        {question.type.replace('_', ' ').toUpperCase()}
                      </span>
                      <span className="text-sm text-gray-600">({question.points} points)</span>
                    </div>
                  </div>
                  <p className="text-gray-700 mb-2">{question.question}</p>
                  {question.options && question.options.length > 0 && (
                    <div className="ml-2 mb-2 text-sm text-gray-600">
                      {question.options.map((opt, i) => (
                        <div key={i}>{String.fromCharCode(65 + i)}) {stripOptionPrefix(opt, i) || opt}</div>
                      ))}
                    </div>
                  )}
                  {question.left_column && question.right_column && question.left_column.length > 0 && (
                    <div className="ml-2 mb-2 flex gap-6 text-sm">
                      <div>
                        <div className="font-medium text-gray-700 mb-1">Column A</div>
                        {question.left_column.map((item, i) => (
                          <div key={i}>{i + 1}. {item}</div>
                        ))}
                      </div>
                      <div>
                        <div className="font-medium text-gray-700 mb-1">Column B</div>
                        {question.right_column.map((item, i) => (
                          <div key={i}>{String.fromCharCode(65 + i)}. {item}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {question.related_criteria && question.related_criteria.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-200">
                      <div className="text-sm font-medium text-purple-600 mb-1">Assesses Rubric Criteria:</div>
                      <div className="flex flex-wrap gap-1">
                        {question.related_criteria.map((criterion, critIdx) => (
                          <span key={critIdx} className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
                            {criterion}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {question.hints && question.hints.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-200">
                      <div className="text-sm font-medium text-gray-600 mb-1">Hints:</div>
                      <ul className="list-disc list-inside text-sm text-gray-600">
                        {question.hints.map((hint, hintIdx) => (
                          <li key={hintIdx}>{hint}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {generatedAssessment.suggested_rubric_criteria && generatedAssessment.suggested_rubric_criteria.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold text-gray-800 mb-4">Suggested Rubric Criteria</h3>
              <div className="space-y-3">
                {generatedAssessment.suggested_rubric_criteria.map((criterion, idx) => (
                  <div key={idx} className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-semibold text-gray-800">{criterion.name}</span>
                      <span className="text-sm font-medium text-blue-600">{criterion.max_points} points</span>
                    </div>
                    <p className="text-sm text-gray-700">{criterion.description}</p>
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

export default AssessmentGenerator;
