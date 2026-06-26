import React, { useState, useEffect } from 'react';
import { authAPI } from '../services/api';
import { Lock, Eye, EyeOff, CheckCircle, AlertCircle, ArrowLeft } from 'lucide-react';

interface Props {
  onBackToLogin: () => void;
}

const ResetPassword: React.FC<Props> = ({ onBackToLogin }) => {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token') || '';
    setToken(t);
    if (!t) setError('Reset link is missing or invalid. Please request a new one.');
  }, []);

  const strength = (pw: string): { score: number; label: string; colour: string } => {
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

  const pw = strength(password);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (!token) { setError('Reset token missing — request a new link'); return; }

    setLoading(true);
    try {
      await authAPI.resetPassword(token, password);
      setDone(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Reset failed. The link may have expired — request a new one.');
    } finally {
      setLoading(false);
    }
  };

  // ── Success ──
  if (done) {
    return (
      <PageShell>
        <div className="px-8 py-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
            <CheckCircle className="h-7 w-7 text-green-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-800">Password updated</h2>
          <p className="mt-2 text-sm text-slate-500">
            Your password has been changed successfully.
          </p>
          <button
            onClick={onBackToLogin}
            className="mt-6 w-full rounded-lg bg-primary-600 py-3 text-sm font-semibold text-white hover:bg-primary-700 transition-colors"
          >
            Sign in with new password
          </button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="px-8 pt-10 pb-2">
        <button
          onClick={onBackToLogin}
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-4 w-4" /> Back to sign in
        </button>
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Set a new password</h1>
        <p className="mt-1 text-sm text-slate-500">Must be at least 8 characters.</p>
      </div>

      <form className="px-8 pb-8 pt-4" onSubmit={handleSubmit} noValidate>
        {error && (
          <div className="mb-5 rounded-lg bg-red-50 border border-red-100 p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm font-medium text-red-800">{error}</p>
          </div>
        )}

        <div className="space-y-4">
          {/* New password */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">New password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock className="h-5 w-5" />
              </div>
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                autoComplete="new-password"
                className="block w-full pl-10 pr-10 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
              >
                {showPw ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
            {/* Strength bar */}
            {password.length > 0 && (
              <div className="mt-2">
                <div className="flex gap-1">
                  {[1,2,3,4,5].map(i => (
                    <div
                      key={i}
                      className="h-1 flex-1 rounded-full transition-all"
                      style={{ background: i <= pw.score ? pw.colour : '#e2e8f0' }}
                    />
                  ))}
                </div>
                <p className="mt-1 text-xs" style={{ color: pw.colour }}>{pw.label}</p>
              </div>
            )}
          </div>

          {/* Confirm */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Confirm password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock className="h-5 w-5" />
              </div>
              <input
                type={showPw ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat your password"
                autoComplete="new-password"
                className="block w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
              />
            </div>
            {confirm.length > 0 && password !== confirm && (
              <p className="mt-1 text-xs text-red-500">Passwords don't match</p>
            )}
          </div>
        </div>

        <button
          type="submit"
          disabled={loading || !token}
          className="mt-6 w-full flex justify-center items-center py-3 px-4 rounded-lg text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
        >
          {loading ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </PageShell>
  );
};

const PageShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-primary-50/30 to-slate-100 py-12 px-4">
    <div className="w-full max-w-md">
      <div className="mb-6 flex justify-center">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-600 text-white font-bold text-lg select-none">A</div>
          <span className="text-xl font-bold text-slate-800 tracking-tight">Acexen</span>
        </div>
      </div>
      <div className="bg-white/90 backdrop-blur rounded-2xl shadow-xl border border-slate-200/60 overflow-hidden">
        {children}
      </div>
    </div>
  </div>
);

export default ResetPassword;
