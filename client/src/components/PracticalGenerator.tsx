import React, { useState } from 'react';
import { Beaker, Download, Loader2, Sparkles } from 'lucide-react';
import { assessmentsAPI, GeneratedPractical } from '../services/api';
import { EDUCATION_LEVEL_OPTIONS } from '../constants/educationLevels';

const PRACTICAL_TYPES = ['Laboratory', 'Workshop', 'Fieldwork', 'Simulation', 'Studio', 'Project-based'];

const PracticalGenerator: React.FC = () => {
  const [topic, setTopic] = useState('');
  const [level, setLevel] = useState('');
  const [practicalType, setPracticalType] = useState('Laboratory');
  const [mode, setMode] = useState<'guide' | 'assessment'>('guide');
  const [includeDetailedInstructions, setIncludeDetailedInstructions] = useState(true);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [learningObjectives, setLearningObjectives] = useState('');
  const [materials, setMaterials] = useState('');
  const [safetyFocus, setSafetyFocus] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedPractical, setGeneratedPractical] = useState<GeneratedPractical | null>(null);

  const splitLines = (text: string) =>
    text
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);

  const handleGenerate = async () => {
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      setError('Please enter a topic for the practical.');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setGeneratedPractical(null);

    try {
      const response = await assessmentsAPI.generatePractical({
        topic: normalizedTopic,
        level: level || null,
        practical_type: practicalType,
        mode,
        include_detailed_instructions: includeDetailedInstructions,
        duration_minutes: durationMinutes,
        learning_objectives: splitLines(learningObjectives),
        required_materials: splitLines(materials),
        safety_focus: splitLines(safetyFocus),
      });
      setGeneratedPractical(response.data.practical);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to generate practical');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!generatedPractical) return;
    const p = generatedPractical;
    const lines: string[] = [
      `# ${p.title}`,
      '',
      `Topic: ${p.topic}`,
      `Type: ${p.practical_type}`,
      `Mode: ${p.mode}`,
      `Estimated duration: ${p.estimated_duration_minutes} minutes`,
      '',
      '## Overview',
      p.overview,
      '',
      '## Learning Objectives',
      ...p.learning_objectives.map((item) => `- ${item}`),
      '',
      '## Materials',
      ...p.materials.map((item) => `- ${item}`),
      '',
      '## Safety Notes',
      ...p.safety_notes.map((item) => `- ${item}`),
      '',
      '## Preparation Checklist',
      ...p.preparation_checklist.map((item) => `- ${item}`),
      '',
      '## Procedure Steps',
    ];
    p.procedure_steps.forEach((step) => {
      lines.push(`${step.step}. ${step.title}`);
      lines.push(`- Instructions: ${step.instructions}`);
      if (step.expected_outcome) lines.push(`- Expected outcome: ${step.expected_outcome}`);
      if (step.teacher_notes) lines.push(`- Teacher notes: ${step.teacher_notes}`);
      lines.push('');
    });
    lines.push('## Reflection Questions');
    lines.push(...p.reflection_questions.map((item) => `- ${item}`));
    lines.push('');
    if (p.optional_assessment) {
      lines.push('## Assessment');
      lines.push(`Total points: ${p.optional_assessment.total_points}`);
      lines.push(`Submission instructions: ${p.optional_assessment.submission_instructions}`);
      lines.push('');
      lines.push('### Evidence requirements');
      lines.push(...p.optional_assessment.evidence_requirements.map((item) => `- ${item}`));
      lines.push('');
      lines.push('### Rubric criteria');
      p.optional_assessment.rubric_criteria.forEach((criterion) => {
        lines.push(`- ${criterion.name} (${criterion.max_points}): ${criterion.description}`);
      });
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <Beaker className="w-8 h-8 text-indigo-600" />
          <h1 className="text-3xl font-bold text-gray-800">Practical Generator</h1>
        </div>
        <p className="text-gray-600 mb-6">
          Generate practical guides or practical assessments with structured steps, safety guidance, and optional rubric criteria.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Topic *</label>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Acids and bases titration"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Level</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              >
                {EDUCATION_LEVEL_OPTIONS.map((option) => (
                  <option key={option.value || 'any'} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Practical type</label>
              <select
                value={practicalType}
                onChange={(e) => setPracticalType(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              >
                {PRACTICAL_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Duration (minutes)</label>
              <input
                type="number"
                min={20}
                max={240}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Math.max(20, Math.min(240, Number.parseInt(e.target.value, 10) || 60)))}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'guide' | 'assessment')}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              >
                <option value="guide">Guide</option>
                <option value="assessment">Assessment</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Guide focuses on teaching flow; Assessment includes evidence and rubric criteria.
              </p>
            </div>
            <div className="flex items-center mt-8 md:mt-0">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDetailedInstructions}
                  onChange={(e) => setIncludeDetailedInstructions(e.target.checked)}
                  className="w-4 h-4 text-indigo-600 border-gray-300 rounded"
                />
                Include detailed instructions
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Learning objectives (optional)</label>
              <textarea
                rows={4}
                value={learningObjectives}
                onChange={(e) => setLearningObjectives(e.target.value)}
                placeholder="One per line or comma-separated"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Materials / equipment (optional)</label>
              <textarea
                rows={4}
                value={materials}
                onChange={(e) => setMaterials(e.target.value)}
                placeholder="One per line or comma-separated"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Safety focus (optional)</label>
              <textarea
                rows={4}
                value={safetyFocus}
                onChange={(e) => setSafetyFocus(e.target.value)}
                placeholder="One per line or comma-separated"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="inline-flex items-center px-5 py-2.5 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Sparkles className="w-4 h-4 mr-2" />}
            {isGenerating ? 'Generating...' : 'Generate Practical'}
          </button>
        </div>
      </div>

      {generatedPractical && (
        <div className="bg-white rounded-lg shadow-lg p-6">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-2xl font-semibold text-gray-800">{generatedPractical.title}</h2>
              <p className="text-sm text-gray-500 mt-1">
                {generatedPractical.practical_type} · {generatedPractical.mode} · {generatedPractical.estimated_duration_minutes} minutes
              </p>
            </div>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
            >
              <Download className="w-4 h-4 mr-2" />
              Download
            </button>
          </div>

          <p className="text-gray-700 mb-5 whitespace-pre-wrap">{generatedPractical.overview}</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Learning Objectives</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                {generatedPractical.learning_objectives.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Materials</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                {generatedPractical.materials.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Safety Notes</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                {generatedPractical.safety_notes.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Preparation Checklist</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                {generatedPractical.preparation_checklist.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Procedure</h3>
            <div className="space-y-3">
              {generatedPractical.procedure_steps.map((step) => (
                <div key={step.step} className="border border-gray-200 rounded-lg p-4">
                  <h4 className="font-medium text-gray-900">{step.step}. {step.title}</h4>
                  <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{step.instructions}</p>
                  {step.expected_outcome && (
                    <p className="text-sm text-emerald-700 mt-2"><span className="font-medium">Expected outcome:</span> {step.expected_outcome}</p>
                  )}
                  {step.teacher_notes && (
                    <p className="text-sm text-indigo-700 mt-2"><span className="font-medium">Teacher notes:</span> {step.teacher_notes}</p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {generatedPractical.reflection_questions.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Reflection Questions</h3>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                {generatedPractical.reflection_questions.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
          )}

          {generatedPractical.optional_assessment && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
              <h3 className="text-lg font-semibold text-indigo-900 mb-2">Assessment Criteria</h3>
              <p className="text-sm text-indigo-800 mb-2">
                <span className="font-medium">Total points:</span> {generatedPractical.optional_assessment.total_points}
              </p>
              <p className="text-sm text-indigo-800 mb-3">{generatedPractical.optional_assessment.submission_instructions}</p>
              <ul className="list-disc list-inside space-y-1 text-sm text-indigo-800 mb-3">
                {generatedPractical.optional_assessment.evidence_requirements.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
              <div className="space-y-2">
                {generatedPractical.optional_assessment.rubric_criteria.map((criterion, index) => (
                  <div key={index} className="rounded border border-indigo-200 bg-white p-3">
                    <p className="text-sm font-medium text-indigo-900">{criterion.name} ({criterion.max_points})</p>
                    <p className="text-sm text-indigo-800">{criterion.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PracticalGenerator;
