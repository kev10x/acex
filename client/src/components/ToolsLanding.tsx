import React from 'react';
import { BarChart3, Brain, ChevronRight, LogOut, Presentation, Shield, User } from 'lucide-react';

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
  accentBg: string;
  accentText: string;
  accentBorder: string;
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
    accentBg: 'bg-blue-50',
    accentText: 'text-blue-700',
    accentBorder: 'border-blue-200',
    path: '/tools/marking',
    roles: ['management', 'lecturer']
  },
  {
    id: 'content',
    label: 'Learning Studio',
    tagline: 'Assessments · Practicals · Content · Modules · Moodle',
    description:
      'Generate assessments, practical activities, and lesson content with AI, then organise them into learning modules for students.',
    studentLabel: 'Acexen LMS',
    studentTagline: 'Modules · Assessments · Results',
    studentDescription: 'Access your learning modules, complete assessments, and view your results.',
    icon: Presentation,
    accentBg: 'bg-emerald-50',
    accentText: 'text-emerald-700',
    accentBorder: 'border-emerald-200',
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
    accentBg: 'bg-amber-50',
    accentText: 'text-amber-700',
    accentBorder: 'border-amber-200',
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
    accentBg: 'bg-slate-100',
    accentText: 'text-slate-700',
    accentBorder: 'border-slate-300',
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

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 py-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center">
                <h1 className="text-2xl font-bold text-gray-900">MarkMate</h1>
                <span className="ml-2 text-sm text-gray-500">AI-Powered Assignment Marking</span>
              </div>
              {orgName && <p className="mt-1 text-sm text-gray-500">{orgName}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1.5 text-sm text-gray-700">
                <User className="mr-2 h-4 w-4" />
                <span>{userName}</span>
              </div>
              <button
                onClick={onLogout}
                className="flex items-center space-x-2 rounded-md px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900"
              >
                <LogOut className="h-4 w-4" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="mb-10">
          <h2 className="text-3xl font-bold text-gray-900">Choose a tool</h2>
          <p className="mt-2 text-gray-500">Each tool opens its own focused workspace.</p>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
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
                className={`group flex flex-col rounded-2xl border p-6 text-left transition-all hover:shadow-md ${tool.accentBorder} ${tool.accentBg}`}
              >
                <div
                  className={`inline-flex items-center justify-center rounded-xl p-3 mb-4 self-start ${tool.accentBg} ${tool.accentText}`}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className={`text-lg font-semibold ${tool.accentText}`}>{label}</h3>
                    <p className="mt-0.5 text-xs font-medium uppercase tracking-wider text-gray-400">
                      {tagline}
                    </p>
                  </div>
                  <ChevronRight
                    className={`h-5 w-5 mt-1 flex-shrink-0 transition-transform group-hover:translate-x-1 ${tool.accentText}`}
                  />
                </div>
                <p className="mt-3 text-sm text-gray-600 leading-relaxed">{description}</p>
              </button>
            );
          })}
        </div>
      </main>
    </div>
  );
}
