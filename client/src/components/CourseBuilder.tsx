import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Circle, Loader2, Plus, RefreshCw, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { courseBuilderAPI, CourseBuildConfig, CourseBuildJob } from '../services/api';
import { EDUCATION_LEVEL_OPTIONS } from '../constants/educationLevels';

type ModuleDraft = CourseBuildConfig['modules'][number];
const STEPS = ['Course', 'Modules', 'Options', 'Students', 'Review'] as const;
const MAX_MODULES = 15;

const emptyModule = (): ModuleDraft => ({ name: '', lesson_topics: '', quiz_topics: '', lesson: true, quiz: true });
const errMsg = (e: unknown, fallback: string) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;

function parseEmails(text: string): string[] {
  const found = text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  return Array.from(new Set(found));
}

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const labelCls = 'block text-sm font-medium text-gray-700 mb-1';
const btnPrimary = 'inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed';
const btnGhost = 'inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50';

function StatusIcon({ status }: { status: string }) {
  if (status === 'done') return <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />;
  if (status === 'running') return <Loader2 className="h-5 w-5 text-indigo-600 animate-spin shrink-0" />;
  if (status === 'failed') return <AlertCircle className="h-5 w-5 text-red-600 shrink-0" />;
  if (status === 'skipped') return <Circle className="h-5 w-5 text-gray-200 shrink-0" />;
  return <Circle className="h-5 w-5 text-gray-300 shrink-0" />;
}

