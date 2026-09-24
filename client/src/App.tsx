import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Brain,
  ChevronLeft,
  ClipboardCheck,
  Edit3,
  FileText,
  FlaskConical,
  Folder,
  Globe,
  Layers,
  LogOut,
  Presentation,
  Shield,
  Sparkles,
  TrendingUp,
  Upload,
  User,
  Video,
  Wand2
} from 'lucide-react';
import LoginForm from './components/LoginForm';
import RegisterForm from './components/RegisterForm';
import VerifyEmail from './components/VerifyEmail';
import BrandMark from './components/BrandMark';
import ErrorBoundary from './components/ErrorBoundary';
import ToolsLanding from './components/ToolsLanding';
import HeroPanel from './components/HeroPanel';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { NotificationProvider } from './contexts/NotificationContext';
import type { GeneratedContent } from './services/api';

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
const PracticalGenerator = lazy(() => import('./components/PracticalGenerator'));
const TakeAssessment = lazy(() => import('./components/TakeAssessment'));
const ContentGenerator = lazy(() => import('./components/ContentGenerator'));
const TakeContent = lazy(() => import('./components/TakeContent'));
const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const ModuleOrganizer = lazy(() => import('./components/ModuleOrganizer'));
const StudentModules = lazy(() => import('./components/StudentModules'));
const StudentModulePlayer = lazy(() => import('./components/StudentModulePlayer'));
const MoodleIntegration = lazy(() => import('./components/MoodleIntegration'));
const SlideGenerator = lazy(() => import('./components/SlideGenerator'));
const SlideGeneratorStudio = lazy(() => import('./components/SlideGeneratorStudio'));
const VideoGenerator = lazy(() => import('./components/VideoGenerator'));
const CourseManager = lazy(() => import('./components/CourseManager'));
const RevisionTracker = lazy(() => import('./components/RevisionTracker'));

type ToolContext = 'marking' | 'content' | 'labs' | 'admin' | null;

const TOOL_WORKSPACES: Record<NonNullable<ToolContext>, WorkspaceType[]> = {
  marking: ['marking'],
  content: ['student'],
  labs: ['labs'],
  admin: ['admin']
};

function getToolContext(pathname: string): ToolContext | 'landing' {
  // The same build is served both at the historical /tools subpath and at
  // the bare domain root (e.g. acexen.com/) — strip a leading /tools, if
  // present, so both resolve identically instead of root-only paths
  // falling through to null (and skipping the landing cards).
  const normalized = pathname.replace(/^\/tools(?=\/|$)/, '') || '/';
  const match = normalized.match(/^\/([a-z-]*)?$/);
  if (!match) return null;
  const segment = match[1] || '';
  if (segment === '') return 'landing';
  if (segment in TOOL_WORKSPACES) return segment as NonNullable<ToolContext>;
  return null;
}

type TabType =
  | 'upload'
  | 'rubrics'
  | 'generator'
  | 'marking'
  | 'manual-marking'
  | 'results'
  | 'revision-tracking'
  | 'mcq'
  | 'batches'
  | 'training'
  | 'assessments'
  | 'practicals'
  | 'content'
  | 'modules'
  | 'moodle'
  | 'slide-gen'
  | 'video-gen'
  | 'courses'
  | 'admin';
type AppRole = 'management' | 'lecturer' | 'student';
type WorkspaceType = 'marking' | 'student' | 'labs' | 'admin';
type IconType = typeof BarChart3;

