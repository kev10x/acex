import React from 'react';

interface BrandMarkProps {
  size?: number;
  className?: string;
}

// Acexen logo tile: an "A" on the brand indigo-to-violet gradient. Matches public/favicon.svg.
export default function BrandMark({ size = 36, className = '' }: BrandMarkProps) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-primary-500 to-accent-600 shadow-glow ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 64 64" width={size * 0.62} height={size * 0.62} fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 50 L32 12 L50 50" strokeWidth="7" />
        <path d="M22 38 H42" strokeWidth="6" />
      </svg>
    </span>
  );
}
