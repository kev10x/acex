import React, { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { privacyAPI } from '../services/api';

/** Asks a signed-in user to accept the current privacy notice (records the time and version). */
export default function PrivacyConsentModal() {
  const { user } = useAuth();
  const [needed, setNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) { setNeeded(false); return; }
    let cancelled = false;
    privacyAPI.status().then((res) => { if (!cancelled) setNeeded(res.data.needs_acceptance); }).catch(() => { /* do not block the app */ });
    return () => { cancelled = true; };
  }, [user?.id]);

  if (!user || !needed) return null;
  const base = ((import.meta as any).env?.BASE_URL || '/').replace(/\/$/, '');

  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      await privacyAPI.accept();
      setNeeded(false);
    } catch {
      setError('Could not save your acceptance. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-gray-900/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" role="dialog" aria-label="Privacy notice">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-50 text-primary-700"><ShieldCheck className="h-5 w-5" /></span>
          <h2 className="text-lg font-bold text-gray-900">Your privacy</h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-gray-700">
          Before you continue, please read how Acexen and your institution use your personal information, including AI marking and feedback, who it is shared with, and your rights under POPIA.
        </p>
        <a href={`${base}/privacy-notice`} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm font-semibold text-primary-700 underline">Read the privacy notice</a>
        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        <button onClick={accept} disabled={busy} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-primary-700 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}I have read it and accept
        </button>
      </div>
    </div>
  );
}
