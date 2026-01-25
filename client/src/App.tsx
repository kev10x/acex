import React, { useState } from 'react';
import { Upload, FileText, BarChart3, Settings, Wand2, Edit3, ClipboardCheck, Folder, Brain, Sparkles, LogOut, User } from 'lucide-react';
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
import LoginForm from './components/LoginForm';
import RegisterForm from './components/RegisterForm';
import { AuthProvider, useAuth } from './contexts/AuthContext';

type TabType = 'upload' | 'rubrics' | 'generator' | 'marking' | 'manual-marking' | 'results' | 'mcq' | 'batches' | 'training' | 'assessments';

function AppContent() {
  const [activeTab, setActiveTab] = useState<TabType>('upload');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const { user, loading, logout } = useAuth();

  const tabs = [
    { id: 'upload', label: 'Upload PDFs', icon: Upload },
    { id: 'rubrics', label: 'Manage Rubrics', icon: FileText },
    { id: 'generator', label: 'AI Rubric Generator', icon: Wand2 },
    { id: 'assessments', label: 'Generate Assessments', icon: Sparkles },
    { id: 'marking', label: 'AI Marking', icon: BarChart3 },
    { id: 'manual-marking', label: 'Manual Marking', icon: Edit3 },
    { id: 'mcq', label: 'MCQ Forms', icon: ClipboardCheck },
    { id: 'batches', label: 'Batches', icon: Folder },
    { id: 'training', label: 'Model Training', icon: Brain },
    { id: 'results', label: 'View Results', icon: Settings },
  ];

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

  // Show login/register if not authenticated
  if (!user) {
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
      <nav className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-8">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as TabType)}
                  className={`flex items-center px-1 py-4 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? 'border-primary-500 text-primary-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <Icon className="w-4 h-4 mr-2" />
                  {tab.label}
                </button>
              );
            })}
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