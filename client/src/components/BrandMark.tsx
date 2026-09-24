import ProfileModalLazy from './ProfileModal';
import React from 'react';
import { createPortal } from 'react-dom';

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

// Small logo + wordmark row for public, logged-out student pages.
export function PublicBrand({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-2.5 ${className}`}>
      <BrandMark size={30} />
      <span className="text-[15px] font-bold tracking-tight text-gray-900">Acexen</span>
    </div>
  );
}

// The user's avatar, as a button that opens their profile.
export function ProfileAvatarButton({ initial, className = '' }: { initial: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Your profile"
        className={`transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${className}`}
      >
        <span className="flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br from-primary-500 to-accent-600 font-bold text-white">
          {initial}
        </span>
      </button>
      {open && createPortal(<ProfileModalLazy onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}
