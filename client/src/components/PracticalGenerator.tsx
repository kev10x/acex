import React, { useEffect, useRef, useState } from 'react';
import { Beaker, Download, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  assessmentsAPI,
  GeneratedPractical,
  modulesAPI,
  PracticalCodeExample,
  PracticalProcedureStep,
} from '../services/api';
import { EDUCATION_LEVEL_OPTIONS } from '../constants/educationLevels';

const PRACTICAL_TYPES = ['Laboratory', 'Workshop', 'Fieldwork', 'Simulation', 'Studio', 'Project-based'];

const PracticalGenerator: React.FC = () => {
  const [topic, setTopic] = useState('');
  const [level, setLevel] = useState('');
  const [practicalType, setPracticalType] = useState('Laboratory');
  const [mode, setMode] = useState<'guide' | 'assessment'>('guide');
  const [deliveryMode, setDeliveryMode] = useState<'computer_based' | 'hands_on'>('computer_based');
  const [includeDetailedInstructions, setIncludeDetailedInstructions] = useState(true);
  const [includeCodeExamples, setIncludeCodeExamples] = useState(true);
  const [programmingLanguage, setProgrammingLanguage] = useState('Python');
  const [platformTools, setPlatformTools] = useState('VS Code, Terminal, Git');
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [learningObjectives, setLearningObjectives] = useState('');
  const [materials, setMaterials] = useState('');
  const [safetyFocus, setSafetyFocus] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backgroundGenerationNotice, setBackgroundGenerationNotice] = useState<string | null>(null);
  const [editablePractical, setEditablePractical] = useState<GeneratedPractical | null>(null);
  const [practicalView, setPracticalView] = useState<'edit' | 'preview'>('edit');
  const recoveredPracticalJobIdRef = useRef<number | null>(null);

  const splitLines = (text: string) =>
    text
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);

  const toLineBlock = (items: string[] | undefined) => (Array.isArray(items) ? items.join('\n') : '');

  const clonePractical = (practical: GeneratedPractical): GeneratedPractical =>
    JSON.parse(JSON.stringify(practical));

  const updatePractical = (updater: (current: GeneratedPractical) => GeneratedPractical) => {
    setEditablePractical((current) => (current ? updater(current) : current));
  };

  const updateStringArrayField = (
    field: 'learning_objectives' | 'materials' | 'safety_notes' | 'preparation_checklist' | 'reflection_questions' | 'digital_environment',
    value: string
  ) => {
    const items = splitLines(value);
    updatePractical((current) => ({ ...current, [field]: items }));
  };

  const updateStep = (index: number, key: keyof PracticalProcedureStep, value: any) => {
    updatePractical((current) => ({
      ...current,
      procedure_steps: current.procedure_steps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, [key]: value } : step
      ),
    }));
  };

  const updateStepCodeExample = (
    index: number,
    key: 'language' | 'code' | 'explanation',
    value: string
  ) => {
    updatePractical((current) => ({
      ...current,
      procedure_steps: current.procedure_steps.map((step, stepIndex) => {
        if (stepIndex !== index) return step;
        const codeExample = {
          language: step.code_example?.language || 'text',
          code: step.code_example?.code || '',
          explanation: step.code_example?.explanation || '',
        };
        return {
          ...step,
          code_example: {
            ...codeExample,
            [key]: value,
          },
        };
      }),
    }));
  };

  const removeStepCodeExample = (index: number) => {
    updatePractical((current) => ({
      ...current,
      procedure_steps: current.procedure_steps.map((step, stepIndex) => {
        if (stepIndex !== index) return step;
        const { code_example, ...rest } = step;
        return rest;
      }),
    }));
  };

  const addStep = () => {
    updatePractical((current) => ({
      ...current,
      procedure_steps: [
        ...current.procedure_steps,
        {
          step: current.procedure_steps.length + 1,
          title: `Step ${current.procedure_steps.length + 1}`,
          instructions: '',
          expected_outcome: '',
          teacher_notes: '',
        },
      ],
    }));
  };

  const removeStep = (index: number) => {
    updatePractical((current) => ({
      ...current,
      procedure_steps: current.procedure_steps
        .filter((_, stepIndex) => stepIndex !== index)
        .map((step, stepIndex) => ({ ...step, step: stepIndex + 1 })),
    }));
  };

  const updateCodeExample = (index: number, key: keyof PracticalCodeExample, value: string) => {
    updatePractical((current) => ({
      ...current,
      code_examples: (current.code_examples || []).map((example, exampleIndex) =>
        exampleIndex === index ? { ...example, [key]: value } : example
      ),
    }));
  };

  const addCodeExample = () => {
    updatePractical((current) => ({
      ...current,
      code_examples: [
        ...(current.code_examples || []),
        {
          title: 'New code example',
          language: programmingLanguage.trim() || 'text',
          code: '',
          explanation: '',
        },
      ],
    }));
  };

  const removeCodeExample = (index: number) => {
    updatePractical((current) => ({
      ...current,
      code_examples: (current.code_examples || []).filter((_, exampleIndex) => exampleIndex !== index),
    }));
  };

  const handleGenerate = async () => {
    const normalizedTopic = topic.trim();
    if (!normalizedTopic) {
      setError('Please enter a topic for the practical.');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setBackgroundGenerationNotice(null);
    setEditablePractical(null);

    try {
      const response = await assessmentsAPI.generatePractical({
        topic: normalizedTopic,
        level: level || null,
        practical_type: practicalType,
        mode,
        delivery_mode: deliveryMode,
        include_code_examples: includeCodeExamples,
        programming_language: programmingLanguage.trim() || null,
        platform_tools: splitLines(platformTools),
        include_detailed_instructions: includeDetailedInstructions,
        duration_minutes: durationMinutes,
        learning_objectives: splitLines(learningObjectives),
        required_materials: splitLines(materials),
        safety_focus: splitLines(safetyFocus),
      });
      setEditablePractical(clonePractical(response.data.practical));
      setPracticalView('edit');
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to generate practical');
    } finally {
      setIsGenerating(false);
    }
  };

  const recoverBackgroundPracticalGeneration = async () => {
    try {
      const res = await modulesAPI.getGenerationJobs({ limit: 40, scope: 'mine' });
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      const jobs = items
        .filter((job: any) => job?.job_type === 'practical_generation')
        .sort((a: any, b: any) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
      let latest = jobs[0];
      if (!latest) return;

      if (['scheduled', 'processing', 'retrying'].includes(String(latest.status || ''))) {
        setBackgroundGenerationNotice('A practical generation is still running in the background. This page will auto-recover it when it finishes.');
        return;
      }

      if (latest.status === 'completed' && latest.result?.has_practical) {
        const fullRes = await modulesAPI.getGenerationJobs({ limit: 40, scope: 'mine', include_full_result: true });
        const fullItems = Array.isArray(fullRes.data?.items) ? fullRes.data.items : [];
        latest = fullItems.find((job: any) => Number(job.id) === Number(latest.id)) || latest;
      }

      if (
        latest.status === 'completed' &&
        latest.result?.practical &&
        recoveredPracticalJobIdRef.current !== Number(latest.id || 0) &&
        (isGenerating || !editablePractical)
      ) {
        recoveredPracticalJobIdRef.current = Number(latest.id || 0);
        setEditablePractical(clonePractical(latest.result.practical));
        setPracticalView('edit');
        setIsGenerating(false);
        setError(null);
        setBackgroundGenerationNotice('Recovered your generated practical from a background job.');
      }
    } catch (_) {
      // Best-effort recovery only; ignore poll failures.
    }
  };

  useEffect(() => {
    recoverBackgroundPracticalGeneration();
    const timer = setInterval(() => {
      recoverBackgroundPracticalGeneration();
    }, 15000);
    return () => clearInterval(timer);
  }, [isGenerating, editablePractical]);

  const handleDownload = () => {
    if (!editablePractical) return;
    const p = editablePractical;
    const lines: string[] = [
      `# ${p.title}`,
      '',
      `Topic: ${p.topic}`,
      `Type: ${p.practical_type}`,
      `Mode: ${p.mode}`,
      `Delivery mode: ${p.delivery_mode || 'computer_based'}`,
      `Estimated duration: ${p.estimated_duration_minutes} minutes`,
      '',
      '## Overview',
      p.overview,
      '',
      '## Learning Objectives',
      ...p.learning_objectives.map((item) => `- ${item}`),
      '',
      '## Digital Environment',
      ...(p.digital_environment || []).map((item) => `- ${item}`),
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
      if (step.code_example?.code) {
        lines.push(`- Code example (${step.code_example.language || 'text'}):`);
        lines.push(`\`\`\`${step.code_example.language || 'text'}`);
        lines.push(step.code_example.code);
        lines.push('```');
        if (step.code_example.explanation) lines.push(`- Code explanation: ${step.code_example.explanation}`);
      }
      lines.push('');
    });
    if (p.code_examples?.length) {
      lines.push('## Additional Code Examples');
      p.code_examples.forEach((example) => {
        lines.push(`### ${example.title}`);
        if (example.explanation) lines.push(example.explanation);
        lines.push('');
        lines.push(`\`\`\`${example.language || 'text'}`);
        lines.push(example.code);
        lines.push('```');
        lines.push('');
      });
    }
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
    <div className="w-full">
      <div className="bg-white rounded-2xl shadow-sm p-6 mb-6 border border-gray-200/70">
        <div className="flex items-center gap-3 mb-4">
          <Beaker className="w-8 h-8 text-indigo-600" />
          <h1 className="text-2xl font-bold text-gray-900">Practical Generator</h1>
        </div>
        <p className="text-gray-600 mb-6">
          Generate editable practical guides or assessments, including computer-based IT workflows and code examples.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}
        {backgroundGenerationNotice && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">{backgroundGenerationNotice}</div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Topic *</label>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Building a secure REST API with Node.js"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Level</label>
              <select
                value={level}
                onChange={(e) => setLevel(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
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
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
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
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'guide' | 'assessment')}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              >
                <option value="guide">Guide</option>
                <option value="assessment">Assessment</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Delivery mode</label>
              <select
                value={deliveryMode}
                onChange={(e) => setDeliveryMode(e.target.value as 'computer_based' | 'hands_on')}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              >
                <option value="computer_based">Computer-based (IT)</option>
                <option value="hands_on">Hands-on</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Programming language</label>
              <input
                value={programmingLanguage}
                onChange={(e) => setProgrammingLanguage(e.target.value)}
                placeholder="e.g. Python, JavaScript, Java"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Digital tools/environment</label>
              <textarea
                rows={3}
                value={platformTools}
                onChange={(e) => setPlatformTools(e.target.value)}
                placeholder="One per line or comma-separated, e.g. VS Code, GitHub Classroom, Docker"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              />
            </div>
            <div className="space-y-3 mt-1">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDetailedInstructions}
                  onChange={(e) => setIncludeDetailedInstructions(e.target.checked)}
                  className="w-4 h-4 text-indigo-600 border-gray-300 rounded"
                />
                Include detailed instructions
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeCodeExamples}
                  onChange={(e) => setIncludeCodeExamples(e.target.checked)}
                  className="w-4 h-4 text-indigo-600 border-gray-300 rounded"
                />
                Include code examples
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
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Materials / equipment (optional)</label>
              <textarea
                rows={4}
                value={materials}
                onChange={(e) => setMaterials(e.target.value)}
                placeholder="One per line or comma-separated"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Safety focus (optional)</label>
              <textarea
                rows={4}
                value={safetyFocus}
                onChange={(e) => setSafetyFocus(e.target.value)}
                placeholder="One per line or comma-separated"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
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

      {editablePractical && (
        <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-200/70">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex-1">
              <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Title</label>
              <input
                value={editablePractical.title}
                onChange={(e) => updatePractical((current) => ({ ...current, title: e.target.value }))}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 text-lg font-semibold bg-white shadow-sm"
              />
              <p className="text-sm text-gray-500 mt-2">
                {editablePractical.practical_type} | {editablePractical.mode} | {(editablePractical.delivery_mode || 'computer_based').replace('_', ' ')} | {editablePractical.estimated_duration_minutes} minutes
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center rounded-md border border-gray-300 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPracticalView('edit')}
                  className={`px-3 py-2 text-sm ${practicalView === 'edit' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setPracticalView('preview')}
                  className={`px-3 py-2 text-sm ${practicalView === 'preview' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                >
                  Preview
                </button>
              </div>
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 bg-white shadow-sm"
              >
                <Download className="w-4 h-4 mr-2" />
                Download
              </button>
            </div>
          </div>

          {practicalView === 'edit' ? (
          <div className="space-y-6">
            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">Overview</label>
              <textarea
                rows={5}
                value={editablePractical.overview}
                onChange={(e) => updatePractical((current) => ({ ...current, overview: e.target.value }))}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 text-sm"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">Learning Objectives</label>
                <textarea
                  rows={6}
                  value={toLineBlock(editablePractical.learning_objectives)}
                  onChange={(e) => updateStringArrayField('learning_objectives', e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">Digital Environment</label>
                <textarea
                  rows={6}
                  value={toLineBlock(editablePractical.digital_environment || [])}
                  onChange={(e) => updateStringArrayField('digital_environment', e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 text-sm"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">Materials</label>
                <textarea
                  rows={6}
                  value={toLineBlock(editablePractical.materials)}
                  onChange={(e) => updateStringArrayField('materials', e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900 mb-2">Safety Notes</label>
                <textarea
                  rows={6}
                  value={toLineBlock(editablePractical.safety_notes)}
                  onChange={(e) => updateStringArrayField('safety_notes', e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">Preparation Checklist</label>
              <textarea
                rows={4}
                value={toLineBlock(editablePractical.preparation_checklist)}
                onChange={(e) => updateStringArrayField('preparation_checklist', e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 text-sm"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold text-gray-900">Procedure</h3>
                <button
                  type="button"
                  onClick={addStep}
                  className="inline-flex items-center px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 bg-white shadow-sm"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add Step
                </button>
              </div>
              <div className="space-y-4">
                {editablePractical.procedure_steps.map((step, index) => (
                  <div key={`${step.step}-${index}`} className="border border-gray-200 rounded-lg p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1">
                        <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Step title</label>
                        <input
                          value={step.title}
                          onChange={(e) => updateStep(index, 'title', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 text-sm font-medium bg-white shadow-sm"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeStep(index)}
                        className="inline-flex items-center px-2 py-2 border border-red-200 rounded-md text-red-600 hover:bg-red-50 mt-5"
                        title="Remove step"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Instructions</label>
                      <textarea
                        rows={4}
                        value={step.instructions}
                        onChange={(e) => updateStep(index, 'instructions', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white shadow-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Expected outcome</label>
                      <textarea
                        rows={2}
                        value={step.expected_outcome || ''}
                        onChange={(e) => updateStep(index, 'expected_outcome', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white shadow-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold uppercase text-gray-500 mb-1">Facilitator notes</label>
                      <textarea
                        rows={2}
                        value={step.teacher_notes || ''}
                        onChange={(e) => updateStep(index, 'teacher_notes', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white shadow-sm"
                      />
                    </div>
                    <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold uppercase text-indigo-700">Step code example</label>
                        {step.code_example?.code && (
                          <button
                            type="button"
                            onClick={() => removeStepCodeExample(index)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      <input
                        value={step.code_example?.language || programmingLanguage || 'text'}
                        onChange={(e) => updateStepCodeExample(index, 'language', e.target.value)}
                        placeholder="Language"
                        className="w-full px-3 py-2 border border-indigo-200 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white"
                      />
                      <textarea
                        rows={4}
                        value={step.code_example?.code || ''}
                        onChange={(e) => updateStepCodeExample(index, 'code', e.target.value)}
                        placeholder="Code snippet for this step"
                        className="w-full px-3 py-2 border border-indigo-200 rounded-md focus:ring-2 focus:ring-primary-500 text-sm font-mono bg-white"
                      />
                      <textarea
                        rows={2}
                        value={step.code_example?.explanation || ''}
                        onChange={(e) => updateStepCodeExample(index, 'explanation', e.target.value)}
                        placeholder="Brief explanation of the snippet"
                        className="w-full px-3 py-2 border border-indigo-200 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold text-gray-900">Additional Code Examples</h3>
                <button
                  type="button"
                  onClick={addCodeExample}
                  className="inline-flex items-center px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 bg-white shadow-sm"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add Code Example
                </button>
              </div>
              <div className="space-y-4">
                {(editablePractical.code_examples || []).map((example, index) => (
                  <div key={`${example.title}-${index}`} className="border border-gray-200 rounded-lg p-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        value={example.title}
                        onChange={(e) => updateCodeExample(index, 'title', e.target.value)}
                        placeholder="Example title"
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white shadow-sm"
                      />
                      <button
                        type="button"
                        onClick={() => removeCodeExample(index)}
                        className="inline-flex items-center px-2 py-2 border border-red-200 rounded-md text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <input
                      value={example.language}
                      onChange={(e) => updateCodeExample(index, 'language', e.target.value)}
                      placeholder="Language"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white shadow-sm"
                    />
                    <textarea
                      rows={5}
                      value={example.code}
                      onChange={(e) => updateCodeExample(index, 'code', e.target.value)}
                      placeholder="Code snippet"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 text-sm font-mono bg-white shadow-sm"
                    />
                    <textarea
                      rows={2}
                      value={example.explanation || ''}
                      onChange={(e) => updateCodeExample(index, 'explanation', e.target.value)}
                      placeholder="Explanation"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white shadow-sm"
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-900 mb-2">Reflection Questions</label>
              <textarea
                rows={4}
                value={toLineBlock(editablePractical.reflection_questions)}
                onChange={(e) => updateStringArrayField('reflection_questions', e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 text-sm"
              />
            </div>

            {editablePractical.optional_assessment && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 space-y-3">
                <h3 className="text-lg font-semibold text-indigo-900">Assessment Criteria</h3>
                <div>
                  <label className="block text-xs font-semibold uppercase text-indigo-700 mb-1">Submission instructions</label>
                  <textarea
                    rows={3}
                    value={editablePractical.optional_assessment.submission_instructions}
                    onChange={(e) =>
                      updatePractical((current) => ({
                        ...current,
                        optional_assessment: current.optional_assessment
                          ? { ...current.optional_assessment, submission_instructions: e.target.value }
                          : current.optional_assessment,
                      }))
                    }
                    className="w-full px-3 py-2 border border-indigo-200 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase text-indigo-700 mb-1">Evidence requirements</label>
                  <textarea
                    rows={4}
                    value={toLineBlock(editablePractical.optional_assessment.evidence_requirements)}
                    onChange={(e) =>
                      updatePractical((current) => ({
                        ...current,
                        optional_assessment: current.optional_assessment
                          ? {
                              ...current.optional_assessment,
                              evidence_requirements: splitLines(e.target.value),
                            }
                          : current.optional_assessment,
                      }))
                    }
                    className="w-full px-3 py-2 border border-indigo-200 rounded-md focus:ring-2 focus:ring-primary-500 text-sm bg-white"
                  />
                </div>
              </div>
            )}
          </div>
          ) : (
          <div className="space-y-6">
            <p className="text-gray-700 whitespace-pre-wrap">{editablePractical.overview}</p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Learning Objectives</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                  {editablePractical.learning_objectives.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Digital Environment</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                  {(editablePractical.digital_environment || []).map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Materials</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                  {editablePractical.materials.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Safety Notes</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                  {editablePractical.safety_notes.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-900 mb-2">Procedure</h3>
              <div className="space-y-3">
                {editablePractical.procedure_steps.map((step) => (
                  <div key={step.step} className="border border-gray-200 rounded-lg p-4">
                    <h4 className="font-medium text-gray-900">{step.step}. {step.title}</h4>
                    <p className="text-sm text-gray-700 mt-2 whitespace-pre-wrap">{step.instructions}</p>
                    {step.expected_outcome && (
                      <p className="text-sm text-emerald-700 mt-2"><span className="font-medium">Expected outcome:</span> {step.expected_outcome}</p>
                    )}
                    {step.teacher_notes && (
                      <p className="text-sm text-indigo-700 mt-2"><span className="font-medium">Teacher notes:</span> {step.teacher_notes}</p>
                    )}
                    {step.code_example?.code && (
                      <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3">
                        <p className="text-xs uppercase font-semibold text-gray-600 mb-2">Code Example ({step.code_example.language || 'text'})</p>
                        <pre className="text-xs text-gray-800 whitespace-pre-wrap overflow-x-auto">{step.code_example.code}</pre>
                        {step.code_example.explanation && (
                          <p className="text-xs text-gray-600 mt-2">{step.code_example.explanation}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {(editablePractical.code_examples || []).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Additional Code Examples</h3>
                <div className="space-y-3">
                  {(editablePractical.code_examples || []).map((example, index) => (
                    <div key={index} className="border border-gray-200 rounded-lg p-4">
                      <h4 className="font-medium text-gray-900">{example.title}</h4>
                      {example.explanation && <p className="text-sm text-gray-700 mt-1">{example.explanation}</p>}
                      <pre className="mt-2 text-xs text-gray-800 whitespace-pre-wrap overflow-x-auto rounded-md bg-gray-50 border border-gray-200 p-3">{example.code}</pre>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {editablePractical.reflection_questions.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Reflection Questions</h3>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                  {editablePractical.reflection_questions.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              </div>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
};

export default PracticalGenerator;
