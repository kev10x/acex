import React, { useEffect, useState } from 'react';
import { Download, KeyRound, Loader2, Mail, ShieldCheck, User as UserIcon, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useNotification } from '../contexts/NotificationContext';
import { getApiErrorMessage, privacyAPI } from '../services/api';

const ROLE_LABEL: Record<string, string> = { management: 'Management', lecturer: 'Lecturer', student: 'Student' };

export default function ProfileModal({ onClose }: { onClose: () => void }) {
  const { user, updateProfile, changePassword } = useAuth();
  const { notifySuccess, notifyError } = useNotification();
  const [name, setName] = useState(user?.name || '');
  const [savingName, setSavingName] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [requestType, setRequestType] = useState<'erasure' | 'correction' | 'objection'>('erasure');
  const [requestDetails, setRequestDetails] = useState('');
  const [sendingRequest, setSendingRequest] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!user) return null;
  const role = String(user.role || '').toLowerCase();
  const initial = String(user.name || user.email || '?').trim().charAt(0).toUpperCase();
  const nameChanged = name.trim() !== (user.name || '') && name.trim().length > 0;
  const passwordMismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const canSavePassword = currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameChanged) return;
    setSavingName(true);
    try {
      await updateProfile(name.trim());
      notifySuccess('Your name has been updated', 'Profile saved');
    } catch (err) {
      notifyError(getApiErrorMessage(err, 'Could not update your name'), 'Save failed');
    } finally {
      setSavingName(false);
    }
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSavePassword) return;
    setSavingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      notifySuccess('Your password has been changed', 'Password updated');
    } catch (err) {
      notifyError(getApiErrorMessage(err, 'Could not change your password'), 'Update failed');
    } finally {
      setSavingPassword(false);
    }
  };

  const downloadMyData = async () => {
    setDownloading(true);
    try {
      const res = await privacyAPI.downloadMyData();
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `my-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      notifyError(getApiErrorMessage(err, 'Could not export your data'), 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const sendRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendingRequest(true);
    try {
      const res = await privacyAPI.createRequest(requestType, requestDetails.trim());
      setRequestDetails('');
      notifySuccess(res.data.message, 'Request sent');
    } catch (err) {
      notifyError(getApiErrorMessage(err, 'Could not send your request'), 'Request failed');
    } finally {
      setSendingRequest(false);
    }
  };

  const privacyBase = ((import.meta as any).env?.BASE_URL || '/').replace(/\/$/, '');
  const inputCls = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-900/50 p-4 backdrop-blur-sm sm:items-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl" role="dialog" aria-label="Your profile">
        <div className="relative bg-gradient-to-br from-primary-600 via-primary-700 to-accent-700 px-6 pb-6 pt-5 text-white">
          <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-white/10" />
          <button onClick={onClose} className="absolute right-4 top-4 rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/15" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
          <div className="relative flex items-center gap-4">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20 text-2xl font-bold ring-2 ring-white/30 backdrop-blur">{initial}</span>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold">{user.name || 'Add your name'}</h2>
              <p className="flex items-center gap-1.5 truncate text-sm text-white/80"><Mail className="h-3.5 w-3.5" />{user.email}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold"><ShieldCheck className="h-3 w-3" />{ROLE_LABEL[role] || 'Member'}</span>
                {user.organisation_name && <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold">{user.organisation_name}</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6 p-6">
          <form onSubmit={saveName} className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900"><UserIcon className="h-4 w-4 text-primary-600" />Your details</h3>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Full name</label>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your full name" maxLength={255} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Email</label>
              <input className={`${inputCls} bg-gray-50 text-gray-500`} value={user.email} readOnly />
              <p className="mt-1 text-xs text-gray-400">Your email identifies your account and cannot be changed here.</p>
            </div>
            <button type="submit" disabled={!nameChanged || savingName} className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50">
              {savingName && <Loader2 className="h-4 w-4 animate-spin" />}Save name
            </button>
          </form>

          <form onSubmit={savePassword} className="space-y-3 border-t border-gray-100 pt-6">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900"><KeyRound className="h-4 w-4 text-primary-600" />Change password</h3>
            <input type="password" className={inputCls} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Current password" autoComplete="current-password" />
            <input type="password" className={inputCls} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (8+ characters)" autoComplete="new-password" />
            <input type="password" className={inputCls} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm new password" autoComplete="new-password" />
            {passwordMismatch && <p className="text-xs text-rose-600">The new passwords do not match.</p>}
            <button type="submit" disabled={!canSavePassword || savingPassword} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">
              {savingPassword && <Loader2 className="h-4 w-4 animate-spin" />}Update password
            </button>
          </form>

          <div className="space-y-3 border-t border-gray-100 pt-6">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900"><ShieldCheck className="h-4 w-4 text-primary-600" />Your data</h3>
            <p className="text-xs text-gray-500">You can download everything Acexen holds about you, or ask for it to be corrected or deleted. Read the <a className="underline" href={`${privacyBase}/privacy-notice`} target="_blank" rel="noreferrer">privacy notice</a>.</p>
            <button type="button" onClick={downloadMyData} disabled={downloading} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-50">
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Download my data
            </button>
            <form onSubmit={sendRequest} className="space-y-2">
              <select className={inputCls} value={requestType} onChange={(e) => setRequestType(e.target.value as 'erasure' | 'correction' | 'objection')}>
                <option value="erasure">Delete my information</option>
                <option value="correction">Correct my information</option>
                <option value="objection">Object to how it is used / human review</option>
              </select>
              <textarea className={inputCls} rows={2} maxLength={2000} value={requestDetails} onChange={(e) => setRequestDetails(e.target.value)} placeholder="Tell us what you need (optional)" />
              <button type="submit" disabled={sendingRequest} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:opacity-50">
                {sendingRequest && <Loader2 className="h-4 w-4 animate-spin" />}Send request
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
