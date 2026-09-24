import React, { useEffect, useState } from 'react';
import { coursesAPI, Course } from '../services/api';

/** Library filter value: every course, only unfiled items, or one course id. */
export type CourseFilter = 'all' | 'none' | number;

export function useCourses(): Course[] {
  const [courses, setCourses] = useState<Course[]>([]);
  useEffect(() => {
    coursesAPI.list().then((res) => setCourses(res.data.courses || [])).catch(() => setCourses([]));
  }, []);
  return courses;
}

export function filterByCourse<T extends { course_id?: number | null }>(items: T[], filter: CourseFilter): T[] {
  if (filter === 'all') return items;
  if (filter === 'none') return items.filter((i) => !i.course_id);
  return items.filter((i) => i.course_id === filter);
}

/** Sort so each course's items sit together (unfiled last), for grouped rendering. */
export function sortByCourse<T extends { course_id?: number | null; course_name?: string | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (!a.course_id !== !b.course_id) return a.course_id ? -1 : 1;
    return String(a.course_name || '').localeCompare(String(b.course_name || ''));
  });
}

export const courseLabel = (item: { course_id?: number | null; course_name?: string | null }) =>
  item.course_id ? (item.course_name || `Course ${item.course_id}`) : 'No course';

export function CourseFilterSelect({ courses, value, onChange, className = '' }: {
  courses: Course[];
  value: CourseFilter;
  onChange: (v: CourseFilter) => void;
  className?: string;
}) {
  return (
    <select
      value={String(value)}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === 'all' || v === 'none' ? v : Number(v));
      }}
      className={`px-2 py-1 border border-gray-300 rounded text-xs bg-white ${className}`}
      aria-label="Filter by course"
    >
      <option value="all">All courses</option>
      {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      <option value="none">No course</option>
    </select>
  );
}

/** Small per-item control to file an item under a course (or none). */
export function CourseAssignSelect({ courses, value, onChange, disabled }: {
  courses: Course[];
  value: number | null | undefined;
  onChange: (courseId: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      className="px-2 py-1 border border-gray-300 rounded text-xs bg-white max-w-[160px]"
      title="Move to a course"
      aria-label="Course for this item"
    >
      <option value="">No course</option>
      {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

export function CourseGroupHeading({ label }: { label: string }) {
  return <li className="pt-2 first:pt-0 text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</li>;
}
