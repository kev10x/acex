import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, ChevronRight,
  ClipboardCheck, ExternalLink, FileText,
  Globe, Link2, Loader2, LogIn, LogOut,
  RefreshCw, Send, Trash2, Upload,
} from 'lucide-react';
import {
  GradeEntry,
  MoodleAssignment,
  MoodleConnection,
  MoodleCourse,
  MoodleQuiz,
  MoodleUser,
  moodleAPI,
} from '../services/api';

type Panel = 'courses' | 'grade-sync' | 'import-xml';

interface GradeRow {
  student_name: string;
  grade: string;
  feedback: string;
  moodle_user_id?: number;
  matched_name?: string;
  match_confidence: 'exact' | 'fuzzy' | 'none';
}

// ── Fuzzy matching ────────────────────────────────────────────
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
}

function matchUser(name: string, users: MoodleUser[]): { user: MoodleUser | null; confidence: GradeRow['match_confidence'] } {
  const n = normalize(name);
  // Exact
  const exact = users.find((u) => normalize(u.fullname) === n || normalize(u.email) === n);
  if (exact) return { user: exact, confidence: 'exact' };
  // Contains
  const partial = users.find(
    (u) => normalize(u.fullname).includes(n) || n.includes(normalize(u.fullname))
  );
  if (partial) return { user: partial, confidence: 'fuzzy' };
  return { user: null, confidence: 'none' };
}

