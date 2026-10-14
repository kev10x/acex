import React, { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Plus, Trash2, Users } from 'lucide-react';
import { cohortsAPI, coursesAPI, Cohort, CohortMember, Course, CohortEnrolResult } from '../services/api';

const errMsg = (e: unknown, fallback: string) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const btnPrimary = 'inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50';
const btnGhost = 'inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50';

function parseEmails(text: string): string[] {
  const found = text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  return Array.from(new Set(found));
}

export default function Cohorts() {
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newIntake, setNewIntake] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    cohortsAPI.list().then((res) => setCohorts(res.data.cohorts)).catch((e) => setError(errMsg(e, 'Could not load cohorts'))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError('');
    try {
      await cohortsAPI.create({ name: newName.trim(), code: newCode.trim() || undefined, intake_date: newIntake || undefined });
      setNewName(''); setNewCode(''); setNewIntake('');
      load();
    } catch (e) {
      setError(errMsg(e, 'Could not create the cohort'));
    } finally {
      setCreating(false);
    }
  };

  if (activeId) return <CohortDetail id={activeId} onBack={() => { setActiveId(null); load(); }} />;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2"><Users className="h-6 w-6 text-indigo-600" /> Cohorts</h1>
        <p className="mt-1 text-sm text-gray-500">A cohort is a reusable group of students, such as an intake. Build the roster once, then enrol the whole group into one or more courses.</p>

        {error && <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}

        <form onSubmit={create} className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Cohort name</label>
            <input className={inputCls} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. 2026 January Intake" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Code (optional)</label>
            <input className={inputCls} value={newCode} onChange={(e) => setNewCode(e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Intake date</label>
            <input type="date" className={inputCls} value={newIntake} onChange={(e) => setNewIntake(e.target.value)} />
          </div>
          <button type="submit" className={btnPrimary} disabled={creating || !newName.trim()}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create
          </button>
        </form>

        <div className="mt-6">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>
          ) : cohorts.length === 0 ? (
            <p className="text-sm text-gray-500 py-8 text-center">No cohorts yet. Create one above.</p>
          ) : (
            <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
              {cohorts.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => setActiveId(c.id)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50">
                    <span>
                      <span className="font-semibold text-gray-900">{c.name}</span>
                      {c.code && <span className="ml-2 text-xs text-gray-400">{c.code}</span>}
                      {c.intake_date && <span className="ml-2 text-xs text-gray-500">Intake: {c.intake_date}</span>}
                    </span>
                    <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">{c.member_count ?? 0} student{(c.member_count ?? 0) === 1 ? '' : 's'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CohortDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const [cohort, setCohort] = useState<Cohort | null>(null);
  const [members, setMembers] = useState<CohortMember[]>([]);
  const [courses, setCourses] = useState<{ id: number; name: string; code: string | null }[]>([]);
  const [allCourses, setAllCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [emailText, setEmailText] = useState('');
  const [adding, setAdding] = useState(false);
  const [selectedCourseId, setSelectedCourseId] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([cohortsAPI.get(id), coursesAPI.list()])
      .then(([res, coursesRes]) => {
        setCohort(res.data.cohort);
        setMembers(res.data.members);
        setCourses(res.data.courses);
        setAllCourses(coursesRes.data.courses);
      })
      .catch((e) => setError(errMsg(e, 'Could not load this cohort')))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  const addMembers = async (e: React.FormEvent) => {
    e.preventDefault();
    const emails = parseEmails(emailText);
    if (emails.length === 0) return;
    setAdding(true);
    setError('');
    setNotice('');
    try {
      const res = await cohortsAPI.addMembers(id, emails);
      const results: CohortEnrolResult[] = res.data.results;
      const ok = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success);
      setNotice(`Added ${ok} student${ok === 1 ? '' : 's'}.` + (failed.length ? ` ${failed.length} failed: ${failed.map((f) => f.email).join(', ')}` : ''));
      setEmailText('');
      load();
    } catch (e) {
      setError(errMsg(e, 'Could not add students'));
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async (studentUserId: number) => {
    try {
      await cohortsAPI.removeMember(id, studentUserId);
      load();
    } catch (e) {
      setError(errMsg(e, 'Could not remove this student'));
    }
  };

  const enrolInCourse = async () => {
    if (!selectedCourseId) return;
    setEnrolling(true);
    setError('');
    setNotice('');
    try {
      const res = await cohortsAPI.enrolCourse(id, Number(selectedCourseId));
      const results: CohortEnrolResult[] = res.data.results;
      const ok = results.filter((r) => r.success).length;
      const failed = results.filter((r) => !r.success);
      setNotice(`Enrolled ${ok} of ${results.length} cohort member${results.length === 1 ? '' : 's'}.` + (failed.length ? ` Failed: ${failed.map((f) => f.email).join(', ')}` : ''));
      load();
    } catch (e) {
      setError(errMsg(e, 'Could not enrol this cohort'));
    } finally {
      setEnrolling(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this cohort? Its enrolments remain, but will no longer be grouped under it.')) return;
    setDeleting(true);
    try {
      await cohortsAPI.delete(id);
      onBack();
    } catch (e) {
      setError(errMsg(e, 'Could not delete this cohort'));
      setDeleting(false);
    }
  };

  const enrolledCourseIds = new Set(courses.map((c) => c.id));
  const enrolableCourses = allCourses.filter((c) => !enrolledCourseIds.has(c.id));

  return (
    <div className="max-w-4xl mx-auto">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" /> All cohorts
      </button>
      <div className="bg-white rounded-lg shadow-lg p-6">
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>
        ) : !cohort ? (
          <p className="text-sm text-gray-500">Not found.</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold text-gray-800">{cohort.name}</h1>
                <p className="mt-1 text-sm text-gray-500">{cohort.code ? `${cohort.code} · ` : ''}{members.length} student{members.length === 1 ? '' : 's'}{cohort.intake_date ? ` · Intake ${cohort.intake_date}` : ''}</p>
              </div>
              <button type="button" onClick={remove} disabled={deleting} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete cohort
              </button>
            </div>

            {error && <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}
            {notice && <div className="mt-4 rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">{notice}</div>}

            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <div>
                <h2 className="text-sm font-semibold text-gray-800">Roster</h2>
                <form onSubmit={addMembers} className="mt-2 space-y-2">
                  <textarea className={inputCls} rows={3} value={emailText} onChange={(e) => setEmailText(e.target.value)} placeholder="Paste student emails, separated by commas or new lines" />
                  <button type="submit" className={btnPrimary} disabled={adding || parseEmails(emailText).length === 0}>
                    {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add to roster
                  </button>
                </form>
                <ul className="mt-4 divide-y divide-gray-100 rounded-lg border border-gray-200 max-h-80 overflow-y-auto">
                  {members.length === 0 ? (
                    <li className="px-3 py-4 text-sm text-gray-400 text-center">No students yet.</li>
                  ) : members.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 truncate text-sm text-gray-700" title={m.email}>{m.name || m.email}</span>
                      <button type="button" onClick={() => removeMember(m.id)} className="shrink-0 text-gray-400 hover:text-red-600" title="Remove from cohort"><Trash2 className="h-3.5 w-3.5" /></button>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h2 className="text-sm font-semibold text-gray-800">Enrol this cohort into a course</h2>
                <p className="mt-1 text-xs text-gray-500">Every student on the roster is enrolled, and new accounts are invited by email.</p>
                <div className="mt-2 flex gap-2">
                  <select className={inputCls} value={selectedCourseId} onChange={(e) => setSelectedCourseId(e.target.value)}>
                    <option value="">Choose a course</option>
                    {enrolableCourses.map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} · ${c.name}` : c.name}</option>)}
                  </select>
                  <button type="button" onClick={enrolInCourse} disabled={!selectedCourseId || enrolling || members.length === 0} className={btnPrimary}>
                    {enrolling ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Enrol'}
                  </button>
                </div>

                <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-gray-500">Already enrolled in</h3>
                {courses.length === 0 ? (
                  <p className="mt-2 text-sm text-gray-400">Not enrolled in any course yet.</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {courses.map((c) => <li key={c.id} className="text-sm text-gray-700">{c.code ? `${c.code} · ${c.name}` : c.name}</li>)}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
