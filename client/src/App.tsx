import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Brain,
  ClipboardCheck,
  Edit3,
  FileText,
  Folder,
  LogOut,
  Presentation,
  Shield,
  Sparkles,
  Upload,
  User,
  Wand2
} from 'lucide-react';
import LoginForm from './components/LoginForm';
import RegisterForm from './components/RegisterForm';
import VerifyEmail from './components/VerifyEmail';
import { AuthProvider, useAuth } from './contexts/AuthContext';

const FileUpload = lazy(() => import('./components/FileUpload'));
const RubricManager = lazy(() => import('./components/RubricManager'));
const MarkingInterface = lazy(() => import('./components/MarkingInterface'));
const ManualMarkingInterface = lazy(() => import('./components/ManualMarkingInterface'));
const ResultsDashboard = lazy(() => import('./components/ResultsDashboard'));
const RubricGenerator = lazy(() => import('./components/RubricGenerator'));
const MCQInterface = lazy(() => import('./components/MCQInterface'));
const BatchManager = lazy(() => import('./components/BatchManager'));
const TrainingDataManager = lazy(() => import('./components/TrainingDataManager'));
const AssessmentGenerator = lazy(() => import('./components/AssessmentGenerator'));
const TakeAssessment = lazy(() => import('./components/TakeAssessment'));
const ContentGenerator = lazy(() => import('./components/ContentGenerator'));
const TakeContent = lazy(() => import('./components/TakeContent'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));

type TabType =
  | 'upload'
  | 'rubrics'
  | 'generator'
  | 'marking'
  | 'manual-marking'
  | 'results'
  | 'mcq'
  | 'batches'
  | 'training'
  | 'assessments'
  | 'content'
  | 'admin';
type AppRole = 'management' | 'lecturer' | 'student';
type WorkspaceType = 'marking' | 'student' | 'labs' | 'admin';
type IconType = typeof BarChart3;

const ROLE_TAB_ACCESS: Record<AppRole, TabType[]> = {
  management: ['upload', 'rubrics', 'generator', 'marking', 'manual-marking', 'results', 'mcq', 'batches', 'training', 'assessments', 'content', 'admin'],
  lecturer: ['upload', 'rubrics', 'generator', 'marking', 'manual-marking', 'results', 'mcq', 'batches', 'training', 'assessments', 'content'],
  student: ['mcq', 'results']
};

const WORKSPACE_ORDER: WorkspaceType[] = ['marking', 'student', 'labs', 'admin'];

const TAB_META: Record<TabType, { label: string; description: string; icon: IconType }> = {
  upload: {
    label: 'Upload Scripts',
    description: 'Bring student work into the marking pipeline.',
    icon: Upload
  },
  rubrics: {
    label: 'Manage Rubrics',
    description: 'Create, refine, and maintain the memorandums you mark against.',
    icon: FileText
  },
  generator: {
    label: 'AI Rubric Generator',
    description: 'Draft rubrics and memorandums faster with AI assistance.',
    icon: Wand2
  },
  marking: {
    label: 'AI Marking',
    description: 'Run automated marking against your selected rubric.',
    icon: BarChart3
  },
  'manual-marking': {
    label: 'Manual Marking',
    description: 'Capture marks and feedback manually when you want full control.',
    icon: Edit3
  },
  results: {
    label: 'Results',
    description: 'Review, moderate, and export marked work.',
    icon: BarChart3
  },
  mcq: {
    label: 'MCQ Forms',
    description: 'Process multiple-choice answer sheets and answer keys.',
    icon: ClipboardCheck
  },
  batches: {
    label: 'Batches',
    description: 'Organise uploads into manageable marking groups.',
    icon: Folder
  },
  training: {
    label: 'Model Training',
    description: 'Export curated data for training and quality-improvement workflows.',
    icon: Brain
  },
  assessments: {
    label: 'Generate Assessments',
    description: 'Prepare and publish student-facing assessments.',
    icon: Sparkles
  },
  content: {
    label: 'Content Generator',
    description: 'Create lesson content and publish learning materials.',
    icon: Presentation
  },
  admin: {
    label: 'Admin Dashboard',
    description: 'Manage organisations, approvals, permissions, and system health.',
    icon: Shield
  }
};