// ── Main component ────────────────────────────────────────────
const MoodleIntegration: React.FC = () => {
  // Connection
  const [connection, setConnection] = useState<MoodleConnection | null>(null);
  const [connectForm, setConnectForm] = useState({ moodle_url: '', moodle_token: '' });
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Courses panel
  const [courses, setCourses] = useState<MoodleCourse[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [selectedCourse, setSelectedCourse] = useState<MoodleCourse | null>(null);
  const [assignments, setAssignments] = useState<MoodleAssignment[]>([]);
  const [quizzes, setQuizzes] = useState<MoodleQuiz[]>([]);
  const [loadingContent, setLoadingContent] = useState(false);
  const [expandedSection, setExpandedSection] = useState<'assignments' | 'quizzes' | null>('assignments');

  // Grade sync panel
  const [syncCourse, setSyncCourse] = useState<number | ''>('');
  const [syncAssignment, setSyncAssignment] = useState<MoodleAssignment | null>(null);
  const [syncAssignments, setSyncAssignments] = useState<MoodleAssignment[]>([]);
  const [enrolledUsers, setEnrolledUsers] = useState<MoodleUser[]>([]);
  const [gradesCsv, setGradesCsv] = useState('');
  const [gradeRows, setGradeRows] = useState<GradeRow[]>([]);
  const [loadingSync, setLoadingSync] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushResult, setPushResult] = useState<{ pushed: number } | null>(null);

  // XML import panel
  const [xmlInput, setXmlInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ title: string; question_count: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Generic
  const [activePanel, setActivePanel] = useState<Panel>('courses');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void loadSettings(); }, []);

  const loadSettings = async () => {
    try {
      const res = await moodleAPI.getSettings();
      setConnection(res.data.connection);
      if (res.data.connection) {
        setConnectForm((f) => ({ ...f, moodle_url: res.data.connection!.moodle_url }));
      }
    } catch { /* ignore */ }
  };

  // ── Connect / Disconnect ──────────────────────────────────
  const handleConnect = async () => {
    const url = connectForm.moodle_url.trim();
    const token = connectForm.moodle_token.trim();
    if (!url || !token) { setError('Please enter both Moodle URL and API token.'); return; }
    setConnecting(true);
    setError(null);
    try {
      const res = await moodleAPI.saveSettings({ moodle_url: url, moodle_token: token });
      setConnection({ moodle_url: res.data.moodle_url, site_name: res.data.site_name, moodle_user_id: res.data.moodle_user_id });
      setConnectForm((f) => ({ ...f, moodle_token: '' }));
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Remove Moodle connection?')) return;
    setDisconnecting(true);
    try {
      await moodleAPI.deleteSettings();
      setConnection(null);
      setCourses([]);
      setSelectedCourse(null);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  // ── Courses ───────────────────────────────────────────────
  const loadCourses = async () => {
    setLoadingCourses(true);
    setError(null);
    try {
      const res = await moodleAPI.getCourses();
      setCourses(res.data.courses);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load courses');
    } finally {
      setLoadingCourses(false);
    }
  };

  const selectCourse = async (course: MoodleCourse) => {
    setSelectedCourse(course);
    setAssignments([]);
    setQuizzes([]);
    setLoadingContent(true);
    setError(null);
    try {
      const [aRes, qRes] = await Promise.all([
        moodleAPI.getAssignments(course.id),
        moodleAPI.getQuizzes(course.id),
      ]);
      setAssignments(aRes.data.assignments);
      setQuizzes(qRes.data.quizzes);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load course content');
    } finally {
      setLoadingContent(false);
    }
  };

  // ── Grade sync ────────────────────────────────────────────
  const loadSyncCourse = async (courseId: number) => {
    setSyncCourse(courseId);
    setSyncAssignment(null);
    setSyncAssignments([]);
    setEnrolledUsers([]);
    setGradeRows([]);
    setLoadingSync(true);
    setError(null);
    try {
      const [aRes, uRes] = await Promise.all([
        moodleAPI.getAssignments(courseId),
        moodleAPI.getCourseUsers(courseId),
      ]);
      setSyncAssignments(aRes.data.assignments);
      setEnrolledUsers(uRes.data.users);
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Failed to load sync data');
    } finally {
      setLoadingSync(false);
    }
  };

  const parseAndMatchGrades = () => {
    const rows: GradeRow[] = [];
    for (const line of gradesCsv.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(',').map((p) => p.trim());
      const student_name = parts[0] || '';
      const grade = parts[1] || '';
      const feedback = parts.slice(2).join(',').trim();
      if (!student_name || !grade) continue;
      const { user, confidence } = matchUser(student_name, enrolledUsers);
      rows.push({
        student_name,
        grade,
        feedback,
        moodle_user_id: user?.id,
        matched_name: user?.fullname,
        match_confidence: confidence,
      });
    }
    setGradeRows(rows);
    setPushResult(null);
  };

  const handlePushGrades = async () => {
    if (!syncAssignment) return;
    const valid: GradeEntry[] = gradeRows
      .filter((r) => r.moodle_user_id && r.match_confidence !== 'none' && !isNaN(Number(r.grade)))
      .map((r) => ({ moodle_user_id: r.moodle_user_id!, grade: Number(r.grade), feedback: r.feedback }));

    if (valid.length === 0) { setError('No matched grades to push.'); return; }
    setPushing(true);
    setError(null);
    try {
      const res = await moodleAPI.pushGrades({ assignment_cmid: syncAssignment.cmid, grades: valid });
      setPushResult({ pushed: res.data.pushed });
      setGradeRows([]);
      setGradesCsv('');
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Grade push failed');
    } finally {
      setPushing(false);
    }
  };

  // ── XML Import ────────────────────────────────────────────
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setXmlInput(String(ev.target?.result || ''));
    reader.readAsText(file);
  };

  const handleImportXml = async () => {
    if (!xmlInput.trim()) { setError('Please paste or upload a Moodle XML file.'); return; }
    setImporting(true);
    setError(null);
    setImportResult(null);
    try {
      const res = await moodleAPI.importXml(xmlInput);
      setImportResult({ title: res.data.title, question_count: res.data.question_count });
      setXmlInput('');
    } catch (e: any) {
      setError(e.response?.data?.error || e.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  // ── Render helpers ────────────────────────────────────────
  const connected = !!connection;

  const panelBtn = (p: Panel, label: string) => (
    <button
      type="button"
      onClick={() => { setActivePanel(p); setError(null); }}
      className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
        activePanel === p
          ? 'bg-indigo-600 text-white shadow-sm'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {label}
    </button>
  );

  // ── Main render ───────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-5xl">

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Connection card ── */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-5 h-5 text-indigo-600" />
          <h2 className="text-base font-semibold text-gray-900">Moodle Connection</h2>
          {connected && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
              Connected — {connection.site_name || connection.moodle_url}
            </span>
          )}
        </div>

        {!connected ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Enter your Moodle site URL and a web services token. In Moodle, enable web services under
              Site administration → Plugins → Web services → Overview, then create a token for an external application.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Moodle Site URL</label>
                <input
                  value={connectForm.moodle_url}
                  onChange={(e) => setConnectForm((f) => ({ ...f, moodle_url: e.target.value }))}
                  placeholder="https://moodle.yourschool.edu"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">API Token</label>
                <input
                  value={connectForm.moodle_token}
                  onChange={(e) => setConnectForm((f) => ({ ...f, moodle_token: e.target.value }))}
                  type="password"
                  placeholder="32-character token"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
            </div>
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {connecting ? 'Connecting…' : 'Test & Connect'}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 text-sm text-gray-600">
              <span className="font-medium">{connection.site_name}</span>
              <span className="text-gray-400 ml-2">{connection.moodle_url}</span>
            </div>
            <a
              href={connection.moodle_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              Open Moodle <ExternalLink className="w-3 h-3" />
            </a>
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* ── Panels (only when connected) ── */}
      {connected && (
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          {/* Panel tabs */}
          <div className="flex items-center gap-1 p-3 border-b border-gray-200 bg-gray-50">
            {panelBtn('courses', 'Browse Courses')}
            {panelBtn('grade-sync', 'Sync Grades →')}
            {panelBtn('import-xml', '← Import Quiz XML')}
          </div>

          <div className="p-5">

            {/* ── COURSES PANEL ── */}
            {activePanel === 'courses' && (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-gray-800">Your Moodle Courses</h3>
                  <button
                    type="button"
                    onClick={loadCourses}
                    disabled={loadingCourses}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    {loadingCourses ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                    {courses.length === 0 ? 'Load Courses' : 'Refresh'}
                  </button>
                </div>

                {courses.length === 0 && !loadingCourses && (
                  <p className="text-sm text-gray-500">Click "Load Courses" to fetch your enrolled Moodle courses.</p>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {courses.map((course) => (
                    <button
                      key={course.id}
                      type="button"
                      onClick={() => selectCourse(course)}
                      className={`text-left p-3 rounded-xl border transition-colors ${
                        selectedCourse?.id === course.id
                          ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <p className="text-sm font-semibold text-gray-800">{course.fullname}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{course.shortname}</p>
                      {course.summary && (
                        <p className="text-xs text-gray-400 mt-1 line-clamp-2">{course.summary}</p>
                      )}
                    </button>
                  ))}
                </div>

                {/* Course content */}
                {selectedCourse && (
                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-2.5 flex items-center gap-2">
                      <Link2 className="w-4 h-4 text-indigo-600" />
                      <span className="text-sm font-semibold text-gray-900">{selectedCourse.fullname}</span>
                      {loadingContent && <Loader2 className="w-4 h-4 animate-spin text-indigo-400 ml-auto" />}
                    </div>

                    {/* Assignments */}
                    <div className="border-b border-gray-100">
                      <button
                        type="button"
                        onClick={() => setExpandedSection(expandedSection === 'assignments' ? null : 'assignments')}
                        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        {expandedSection === 'assignments' ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        <FileText className="w-4 h-4 text-primary-500" />
                        Assignments ({assignments.length})
                      </button>
                      {expandedSection === 'assignments' && (
                        <div className="px-4 pb-3 space-y-1.5">
                          {assignments.length === 0 && !loadingContent ? (
                            <p className="text-xs text-gray-400">No assignments in this course.</p>
                          ) : (
                            assignments.map((a) => (
                              <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 bg-white">
                                <div>
                                  <p className="text-sm font-medium text-gray-800">{a.name}</p>
                                  {a.duedate > 0 && (
                                    <p className="text-xs text-gray-400">
                                      Due: {new Date(a.duedate * 1000).toLocaleDateString()}
                                    </p>
                                  )}
                                </div>
                                <span className="text-xs text-gray-400 tabular-nums">ID {a.id}</span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    {/* Quizzes */}
                    <div>
                      <button
                        type="button"
                        onClick={() => setExpandedSection(expandedSection === 'quizzes' ? null : 'quizzes')}
                        className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        {expandedSection === 'quizzes' ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        <ClipboardCheck className="w-4 h-4 text-emerald-500" />
                        Quizzes ({quizzes.length})
                      </button>
                      {expandedSection === 'quizzes' && (
                        <div className="px-4 pb-3 space-y-1.5">
                          {quizzes.length === 0 && !loadingContent ? (
                            <p className="text-xs text-gray-400">No quizzes in this course.</p>
                          ) : (
                            quizzes.map((q) => (
                              <div key={q.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2 bg-white">
                                <div>
                                  <p className="text-sm font-medium text-gray-800">{q.name}</p>
                                  {q.intro && <p className="text-xs text-gray-400 line-clamp-1">{q.intro}</p>}
                                </div>
                                <span className="text-xs text-gray-400 tabular-nums">{q.sumgrades ?? 0}pts</span>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── GRADE SYNC PANEL ── */}
            {activePanel === 'grade-sync' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-gray-800 mb-1">Push Grades to Moodle</h3>
                  <p className="text-xs text-gray-500">
                    Select a course and assignment, paste your grade data (one student per line:
                    <code className="mx-1 bg-gray-100 px-1 rounded">Student Name, Grade, Feedback</code>),
                    confirm the mapping, then push to Moodle's gradebook.
                  </p>
                </div>

                {/* Step 1: Select course */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">1. Select Course</label>
                    <select
                      value={syncCourse}
                      onChange={(e) => e.target.value ? loadSyncCourse(Number(e.target.value)) : setSyncCourse('')}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
                    >
                      <option value="">— Select course —</option>
                      {courses.map((c) => <option key={c.id} value={c.id}>{c.fullname}</option>)}
                    </select>
                    {courses.length === 0 && (
                      <p className="text-xs text-gray-400 mt-1">
                        Load courses first from the Browse Courses tab.
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">2. Select Assignment</label>
                    <select
                      value={syncAssignment?.id ?? ''}
                      onChange={(e) => {
                        const a = syncAssignments.find((x) => x.id === Number(e.target.value));
                        setSyncAssignment(a || null);
                        setPushResult(null);
                        setGradeRows([]);
                      }}
                      disabled={!syncCourse || loadingSync}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:opacity-50"
                    >
                      <option value="">— Select assignment —</option>
                      {syncAssignments.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    {loadingSync && <p className="text-xs text-gray-400 mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</p>}
                  </div>
                </div>

                {/* Step 2: Grade data */}
                {syncAssignment && (
                  <div className="space-y-2">
                    <label className="block text-xs font-medium text-gray-600">
                      3. Paste Grade Data (CSV — Name, Grade, Feedback)
                    </label>
                    <textarea
                      value={gradesCsv}
                      onChange={(e) => { setGradesCsv(e.target.value); setGradeRows([]); setPushResult(null); }}
                      rows={6}
                      placeholder={`# One student per line\nJohn Smith, 78, Great effort!\nJane Doe, 92, Excellent work.\nAlex Johnson, 55`}
                      className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-y"
                    />
                    <button
                      type="button"
                      onClick={parseAndMatchGrades}
                      disabled={!gradesCsv.trim()}
                      className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Match Students
                    </button>
                  </div>
                )}

                {/* Step 3: Mapping table */}
                {gradeRows.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                        Student Mapping ({gradeRows.filter((r) => r.match_confidence !== 'none').length}/{gradeRows.length} matched)
                      </h4>
                      <span className="text-xs text-gray-400">{enrolledUsers.length} enrolled in Moodle</span>
                    </div>
                    <div className="overflow-x-auto rounded-lg border border-gray-200">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th className="text-left px-3 py-2 font-semibold text-gray-600">MarkMate Student</th>
                            <th className="text-left px-3 py-2 font-semibold text-gray-600">Moodle User</th>
                            <th className="text-right px-3 py-2 font-semibold text-gray-600">Grade</th>
                            <th className="text-left px-3 py-2 font-semibold text-gray-600">Feedback</th>
                            <th className="px-3 py-2" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {gradeRows.map((row, i) => (
                            <tr key={i} className={row.match_confidence === 'none' ? 'bg-red-50' : row.match_confidence === 'fuzzy' ? 'bg-amber-50' : ''}>
                              <td className="px-3 py-2 font-medium text-gray-800">{row.student_name}</td>
                              <td className="px-3 py-2 text-gray-600">
                                {row.matched_name || <span className="text-red-500 italic">No match found</span>}
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums font-medium">{row.grade}</td>
                              <td className="px-3 py-2 text-gray-500 max-w-[200px] truncate">{row.feedback || '—'}</td>
                              <td className="px-3 py-2 text-right">
                                {row.match_confidence === 'exact' && <Check className="w-3.5 h-3.5 text-emerald-500 inline" />}
                                {row.match_confidence === 'fuzzy' && (
                                  <span title="Fuzzy match — please verify">
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 inline" />
                                  </span>
                                )}
                                {row.match_confidence === 'none' && (
                                  <span title="Will not be pushed">
                                    <Trash2 className="w-3.5 h-3.5 text-red-400 inline" />
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-gray-500">
                      <Check className="w-3 h-3 text-emerald-500 inline mr-1" />exact match ·
                      <AlertTriangle className="w-3 h-3 text-amber-500 inline mx-1" />fuzzy match (verify) ·
                      <Trash2 className="w-3 h-3 text-red-400 inline mx-1" />no match (skipped)
                    </p>

                    {pushResult && (
                      <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
                        <Check className="w-4 h-4" />
                        Successfully pushed {pushResult.pushed} grade{pushResult.pushed !== 1 ? 's' : ''} to Moodle.
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={handlePushGrades}
                      disabled={pushing || gradeRows.filter((r) => r.match_confidence !== 'none').length === 0}
                      className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {pushing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      {pushing ? 'Pushing…' : `Push ${gradeRows.filter((r) => r.match_confidence !== 'none').length} Grade(s) to Moodle`}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── XML IMPORT PANEL ── */}
            {activePanel === 'import-xml' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-gray-800 mb-1">Import Questions from Moodle XML</h3>
                  <p className="text-xs text-gray-500">
                    In Moodle, go to <strong>Question Bank → Export → Moodle XML format</strong>, download the file,
                    then paste or upload it here. The questions will be saved to your Assessment history.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    <Upload className="w-4 h-4" />
                    Upload XML file
                  </button>
                  <input ref={fileRef} type="file" accept=".xml,text/xml" className="hidden" onChange={handleFileChange} />
                  <span className="text-xs text-gray-400">or paste below</span>
                </div>

                <textarea
                  value={xmlInput}
                  onChange={(e) => { setXmlInput(e.target.value); setImportResult(null); }}
                  rows={10}
                  placeholder={`<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n  <question type="multichoice">\n    ...\n  </question>\n</quiz>`}
                  className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-y"
                />

                {importResult && (
                  <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
                    <Check className="w-4 h-4 shrink-0" />
                    <span>
                      Imported <strong>{importResult.question_count} question{importResult.question_count !== 1 ? 's' : ''}</strong> from
                      &ldquo;{importResult.title}&rdquo; — find it in the <em>Generate Assessments → History</em> tab.
                    </span>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleImportXml}
                  disabled={importing || !xmlInput.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
                  {importing ? 'Importing…' : 'Import Questions'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MoodleIntegration;
