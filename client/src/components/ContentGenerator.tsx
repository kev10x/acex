import React, { useState, useEffect, useRef } from 'react';
import { FileText, Loader2, Video, Link2, Upload, X, Presentation, BookOpen, Trash2, CalendarClock } from 'lucide-react';
import { contentAPI, rubricsAPI, GeneratedContent, ContentPlannerJob, ContentTemplate } from '../services/api';

const LEVEL_OPTIONS = [
  { value: '', label: 'Any level' },
  { value: 'ECD', label: 'ECD (Early Childhood Development)' },
  { value: 'Foundation Phase', label: 'Foundation Phase' },
  { value: 'Grade 8', label: 'Grade 8' },
  { value: 'Grade 10', label: 'Grade 10' },
  { value: 'Grade 12', label: 'Grade 12' },
  { value: 'Undergraduate', label: 'Undergraduate' },
  { value: 'Postgraduate', label: 'Postgraduate' },
];

const ContentGenerator: React.FC = () => {
  const [topics, setTopics] = useState('');
  const [level, setLevel] = useState('');
  const [numSections, setNumSections] = useState(5);
  const [rubricId, setRubricId] = useState<number | null>(null);
  const [includeVideo, setIncludeVideo] = useState(false);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [templateId, setTemplateId] = useState('classroom');
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<GeneratedContent | null>(null);
  const [publishedLink, setPublishedLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rubrics, setRubrics] = useState<any[]>([]);
  const [myContent, setMyContent] = useState<{ id: number; code: string; title: string; created_at: string }[]>([]);
  const [plannerJobs, setPlannerJobs] = useState<ContentPlannerJob[]>([]);
  const [scheduledFor, setScheduledFor] = useState('');
  const [isScheduling, setIsScheduling] = useState(false);
  const [cancellingPlannerJobId, setCancellingPlannerJobId] = useState<number | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [deletingContentId, setDeletingContentId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadRubrics();
    loadMyContent();
    loadPlannerJobs();
    loadTemplates();
  }, []);

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
    setIsGenerating(true);
    setGeneratedContent(null);
    try {
      if (templateFile) {
        await contentAPI.uploadTemplate(templateFile);
      }
      const res = await contentAPI.generate({
        topics: topicsTrim,
        level: level || undefined,
        num_sections: numSections,
        rubric_id: rubricId || undefined,
        template_id: templateId || undefined,
      });
      if (res.data.success && res.data.content) {
        setGeneratedContent(res.data.content);
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
      const res = await contentAPI.publish({
        content: generatedContent,
        rubric_id: rubricId || undefined,
        include_video: withVideo,
      });
      if (res.data.success && res.data.code) {
        const link = res.data.link;
        const base = typeof window !== 'undefined' && window.location.pathname.startsWith('/tools') ? '/tools' : '';
        setPublishedLink(link && link.startsWith('http') ? link : `${window.location.origin}${base}/take-content?code=${res.data.code}`);
        loadMyContent();
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

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <Presentation className="w-8 h-8 text-teal-600" />
          <h1 className="text-3xl font-bold text-gray-800">Content Generator</h1>
        </div>
        <p className="text-gray-600 mb-6">
          Create course content from topics: slide decks, lecture notes, and an interactive student view. Optionally add AI-generated video and upload a PowerPoint template for slides.
        </p>

        {myContent.length > 0 && (
          <div className="mb-6 p-4 bg-teal-50 border border-teal-200 rounded-lg">
            <h3 className="text-sm font-semibold text-teal-900 mb-2">My published content (reuse links)</h3>
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
          </div>
        )}

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
                {LEVEL_OPTIONS.map((o) => (
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
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-teal-500"
              >
                {(templates.length > 0 ? templates : [{ id: 'classroom', name: 'Classroom Fresh', theme: {} }]).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
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
                checked={includeVideo}
                onChange={(e) => setIncludeVideo(e.target.checked)}
                className="w-4 h-4 text-teal-600 border-gray-300 rounded"
              />
              <Video className="w-4 h-4 text-gray-500" />
              <span className="text-sm text-gray-700">Include AI video (Sora) when publishing</span>
            </label>
            <div className="flex items-center gap-2">
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
                className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white hover:bg-gray-50"
              >
                <Upload className="w-4 h-4" />
                Upload PPT template
              </button>
              {templateFile && (
                <span className="text-sm text-gray-600 flex items-center gap-1">
                  {templateFile.name}
                  <button type="button" onClick={() => setTemplateFile(null)} className="text-red-600"><X className="w-4 h-4" /></button>
                </span>
              )}
            </div>
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
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
            <h2 className="text-xl font-bold text-gray-800">{generatedContent.title}</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => handleExport('pptx')}
                disabled={!!exporting}
                className="flex items-center gap-2 px-3 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50"
              >
                {exporting === 'pptx' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Presentation className="w-4 h-4" />}
                Download PPTX
              </button>
              <button
                onClick={() => handleExport('lecture-notes')}
                disabled={!!exporting}
                className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {exporting === 'lecture-notes' ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookOpen className="w-4 h-4" />}
                Lecture notes
              </button>
              <button
                onClick={handleExportScorm}
                disabled={!!exporting}
                className="flex items-center gap-2 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
              >
                {exporting === 'scorm' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Presentation className="w-4 h-4" />}
                SCORM package
              </button>
              <button
                onClick={() => handlePublish(false)}
                className="flex items-center gap-2 px-3 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700"
              >
                <Link2 className="w-4 h-4" />
                Publish for students
              </button>
              <button
                onClick={() => handlePublish(true)}
                className="flex items-center gap-2 px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                <Video className="w-4 h-4" />
                Publish with video
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
          <div className="space-y-4">
            {(generatedContent.sections || []).map((sec: any, i: number) => (
              <div key={i} className="border border-gray-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-800 mb-1">{sec.heading || sec.title || 'Section'}</h3>
                {sec.support && <p className="text-gray-600 text-sm mb-2">{sec.support}</p>}
                <p className="text-gray-700 whitespace-pre-wrap text-sm">{sec.body}</p>
                {Array.isArray(sec.visuals) && sec.visuals.length > 0 && (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    {sec.visuals.map((visual: any, visualIdx: number) => (
                      <div key={visualIdx} className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
                        {visual.image_url && (
                          <img
                            src={visual.image_url}
                            alt={visual.alt_text || visual.title || `${visual.kind || 'visual'} for section ${i + 1}`}
                            className="w-full h-36 object-cover"
                          />
                        )}
                        <div className="p-2">
                          <div className="text-xs font-semibold text-gray-700 uppercase">{visual.kind || 'visual'}</div>
                          {visual.title && <div className="text-sm text-gray-800">{visual.title}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
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
        </div>
      )}

    </div>
  );
};

export default ContentGenerator;
