import React, { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { integrityAPI, WebcamPolicy } from '../services/api';
import { SectionCard, btn } from './ui';

// What management confirms before webcam monitoring is allowed (keys match the server).
const ACKNOWLEDGEMENT_TEXT: Record<string, string> = {
  lawful_basis:
    'We have a lawful basis for processing biometric information (POPIA sections 26–27), and webcam monitoring is necessary and proportionate for the assessments it will be used on.',
  explicit_consent:
    'Students will be told what is captured and why, and must give explicit consent before each monitored assessment. Students who cannot use a webcam will have a fair alternative.',
  minors:
    'If any students are under 18, we will obtain consent from a competent person (parent or guardian) as POPIA sections 34–35 require, or not use webcam monitoring for them.',
  retention:
    'Webcam images and video will be kept only for the retention period below and then deleted automatically, and deleted sooner on a valid request.',
  access:
    'Only the lecturer who owns an assessment and management in our organisation may view the images, every viewing is logged, and images will not be analysed automatically (no facial recognition).',
  information_officer:
    "Our Information Officer has approved this processing, and our privacy notice to students describes it (including Acexen's role as operator)."
};

/** Management: organisation-wide permission for webcam monitoring, behind POPIA acknowledgements. */
export default function WebcamPolicyPanel() {
  const [policy, setPolicy] = useState<WebcamPolicy | null>(null);
  // The super admin manages every organisation's policy; others only their own.
  const [organisations, setOrganisations] = useState<{ id: number; name: string }[] | null>(null);
  const [organisationId, setOrganisationId] = useState<number | null>(null);
  const [keys, setKeys] = useState<string[]>([]);
  const [allowed, setAllowed] = useState(false);
  const [allowVideo, setAllowVideo] = useState(false);
  const [retention, setRetention] = useState(30);
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const apply = (next: WebcamPolicy) => {
    setPolicy(next);
    setAllowed(next.allowed);
    setAllowVideo(next.allow_video);
    setRetention(next.retention_days);
  };

  const load = (targetOrganisationId?: number | null) => {
    setPolicy(null);
    setAcks({});
    integrityAPI.getWebcamPolicy(targetOrganisationId ? { organisation_id: targetOrganisationId } : undefined)
      .then((res) => {
        apply(res.data.policy);
        setKeys(res.data.acknowledgements || Object.keys(ACKNOWLEDGEMENT_TEXT));
        setOrganisationId(res.data.organisation_id ?? targetOrganisationId ?? null);
        if (res.data.organisations) setOrganisations(res.data.organisations);
      })
      .catch(() => setMessage('Could not load the webcam policy.'));
  };

  useEffect(() => { load(); }, []);

  const allAcknowledged = keys.length > 0 && keys.every((key) => acks[key]);
  // The super admin (who may not belong to any organisation) must say which organisation this is for.
  const needsOrganisation = organisations != null && organisationId == null;
  // Re-confirming is needed whenever webcam monitoring is being (re)allowed or widened.
  const needsAcknowledgement = allowed && (!policy?.allowed || (allowVideo && !policy.allow_video));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await integrityAPI.saveWebcamPolicy({
        organisation_id: organisations ? organisationId : undefined,
        allowed,
        allow_video: allowed && allowVideo,
        retention_days: retention,
        acknowledgements: needsAcknowledgement ? acks : Object.fromEntries(keys.map((key) => [key, true]))
      });
      apply(res.data.policy);
      setAcks({});
      setMessage(res.data.policy.allowed
        ? 'Saved. Lecturers can now turn on webcam monitoring for their assessments.'
        : 'Webcam monitoring is off for your organisation. Webcam options are disabled on all assessments; images already captured are kept until their deletion date.');
    } catch (e: any) {
      setMessage(e.response?.data?.error || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Webcam monitoring"
      description="Off unless you allow it for your organisation. Lecturers then choose it per assessment."
    >
      {organisations && organisations.length === 0 && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
          There are no organisations yet. Create one in the Admin dashboard (Organisations &amp; departments), then set its webcam policy here.
        </p>
      )}
      {organisations && organisations.length > 0 && (
        <label className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-gray-800">Organisation</span>
          <select
            value={organisationId ?? ''}
            onChange={(e) => { setMessage(null); load(Number(e.target.value)); }}
            className="rounded-md border-gray-300 text-sm shadow-sm focus:border-primary-500 focus:ring-primary-500"
          >
            {organisationId == null && <option value="">Choose an organisation</option>}
            {organisations.map((organisation) => <option key={organisation.id} value={organisation.id}>{organisation.name}</option>)}
          </select>
          <span className={`text-xs ${needsOrganisation ? 'font-semibold text-amber-800' : 'text-gray-500'}`}>
            {needsOrganisation
              ? 'Choose the organisation whose webcam policy you are setting.'
              : 'As super admin you set this for each organisation.'}
          </span>
        </label>
      )}
      {!policy ? (
        <div className="flex justify-center p-4"><Loader2 className="h-5 w-5 animate-spin text-primary-600" /></div>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">Webcam images are biometric information, which POPIA treats as special personal information.</p>
              <p className="text-xs">
                Your organisation is the responsible party and must have a lawful basis, explicit student consent, extra safeguards for anyone under 18,
                limited retention and controlled access. Acexen processes the images as your operator. Take advice from your Information Officer before allowing it.
              </p>
            </div>
          </div>

          {policy.allowed && policy.accepted_by && (
            <p className="text-xs text-gray-600">
              Allowed by {policy.accepted_by.name} on {policy.accepted_at ? new Date(policy.accepted_at).toLocaleString() : 'unknown date'}.
            </p>
          )}

          <div className="flex flex-wrap items-end gap-5">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
              <input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
              Allow webcam monitoring
            </label>
            <label className={`flex items-center gap-2 text-sm text-gray-800 ${allowed ? '' : 'opacity-50'}`}>
              <input type="checkbox" checked={allowVideo} disabled={!allowed} onChange={(e) => setAllowVideo(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" />
              Also allow continuous video (more intrusive, much more storage)
            </label>
            <label className={`text-sm text-gray-800 ${allowed ? '' : 'opacity-50'}`}>
              <span className="mr-2">Delete images after</span>
              <select
                value={retention}
                disabled={!allowed}
                onChange={(e) => setRetention(Number(e.target.value))}
                className="rounded-md border-gray-300 text-sm shadow-sm focus:border-primary-500 focus:ring-primary-500"
              >
                {[7, 14, 30, 60, 90].map((days) => <option key={days} value={days}>{days} days</option>)}
              </select>
            </label>
          </div>

          {needsAcknowledgement && (
            <fieldset className="space-y-2 rounded-lg border border-gray-200 p-4">
              <legend className="px-1 text-sm font-semibold text-gray-900">Confirm each statement before allowing webcam monitoring</legend>
              {keys.map((key) => (
                <label key={key} className="flex items-start gap-2 text-sm text-gray-800">
                  <input
                    type="checkbox"
                    checked={Boolean(acks[key])}
                    onChange={(e) => setAcks((prev) => ({ ...prev, [key]: e.target.checked }))}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                  />
                  <span>{ACKNOWLEDGEMENT_TEXT[key] || key}</span>
                </label>
              ))}
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={save} disabled={saving || needsOrganisation || (needsAcknowledgement && !allAcknowledged)} className={btn.primary}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </button>
            {needsOrganisation
              ? <span className="text-xs text-gray-500">Choose an organisation first.</span>
              : needsAcknowledgement && !allAcknowledged && <span className="text-xs text-gray-500">Confirm all {keys.length} statements to allow webcam monitoring.</span>}
          </div>
          {message && <p role="status" className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700 ring-1 ring-inset ring-gray-200">{message}</p>}
        </div>
      )}
    </SectionCard>
  );
}
