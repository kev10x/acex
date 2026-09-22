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

const styles: Record<StateVariant, string> = {
  loading: 'bg-primary-50 border-primary-200 text-primary-900',
  error: 'bg-red-50 border-red-200 text-red-900',
  empty: 'bg-gray-50 border-gray-200 text-gray-800',
  info: 'bg-amber-50 border-amber-200 text-amber-900',
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

  return (
    <div className={`rounded-lg border p-4 ${styles[variant]} ${className}`.trim()}>
      <div className="flex items-start gap-3">
        <Icon className={`h-5 w-5 mt-0.5 ${variant === 'loading' ? 'animate-spin' : ''}`} />
        <div className="min-w-0 flex-1">
          {title ? <p className="text-sm font-semibold">{title}</p> : null}
          {message ? <p className={`text-sm ${title ? 'mt-1 opacity-90' : ''}`}>{message}</p> : null}
          {actionLabel && onAction ? (
            <button
              type="button"
              onClick={onAction}
              className="mt-3 inline-flex items-center rounded-md border border-current px-3 py-1.5 text-xs font-medium hover:bg-white/40"
            >
              {actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default StatePanel;
