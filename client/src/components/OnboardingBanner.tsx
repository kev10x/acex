import React, { useState } from 'react';
import { CheckCircle, ChevronRight, X } from 'lucide-react';

const STORAGE_KEY = 'ax:onboarding-dismissed';

const STEPS = [
  { id: 'rubric',     label: 'Create your first rubric',        tab: 'rubrics',  hint: 'Manage Rubrics tab' },
  { id: 'upload',     label: 'Upload student scripts',           tab: 'upload',   hint: 'Upload Scripts tab' },
  { id: 'mark',       label: 'Run AI marking',                   tab: 'marking',  hint: 'AI Marking tab' },
  { id: 'results',    label: 'Review and export results',        tab: 'results',  hint: 'Results tab' },
];

interface Props {
  completedSteps?: string[];
  onNavigate: (tab: string) => void;
}

const OnboardingBanner: React.FC<Props> = ({ completedSteps = [], onNavigate }) => {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === '1'
  );

  if (dismissed) return null;

  const allDone = STEPS.every(s => completedSteps.includes(s.id));

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setDismissed(true);
  };

  return (
    <div className="mb-6 rounded-xl border border-primary-200 bg-gradient-to-r from-primary-50 to-violet-50 p-5 relative">
      <button
        onClick={dismiss}
        className="absolute right-4 top-4 text-slate-400 hover:text-slate-600"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="mb-3">
        <h3 className="text-sm font-bold text-slate-800">
          {allDone ? '🎉 You're all set!' : 'Get started with Acexen'}
        </h3>
        <p className="text-xs text-slate-500 mt-0.5">
          {allDone
            ? 'You've completed the setup. Dismiss this whenever you're ready.'
            : 'Four steps to your first AI-marked batch.'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STEPS.map((step, i) => {
          const done = completedSteps.includes(step.id);
          return (
            <button
              key={step.id}
              onClick={() => !done && onNavigate(step.tab)}
              className={`group rounded-lg border p-3 text-left transition-all ${
                done
                  ? 'border-green-200 bg-green-50 cursor-default'
                  : 'border-primary-200 bg-white hover:border-primary-400 hover:shadow-sm cursor-pointer'
              }`}
            >
              <div className="flex items-start gap-2">
                <div className={`mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  done ? 'bg-green-500 text-white' : 'bg-primary-100 text-primary-600'
                }`}>
                  {done ? <CheckCircle className="h-3.5 w-3.5" /> : i + 1}
                </div>
                <div>
                  <p className={`text-xs font-semibold ${done ? 'text-green-700 line-through' : 'text-slate-700'}`}>
                    {step.label}
                  </p>
                  {!done && (
                    <p className="mt-0.5 flex items-center gap-0.5 text-[10px] text-primary-500 group-hover:text-primary-700">
                      {step.hint} <ChevronRight className="h-2.5 w-2.5" />
                    </p>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default OnboardingBanner;