const WORKSPACE_META: Record<WorkspaceType, { label: string; description: string; icon: IconType; accent: string }> = {
  marking: {
    label: 'Marking Workspace',
    description: 'The core lecturer journey: upload, prepare memorandums, mark, review, and export.',
    icon: BarChart3,
    accent: 'bg-blue-50 text-blue-700 border-blue-200'
  },
  student: {
    label: 'Student Workspace',
    description: 'Student-facing assessments, content, and outcome views live here.',
    icon: Presentation,
    accent: 'bg-emerald-50 text-emerald-700 border-emerald-200'
  },
  labs: {
    label: 'Labs and Advanced Tools',
    description: 'Specialist utilities for scanning, training, and advanced workflows.',
    icon: Brain,
    accent: 'bg-amber-50 text-amber-700 border-amber-200'
  },
  admin: {
    label: 'Admin Workspace',
    description: 'Organisation oversight, approvals, permissions, and operational visibility.',
    icon: Shield,
    accent: 'bg-slate-100 text-slate-700 border-slate-300'
  }
};

function TabLoadingFallback() {
  return (
    <div className="min-h-[16rem] flex items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="text-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary-600 mx-auto"></div>
        <p className="mt-3 text-sm text-gray-600">Loading workspace...</p>
      </div>
    </div>
  );
}

function WorkspaceShell({
  activeTab,
  canAccessTab,
  normalizedRole
}: {
  activeTab: TabType;
  canAccessTab: (tab: TabType) => boolean;
  normalizedRole: AppRole;
}) {
  return (
    <Suspense fallback={<TabLoadingFallback />}>
      {activeTab === 'upload' && canAccessTab('upload') && <FileUpload />}
      {activeTab === 'rubrics' && canAccessTab('rubrics') && <RubricManager />}
      {activeTab === 'generator' && canAccessTab('generator') && <RubricGenerator />}
      {activeTab === 'assessments' && canAccessTab('assessments') && <AssessmentGenerator />}
      {activeTab === 'content' && canAccessTab('content') && <ContentGenerator />}
      {activeTab === 'marking' && canAccessTab('marking') && <MarkingInterface />}
      {activeTab === 'manual-marking' && canAccessTab('manual-marking') && <ManualMarkingInterface />}
      {activeTab === 'mcq' && canAccessTab('mcq') && <MCQInterface />}
      {activeTab === 'batches' && canAccessTab('batches') && <BatchManager />}
      {activeTab === 'training' && canAccessTab('training') && <TrainingDataManager />}
      {activeTab === 'results' && canAccessTab('results') && <ResultsDashboard />}
      {activeTab === 'admin' && normalizedRole === 'management' && <AdminDashboard />}
    </Suspense>
  );
}

