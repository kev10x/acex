import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { authAPI } from '../services/api';
import { Mail, Lock, AlertCircle, CheckCircle, Eye, EyeOff, ArrowLeft } from 'lucide-react';

interface LoginFormProps {
  onSwitchToRegister: () => void;
}

type LoginView = 'login' | 'forgot' | 'forgot-sent';

const LoginForm: React.FC<LoginFormProps> = ({ onSwitchToRegister }) => {
  const [view, setView] = useState<LoginView>('login');

  // Login state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [requiresVerification, setRequiresVerification] = useState(false);

  // Forgot password state
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState<string | null>(null);

  const { login } = useAuth();

  // ── Validation ──────────────────────────────────────────────────────────────
  const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

  const validateLogin = (): string | null => {
    if (!email.trim()) return 'Email is required';
    if (!isValidEmail(email)) return 'Enter a valid email address';
    if (!password) return 'Password is required';
    if (password.length < 6) return 'Password must be at least 6 characters';
    return null;
  };

  // ── Handlers ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setRequiresVerification(false);
    setResendSuccess(false);

    const validationError = validateLogin();
    if (validationError) { setError(validationError); return; }

    setLoading(true);
    try {
      await login(email.trim(), password);
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.requiresVerification) {
        setRequiresVerification(true);
        setError(data.error || 'Please verify your email before signing in.');
      } else if (data?.requiresApproval) {
        setError(data.error || 'Your account is pending admin approval.');
      } else {
        setError(data?.error || 'Incorrect email or password.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email) { setError('Enter your email first'); return; }
    setResending(true);
    setResendSuccess(false);
    setError(null);
    try {
      await authAPI.resendVerification(email);
      setResendSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to resend verification email');
    } finally {
      setResending(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotError(null);
    if (!isValidEmail(forgotEmail)) { setForgotError('Enter a valid email address'); return; }
    setForgotLoading(true);
    try {
      await authAPI.forgotPassword(forgotEmail.trim());
      setView('forgot-sent');
    } catch (err: any) {
      setForgotError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setForgotLoading(false);
    }
  };

  // ── Forgot-sent confirmation ─────────────────────────────────────────────────
  if (view === 'forgot-sent') {
    return (
      <PageShell>
        <div className="px-8 py-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
            <CheckCircle className="h-7 w-7 text-green-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-800">Check your inbox</h2>
          <p className="mt-2 text-sm text-slate-500">
            If <span className="font-medium text-slate-700">{forgotEmail}</span> is registered,
            we've sent a password reset link. It expires in 1 hour.
          </p>
          <button
            onClick={() => { setView('login'); setForgotEmail(''); }}
            className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-500"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to sign in
          </button>
        </div>
      </PageShell>
    );
  }

  // ── Forgot password form ──────────────────────────────────────────────────
  if (view === 'forgot') {
    return (
      <PageShell>
        <div className="px-8 pt-10 pb-2">
          <button
            onClick={() => { setView('login'); setForgotError(null); }}
            className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Reset your password</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter your email and we'll send you a reset link.
          </p>
        </div>
        <form className="px-8 pb-8 pt-4" onSubmit={handleForgotSubmit}>
          {forgotError && (
            <div className="mb-5 rounded-lg bg-red-50 border border-red-100 p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm font-medium text-red-800">{forgotError}</p>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Email address</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Mail className="h-5 w-5" />
              </div>
              <input
                type="email"
                autoComplete="email"
                required
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                placeholder="you@example.com"
                className="block w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={forgotLoading}
            className="mt-5 w-full flex justify-center items-center py-3 px-4 rounded-lg text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {forgotLoading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      </PageShell>
    );
  }

  // ── Login form ────────────────────────────────────────────────────────────
  return (
    <PageShell>
      <div className="px-8 pt-10 pb-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Sign in to Acexen</h1>
        <p className="mt-1 text-sm text-slate-500">Enter your credentials to access your account.</p>
      </div>

      <form className="px-8 pb-8 pt-4" onSubmit={handleSubmit} noValidate>
        {error && (
          <div className="mb-6 rounded-lg bg-red-50 border border-red-100 p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-800">{error}</p>
              {requiresVerification && (
                <button
                  type="button"
                  onClick={handleResendVerification}
                  disabled={resending}
                  className="mt-2 text-sm text-red-700 hover:text-red-800 font-medium underline disabled:opacity-50"
                >
                  {resending ? 'Sending…' : 'Resend verification email'}
                </button>
              )}
            </div>
          </div>
        )}
        {resendSuccess && (
          <div className="mb-6 rounded-lg bg-green-50 border border-green-100 p-4 flex items-start gap-3">
            <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm font-medium text-green-800">Verification email sent! Check your inbox.</p>
          </div>
        )}

        <div className="space-y-5">
          {/* Email */}
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">
              Email address
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Mail className="h-5 w-5" />
              </div>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="block w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                Password
              </label>
              <button
                type="button"
                onClick={() => { setView('forgot'); setForgotEmail(email); }}
                className="text-xs text-primary-600 hover:text-primary-500 font-medium"
              >
                Forgot password?
              </button>
            </div>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock className="h-5 w-5" />
              </div>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                className="block w-full pl-10 pr-10 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="mt-6 w-full flex justify-center items-center py-3 px-4 rounded-lg text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="mt-6 text-center text-sm text-slate-500">
          Don&apos;t have an account?{' '}
          <button
            type="button"
            onClick={onSwitchToRegister}
            className="font-medium text-primary-600 hover:text-primary-500 focus:outline-none focus:underline"
          >
            Create account
          </button>
        </p>
      </form>
    </PageShell>
  );
};

// Shared page shell
const PageShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-primary-50/30 to-slate-100 py-12 px-4 sm:px-6 lg:px-8">
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

export default LoginForm;
