import React, { useEffect, useMemo, useState } from 'react';
import { Building2, GraduationCap, Heart, Sparkles } from 'lucide-react';
import BrandMark from './BrandMark';

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
    desc: "From a mark that's just a number to personalised feedback they can question, with a 360 capability map across their entire academic journey",
  },
  {
    key: 'lecturers',
    label: 'Lecturers',
    icon: Heart,
    eyebrow: 'LECTURERS',
    title: 'Teaching Transformed, Not Just Time Saved',
    desc: "See where teaching landed, what students don't understand, and let AI learn your standards, with emotion-free consistency that gives you your evenings back",
  },
  {
    key: 'institution',
    label: 'Institution',
    icon: Building2,
    eyebrow: 'INSTITUTION',
    title: 'An Intelligence Moat That Compounds',
    desc: 'Features can be copied. Institutional learning cannot. An AI model that gets smarter with every moderation cycle, every semester',
  },
];

const ROTATE_MS = 5000;
const SPARKLE_COUNT = 14;

/**
 * Marketing panel shown alongside the login/register screens (desktop only).
 * Rendered by App.tsx only while `!user`, so it naturally disappears once
 * the user is authenticated, so no auth-state polling needed here, unlike
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
      className="relative hidden w-[55%] flex-col overflow-hidden p-12 text-white lg:flex xl:p-16"
      style={{
        background:
          'linear-gradient(145deg, rgb(67,56,202), rgb(91,79,229) 20%, rgb(109,40,217) 45%, rgb(124,58,237), rgb(99,102,241) 85%, rgb(79,70,229))',
      }}
    >
      {/* Colour glows for depth */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(70% 50% at 20% 30%, rgba(167,139,250,.35) 0%, transparent 60%), radial-gradient(50% 70% at 80% 20%, rgba(99,102,241,.3) 0%, transparent 55%), radial-gradient(60% 50% at 50% 80%, rgba(139,92,246,.25) 0%, transparent 55%)',
        }}
      />
      {/* Navy tint, strongest behind the text on the left, so the copy stays readable */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'linear-gradient(115deg, rgba(8,17,54,.82) 0%, rgba(10,22,64,.6) 55%, rgba(24,20,88,.42) 100%)' }}
      />
      {/* Fine grid that fades out towards the bottom */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[.14]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.9) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.9) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 80%)',
          maskImage: 'linear-gradient(to bottom, black 0%, transparent 80%)',
        }}
      />
      {/* Soft floating orbs */}
      <div className="pointer-events-none absolute -right-24 top-24 h-72 w-72 animate-[hp-float_9s_ease-in-out_infinite] rounded-full bg-violet-400/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-20 -left-16 h-64 w-64 animate-[hp-float_11s_ease-in-out_infinite] rounded-full bg-indigo-400/20 blur-3xl" />
      {sparkles.map((s, i) => (
        <span
          key={i}
          className="pointer-events-none absolute h-[3px] w-[3px] animate-[hp-twinkle_3s_ease-in-out_infinite] rounded-full bg-white/80"
          style={{ left: s.left, top: s.top, animationDelay: s.delay }}
        />
      ))}

      <div className="relative z-10 flex items-center gap-3 text-xl font-bold tracking-tight">
        <BrandMark size={40} />
        Acexen
      </div>

      <div className="relative z-10 my-auto py-10">
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-xs font-semibold tracking-wide text-violet-100 backdrop-blur-sm">
          <Sparkles className="h-3.5 w-3.5 text-amber-200" />
          AI Academic Intelligence Engine
        </div>

        <h1 className="mt-6 text-[2.1rem] font-extrabold leading-[1.1] tracking-tight xl:text-[3rem]">
          The AI that sustains
          <br />
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: 'linear-gradient(90deg, #ffffff, #c4b5fd 60%, #fde68a)' }}
          >
            academic cognitive endurance
          </span>
        </h1>

        <p className="mt-5 max-w-[34rem] text-base leading-relaxed text-white/90">
          Not a marking tool. The intelligence layer that strengthens how students think, transforms how
          lecturers teach, and builds institutional memory that compounds.
        </p>

        <div className="mt-8 inline-flex rounded-full border border-white/15 bg-white/10 p-1 backdrop-blur-sm">
          {TABS.map((tab, idx) => {
            const Icon = tab.icon;
            const isActive = idx === active;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActive(idx)}
                className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[.8rem] font-semibold transition-all ${
                  isActive ? 'bg-white text-primary-700 shadow-md' : 'text-white/75 hover:text-white'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div key={current.key} className="mt-5 overflow-hidden rounded-2xl border border-white/20 bg-white/10 shadow-[0_20px_50px_-20px_rgba(0,0,0,.5)] backdrop-blur-md">
          <div className="flex gap-4 p-5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-400 to-indigo-500 shadow-lg">
              <current.icon className="h-5 w-5 text-white" />
            </span>
            <div>
              <div className="mb-1 text-[.7rem] font-bold tracking-[.1em] text-violet-200">{current.eyebrow}</div>
              <div className="mb-1.5 text-[1.1rem] font-semibold leading-snug">{current.title}</div>
              <div className="text-[.88rem] leading-relaxed text-white/85">{current.desc}</div>
            </div>
          </div>
          <div className="h-1 w-full bg-white/10">
            <div
              className="h-full origin-left bg-gradient-to-r from-violet-300 to-amber-200"
              style={{ animation: `hp-progress ${ROTATE_MS}ms linear forwards` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeroPanel;
