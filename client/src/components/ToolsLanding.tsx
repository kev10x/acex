import React from 'react';
import { ArrowUpRight, BarChart3, Brain, LogOut, Presentation, Shield } from 'lucide-react';
import BrandMark, { ProfileAvatarButton } from './BrandMark';

type AppRole = 'management' | 'lecturer' | 'student';

interface ToolCard {
  id: string;
  label: string;
  tagline: string;
  description: string;
  studentLabel?: string;
  studentTagline?: string;
  studentDescription?: string;
  icon: React.ComponentType<{ className?: string }>;
  tileGradient: string;
  tileShadow: string;
  path: string;
  roles: AppRole[];
}

const TOOLS: ToolCard[] = [
  {
    id: 'marking',
    label: 'Marking Tool',
    tagline: 'Upload · Rubrics · Mark · Results',
    description:
      'Bring student work into the pipeline, build memorandums, run AI or manual marking, and export grades.',
    icon: BarChart3,
    tileGradient: 'from-primary-500 to-accent-600',
    tileShadow: 'shadow-[0_8px_20px_-6px_rgba(79,70,229,0.55)]',
    path: '/tools/marking',
    roles: ['management', 'lecturer']
  },
  {
    id: 'content',
    label: 'Learning Studio',
    tagline: 'Assessments · Practicals · Content · Modules · Courses · Moodle',
    description:
      'Generate assessments, practical activities, and lesson content with AI, then organise them into modules and courses with a weighted gradebook.',
    studentLabel: 'Acexen LMS',
    studentTagline: 'Modules · Courses · Assessments · Results',
    studentDescription: 'Access your learning modules and courses, complete assessments, and view your results and grades.',
    icon: Presentation,
    tileGradient: 'from-emerald-500 to-teal-600',
    tileShadow: 'shadow-[0_8px_20px_-6px_rgba(16,185,129,0.55)]',
    path: '/tools/content',
    roles: ['management', 'lecturer', 'student']
  },
  {
    id: 'labs',
    label: 'Labs & Advanced Tools',
    tagline: 'MCQ · Model Training · Video Generation',
    description:
      'Process multiple-choice answer sheets, export curated data for model-training workflows, and generate short AI video clips.',
    icon: Brain,
    tileGradient: 'from-amber-500 to-orange-600',
    tileShadow: 'shadow-[0_8px_20px_-6px_rgba(245,158,11,0.55)]',
    path: '/tools/labs',
    roles: ['management', 'lecturer']
  },
  {
    id: 'admin',
    label: 'Admin Dashboard',
    tagline: 'Organisations · Permissions · System Health',
    description:
      'Manage organisations, approvals, user permissions, and monitor overall system health.',
    icon: Shield,
    tileGradient: 'from-slate-600 to-slate-800',
    tileShadow: 'shadow-[0_8px_20px_-6px_rgba(51,65,85,0.5)]',
    path: '/tools/admin',
    roles: ['management']
  }
];

interface ToolsLandingProps {
  role: AppRole;
  userName: string;
  orgName?: string;
  onNavigate: (path: string) => void;
  onLogout: () => void;
}

export default function ToolsLanding({
  role,
  userName,
  orgName,
  onNavigate,
  onLogout
}: ToolsLandingProps) {
  const visibleTools = TOOLS.filter((t) => t.roles.includes(role));
  const firstName = String(userName || '').trim().split(/[\s@]/)[0] || 'there';
  const initial = firstName.charAt(0).toUpperCase();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const roleLabel = role === 'management' ? 'Management' : role === 'student' ? 'Student' : 'Lecturer';

  return (
    <div className="min-h-screen bg-app">
      <header className="sticky top-0 z-40 border-b border-gray-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <BrandMark size={34} />
            <div>
              <div className="text-[15px] font-bold leading-tight text-gray-900">Acexen</div>
              <div className="hidden text-[11px] leading-tight text-gray-500 sm:block">The Academic Excellence Engine</div>
            </div>
            {orgName && (
              <>
                <span className="hidden h-6 w-px bg-gray-200 md:block" />
                <span className="hidden truncate text-sm font-medium text-gray-500 md:block">{orgName}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="hidden rounded-full bg-primary-50 px-2.5 py-1 text-xs font-semibold text-primary-700 ring-1 ring-inset ring-primary-100 sm:inline-flex">
              {roleLabel}
            </span>
            <ProfileAvatarButton initial={initial} className="h-8 w-8 rounded-full text-xs" />
            <button
              onClick={onLogout}
              title="Log out"
              className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              <LogOut className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-12 sm:px-6 lg:px-8">
        <div className="mb-10">
          <p className="text-sm font-semibold text-primary-600">{greeting}, {firstName}</p>
          <h1 className="mt-1 text-3xl font-bold text-gray-900 sm:text-4xl">What would you like to work on?</h1>
          <p className="mt-2 max-w-xl text-gray-500">Pick a workspace to get started. Each one opens a focused set of tools.</p>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {visibleTools.map((tool) => {
            const Icon = tool.icon;
            const isStudent = role === 'student';
            const label = (isStudent && tool.studentLabel) ? tool.studentLabel : tool.label;
            const tagline = (isStudent && tool.studentTagline) ? tool.studentTagline : tool.tagline;
            const description = (isStudent && tool.studentDescription) ? tool.studentDescription : tool.description;
            return (
              <button
                key={tool.id}
                onClick={() => onNavigate(tool.path)}
                className="group relative flex flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white p-6 text-left shadow-sm transition-all duration-200 hover:-translate-y-1 hover:border-primary-200 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <div className={`pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-gradient-to-br ${tool.tileGradient} opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-20`} />
                <div className="flex items-start justify-between">
                  <div className={`inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-white ${tool.tileGradient} ${tool.tileShadow}`}>
                    <Icon className="h-6 w-6" />
                  </div>
                  <ArrowUpRight className="h-5 w-5 text-gray-300 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary-600" />
                </div>
                <h3 className="mt-5 text-lg font-semibold text-gray-900">{label}</h3>
                <p className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{tagline}</p>
                <p className="mt-3 text-sm leading-relaxed text-gray-600">{description}</p>
              </button>
            );
          })}
        </div>
      </main>
    </div>
  );
}
