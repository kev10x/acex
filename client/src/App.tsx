import React, { useState, useEffect } from 'react';
import { Upload, FileText, BarChart3, Wand2, Edit3, ClipboardCheck, Folder, Brain, Sparkles, LogOut, User, Shield, ChevronDown, Award, PenLine } from 'lucide-react';
import FileUpload from './components/FileUpload';
import RubricManager from './components/RubricManager';
import MarkingInterface from './components/MarkingInterface';
import ManualMarkingInterface from './components/ManualMarkingInterface';
import ResultsDashboard from './components/ResultsDashboard';
import RubricGenerator from './components/RubricGenerator';
import MCQInterface from './components/MCQInterface';
import BatchManager from './components/BatchManager';
import TrainingDataManager from './components/TrainingDataManager';
import AssessmentGenerator from './components/AssessmentGenerator';
import TakeAssessment from './components/TakeAssessment';
import LoginForm from './components/LoginForm';
import RegisterForm from './components/RegisterForm';
import VerifyEmail from './components/VerifyEmail';
import AdminDashboard from './components/AdminDashboard';
import { AuthProvider, useAuth } from './contexts/AuthContext';

type TabType = 'upload' | 'rubrics' | 'generator' | 'marking' | 'manual-marking' | 'results' | 'mcq' | 'batches' | 'training' | 'assessments' | 'admin';