export default function CourseBuilder({ onOpenCourses }: { onOpenCourses: () => void }) {
  const [step, setStep] = useState(0);
  const [course, setCourse] = useState({ name: '', code: '', term: '', description: '' });
  const [moduleCount, setModuleCount] = useState(5);
  const [modules, setModules] = useState<ModuleDraft[]>([]);
  const [options, setOptions] = useState({ level: '', lesson_sections: 4, lesson_images: true, quiz_questions: 5, summary_videos: false });
  const [studentText, setStudentText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<CourseBuildJob | null>(null);
  const pollRef = useRef<number | null>(null);

  const students = useMemo(() => parseEmails(studentText), [studentText]);
  const lessonCount = modules.filter((m) => m.lesson).length;
  const quizCount = modules.filter((m) => m.quiz).length;
  const videoCount = options.summary_videos ? lessonCount * options.lesson_sections * 2 : 0;
  const estMinutes = Math.ceil(lessonCount * 2.5 + quizCount * 1);

  // Reattach to a build that is still running (e.g. after a page refresh).
  useEffect(() => {
    courseBuilderAPI.list().then((res) => {
      const active = res.data.jobs.find((j) => j.status === 'queued' || j.status === 'running' || j.status === 'interrupted');
      if (active) setJob(active);
    }).catch(() => { /* wizard still usable */ });
  }, []);

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await courseBuilderAPI.get(job.id);
        setJob(res.data.job);
      } catch { /* transient; try again next tick */ }
    }, 4000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [job?.id, job?.status]);

  const updateModule = (i: number, patch: Partial<ModuleDraft>) =>
    setModules((prev) => prev.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));

  const draftOutline = async () => {
    setError('');
    setDrafting(true);
    try {
      const res = await courseBuilderAPI.outline({ name: course.name, description: course.description, module_count: moduleCount, level: options.level });
      setModules(res.data.modules.map((m) => ({ ...m, lesson: true, quiz: true })));
      if (!course.description.trim() && res.data.description) setCourse((c) => ({ ...c, description: res.data.description }));
    } catch (e) {
      setError(errMsg(e, 'Could not draft an outline'));
    } finally {
      setDrafting(false);
    }
  };

  const config = (): CourseBuildConfig => ({
    course, modules: modules.filter((m) => m.name.trim()), options, students,
  });

  const start = async () => {
    setError('');
    setStarting(true);
    try {
      const res = await courseBuilderAPI.start(config());
      const fresh = await courseBuilderAPI.get(res.data.job_id);
      setJob(fresh.data.job);
    } catch (e) {
      setError(errMsg(e, 'Could not start the build'));
    } finally {
      setStarting(false);
    }
  };

  const resume = async () => {
    if (!job) return;
    setError('');
    try {
      await courseBuilderAPI.resume(job.id);
      const fresh = await courseBuilderAPI.get(job.id);
      setJob(fresh.data.job);
    } catch (e) {
      setError(errMsg(e, 'Could not resume the build'));
    }
  };

  const reset = () => {
    setJob(null); setStep(0); setModules([]); setStudentText('');
    setCourse({ name: '', code: '', term: '', description: '' }); setError('');
  };

  // ---- Build progress view ----
  if (job) {
    const p = job.progress;
    const finished = job.status === 'completed';
    const busy = job.status === 'queued' || job.status === 'running';
    const failedCount = p?.modules.filter((m) => m.status === 'failed').length || 0;
    return (
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-800">{job.course_name || 'Building your course'}</h1>
              <p className="text-sm text-gray-500 mt-1">
                {busy && 'Building. You can leave this page; the build carries on in the background.'}
                {finished && (failedCount ? `Finished with ${failedCount} module${failedCount > 1 ? 's' : ''} needing attention.` : 'Your course is ready.')}
                {job.status === 'failed' && 'The build stopped with an error.'}
                {job.status === 'interrupted' && 'The build was interrupted by a server restart.'}
              </p>
            </div>
            {busy && <Loader2 className="h-6 w-6 text-indigo-600 animate-spin" />}
          </div>

          {job.error_message && !busy && (
            <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">{job.error_message}</div>
          )}
          {error && <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}

          {p && (
            <ul className="mt-6 space-y-3">
              <li className="flex items-center gap-3 text-sm"><StatusIcon status={p.course.status} /> Create the course</li>
              {p.category.status !== 'skipped' && (
                <li className="flex items-center gap-3 text-sm"><StatusIcon status={p.category.status} /> Set up grading (Quizzes category)</li>
              )}
              {p.modules.map((m, i) => (
                <li key={i} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center gap-3 text-sm font-medium text-gray-800"><StatusIcon status={m.status} /> {i + 1}. {m.name}</div>
                  <div className="mt-2 ml-8 flex flex-wrap gap-4 text-xs text-gray-600">
                    {m.lesson !== 'skipped' && <span className="inline-flex items-center gap-1"><StatusIcon status={m.lesson} /> Lesson</span>}
                    {m.quiz !== 'skipped' && <span className="inline-flex items-center gap-1"><StatusIcon status={m.quiz} /> Quiz</span>}
                  </div>
                  {m.error && <p className="mt-2 ml-8 text-xs text-red-600">{m.error}</p>}
                </li>
              ))}
              {p.students.status !== 'skipped' && (
                <li className="flex items-start gap-3 text-sm">
                  <StatusIcon status={p.students.status} />
                  <span>
                    Enrol students
                    {p.students.status === 'done' && (
                      <span className="block text-xs text-gray-500">
                        {p.students.enrolled} enrolled, {p.students.invited} new invites, {p.students.emailed} emails sent
                        {p.students.failed ? `, ${p.students.failed} failed (${(p.students.failed_emails || []).join(', ')})` : ''}
                      </span>
                    )}
                    {p.students.error && <span className="block text-xs text-red-600">{p.students.error}</span>}
                  </span>
                </li>
              )}
            </ul>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            {(job.status === 'interrupted' || job.status === 'failed' || (finished && failedCount > 0)) && (
              <button className={btnPrimary} onClick={resume}><RefreshCw className="h-4 w-4" /> {finished ? 'Retry failed steps' : 'Resume'}</button>
            )}
            {finished && <button className={btnPrimary} onClick={onOpenCourses}>Open Courses</button>}
            {!busy && <button className={btnGhost} onClick={reset}>Build another course</button>}
          </div>
        </div>
      </div>
    );
  }

  // ---- Wizard ----
  const canNext = [
    course.name.trim().length > 0,
    modules.some((m) => m.name.trim()),
    true,
    true,
    true,
  ][step];

  return (
    <div className="max-w-3xl mx-auto">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><Wand2 className="h-6 w-6 text-indigo-600" /> Course Builder</h1>
        <p className="text-sm text-gray-500 mt-1">Set a course up in one pass. The AI writes a lesson and a quiz for every module, then enrols your students.</p>

        <ol className="mt-6 flex items-center gap-2 text-xs">
          {STEPS.map((label, i) => (
            <li key={label} className={`flex-1 rounded-full px-3 py-1.5 text-center font-medium ${i === step ? 'bg-indigo-600 text-white' : i < step ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500'}`}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>

        {error && <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}

        <div className="mt-6 space-y-4">
          {step === 0 && (
            <>
              <div><label className={labelCls}>Course name</label><input className={inputCls} value={course.name} onChange={(e) => setCourse({ ...course, name: e.target.value })} placeholder="e.g. Introduction to Cybersecurity" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className={labelCls}>Code (optional)</label><input className={inputCls} value={course.code} onChange={(e) => setCourse({ ...course, code: e.target.value })} /></div>
                <div><label className={labelCls}>Term (optional)</label><input className={inputCls} value={course.term} onChange={(e) => setCourse({ ...course, term: e.target.value })} placeholder="e.g. 2026 Semester 1" /></div>
              </div>
              <div><label className={labelCls}>What is it about? (helps the AI plan)</label><textarea className={inputCls} rows={3} value={course.description} onChange={(e) => setCourse({ ...course, description: e.target.value })} /></div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="flex flex-wrap items-end gap-3 rounded-lg bg-indigo-50 p-4">
                <div>
                  <label className={labelCls}>How many modules?</label>
                  <input type="number" min={1} max={MAX_MODULES} className={`${inputCls} w-24`} value={moduleCount} onChange={(e) => setModuleCount(Math.max(1, Math.min(MAX_MODULES, Number(e.target.value) || 1)))} />
                </div>
                <button className={btnPrimary} onClick={draftOutline} disabled={drafting}>
                  {drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {modules.length ? 'Redraft outline with AI' : 'Draft outline with AI'}
                </button>
                <p className="text-xs text-gray-600 basis-full">Or add modules by hand below. You can edit everything the AI suggests.</p>
              </div>

              {modules.map((m, i) => (
                <div key={i} className="rounded-lg border border-gray-200 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-500">{i + 1}</span>
                    <input className={inputCls} value={m.name} onChange={(e) => updateModule(i, { name: e.target.value })} placeholder="Module name" />
                    <button className="text-gray-400 hover:text-red-600" title="Remove module" onClick={() => setModules((prev) => prev.filter((_, idx) => idx !== i))}><Trash2 className="h-4 w-4" /></button>
                  </div>
                  <div>
                    <label className="flex items-center gap-2 text-xs font-medium text-gray-600"><input type="checkbox" checked={m.lesson} onChange={(e) => updateModule(i, { lesson: e.target.checked })} /> Lesson: what should it cover?</label>
                    <textarea className={`${inputCls} mt-1`} rows={2} disabled={!m.lesson} value={m.lesson_topics} onChange={(e) => updateModule(i, { lesson_topics: e.target.value })} />
                  </div>
                  <div>
                    <label className="flex items-center gap-2 text-xs font-medium text-gray-600"><input type="checkbox" checked={m.quiz} onChange={(e) => updateModule(i, { quiz: e.target.checked })} /> Quiz: what should it test?</label>
                    <textarea className={`${inputCls} mt-1`} rows={2} disabled={!m.quiz} value={m.quiz_topics} onChange={(e) => updateModule(i, { quiz_topics: e.target.value })} />
                  </div>
                </div>
              ))}
              {modules.length < MAX_MODULES && (
                <button className={btnGhost} onClick={() => setModules((prev) => [...prev, emptyModule()])}><Plus className="h-4 w-4" /> Add module</button>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <label className={labelCls}>Audience level</label>
                <select className={inputCls} value={options.level} onChange={(e) => setOptions({ ...options, level: e.target.value })}>
                  {EDUCATION_LEVEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className={labelCls}>Sections per lesson</label><input type="number" min={2} max={8} className={inputCls} value={options.lesson_sections} onChange={(e) => setOptions({ ...options, lesson_sections: Math.max(2, Math.min(8, Number(e.target.value) || 4)) })} /></div>
                <div><label className={labelCls}>Questions per quiz</label><input type="number" min={3} max={15} className={inputCls} value={options.quiz_questions} onChange={(e) => setOptions({ ...options, quiz_questions: Math.max(3, Math.min(15, Number(e.target.value) || 5)) })} /></div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={options.lesson_images} onChange={(e) => setOptions({ ...options, lesson_images: e.target.checked })} /> Include AI diagrams and images in lessons</label>
              <div className="rounded-lg border border-gray-200 p-4">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700"><input type="checkbox" checked={options.summary_videos} onChange={(e) => setOptions({ ...options, summary_videos: e.target.checked })} /> Add a 15 second animated summary video to each lesson section</label>
                <p className="mt-1 ml-6 text-xs text-gray-500">
                  Uses xAI credits and is slow. This build would queue about {lessonCount * options.lesson_sections * 2} videos (roughly 2 per section), generated in the background after the course is built.
                  You can also turn this on later from the lesson publishing screen.
                </p>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <label className={labelCls}>Student email addresses (optional)</label>
                <textarea className={inputCls} rows={6} value={studentText} onChange={(e) => setStudentText(e.target.value)} placeholder="Paste emails separated by commas, spaces or new lines" />
                <p className="mt-1 text-xs text-gray-500">{students.length} valid address{students.length === 1 ? '' : 'es'}. New students get an email inviting them to set their name and password.</p>
              </div>
            </>
          )}

          {step === 4 && (
            <div className="space-y-3 text-sm text-gray-700">
              <div className="rounded-lg bg-gray-50 p-4">
                <p className="font-semibold text-gray-800">{course.name}{course.code ? ` (${course.code})` : ''}</p>
                <ul className="mt-2 list-disc ml-5 space-y-1">
                  {modules.filter((m) => m.name.trim()).map((m, i) => (
                    <li key={i}>{m.name} <span className="text-gray-500">({[m.lesson && 'lesson', m.quiz && 'quiz'].filter(Boolean).join(' + ') || 'empty'})</span></li>
                  ))}
                </ul>
              </div>
              <p>{lessonCount} lessons of {options.lesson_sections} sections, {quizCount} quizzes of {options.quiz_questions} questions, {students.length} student{students.length === 1 ? '' : 's'} to enrol.</p>
              <p>Estimated time: about {estMinutes} minutes{videoCount ? `, plus ${videoCount} summary videos generated afterwards` : ''}. This uses AI credits for each lesson and quiz.</p>
            </div>
          )}
        </div>

        <div className="mt-8 flex justify-between">
          <button className={btnGhost} onClick={() => { setError(''); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0}>Back</button>
          {step < STEPS.length - 1 ? (
            <button className={btnPrimary} disabled={!canNext} onClick={() => { setError(''); setStep((s) => s + 1); }}>Next</button>
          ) : (
            <button className={btnPrimary} onClick={start} disabled={starting}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Build course
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
