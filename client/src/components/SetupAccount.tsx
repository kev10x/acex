import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, Eye, EyeOff, Loader2, Lock, User as UserIcon } from 'lucide-react';
import BrandMark from './BrandMark';
import { authAPI, getApiErrorMessage } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

// Opened from an emailed one-time link. 'invite' = a newly enrolled student choosing
// their name and password; 'reset' = a forgotten password.
const strength = (pw: string) => {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
  const colours = ['', '#ef4444', '#f97316', '#eab308', '#22c55e', '#16a34a'];
  return { score, label: labels[score] || '', colour: colours[score] || '' };
};

export default function SetupAccount({ onBackToLogin, onComplete }: { onBackToLogin: () => void; onComplete?: () => void }) {
  const { login } = useAuth();
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  const [checking, setChecking] = useState(true);
  const [info, setInfo] = useState<{ email: string; name: string; purpose: 'invite' | 'reset' } | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setLinkError('This link is missing its code. Please use the link from your email.');
        setChecking(false);
        return;
      }
      try {
        const res = await authAPI.getSetupInfo(token);
        if (cancelled) return;
        setInfo({ email: res.email, name: res.name, purpose: res.purpose });
        setName(res.name || '');
      } catch (err) {
        if (!cancelled) setLinkError(getApiErrorMessage(err, 'This link is invalid or has expired. Please ask for a new one.'));
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const pw = strength(password);
  const isInvite = info?.purpose === 'invite';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (isInvite && !name.trim()) { setError('Please enter your name'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setSaving(true);
    try {
      const res = await authAPI.setupAccount(token, password, name.trim() || undefined);
      setDone(true);
      // Straight in: they just proved who they are, so log them in with the new password.
      try {
        await login(res.email, password);
        window.history.replaceState({}, '', '/tools/');
        onComplete?.();
      } catch (_) {
        /* fall back to the manual "Go to sign in" button below */
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not save your password. The link may have expired.'));
    } finally {
      setSaving(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="flex min-h-screen items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200/70 bg-white shadow-xl">{children}</div>
    </div>
  );

  if (checking) {
    return shell(<div className="flex flex-col items-center px-8 py-14"><Loader2 className="h-8 w-8 animate-spin text-primary-600" /><p className="mt-3 text-sm text-gray-500">Checking your link...</p></div>);
  }

  if (linkError || !info) {
    return shell(
      <div className="px-8 py-10 text-center">
        <span className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-600"><AlertCircle className="h-6 w-6" /></span>
        <h1 className="text-xl font-bold text-gray-900">This link cannot be used</h1>
        <p className="mt-2 text-sm text-gray-500">{linkError || 'It may have expired or already been used.'}</p>
        <button onClick={onBackToLogin} className="mt-6 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-700">Go to sign in</button>
      </div>
    );
  }

  if (done) {
    return shell(
      <div className="px-8 py-10 text-center">
        <span className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600"><CheckCircle className="h-6 w-6" /></span>
        <h1 className="text-xl font-bold text-gray-900">{isInvite ? 'You are all set' : 'Password updated'}</h1>
        <p className="mt-2 text-sm text-gray-500">Signing you in...</p>
        <button onClick={onBackToLogin} className="mt-6 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50">Go to sign in</button>
      </div>
    );
  }

  const inputCls = 'w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-10 pr-3 text-sm shadow-sm';
  return shell(
    <form onSubmit={submit} className="px-8 py-9">
      <BrandMark size={44} className="mb-5" />
      <h1 className="text-2xl font-bold tracking-tight text-gray-900">{isInvite ? 'Welcome! Finish setting up' : 'Choose a new password'}</h1>
      <p className="mt-1 text-sm text-gray-500">
        {isInvite ? <>You have been enrolled. Set your name and a password for <span className="font-medium text-gray-700">{info.email}</span>.</> : <>Set a new password for <span className="font-medium text-gray-700">{info.email}</span>.</>}
      </p>

      <div className="mt-6 space-y-4">
        {isInvite && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Your name</label>
            <div className="relative">
              <UserIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" maxLength={255} autoFocus />
            </div>
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Password</label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input className={`${inputCls} pr-10`} type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
            <button type="button" onClick={() => setShow((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" aria-label={show ? 'Hide password' : 'Show password'}>
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {password && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex flex-1 gap-1">
                {[1, 2, 3, 4, 5].map((n) => (<div key={n} className="h-1 flex-1 rounded-full" style={{ backgroundColor: n <= pw.score ? pw.colour : '#e5e7eb' }} />))}
              </div>
              <span className="text-xs text-gray-500">{pw.label}</span>
            </div>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Confirm password</label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input className={inputCls} type={show ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat your password" autoComplete="new-password" />
          </div>
        </div>
      </div>

      {error && <p className="mt-4 flex items-center gap-1.5 text-sm text-rose-600"><AlertCircle className="h-4 w-4 shrink-0" />{error}</p>}

      <button type="submit" disabled={saving} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:opacity-60">
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        {isInvite ? 'Save and continue' : 'Update password'}
      </button>
    </form>
  );
}
