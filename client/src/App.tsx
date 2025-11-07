import React, { useState } from 'react';
import { Upload, FileText, BarChart3, Settings, Wand2, Edit3, ClipboardCheck } from 'lucide-react';
import FileUpload from './components/FileUpload';
import RubricManager from './components/RubricManager';
import MarkingInterface from './components/MarkingInterface';
import ManualMarkingInterface from './components/ManualMarkingInterface';
import ResultsDashboard from './components/ResultsDashboard';
import RubricGenerator from './components/RubricGenerator';
import MCQInterface from './components/MCQInterface';

type TabType = 'upload' | 'rubrics' | 'generator' | 'marking' | 'manual-marking' | 'results' | 'mcq';

function App() {
  const [activeTab, setActiveTab] = useState<TabType>('upload');

  const tabs = [
    { id: 'upload', label: 'Upload PDFs', icon: Upload },
    { id: 'rubrics', label: 'Manage Rubrics', icon: FileText },
    { id: 'generator', label: 'AI Rubric Generator', icon: Wand2 },
    { id: 'marking', label: 'AI Marking', icon: BarChart3 },
    { id: 'manual-marking', label: 'Manual Marking', icon: Edit3 },
    { id: 'mcq', label: 'MCQ Forms', icon: ClipboardCheck },
    { id: 'results', label: 'View Results', icon: Settings },
  ];

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
        {activeTab === 'marking' && <MarkingInterface />}
        {activeTab === 'manual-marking' && <ManualMarkingInterface />}
        {activeTab === 'mcq' && <MCQInterface />}
        {activeTab === 'results' && <ResultsDashboard />}
      </main>
    </div>
  );
}

export default App;