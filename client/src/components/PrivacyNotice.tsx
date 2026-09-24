import React from 'react';
import BrandMark from './BrandMark';

const APP = 'Acexen';
const CONTACT = (import.meta as any).env?.VITE_PRIVACY_CONTACT_EMAIL as string | undefined;
export const PRIVACY_VERSION = '2026-09-24';

const h2 = 'mt-8 text-lg font-bold text-gray-900';
const p = 'mt-2 text-sm leading-relaxed text-gray-700';
const li = 'mt-1 text-sm leading-relaxed text-gray-700';

/** Public privacy notice (POPIA). Keep the version in step with server/services/privacyService.js. */
export default function PrivacyNotice() {
  const contact = CONTACT
    ? <a className="text-primary-700 underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>
    : <>your institution's administrator</>;
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="flex items-center gap-3"><BrandMark size={34} /><span className="text-xl font-bold text-gray-900">{APP}</span></div>
        <h1 className="mt-6 text-3xl font-bold text-gray-900">Privacy notice</h1>
        <p className="mt-1 text-xs text-gray-500">Version {PRIVACY_VERSION}. Prepared under the Protection of Personal Information Act 4 of 2013 (POPIA).</p>

        <h2 className={h2}>1. Who is responsible for your information</h2>
        <p className={p}>{APP} is a teaching and assessment platform. The organisation that runs your course (your school, college or training provider) decides why your information is used and is the responsible party. {APP} processes it on their behalf. Questions and requests go to {contact}.</p>

        <h2 className={h2}>2. What we collect</h2>
        <ul className="mt-2 list-disc pl-5">
          <li className={li}><strong>Account details:</strong> your name, email address, role, organisation, and a securely hashed password.</li>
          <li className={li}><strong>Learning records:</strong> the courses and modules you are enrolled in, lesson progress, quiz and assessment answers, marks, feedback and homework.</li>
          <li className={li}><strong>Work you submit:</strong> documents, code or recordings you upload for marking.</li>
          <li className={li}><strong>Technical data:</strong> login times, IP address and browser type (for security), and an activity log of important actions.</li>
        </ul>

        <h2 className={h2}>3. Why we use it</h2>
        <ul className="mt-2 list-disc pl-5">
          <li className={li}>To create your account and give you access to your courses.</li>
          <li className={li}>To deliver lessons, collect your answers, mark your work and give you feedback and personalised homework.</li>
          <li className={li}>To let your lecturers see progress and results for the courses they teach.</li>
          <li className={li}>To keep the platform secure and to send you service emails such as invitations, password links and homework notices. We do not send marketing email.</li>
        </ul>
        <p className={p}>We rely on the performance of your enrolment agreement with your institution, our legitimate interest in running a secure service, and your consent where it is asked for.</p>

        <h2 className={h2}>4. AI processing and automated marking</h2>
        <p className={p}>Some features use artificial intelligence: generating lessons and quizzes, marking submissions, and writing feedback and personalised homework. To do this, the relevant text (for example your answers) is sent to AI providers such as OpenAI, Anthropic and xAI. We ask providers not to use it to train their models where their terms allow this. AI marks are a recommendation: a lecturer can review, moderate and override any mark or feedback, and you may ask for a human review of any result.</p>

        <h2 className={h2}>5. Who we share it with</h2>
        <p className={p}>Only with people and services needed to run the platform: your lecturers and administrators; our hosting provider; our email provider; and the AI providers above. We do not sell your information. Some providers process data outside South Africa (for example in the United States). We only use providers that give comparable protection, as POPIA section 72 requires.</p>

        <h2 className={h2}>6. How long we keep it</h2>
        <p className={p}>Account and learning records are kept while your account is active and your institution needs them for its records, then deleted or de-identified. Login and activity logs are kept for a limited period for security. You can ask for earlier deletion (see below); some marks may need to be kept by your institution.</p>

        <h2 className={h2}>7. How we protect it</h2>
        <p className={p}>Passwords are hashed and never stored in readable form. Connections use HTTPS. Access is limited by role, so students only see their own records. Uploaded student work is not publicly accessible. Important actions are logged. If there is a security breach that could harm you, we will tell you and the Information Regulator as soon as reasonably possible.</p>

        <h2 className={h2}>8. Your rights</h2>
        <ul className="mt-2 list-disc pl-5">
          <li className={li}><strong>Access:</strong> download everything we hold about you from Profile, then "Your data".</li>
          <li className={li}><strong>Correction and deletion:</strong> ask us to correct or delete your information from the same place.</li>
          <li className={li}><strong>Objection:</strong> object to how your information is used, or ask for human review of an automated result.</li>
          <li className={li}><strong>Complaint:</strong> you may complain to the Information Regulator: complaints.IR@justice.gov.za, www.inforegulator.org.za.</li>
        </ul>

        <h2 className={h2}>9. Learners under 18</h2>
        <p className={p}>If you are under 18, your institution is responsible for obtaining a parent or guardian's consent before enrolling you, as POPIA requires.</p>

        <h2 className={h2}>10. Changes</h2>
        <p className={p}>If this notice changes in a way that matters, we will update the version above and ask you to accept it again.</p>

        <p className="mt-10 text-sm"><a className="text-primary-700 underline" href={(import.meta as any).env?.BASE_URL || '/'}>Back to {APP}</a></p>
      </div>
    </div>
  );
}
