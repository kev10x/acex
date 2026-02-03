import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { Mail, Lock, AlertCircle } from 'lucide-react';

interface LoginFormProps {
  onSwitchToRegister: () => void;
}

const LoginForm: React.FC<LoginFormProps> = ({ onSwitchToRegister }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to sign in. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-primary-50/30 to-slate-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="w-full max-w-md">
        <div className="bg-white/90 backdrop-blur rounded-2xl shadow-xl border border-slate-200/60 overflow-hidden">
          <div className="px-8 pt-10 pb-2">
            <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Sign in to MarkMate</h1>
            <p className="mt-1 text-sm text-slate-500">
              Enter your credentials to access your account.
            </p>
          </div>

          <form className="px-8 pb-8 pt-4" onSubmit={handleSubmit}>
            {error && (
              <div className="mb-6 rounded-lg bg-red-50 border border-red-100 p-4 flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm font-medium text-red-800">{error}</p>
              </div>
            )}

            <div className="space-y-5">
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
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="block w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                    <Lock className="h-5 w-5" />
                  </div>
                  <input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your password"
                    className="block w-full pl-10 pr-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-6 w-full flex justify-center items-center py-3 px-4 rounded-lg text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {loading ? 'Signing in...' : 'Sign in'}
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
        </div>
      </div>
    </div>
  );
};

export default LoginForm;
