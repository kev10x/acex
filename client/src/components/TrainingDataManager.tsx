import React, { useState, useEffect } from 'react';
import { Download, Trash2, FileText, Database, TrendingUp, AlertCircle, CheckCircle } from 'lucide-react';
import { trainingAPI, TrainingFile, TrainingStats } from '../services/api';

const TrainingDataManager: React.FC = () => {
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [files, setFiles] = useState<TrainingFile[]>([]);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Export options
  const [includeText, setIncludeText] = useState(true);
  const [onlyCurrentVersions, setOnlyCurrentVersions] = useState(true);
  const [minScoreCount, setMinScoreCount] = useState(1);
  const [selectedStrictness, setSelectedStrictness] = useState<string[]>([]);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);

  useEffect(() => {
    loadStats();
    loadFiles();
  }, []);

  const loadStats = async () => {
    try {
      const response = await trainingAPI.getStats();
      const data = response.data;
      if (data.success) {
        setStats(data.statistics);
      }
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  };

  const loadFiles = async () => {
    try {
      const response = await trainingAPI.getFiles();
      const data = response.data;
      if (data.success) {
        setFiles(data.files);
      }
    } catch (error) {
      console.error('Error loading files:', error);
    }
  };

  const exportData = async (format: 'json' | 'openai' | 'anthropic') => {
    setExporting(true);
    setMessage(null);

    try {
      const response = await trainingAPI.exportData(format, {
        includeText,
        onlyCurrentVersions,
        minScoreCount,
        strictnessLevels: selectedStrictness.length > 0 ? selectedStrictness : null,
        providers: selectedProviders.length > 0 ? selectedProviders : null
      });
      const data = response.data;

      if (data.success) {
        setMessage({
          type: 'success',
          text: `Export successful! ${data.processed || data.examples || 0} examples exported.`
        });
        loadFiles();
      } else {
        setMessage({
          type: 'error',
          text: data.error || 'Export failed'
        });
      }
    } catch (error: any) {
      setMessage({
        type: 'error',
        text: error.message || 'Export failed'
      });
    } finally {
      setExporting(false);
    }
  };

  const downloadFile = async (filename: string) => {
    try {
      const response = await trainingAPI.downloadFile(filename);
      const blob = new Blob([response.data]);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error: any) {
      setMessage({
        type: 'error',
        text: error.response?.data?.error || error.message || 'Download failed'
      });
    }
  };

  const deleteFile = async (filename: string) => {
    if (!window.confirm(`Delete ${filename}?`)) return;

    try {
      const response = await trainingAPI.deleteFile(filename);
      const data = response.data;

      if (data.success) {
        setMessage({
          type: 'success',
          text: 'File deleted successfully'
        });
        loadFiles();
      } else {
        setMessage({
          type: 'error',
          text: data.error || 'Delete failed'
        });
      }
    } catch (error: any) {
      setMessage({
        type: 'error',
        text: error.message || 'Delete failed'
      });
    }
  };

  const toggleStrictness = (level: string) => {
    setSelectedStrictness(prev =>
      prev.includes(level)
        ? prev.filter(l => l !== level)
        : [...prev, level]
    );
  };

  const toggleProvider = (provider: string) => {
    setSelectedProviders(prev =>
      prev.includes(provider)
        ? prev.filter(p => p !== provider)
        : [...prev, provider]
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Training Data Manager</h1>
        <p className="text-gray-600">
          Export your marking data to train custom AI models
        </p>
      </div>

      {message && (
        <div className={`mb-4 p-4 rounded-lg flex items-center gap-2 ${
          message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
        }`}>
          {message.type === 'success' ? (
            <CheckCircle className="w-5 h-5" />
          ) : (
            <AlertCircle className="w-5 h-5" />
          )}
          <span>{message.text}</span>
        </div>
      )}

      {/* Statistics */}
      {stats && (
        <div className="bg-white rounded-2xl shadow-sm p-6 mb-6 border border-gray-200/70">
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            Training Data Statistics
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-2xl font-bold">{stats.total_results}</div>
              <div className="text-sm text-gray-600">Total Results</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{stats.unique_assignments}</div>
              <div className="text-sm text-gray-600">Unique Assignments</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{stats.unique_rubrics}</div>
              <div className="text-sm text-gray-600">Unique Rubrics</div>
            </div>
            <div>
              <div className="text-2xl font-bold">{Number(stats.avg_score || 0).toFixed(1)}</div>
              <div className="text-sm text-gray-600">Average Score</div>
            </div>
          </div>
        </div>
      )}

      {/* Export Options */}
      <div className="bg-white rounded-2xl shadow-sm p-6 mb-6 border border-gray-200/70">
        <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
          <Database className="w-5 h-5" />
          Export Options
        </h2>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="includeText"
              checked={includeText}
              onChange={(e) => setIncludeText(e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="includeText" className="text-sm">
              Include assignment text (required for fine-tuning)
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="onlyCurrentVersions"
              checked={onlyCurrentVersions}
              onChange={(e) => setOnlyCurrentVersions(e.target.checked)}
              className="w-4 h-4"
            />
            <label htmlFor="onlyCurrentVersions" className="text-sm">
              Only export current versions
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Minimum score count per assignment
            </label>
            <input
              type="number"
              min="1"
              value={minScoreCount}
              onChange={(e) => setMinScoreCount(parseInt(e.target.value) || 1)}
              className="border rounded px-3 py-2 w-32"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Filter by Strictness Level (optional)
            </label>
            <div className="flex flex-wrap gap-2">
              {['very_strict', 'strict', 'moderate', 'lenient'].map(level => (
                <button
                  key={level}
                  onClick={() => toggleStrictness(level)}
                  className={`px-3 py-1 rounded text-sm ${
                    selectedStrictness.includes(level)
                      ? 'bg-primary-500 text-white'
                      : 'bg-gray-200 text-gray-700'
                  }`}
                >
                  {level.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Filter by Provider (optional)
            </label>
            <div className="flex flex-wrap gap-2">
              {['openai', 'anthropic'].map(provider => (
                <button
                  key={provider}
                  onClick={() => toggleProvider(provider)}
                  className={`px-3 py-1 rounded text-sm ${
                    selectedProviders.includes(provider)
                      ? 'bg-primary-500 text-white'
                      : 'bg-gray-200 text-gray-700'
                  }`}
                >
                  {provider}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <button
            onClick={() => exportData('json')}
            disabled={exporting}
            className="px-4 py-2 bg-primary-500 text-white rounded hover:bg-primary-600 disabled:opacity-50 flex items-center gap-2"
          >
            <FileText className="w-4 h-4" />
            Export JSON
          </button>
          <button
            onClick={() => exportData('openai')}
            disabled={exporting}
            className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50 flex items-center gap-2"
          >
            <FileText className="w-4 h-4" />
            Export for OpenAI
          </button>
          <button
            onClick={() => exportData('anthropic')}
            disabled={exporting}
            className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 disabled:opacity-50 flex items-center gap-2"
          >
            <FileText className="w-4 h-4" />
            Export for Anthropic
          </button>
        </div>

        {exporting && (
          <div className="mt-4 text-sm text-gray-600">
            Exporting... This may take a while for large datasets.
          </div>
        )}
      </div>

      {/* Exported Files */}
      <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-200/70">
        <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Exported Files
        </h2>

        {files.length === 0 ? (
          <p className="text-gray-500">No exported files yet. Export training data to get started.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">Filename</th>
                  <th className="text-left p-2">Format</th>
                  <th className="text-left p-2">Size</th>
                  <th className="text-left p-2">Modified</th>
                  <th className="text-left p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.filename} className="border-b">
                    <td className="p-2 font-mono text-sm">{file.filename}</td>
                    <td className="p-2">
                      <span className={`px-2 py-1 rounded text-xs ${
                        file.format === 'jsonl' ? 'bg-green-100 text-green-800' :
                        file.format === 'json' ? 'bg-primary-100 text-primary-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {file.format.toUpperCase()}
                      </span>
                    </td>
                    <td className="p-2">{file.size_mb} MB</td>
                    <td className="p-2 text-sm text-gray-600">
                      {new Date(file.modified).toLocaleString()}
                    </td>
                    <td className="p-2">
                      <div className="flex gap-2">
                        <button
                          onClick={() => downloadFile(file.filename)}
                          className="p-1 text-primary-600 hover:bg-primary-50 rounded"
                          title="Download"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => deleteFile(file.filename)}
                          className="p-1 text-red-600 hover:bg-red-50 rounded"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Training Instructions */}
      <div className="mt-6 bg-primary-50 rounded-lg p-6">
        <h3 className="font-semibold mb-2">How to Train Your Model</h3>
        <ol className="list-decimal list-inside space-y-2 text-sm text-gray-700">
          <li>Export your training data using one of the export buttons above</li>
          <li>Download the exported file (JSONL format for fine-tuning)</li>
          <li>Use the training script: <code className="bg-white px-2 py-1 rounded">node scripts/train-model.js --format openai --file your-file.jsonl</code></li>
          <li>Follow the instructions provided by the script</li>
          <li>Once trained, you can use your custom model for marking</li>
        </ol>
        <p className="mt-4 text-sm text-gray-600">
          <strong>Note:</strong> Fine-tuning requires API access from OpenAI or Anthropic. 
          Check their documentation for current availability and pricing.
        </p>
      </div>
    </div>
  );
};

export default TrainingDataManager;



