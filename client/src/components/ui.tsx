import React from 'react';

type IconType = React.ComponentType<{ className?: string }>;

export type Tone = 'primary' | 'green' | 'amber' | 'rose' | 'orange' | 'violet' | 'slate' | 'sky';

const TONES: Record<Tone, { chip: string; text: string; tile: string; label: string; value: string }> = {
  primary: { chip: 'bg-primary-50 text-primary-600', text: 'text-primary-600', tile: 'bg-primary-50/60 border-primary-100', label: 'text-primary-700', value: 'text-primary-900' },
  green: { chip: 'bg-emerald-50 text-emerald-600', text: 'text-emerald-600', tile: 'bg-emerald-50/60 border-emerald-100', label: 'text-emerald-700', value: 'text-emerald-900' },
  amber: { chip: 'bg-amber-50 text-amber-600', text: 'text-amber-600', tile: 'bg-amber-50/60 border-amber-100', label: 'text-amber-700', value: 'text-amber-900' },
  rose: { chip: 'bg-rose-50 text-rose-600', text: 'text-rose-600', tile: 'bg-rose-50/60 border-rose-100', label: 'text-rose-700', value: 'text-rose-900' },
  orange: { chip: 'bg-orange-50 text-orange-600', text: 'text-orange-600', tile: 'bg-orange-50/60 border-orange-100', label: 'text-orange-700', value: 'text-orange-900' },
  violet: { chip: 'bg-accent-50 text-accent-600', text: 'text-accent-600', tile: 'bg-accent-50/60 border-accent-100', label: 'text-accent-700', value: 'text-accent-900' },
  slate: { chip: 'bg-gray-100 text-gray-600', text: 'text-gray-600', tile: 'bg-gray-50 border-gray-200', label: 'text-gray-600', value: 'text-gray-900' },
  sky: { chip: 'bg-sky-50 text-sky-600', text: 'text-sky-600', tile: 'bg-sky-50/60 border-sky-100', label: 'text-sky-700', value: 'text-sky-900' },
};

// Consistent page title row: title + description on the left, actions on the right.
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: IconType;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between ${className}`}>
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-600 ring-1 ring-inset ring-primary-100">
            <Icon className="h-5 w-5" />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight text-gray-900">{title}</h2>
          {description && <p className="mt-1 max-w-2xl text-sm text-gray-500">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// KPI tile: tinted icon chip, small label, large value.
export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'primary',
  hint,
}: {
  label: string;
  value: React.ReactNode;
  icon?: IconType;
  tone?: Tone;
  hint?: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-gray-200/70 bg-white p-5 shadow-sm">
      {Icon && (
        <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${t.chip}`}>
          <Icon className="h-5 w-5" />
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</div>
        <div className="mt-0.5 text-2xl font-bold tracking-tight text-gray-900">{value}</div>
        {hint && <div className="mt-0.5 text-xs text-gray-500">{hint}</div>}
      </div>
    </div>
  );
}

// Compact tinted tile for status/queue counters.
export function MetricTile({ label, value, tone = 'slate' }: { label: string; value: React.ReactNode; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <div className={`rounded-xl border px-4 py-3 ${t.tile}`}>
      <div className={`text-xs font-semibold ${t.label}`}>{label}</div>
      <div className={`mt-1 text-2xl font-bold tracking-tight ${t.value}`}>{value}</div>
    </div>
  );
}

// Standard content card with an optional header row.
export function SectionCard({
  title,
  description,
  actions,
  children,
  className = '',
  bodyClassName = 'p-5 sm:p-6',
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`rounded-2xl border border-gray-200/70 bg-white shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            {title && <h3 className="text-base font-semibold text-gray-900">{title}</h3>}
            {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

// Friendly empty state, replaces bare grey "nothing here" text.
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: IconType;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-12 text-center ${className}`}>
      {Icon && (
        <span className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-50 text-primary-500 ring-1 ring-inset ring-primary-100">
          <Icon className="h-7 w-7" />
        </span>
      )}
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-gray-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export const btn = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
  secondary:
    'inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
  ghostDanger:
    'inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:opacity-50',
};
