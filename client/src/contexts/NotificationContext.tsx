import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type NotificationVariant = 'success' | 'error' | 'info';

type NotificationInput =
  | string
  | {
      title?: string;
      message: string;
      variant?: NotificationVariant;
      durationMs?: number;
    };

interface NotificationItem {
  id: number;
  title?: string;
  message: string;
  variant: NotificationVariant;
}

interface NotificationContextValue {
  notify: (input: NotificationInput) => void;
  notifySuccess: (message: string, title?: string) => void;
  notifyError: (message: string, title?: string) => void;
  notifyInfo: (message: string, title?: string) => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const variantStyles: Record<NotificationVariant, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-red-200 bg-red-50 text-red-900',
  info: 'border-blue-200 bg-blue-50 text-blue-900',
};

const variantIcon: Record<NotificationVariant, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timersRef.current[id];
    }
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const payload = typeof input === 'string'
      ? { message: input, variant: 'info' as NotificationVariant, durationMs: 3800 }
      : {
          title: input.title,
          message: input.message,
          variant: input.variant || 'info',
          durationMs: input.durationMs ?? 3800,
        };
    const id = nextIdRef.current++;
    setItems((prev) => [...prev, { id, title: payload.title, message: payload.message, variant: payload.variant }]);
    timersRef.current[id] = setTimeout(() => dismiss(id), payload.durationMs);
  }, [dismiss]);

  const value = useMemo<NotificationContextValue>(() => ({
    notify,
    notifySuccess: (message, title) => notify({ message, title, variant: 'success' }),
    notifyError: (message, title) => notify({ message, title, variant: 'error', durationMs: 4800 }),
    notifyInfo: (message, title) => notify({ message, title, variant: 'info' }),
  }), [notify]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(92vw,24rem)] flex-col gap-2">
        {items.map((item) => {
          const Icon = variantIcon[item.variant];
          return (
            <div key={item.id} className={`pointer-events-auto rounded-lg border p-3 shadow-lg ${variantStyles[item.variant]}`}>
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  {item.title ? <p className="text-sm font-semibold">{item.title}</p> : null}
                  <p className={`text-sm ${item.title ? 'mt-0.5' : ''}`}>{item.message}</p>
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(item.id)}
                  className="rounded p-0.5 hover:bg-white/40"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </NotificationContext.Provider>
  );
};

export function useNotification() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotification must be used within NotificationProvider');
  }
  return context;
}
