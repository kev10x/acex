import React from 'react';
import { AlertCircle, Inbox, Info, Loader2 } from 'lucide-react';

type StateVariant = 'loading' | 'error' | 'empty' | 'info';

interface StatePanelProps {
  variant: StateVariant;
  title?: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

// Empty / loading states are centred and roomy (a friendly icon tile);
// error / info states stay as compact, tinted inline banners.
const tones: Record<StateVariant, { wrap: string; chip: string }> = {
  loading: { wrap: 'border-gray-200/70 bg-white', chip: 'bg-primary-50 text-primary-600 ring-primary-100' },
  empty: { wrap: 'border-dashed border-gray-300 bg-white/60', chip: 'bg-primary-50 text-primary-500 ring-primary-100' },
  error: { wrap: 'border-rose-200 bg-rose-50/70', chip: 'bg-rose-100 text-rose-600 ring-rose-200' },
  info: { wrap: 'border-amber-200 bg-amber-50/70', chip: 'bg-amber-100 text-amber-600 ring-amber-200' },
};

const iconMap: Record<StateVariant, React.ComponentType<{ className?: string }>> = {
  loading: Loader2,
  error: AlertCircle,
  empty: Inbox,
  info: Info,
};

const StatePanel: React.FC<StatePanelProps> = ({
  variant,
  title,
  message,
  actionLabel,
  onAction,
  className = '',
}) => {
  const Icon = iconMap[variant];
  const tone = tones[variant];
  const centred = variant === 'empty' || variant === 'loading';

  const action =
    actionLabel && onAction ? (
      <button
        type="button"
        onClick={onAction}
        className="mt-4 inline-flex items-center rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
      >
        {actionLabel}
      </button>
    ) : null;

  if (centred) {
    return (
      <div className={`flex flex-col items-center rounded-2xl border px-6 py-10 text-center ${tone.wrap} ${className}`.trim()}>
        <span className={`inline-flex h-12 w-12 items-center justify-center rounded-2xl ring-1 ring-inset ${tone.chip}`}>
          <Icon className={`h-6 w-6 ${variant === 'loading' ? 'animate-spin' : ''}`} />
        </span>
        {title ? <p className="mt-4 text-sm font-semibold text-gray-900">{title}</p> : null}
        {message ? <p className={`max-w-sm text-sm text-gray-500 ${title ? 'mt-1' : 'mt-4'}`}>{message}</p> : null}
        {action}
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-3 rounded-xl border p-4 ${tone.wrap} ${className}`.trim()}>
      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${tone.chip}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        {title ? <p className="text-sm font-semibold text-gray-900">{title}</p> : null}
        {message ? <p className={`text-sm text-gray-600 ${title ? 'mt-0.5' : ''}`}>{message}</p> : null}
        {action}
      </div>
    </div>
  );
};

export default StatePanel;
