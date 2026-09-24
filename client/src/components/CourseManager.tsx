import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, Plus, Trash2, Upload, Users } from 'lucide-react';
import {
  coursesAPI,
  assessmentsAPI,
  Course,
  CourseStaffMember,
  CourseEnrollment,
  GradeCategory,
  GradeItem,
  GradebookRow,
  getApiErrorMessage,
} from '../services/api';
import { useNotification } from '../contexts/NotificationContext';
import { useAuth } from '../contexts/AuthContext';

type Tab = 'roster' | 'grading' | 'gradebook';

const CourseManager: React.FC = () => {
  const { notifySuccess, notifyError } = useNotification();
  const { user } = useAuth();
  const isStudent = (user?.role || '').toLowerCase() === 'student';
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('roster');

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newTerm, setNewTerm] = useState('');
  const [creating, setCreating] = useState(false);

  const [staff, setStaff] = useState<CourseStaffMember[]>([]);
  const [enrollments, setEnrollments] = useState<CourseEnrollment[]>([]);
  const [enrollEmails, setEnrollEmails] = useState('');
  const [enrolling, setEnrolling] = useState(false);

  const [categories, setCategories] = useState<GradeCategory[]>([]);
  const [items, setItems] = useState<GradeItem[]>([]);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryWeight, setNewCategoryWeight] = useState(0);
  const [publishedAssessments, setPublishedAssessments] = useState<any[]>([]);
  const [newItemAssessmentId, setNewItemAssessmentId] = useState<number | ''>('');
  const [newItemCategoryId, setNewItemCategoryId] = useState<number | ''>('');
  const [newItemMaxPoints, setNewItemMaxPoints] = useState<number | ''>('');

  const [gradebook, setGradebook] = useState<GradebookRow[]>([]);
  const [gradebookLoading, setGradebookLoading] = useState(false);

  const loadCourses = async () => {
    setLoading(true);
    try {
      const res = await coursesAPI.list();
      if (res.data.success) setCourses(res.data.courses);
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to load courses'), 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCourses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await coursesAPI.create({ name: newName.trim(), code: newCode.trim() || undefined, term: newTerm.trim() || undefined });
      if (res.data.success) {
        setCourses((prev) => [res.data.course, ...prev]);
        setShowCreate(false);
        setNewName('');
        setNewCode('');
        setNewTerm('');
        notifySuccess('Course created', 'Success');
      }
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to create course'), 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const openCourse = async (course: Course) => {
    setSelectedCourse(course);
    if (isStudent) {
      // Students only ever see the gradebook tab — roster/grade-setup
      // endpoints are staff-only and would 403 for a student anyway.
      setActiveTab('gradebook');
      return;
    }
    setActiveTab('roster');
    try {
      const [detail, enrollRes, catRes, itemRes, publishedRes] = await Promise.all([
        coursesAPI.get(course.id),
        coursesAPI.listEnrollments(course.id),
        coursesAPI.listGradeCategories(course.id),
        coursesAPI.listGradeItems(course.id),
        assessmentsAPI.getPublished(),
      ]);
      if (detail.data.success) setStaff(detail.data.staff);
      if (enrollRes.data.success) setEnrollments(enrollRes.data.enrollments);
      if (catRes.data.success) setCategories(catRes.data.categories);
      if (itemRes.data.success) setItems(itemRes.data.items);
      const pub = (publishedRes.data as any)?.items || (publishedRes.data as any)?.assessments || [];
      setPublishedAssessments(Array.isArray(pub) ? pub : []);
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to load course'), 'Load failed');
    }
  };

  const [csvFileName, setCsvFileName] = useState('');
  const csvFileRef = useRef<HTMLInputElement>(null);

  const handleCsvFile = async (file: File) => {
    const text = await file.text();
    // Pull every email-shaped token out of the file rather than parsing CSV
    // structure strictly — this handles a bare list, "email" column with a
    // header, or a "name,email" export equally well with no dependency.
    const found = text.match(/[^\s,;<>"]+@[^\s,;<>"]+\.[^\s,;<>"]+/g) || [];
    const emails = Array.from(new Set(found.map((e) => e.trim().replace(/[.,;]+$/, ''))));
    if (emails.length === 0) {
      notifyError('No email addresses found in that file', 'Nothing to import');
      return;
    }
    setCsvFileName(file.name);
    setEnrollEmails((prev) => {
      const existing = prev.split(/[,\n]/).map((e) => e.trim()).filter(Boolean);
      return Array.from(new Set([...existing, ...emails])).join('\n');
    });
    notifySuccess(`Found ${emails.length} email address(es) — review the list below, then click Enroll`, 'CSV parsed');
  };

  const handleEnroll = async () => {
    if (!selectedCourse) return;
    const emails = enrollEmails.split(/[,\n]/).map((e) => e.trim()).filter(Boolean);
    if (emails.length === 0) return;
    setEnrolling(true);
    try {
      const res = await coursesAPI.enroll(selectedCourse.id, emails);
      const failed = res.data.results.filter((r) => !r.success);
      if (failed.length > 0) {
        notifyError(`${failed.length} could not be enrolled: ${failed.map((f) => f.email).join(', ')}`, 'Some enrollments failed');
      } else {
        notifySuccess(`Enrolled ${res.data.results.length} student(s)`, 'Success');
      }
      setEnrollEmails('');
      setCsvFileName('');
      const enrollRes = await coursesAPI.listEnrollments(selectedCourse.id);
      if (enrollRes.data.success) setEnrollments(enrollRes.data.enrollments);
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to enroll students'), 'Enroll failed');
    } finally {
      setEnrolling(false);
    }
  };

  const handleUnenroll = async (studentUserId: number) => {
    if (!selectedCourse) return;
    try {
      await coursesAPI.unenroll(selectedCourse.id, studentUserId);
      setEnrollments((prev) => prev.filter((e) => e.student_user_id !== studentUserId));
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to remove student'), 'Remove failed');
    }
  };

  const handleAddCategory = async () => {
    if (!selectedCourse || !newCategoryName.trim()) return;
    try {
      const res = await coursesAPI.createGradeCategory(selectedCourse.id, { name: newCategoryName.trim(), weight_percent: newCategoryWeight });
      if (res.data.success) {
        setCategories((prev) => [...prev, res.data.category]);
        setNewCategoryName('');
        setNewCategoryWeight(0);
      }
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to add grade category'), 'Add failed');
    }
  };

  const handleRemoveCategory = async (categoryId: number) => {
    if (!selectedCourse) return;
    try {
      await coursesAPI.removeGradeCategory(selectedCourse.id, categoryId);
      setCategories((prev) => prev.filter((c) => c.id !== categoryId));
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to remove category'), 'Remove failed');
    }
  };

  const handleAddItem = async () => {
    if (!selectedCourse || !newItemAssessmentId) return;
    const assessment = publishedAssessments.find((a) => a.id === newItemAssessmentId);
    try {
      const res = await coursesAPI.createGradeItem(selectedCourse.id, {
        grade_category_id: newItemCategoryId || null,
        item_type: 'assessment',
        item_id: Number(newItemAssessmentId),
        title: assessment?.title || undefined,
        max_points: newItemMaxPoints ? Number(newItemMaxPoints) : undefined,
      });
      if (res.data.success) {
        setItems((prev) => [...prev, res.data.item]);
        setNewItemAssessmentId('');
        setNewItemMaxPoints('');
      }
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to add grade item'), 'Add failed');
    }
  };

  const handleRemoveItem = async (itemId: number) => {
    if (!selectedCourse) return;
    try {
      await coursesAPI.removeGradeItem(selectedCourse.id, itemId);
      setItems((prev) => prev.filter((i) => i.id !== itemId));
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to remove grade item'), 'Remove failed');
    }
  };

  const loadGradebook = async () => {
    if (!selectedCourse) return;
    setGradebookLoading(true);
    try {
      const res = await coursesAPI.getGradebook(selectedCourse.id);
      if (res.data.success) {
        setGradebook(res.data.grades);
        if (isStudent) setItems(res.data.items);
      }
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to load gradebook'), 'Load failed');
    } finally {
      setGradebookLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'gradebook') loadGradebook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedCourse]);

  if (selectedCourse) {
    return (
      <div className="w-full">
        <button
          type="button"
          onClick={() => setSelectedCourse(null)}
          className="mb-4 inline-flex items-center text-sm text-gray-500 hover:text-gray-700"
        >
          <ChevronLeft className="h-4 w-4" />
          All courses
        </button>

        <div className="bg-white rounded-2xl shadow-sm p-6 mb-6 border border-gray-200/70">
          <h1 className="text-2xl font-bold text-gray-800">{selectedCourse.name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {[selectedCourse.code, selectedCourse.term].filter(Boolean).join(' · ') || 'No code or term set'}
          </p>

          {!isStudent && (
            <div className="mt-4 flex gap-2 border-b border-gray-200">
              {(['roster', 'grading', 'gradebook'] as Tab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    activeTab === tab ? 'border-primary-600 text-primary-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab === 'roster' ? 'Roster' : tab === 'grading' ? 'Grade Setup' : 'Gradebook'}
                </button>
              ))}
            </div>
          )}
        </div>

        {!isStudent && activeTab === 'roster' && (
          <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-200/70">
            <h2 className="text-sm font-semibold text-gray-800 mb-3">Enroll students</h2>
            <div className="flex flex-col sm:flex-row gap-2 mb-2">
              <textarea
                value={enrollEmails}
                onChange={(e) => setEnrollEmails(e.target.value)}
                placeholder="student1@example.com, student2@example.com"
                rows={2}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              />
              <button
                type="button"
                onClick={handleEnroll}
                disabled={enrolling}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary-600 text-white font-semibold hover:bg-primary-700 disabled:opacity-50 shadow-sm transition-colors"
              >
                <Plus className="h-4 w-4" />
                Enroll
              </button>
            </div>
            <div className="mb-4">
              <input
                ref={csvFileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleCsvFile(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => csvFileRef.current?.click()}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-700 hover:text-primary-800"
              >
                <Upload className="h-3.5 w-3.5" />
                Import from CSV{csvFileName ? ` — ${csvFileName}` : ''}
              </button>
            </div>
            <p className="text-xs text-gray-400 mb-4">Students must already have an account. Separate multiple emails with commas or newlines, or import a CSV (a roster export, or a plain list of emails).</p>

            <h2 className="text-sm font-semibold text-gray-800 mb-3">Roster ({enrollments.length})</h2>
            {enrollments.length === 0 ? (
              <p className="text-sm text-gray-500">No students enrolled yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {enrollments.map((e) => (
                  <div key={e.id} className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-sm text-gray-800">{e.name}</p>
                      <p className="text-xs text-gray-500">{e.email}</p>
                    </div>
                    <button type="button" onClick={() => handleUnenroll(e.student_user_id)} className="text-gray-400 hover:text-red-600">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {staff.length > 0 && (
              <>
                <h2 className="text-sm font-semibold text-gray-800 mt-6 mb-3">Course staff</h2>
                <div className="divide-y divide-gray-100">
                  {staff.map((s) => (
                    <div key={s.user_id} className="py-2 text-sm text-gray-700">
                      {s.name} <span className="text-gray-400">({s.role})</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {!isStudent && activeTab === 'grading' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-200/70">
              <h2 className="text-sm font-semibold text-gray-800 mb-3">Grade categories</h2>
              <div className="flex gap-2 mb-4">
                <input
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="e.g. Assignments"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
                />
                <input
                  type="number"
                  value={newCategoryWeight}
                  onChange={(e) => setNewCategoryWeight(Number(e.target.value))}
                  placeholder="%"
                  className="w-20 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
                />
                <button type="button" onClick={handleAddCategory} className="px-3 py-2 rounded-lg bg-primary-600 text-white hover:bg-primary-700 shadow-sm transition-colors">
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              {categories.length === 0 ? (
                <p className="text-sm text-gray-500">No categories yet.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {categories.map((c) => (
                    <div key={c.id} className="flex items-center justify-between py-2 text-sm">
                      <span className="text-gray-800">{c.name}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-gray-500">{c.weight_percent}%</span>
                        <button type="button" onClick={() => handleRemoveCategory(c.id)} className="text-gray-400 hover:text-red-600">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {categories.length > 0 && (
                <p className="text-xs text-gray-400 mt-3">
                  Total weight: {categories.reduce((sum, c) => sum + c.weight_percent, 0)}%
                </p>
              )}
            </div>

            <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-200/70">
              <h2 className="text-sm font-semibold text-gray-800 mb-3">Grade items</h2>
              <div className="space-y-2 mb-4">
                <select
                  value={newItemAssessmentId}
                  onChange={(e) => setNewItemAssessmentId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
                >
                  <option value="">Select a published assessment...</option>
                  {publishedAssessments.map((a) => (
                    <option key={a.id} value={a.id}>{a.title || `Assessment #${a.id}`}</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <select
                    value={newItemCategoryId}
                    onChange={(e) => setNewItemCategoryId(e.target.value ? Number(e.target.value) : '')}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
                  >
                    <option value="">No category</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    value={newItemMaxPoints}
                    onChange={(e) => setNewItemMaxPoints(e.target.value ? Number(e.target.value) : '')}
                    placeholder="Max points"
                    className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
                  />
                  <button type="button" onClick={handleAddItem} className="px-3 py-2 rounded-lg bg-primary-600 text-white hover:bg-primary-700 shadow-sm transition-colors">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {items.length === 0 ? (
                <p className="text-sm text-gray-500">No grade items yet.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {items.map((i) => (
                    <div key={i.id} className="flex items-center justify-between py-2 text-sm">
                      <div>
                        <span className="text-gray-800">{i.title || `Item #${i.id}`}</span>
                        {i.max_points && <span className="text-gray-400"> · {i.max_points} pts</span>}
                      </div>
                      <button type="button" onClick={() => handleRemoveItem(i.id)} className="text-gray-400 hover:text-red-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'gradebook' && (
          <div className="bg-white rounded-2xl shadow-sm p-6 overflow-x-auto border border-gray-200/70">
            {gradebookLoading ? (
              <p className="text-sm text-gray-500">Loading...</p>
            ) : gradebook.length === 0 ? (
              <p className="text-sm text-gray-500">No enrolled students yet, or no grade items scored.</p>
            ) : (
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-4">Student</th>
                    {items.map((i) => (
                      <th key={i.id} className="py-2 pr-4">{i.title || `Item #${i.id}`}</th>
                    ))}
                    <th className="py-2 pr-4">Final grade</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {gradebook.map((row) => (
                    <tr key={row.student_user_id}>
                      <td className="py-2 pr-4 text-gray-800">{row.name}</td>
                      {items.map((i) => (
                        <td key={i.id} className="py-2 pr-4 text-gray-600">
                          {row.item_scores[i.id] === null || row.item_scores[i.id] === undefined ? '—' : row.item_scores[i.id]}
                        </td>
                      ))}
                      <td className="py-2 pr-4 font-medium text-gray-800">
                        {row.final_grade_percent === null ? '—' : `${row.final_grade_percent}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="bg-white rounded-2xl shadow-sm p-6 mb-6 border border-gray-200/70">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <BookOpen className="w-8 h-8 text-primary-600" />
            <h1 className="text-2xl font-bold text-gray-900">Courses</h1>
          </div>
          {!isStudent && (
            <button
              type="button"
              onClick={() => setShowCreate((v) => !v)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-600 text-white font-semibold hover:bg-primary-700 shadow-sm transition-colors"
            >
              <Plus className="h-4 w-4" />
              New course
            </button>
          )}
        </div>
        <p className="text-gray-600">
          {isStudent
            ? 'View your enrolled courses and track your grades.'
            : 'Manage enrollment, weighted grading, and the gradebook for each course.'}
        </p>

        {!isStudent && showCreate && (
          <div className="mt-4 p-4 border border-gray-200 rounded-lg grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Course name *"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
            />
            <input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              placeholder="Code (e.g. CS101)"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
            />
            <input
              value={newTerm}
              onChange={(e) => setNewTerm(e.target.value)}
              placeholder="Term (e.g. 2026 S2)"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="sm:col-span-3 px-4 py-2 rounded-lg bg-primary-600 text-white font-semibold hover:bg-primary-700 disabled:opacity-50 shadow-sm transition-colors"
            >
              {creating ? 'Creating...' : 'Create course'}
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : courses.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-sm p-8 text-center text-sm text-gray-500 border border-gray-200/70">
          No courses yet — create one to start enrolling students and building a gradebook.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {courses.map((course) => (
            <button
              key={course.id}
              onClick={() => openCourse(course)}
              className="text-left bg-white rounded-2xl shadow-sm p-5 hover:shadow-md transition-shadow border border-gray-200/70"
            >
              <h3 className="text-lg font-semibold text-gray-800">{course.name}</h3>
              <p className="text-xs text-gray-400 mt-0.5">{[course.code, course.term].filter(Boolean).join(' · ') || 'No code or term'}</p>
              <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-gray-500">
                <Users className="h-3.5 w-3.5" />
                {course.status}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default CourseManager;