const ROLE_TAB_ACCESS: Record<AppRole, TabType[]> = {
  management: ['upload', 'rubrics', 'generator', 'marking', 'manual-marking', 'results', 'revision-tracking', 'mcq', 'batches', 'training', 'slide-gen', 'video-gen', 'assessments', 'practicals', 'content', 'modules', 'courses', 'moodle', 'admin'],
  lecturer: ['upload', 'rubrics', 'generator', 'marking', 'manual-marking', 'results', 'revision-tracking', 'mcq', 'batches', 'training', 'slide-gen', 'video-gen', 'assessments', 'practicals', 'content', 'modules', 'courses', 'moodle'],
  student: ['modules', 'mcq', 'results', 'courses', 'revision-tracking']
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
  'revision-tracking': {
    label: 'Revision Tracking',
    description: 'Track longitudinal improvement across successive document revisions.',
    icon: TrendingUp
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
  'slide-gen': {
    label: 'Presentation Studio',
    description: 'Generate full PowerPoint presentations from topics or unit plans, with AI-designed slides and Grok images.',
    icon: Presentation
  },
  'video-gen': {
    label: 'Video Generator',
    description: 'Generate short AI video clips from a text prompt, powered by Grok Imagine.',
    icon: Video
  },
  assessments: {
    label: 'Assessment Generator',
    description: 'Prepare and publish student-facing assessments.',
    icon: Sparkles
  },
  practicals: {
    label: 'Practical Generator',
    description: 'Create practical guides or assessable practical tasks.',
    icon: FlaskConical
  },
  content: {
    label: 'Lesson Generator',
    description: 'Create lesson materials and publish learning content.',
    icon: Presentation
  },
  modules: {
    label: 'Learning Modules',
    description: 'Organise assessments and content into learning modules for students.',
    icon: Layers
  },
  courses: {
    label: 'Courses',
    description: 'Manage enrollment, weighted grading, and the gradebook for each course.',
    icon: BookOpen
  },
  moodle: {
    label: 'Moodle Integration',
    description: 'Browse courses, push grades to Moodle, and import quiz questions.',
    icon: Globe
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
    accent: 'bg-primary-50 text-primary-700 border-primary-200'
  },
  student: {
    label: 'Student Workspace',
    description: 'Student-facing assessments, practicals, lesson content, and outcomes live here.',
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
  normalizedRole,
  pendingSlideContent,
  onCreateSlides,
}: {
  activeTab: TabType;
  canAccessTab: (tab: TabType) => boolean;
  normalizedRole: AppRole;
  pendingSlideContent: GeneratedContent | null;
  onCreateSlides: (content: GeneratedContent) => void;
}) {
  return (
    <ErrorBoundary key={activeTab}>
    <Suspense fallback={<TabLoadingFallback />}>
      {activeTab === 'upload' && canAccessTab('upload') && <FileUpload />}
      {activeTab === 'rubrics' && canAccessTab('rubrics') && <RubricManager />}
      {activeTab === 'generator' && canAccessTab('generator') && <RubricGenerator />}
      {activeTab === 'assessments' && canAccessTab('assessments') && <AssessmentGenerator />}
      {activeTab === 'practicals' && canAccessTab('practicals') && <PracticalGenerator />}
      {activeTab === 'content' && canAccessTab('content') && <ContentGenerator onCreateSlides={onCreateSlides} />}
      {activeTab === 'marking' && canAccessTab('marking') && <MarkingInterface />}
      {activeTab === 'manual-marking' && canAccessTab('manual-marking') && <ManualMarkingInterface />}
      {activeTab === 'mcq' && canAccessTab('mcq') && <MCQInterface />}
      {activeTab === 'batches' && canAccessTab('batches') && <BatchManager />}
      {activeTab === 'training' && canAccessTab('training') && <TrainingDataManager />}
      {activeTab === 'slide-gen' && canAccessTab('slide-gen') && <SlideGeneratorStudio initialContent={pendingSlideContent} />}
      {activeTab === 'video-gen' && canAccessTab('video-gen') && <VideoGenerator />}
      {activeTab === 'results' && canAccessTab('results') && <ResultsDashboard />}
      {activeTab === 'revision-tracking' && canAccessTab('revision-tracking') && (
        <RevisionTracker readOnly={normalizedRole === 'student'} />
      )}
      {activeTab === 'modules' && canAccessTab('modules') && (
        normalizedRole === 'student' ? <StudentModules /> : <ModuleOrganizer />
      )}
      {activeTab === 'courses' && canAccessTab('courses') && <CourseManager />}
      {activeTab === 'moodle' && canAccessTab('moodle') && <MoodleIntegration />}
      {activeTab === 'admin' && normalizedRole === 'management' && <AdminDashboard />}
    </Suspense>
    </ErrorBoundary>
  );
}

function AppContent() {
  const [activeTab, setActiveTab] = useState<TabType>('marking');
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceType>('marking');
  const [pendingSlideContent, setPendingSlideContent] = useState<GeneratedContent | null>(null);

  const handleCreateSlides = (content: GeneratedContent) => {
    setPendingSlideContent(content);
    setActiveTab('slide-gen');
  };
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'verify'>('login');
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const { user, loading, logout, impersonation, stopImpersonation } = useAuth();

  const navigate = (path: string) => {
    window.history.pushState(null, '', path);
    setCurrentPath(path);
  };

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const normalizedRole: AppRole = user?.role === 'admin'
    ? 'management'
    : (user?.role as AppRole) || 'lecturer';

  const toolContext = getToolContext(currentPath);

  const canAccessTab = (tab: TabType) => ROLE_TAB_ACCESS[normalizedRole].includes(tab);
  const allowAssessmentCreation = user?.features?.assessment_creation !== false;
  const allowContentCreation = user?.features?.content_creation !== false;
  const allowPracticalCreation = allowAssessmentCreation || allowContentCreation;

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('token') && window.location.pathname.includes('verify-email')) {
      setAuthMode('verify');
    }
  }, []);

  const workspaceTabs = useMemo<Record<WorkspaceType, TabType[]>>(
    () => ({
      marking:
        normalizedRole === 'student'
          ? []
          : (['upload', 'rubrics', 'generator', 'marking', 'manual-marking', 'results', 'revision-tracking', 'batches'] as TabType[]).filter((tab) =>
              ROLE_TAB_ACCESS[normalizedRole].includes(tab)
            ),
      student:
        normalizedRole === 'student'
          ? (['modules', 'courses', 'results', 'mcq', 'revision-tracking'] as TabType[]).filter((tab) => ROLE_TAB_ACCESS[normalizedRole].includes(tab))
          : (['assessments', 'practicals', 'content', 'modules', 'courses', 'moodle'] as TabType[])
              .filter((tab) => {
                if (tab === 'assessments') return allowAssessmentCreation;
                if (tab === 'practicals') return allowPracticalCreation;
                if (tab === 'content') return allowContentCreation;
                return true;
              })
              .filter((tab) => ROLE_TAB_ACCESS[normalizedRole].includes(tab)),
      labs:
        normalizedRole === 'student'
          ? []
          : (['mcq', 'training', 'slide-gen', 'video-gen'] as TabType[]).filter((tab) => ROLE_TAB_ACCESS[normalizedRole].includes(tab)),
      admin: normalizedRole === 'management' ? (['admin'] as TabType[]) : []
    }),
    [allowAssessmentCreation, allowContentCreation, allowPracticalCreation, normalizedRole]
  );

  const availableWorkspaces = useMemo(() => {
    const all = WORKSPACE_ORDER.filter((w) => workspaceTabs[w].length > 0);
    if (toolContext && toolContext !== 'landing') {
      const allowed = TOOL_WORKSPACES[toolContext];
      return all.filter((w) => allowed.includes(w));
    }
    return all;
  }, [workspaceTabs, toolContext]);

  const currentWorkspaceTabs = workspaceTabs[activeWorkspace] || [];
  const activeTabMeta = TAB_META[activeTab] || TAB_META.results;
  const activeWorkspaceMeta = WORKSPACE_META[activeWorkspace] || WORKSPACE_META.marking;

  useEffect(() => {
    if (!user || availableWorkspaces.length === 0) return;

    const defaultWorkspace =
      normalizedRole === 'student' && availableWorkspaces.includes('student')
        ? 'student'
        : availableWorkspaces[0];
    const activeTabWorkspace = workspaceTabs[activeWorkspace]?.includes(activeTab)
      ? activeWorkspace
      : WORKSPACE_ORDER.find((workspace) => workspaceTabs[workspace].includes(activeTab));

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

  if (currentPath.includes('take-assessment')) {
    return (
      <Suspense fallback={<TabLoadingFallback />}>
        <TakeAssessment />
      </Suspense>
    );
  }

  if (currentPath.includes('take-content')) {
    return (
      <Suspense fallback={<TabLoadingFallback />}>
        <TakeContent />
      </Suspense>
    );
  }

  if (currentPath.includes('take-module')) {
    return (
      <Suspense fallback={<TabLoadingFallback />}>
        <StudentModulePlayer />
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
    return (
      <div className="lg:flex lg:min-h-screen">
        <HeroPanel />
        <div className="lg:min-w-0 lg:flex-1">
          {authMode === 'verify' ? (
            <VerifyEmail
              onBackToLogin={() => {
                setAuthMode('login');
                window.history.replaceState({}, '', window.location.pathname);
              }}
            />
          ) : authMode === 'login' ? (
            <LoginForm onSwitchToRegister={() => setAuthMode('register')} />
          ) : (
            <RegisterForm onSwitchToLogin={() => setAuthMode('login')} />
          )}
        </div>
      </div>
    );
  }

  if (toolContext === 'landing') {
    return (
      <ToolsLanding
        role={normalizedRole}
        userName={user.name || user.email || ''}
        orgName={user.organisation_name ?? undefined}
        onNavigate={navigate}
        onLogout={logout}
      />
    );
  }

  const roleLabel =
    normalizedRole === 'management' ? 'Management' : normalizedRole === 'student' ? 'Student' : 'Lecturer';
  const userInitial = String(user.name || user.email || '?').trim().charAt(0).toUpperCase();

  return (
    <div className="min-h-screen bg-app">
      <header className="sticky top-0 z-40 border-b border-gray-200/70 bg-white/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => navigate('/tools')}
              title="All tools"
              className="flex items-center gap-3 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              <BrandMark size={34} />
              <div className="hidden text-left sm:block">
                <div className="text-[15px] font-bold leading-tight text-gray-900">Acexen</div>
                <div className="text-[11px] leading-tight text-gray-500">The Academic Excellence Engine</div>
              </div>
            </button>
            {user.organisation_name && (
              <>
                <span className="hidden h-6 w-px bg-gray-200 md:block" />
                <span className="hidden truncate text-sm font-medium text-gray-500 md:block">{user.organisation_name}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {toolContext && (
              <button
                onClick={() => navigate('/tools')}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
              >
                <ChevronLeft className="h-4 w-4" />
                All tools
              </button>
            )}
            <span className="hidden rounded-full bg-primary-50 px-2.5 py-1 text-xs font-semibold text-primary-700 ring-1 ring-inset ring-primary-100 sm:inline-flex">
              {roleLabel}
            </span>
            <div className="flex items-center gap-2 rounded-full bg-white py-1 pl-1 pr-3 shadow-sm ring-1 ring-gray-200">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-accent-600 text-xs font-bold text-white">
                {userInitial}
              </span>
              <span className="hidden max-w-[10rem] truncate text-sm font-medium text-gray-700 md:block">
                {user.name || user.email}
              </span>
            </div>
            <button
              onClick={logout}
              title="Log out"
              className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
            >
              <LogOut className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </header>

      {impersonation?.active && (
        <div className="border-b border-amber-200 bg-amber-50">
          <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3 px-4 py-3 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
            <div className="flex items-center gap-2 text-sm text-amber-900">
              <Shield className="h-4 w-4" />
              <span>
                Impersonating `{user?.name || user?.email}`. Admin session: {impersonation.admin_name || impersonation.admin_email}
              </span>
            </div>
            <button
              onClick={() => void stopImpersonation()}
              className="inline-flex items-center justify-center rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
            >
              Stop impersonating
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6 lg:px-8">
        <div className="pt-8">
          {!toolContext && availableWorkspaces.length > 1 && (
            <div className="mb-6 inline-flex max-w-full gap-1 overflow-x-auto rounded-xl bg-white p-1 shadow-sm ring-1 ring-gray-200">
              {availableWorkspaces.map((workspace) => {
                const meta = WORKSPACE_META[workspace];
                const Icon = meta.icon;
                const isActive = workspace === activeWorkspace;
                return (
                  <button
                    key={workspace}
                    onClick={() => switchWorkspace(workspace)}
                    className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-all ${
                      isActive
                        ? 'bg-primary-600 text-white shadow-sm'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          )}

          {currentWorkspaceTabs.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-600">
                {activeWorkspace === 'student' && normalizedRole !== 'student' ? 'Learning Studio' : activeWorkspaceMeta.label}
              </p>
              {currentWorkspaceTabs.length > 1 && (
                <div className="no-scrollbar -mx-1 mt-3 flex gap-1 overflow-x-auto border-b border-gray-200 px-1">
                  {currentWorkspaceTabs.map((tab) => {
                    const meta = TAB_META[tab];
                    const Icon = meta.icon;
                    const isActive = activeTab === tab;
                    return (
                      <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors ${
                          isActive
                            ? 'border-primary-600 text-primary-700'
                            : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800'
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <main className="py-6">
          <WorkspaceShell
            activeTab={activeTab}
            canAccessTab={canAccessTab}
            normalizedRole={normalizedRole}
            pendingSlideContent={pendingSlideContent}
            onCreateSlides={handleCreateSlides}
          />
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <NotificationProvider>
        <AppContent />
      </NotificationProvider>
    </AuthProvider>
  );
}

export default App;