function AppContent() {
  const [activeTab, setActiveTab] = useState<TabType>('upload');
  const [authMode, setAuthMode] = useState<'login' | 'register' | 'verify'>('login');
  const [openDropdown, setOpenDropdown] = useState<'memorandums' | 'marking' | null>(null);
  const { user, loading, logout } = useAuth();

  // Check if we're on the verification page
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('token') && window.location.pathname.includes('verify-email')) {
      setAuthMode('verify');
    }
  }, []);

  useEffect(() => {
    if (!openDropdown) return;
    const close = () => setOpenDropdown(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openDropdown]);

  const allowGenerateAssessments = user?.features?.generate_assessments !== false;
  const memorandumsItems: { id: TabType; label: string; icon: typeof FileText }[] = [
    { id: 'rubrics', label: 'Manage Rubrics', icon: FileText },
    { id: 'generator', label: 'AI Rubric Generator', icon: Wand2 },
    ...(allowGenerateAssessments ? [{ id: 'assessments' as TabType, label: 'Generate Assessments', icon: Sparkles }] : []),
  ];
  const markingItems: { id: TabType; label: string; icon: typeof BarChart3 }[] = [
    { id: 'marking', label: 'AI Marking', icon: BarChart3 },
    { id: 'manual-marking', label: 'Manual Marking', icon: Edit3 },
    { id: 'mcq', label: 'MCQ Forms', icon: ClipboardCheck },
    { id: 'batches', label: 'Batches', icon: Folder },
    { id: 'training', label: 'Model Training', icon: Brain },
  ];

  // Take-assessment route: no auth required, render student view first
  if (typeof window !== 'undefined' && window.location.pathname.includes('take-assessment')) {
    return <TakeAssessment />;
  }

  // Show loading state
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

  // Show login/register/verify if not authenticated
  if (!user) {
    if (authMode === 'verify') {
      return <VerifyEmail onBackToLogin={() => {
        setAuthMode('login');
        window.history.replaceState({}, '', window.location.pathname);
      }} />;
    }
    return authMode === 'login' ? (
      <LoginForm onSwitchToRegister={() => setAuthMode('register')} />
    ) : (
      <RegisterForm onSwitchToLogin={() => setAuthMode('login')} />
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center">
              <h1 className="text-2xl font-bold text-gray-900">MarkMate</h1>
              <span className="ml-2 text-sm text-gray-500">AI-Powered Assignment Marking</span>
            </div>
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2 text-sm text-gray-700">
                <User className="h-4 w-4" />
                <span>{user.name || user.email}</span>
              </div>
              <button
                onClick={logout}
                className="flex items-center space-x-2 px-3 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
              >
                <LogOut className="h-4 w-4" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-1">
            {/* Upload (standalone) */}
            <button
              onClick={() => setActiveTab('upload')}
              className={`flex items-center px-4 py-3.5 text-sm font-medium rounded-t-md transition-colors ${
                activeTab === 'upload'
                  ? 'bg-primary-50 text-primary-700 border-b-2 border-primary-500'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              <Upload className="w-4 h-4 mr-2" />
              Upload
            </button>

            {/* Memorandums (dropdown) */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenDropdown((prev) => (prev === 'memorandums' ? null : 'memorandums'));
                }}
                className={`flex items-center px-4 py-3.5 text-sm font-medium rounded-t-md transition-colors ${
                  openDropdown === 'memorandums' || memorandumsItems.some((i) => i.id === activeTab)
                    ? 'bg-primary-50 text-primary-700 border-b-2 border-primary-500'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <Award className="w-4 h-4 mr-2" />
                Memorandums
                <ChevronDown className={`w-4 h-4 ml-1 transition-transform ${openDropdown === 'memorandums' ? 'rotate-180' : ''}`} />
              </button>
              {openDropdown === 'memorandums' && (
                <div
                  className="absolute left-0 top-full z-50 mt-0 w-56 rounded-b-md border border-t-0 border-gray-200 bg-white py-1 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  {memorandumsItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          setActiveTab(item.id);
                          setOpenDropdown(null);
                        }}
                        className={`flex w-full items-center px-4 py-2.5 text-left text-sm ${
                          activeTab === item.id ? 'bg-primary-50 text-primary-700' : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <Icon className="w-4 h-4 mr-3 text-gray-500" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Marking (dropdown) */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenDropdown((prev) => (prev === 'marking' ? null : 'marking'));
                }}
                className={`flex items-center px-4 py-3.5 text-sm font-medium rounded-t-md transition-colors ${
                  openDropdown === 'marking' || markingItems.some((i) => i.id === activeTab)
                    ? 'bg-primary-50 text-primary-700 border-b-2 border-primary-500'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <PenLine className="w-4 h-4 mr-2" />
                Marking
                <ChevronDown className={`w-4 h-4 ml-1 transition-transform ${openDropdown === 'marking' ? 'rotate-180' : ''}`} />
              </button>
              {openDropdown === 'marking' && (
                <div
                  className="absolute left-0 top-full z-50 mt-0 w-56 rounded-b-md border border-t-0 border-gray-200 bg-white py-1 shadow-lg"
                  onClick={(e) => e.stopPropagation()}
                >
                  {markingItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => {
                          setActiveTab(item.id);
                          setOpenDropdown(null);
                        }}
                        className={`flex w-full items-center px-4 py-2.5 text-left text-sm ${
                          activeTab === item.id ? 'bg-primary-50 text-primary-700' : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <Icon className="w-4 h-4 mr-3 text-gray-500" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Results (standalone) */}
            <button
              onClick={() => setActiveTab('results')}
              className={`flex items-center px-4 py-3.5 text-sm font-medium rounded-t-md transition-colors ${
                activeTab === 'results'
                  ? 'bg-primary-50 text-primary-700 border-b-2 border-primary-500'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              <BarChart3 className="w-4 h-4 mr-2" />
              Results
            </button>

            {/* Admin (standalone, admin only) */}
            {user?.role === 'admin' && (
              <button
                onClick={() => setActiveTab('admin')}
                className={`flex items-center px-4 py-3.5 text-sm font-medium rounded-t-md transition-colors ${
                  activeTab === 'admin'
                    ? 'bg-primary-50 text-primary-700 border-b-2 border-primary-500'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <Shield className="w-4 h-4 mr-2" />
                Admin
              </button>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'upload' && <FileUpload />}
        {activeTab === 'rubrics' && <RubricManager />}
        {activeTab === 'generator' && <RubricGenerator />}
        {activeTab === 'assessments' && <AssessmentGenerator />}
        {activeTab === 'marking' && <MarkingInterface />}
        {activeTab === 'manual-marking' && <ManualMarkingInterface />}
        {activeTab === 'mcq' && <MCQInterface />}
        {activeTab === 'batches' && <BatchManager />}
        {activeTab === 'training' && <TrainingDataManager />}
        {activeTab === 'results' && <ResultsDashboard />}
        {activeTab === 'admin' && <AdminDashboard />}
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