function AppContent() {
  const [activeTab, setActiveTab] = useState<TabType>('marking');
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceType>('marking');
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'verify'>('login');
  const { user, loading, logout } = useAuth();

  const normalizedRole: AppRole = user?.role === 'admin'
    ? 'management'
    : (user?.role as AppRole) || 'lecturer';

  const canAccessTab = (tab: TabType) => ROLE_TAB_ACCESS[normalizedRole].includes(tab);
  const allowGenerateAssessments = user?.features?.generate_assessments !== false;

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('token') && window.location.pathname.includes('verify-email')) {
      setAuthMode('verify');
    }
  }, []);

  const workspaceTabs = useMemo<Record<WorkspaceType, TabType[]>>(
    () => ({
      marking: ['upload', 'rubrics', 'generator', 'marking', 'manual-marking', 'results', 'batches'].filter((tab) =>
        ROLE_TAB_ACCESS[normalizedRole].includes(tab)
      ),
      student:
        normalizedRole === 'student'
          ? ['results', 'mcq'].filter((tab) => ROLE_TAB_ACCESS[normalizedRole].includes(tab))
          : allowGenerateAssessments
            ? ['assessments', 'content'].filter((tab) => ROLE_TAB_ACCESS[normalizedRole].includes(tab))
            : [],
      labs:
        normalizedRole === 'student'
          ? []
          : ['mcq', 'training'].filter((tab) => ROLE_TAB_ACCESS[normalizedRole].includes(tab)),
      admin: normalizedRole === 'management' ? ['admin'] : []
    }),
    [allowGenerateAssessments, normalizedRole]
  );

  const availableWorkspaces = useMemo(
    () => WORKSPACE_ORDER.filter((workspace) => workspaceTabs[workspace].length > 0),
    [workspaceTabs]
  );

  const currentWorkspaceTabs = workspaceTabs[activeWorkspace] || [];
  const activeTabMeta = TAB_META[activeTab] || TAB_META.results;
  const activeWorkspaceMeta = WORKSPACE_META[activeWorkspace] || WORKSPACE_META.marking;

  useEffect(() => {
    if (!user || availableWorkspaces.length === 0) return;

    const defaultWorkspace =
      normalizedRole === 'student' && availableWorkspaces.includes('student')
        ? 'student'
        : availableWorkspaces[0];
    const activeTabWorkspace = WORKSPACE_ORDER.find((workspace) => workspaceTabs[workspace].includes(activeTab));

    if (!activeTabWorkspace) {
      setActiveWorkspace(defaultWorkspace);
      setActiveTab(workspaceTabs[defaultWorkspace][0]);
      return;
    }

    if (!availableWorkspaces.includes(activeWorkspace)) {
      setActiveWorkspace(defaultWorkspace);
      if (!workspaceTabs[defaultWorkspace].includes(activeTab)) {
        setActiveTab(workspaceTabs[defaultWorkspace][0]);
      }
      return;
    }

    if (activeWorkspace !== activeTabWorkspace) {
      setActiveWorkspace(activeTabWorkspace);
    }
  }, [activeTab, activeWorkspace, availableWorkspaces, normalizedRole, user, workspaceTabs]);

  const switchWorkspace = (workspace: WorkspaceType) => {
    const tabs = workspaceTabs[workspace];
    if (!tabs?.length) return;
    setActiveWorkspace(workspace);
    if (!tabs.includes(activeTab)) {
      setActiveTab(tabs[0]);
    }
  };

  if (typeof window !== 'undefined' && window.location.pathname.includes('take-assessment')) {
    return (
      <Suspense fallback={<TabLoadingFallback />}>
        <TakeAssessment />
      </Suspense>
    );
  }

  if (typeof window !== 'undefined' && window.location.pathname.includes('take-content')) {
    return (
      <Suspense fallback={<TabLoadingFallback />}>
        <TakeContent />
      </Suspense>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    if (authMode === 'verify') {
      return (
        <VerifyEmail
          onBackToLogin={() => {
            setAuthMode('login');
            window.history.replaceState({}, '', window.location.pathname);
          }}
        />
      );
    }

    return authMode === 'login' ? (
      <LoginForm onSwitchToRegister={() => setAuthMode('register')} />
    ) : (
      <RegisterForm onSwitchToLogin={() => setAuthMode('login')} />
    );
  }

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
              {user.organisation_name && (
                <p className="mt-1 text-sm text-gray-500">{user.organisation_name}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1.5 text-sm text-gray-700">
                <User className="mr-2 h-4 w-4" />
                <span>{user.name || user.email}</span>
              </div>
              <div className="inline-flex items-center rounded-full bg-primary-50 px-3 py-1.5 text-sm font-medium text-primary-700">
                {normalizedRole === 'management'
                  ? 'Management'
                  : normalizedRole === 'student'
                    ? 'Student'
                    : 'Lecturer'}
              </div>
              <button
                onClick={logout}
                className="flex items-center space-x-2 rounded-md px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 hover:text-gray-900"
              >
                <LogOut className="h-4 w-4" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex flex-wrap gap-3">
            {availableWorkspaces.map((workspace) => {
              const meta = WORKSPACE_META[workspace];
              const Icon = meta.icon;
              const isActive = workspace === activeWorkspace;

              return (
                <button
                  key={workspace}
                  onClick={() => switchWorkspace(workspace)}
                  className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                    isActive
                      ? `${meta.accent} shadow-sm`
                      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Icon className="h-4 w-4" />
                    <span>{meta.label}</span>
                  </div>
                  <div className="mt-1 max-w-sm text-xs opacity-80">
                    {meta.description}
                  </div>
                </button>
              );
            })}
          </div>

          {currentWorkspaceTabs.length > 0 && (
            <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">
                    {activeWorkspaceMeta.label}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-gray-900">
                    {activeTabMeta.label}
                  </h2>
                  <p className="mt-1 max-w-2xl text-sm text-gray-600">
                    {activeTabMeta.description}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {currentWorkspaceTabs.map((tab) => {
                    const meta = TAB_META[tab];
                    const Icon = meta.icon;
                    const isActive = activeTab === tab;

                    return (
                      <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`inline-flex items-center rounded-full px-3 py-2 text-sm font-medium transition-colors ${
                          isActive
                            ? 'bg-primary-600 text-white shadow-sm'
                            : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        <Icon className="mr-2 h-4 w-4" />
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <WorkspaceShell
          activeTab={activeTab}
          canAccessTab={canAccessTab}
          normalizedRole={normalizedRole}
        />
      </main>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
