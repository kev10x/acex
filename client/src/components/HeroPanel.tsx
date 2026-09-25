import React, { useEffect, useMemo, useState } from 'react';
import { Building2, GraduationCap, Heart } from 'lucide-react';

interface HeroTab {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  title: string;
  desc: string;
}

const TABS: HeroTab[] = [
  {
    key: 'students',
    label: 'Students',
    icon: GraduationCap,
    eyebrow: 'STUDENTS',
    title: 'Feedback That Transforms Thinking',
    desc: "From a mark that's just a number to personalised feedback they can question — with a 360 capability map across their entire academic journey",
  },
  {
    key: 'lecturers',
    label: 'Lecturers',
    icon: Heart,
    eyebrow: 'LECTURERS',
    title: 'Teaching Transformed, Not Just Time Saved',
    desc: "See where teaching landed, what students don't understand, and let AI learn your standards — emotion-free consistency that gives you your evenings back",
  },
  {
    key: 'institution',
    label: 'Institution',
    icon: Building2,
    eyebrow: 'INSTITUTION',
    title: 'An Intelligence Moat That Compounds',
    desc: 'Features can be copied. Institutional learning cannot — an AI model that gets smarter with every moderation cycle, every semester',
  },
];

const ROTATE_MS = 5000;
const SPARKLE_COUNT = 14;

/**
 * Marketing panel shown alongside the login/register screens (desktop only).
 * Rendered by App.tsx only while `!user`, so it naturally disappears once
 * the user is authenticated — no auth-state polling needed here, unlike
 * the earlier standalone static-HTML version of this panel.
 */
const HeroPanel: React.FC = () => {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActive((prev) => (prev + 1) % TABS.length);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  const sparkles = useMemo(
    () =>
      Array.from({ length: SPARKLE_COUNT }, () => ({
        left: `${Math.random() * 100}%`,
        top: `${Math.random() * 100}%`,
        delay: `${Math.random() * 3}s`,
      })),
    []
  );

  const current = TABS[active];

  return (
    <div
      className="relative hidden w-[55%] flex-col justify-between overflow-hidden p-12 text-white lg:flex xl:p-16"
      style={{
        background:
          'linear-gradient(145deg, rgb(67,56,202), rgb(91,79,229) 20%, rgb(109,40,217) 45%, rgb(124,58,237), rgb(99,102,241) 85%, rgb(79,70,229))',
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(70% 50% at 20% 30%, rgba(167,139,250,.35) 0%, transparent 60%), radial-gradient(50% 70% at 80% 20%, rgba(99,102,241,.3) 0%, transparent 55%), radial-gradient(60% 50% at 50% 80%, rgba(139,92,246,.25) 0%, transparent 55%), radial-gradient(40% 40% at 70% 60%, rgba(196,181,253,.15) 0%, transparent 50%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255,255,255,.9) .8px, transparent .8px), radial-gradient(circle, rgba(255,255,255,.5) .5px, transparent .5px)',
          backgroundSize: '28px 28px, 14px 14px',
          backgroundPosition: '0 0, 7px 7px',
        }}
      />
      {/* Navy tint so the copy stays readable over the bright gradient */}
      <div className="pointer-events-none absolute inset-0 bg-[rgba(10,22,64,0.55)]" />
      {sparkles.map((s, i) => (
        <span
          key={i}
          className="pointer-events-none absolute h-[3px] w-[3px] animate-[hp-twinkle_3s_ease-in-out_infinite] rounded-full bg-white/80"
          style={{ left: s.left, top: s.top, animationDelay: s.delay }}
        />
      ))}

      <div className="relative z-10 flex h-full flex-col justify-between">
        <div>
          <div className="flex items-center gap-2.5 text-[1.15rem] font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white/15">
              <GraduationCap className="h-4 w-4" />
            </span>
            Acexen
          </div>

          <div className="mt-10 inline-flex w-fit items-center gap-1.5 rounded-full border border-white/20 bg-white/12 px-3.5 py-1.5 text-xs font-medium">
            ✨ AI Academic Intelligence Engine
          </div>

          <h1 className="mt-5 text-[2.4rem] font-bold leading-[1.15] tracking-tight">
            The AI that sustains
            <br />
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,.95), rgba(196,181,253,.95))',
              }}
            >
              academic cognitive endurance
            </span>
          </h1>

          <p className="mt-4 max-w-[34rem] text-[.95rem] leading-relaxed text-white/85">
            Not a marking tool. The intelligence layer that strengthens how students think, transforms how
            lecturers teach, and builds institutional memory that compounds.
          </p>

          <div className="mt-7 flex flex-wrap gap-2">
            {TABS.map((tab, idx) => {
              const Icon = tab.icon;
              const isActive = idx === active;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActive(idx)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[.8rem] font-medium transition-colors ${
                    isActive
                      ? 'border-transparent bg-white/95 text-primary-600'
                      : 'border-white/18 bg-white/8 text-white/75 hover:bg-white/15'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="mt-6 rounded-2xl border border-white/18 bg-white/10 p-5 backdrop-blur-sm">
            <div className="mb-1.5 text-[.7rem] font-bold tracking-[.08em] text-violet-200">
              {current.eyebrow}
            </div>
            <div className="mb-1.5 text-[1.05rem] font-semibold">{current.title}</div>
            <div className="text-[.85rem] leading-relaxed text-white/80">{current.desc}</div>
            <div className="mt-4 flex gap-1.5">
              {TABS.map((tab, idx) => (
                <span
                  key={tab.key}
                  className={`h-1 flex-1 rounded-full transition-colors ${idx === active ? 'bg-white/90' : 'bg-white/25'}`}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="mt-8 text-[.78rem] text-white/55">Built for higher education institutions</div>
      </div>
    </div>
  );
};

export default HeroPanel;
