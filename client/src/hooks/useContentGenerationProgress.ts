import { useEffect, useRef, useState } from 'react';
import { contentAPI, modulesAPI, GeneratedContent, GenerationJobItem, GenerationTrace } from '../services/api';

export type GenerationProgressTask = 'content' | 'visual' | 'mascot';

export interface GenerationProgressState {
  active: boolean;
  task: GenerationProgressTask;
  percent: number;
  label: string;
  detail: string;
}

interface UseContentGenerationProgressOptions {
  // Read-only views into the editor's "is a generation in flight / do we already
  // have content" state, used to decide whether a recovered background job should
  // overwrite what's on screen.
  isGeneratingRef: React.MutableRefObject<boolean>;
  generatedContentRef: React.MutableRefObject<GeneratedContent | null>;
  // Called synchronously when a background content-generation job is found completed
  // and should be adopted into the editor. Implementations should not need to await
  // anything long-running here — fire off persistence (e.g. saving to history) without
  // blocking, so the progress bar can finish immediately afterwards.
  onJobRecovered: (content: GeneratedContent, trace: GenerationTrace | null) => void;
}

/**
 * Owns the "AI job in progress" UI: the progress bar shown during content
 * generation / visual / mascot regeneration, and the background-job polling,
 * SSE streaming, and on-mount recovery that drive it for full content
 * generation jobs (visual/mascot regeneration are synchronous API calls with
 * no backend job, so they only ever use the simulated ticker in
 * startGenerationProgress).
 */
export function useContentGenerationProgress({
  isGeneratingRef,
  generatedContentRef,
  onJobRecovered,
}: UseContentGenerationProgressOptions) {
  const [generationProgress, setGenerationProgress] = useState<GenerationProgressState>({
    active: false,
    task: 'content',
    percent: 0,
    label: '',
    detail: '',
  });
  const [backgroundGenerationNotice, setBackgroundGenerationNotice] = useState<string | null>(null);

  const recoveredContentJobIdRef = useRef<number | null>(null);
  const generationProgressTimerRef = useRef<number | null>(null);
  const generationProgressHideTimerRef = useRef<number | null>(null);
  const generationJobPollTimerRef = useRef<number | null>(null);
  const activeGenerationJobIdRef = useRef<number | null>(null);
  const generationJobPollBusyRef = useRef(false);
  const jobStreamCleanupRef = useRef<(() => void) | null>(null);

  const clearGenerationProgressTimer = () => {
    if (generationProgressTimerRef.current) {
      window.clearInterval(generationProgressTimerRef.current);
      generationProgressTimerRef.current = null;
    }
    if (generationProgressHideTimerRef.current) {
      window.clearTimeout(generationProgressHideTimerRef.current);
      generationProgressHideTimerRef.current = null;
    }
  };

  const clearGenerationJobPoller = () => {
    if (generationJobPollTimerRef.current) {
      window.clearInterval(generationJobPollTimerRef.current);
      generationJobPollTimerRef.current = null;
    }
    generationJobPollBusyRef.current = false;
    if (jobStreamCleanupRef.current) {
      jobStreamCleanupRef.current();
      jobStreamCleanupRef.current = null;
    }
  };

  const startGenerationProgress = (task: GenerationProgressTask) => {
    clearGenerationProgressTimer();
    const startLabel = task === 'content'
      ? 'Preparing generation request'
      : task === 'visual'
        ? 'Preparing visual regeneration'
        : 'Preparing mascot regeneration';
    const startDetail = task === 'content'
      ? 'Building prompt and context'
      : 'Gathering section context';

    setGenerationProgress({
      active: true,
      task,
      percent: 6,
      label: startLabel,
      detail: startDetail,
    });

    // 'content' generation reports real progress through the backend job's SSE
    // stream/poller (see startGenerationJobPoller -> mapBackendProgressToUi) —
    // a simulated ticker here would just race it for control of the same bar.
    // 'visual'/'mascot' regeneration are single synchronous API calls with no
    // backend progress events, so they still need a simulated ticker.
    if (task === 'content') return;

    const cap = 90;
    generationProgressTimerRef.current = window.setInterval(() => {
      setGenerationProgress((prev) => {
        if (!prev.active || prev.task !== task) return prev;
        if (prev.percent >= cap) return prev;

        const slowdown = prev.percent > 75 ? 0.45 : prev.percent > 55 ? 0.7 : 1;
        const jitter = Math.random() * 0.9;
        const nextPercent = Math.min(cap, prev.percent + (3.2 + jitter) * slowdown);

        let label = prev.label;
        let detail = prev.detail;
        if (task === 'visual') {
          if (nextPercent < 45) {
            label = 'Regenerating visual';
            detail = 'Sending visual prompt to image model';
          } else {
            label = 'Finalizing visual';
            detail = 'Updating section preview';
          }
        } else {
          if (nextPercent < 45) {
            label = 'Regenerating mascot';
            detail = 'Sending mascot prompt to image model';
          } else {
            label = 'Finalizing mascot';
            detail = 'Updating key point companion';
          }
        }

        return { ...prev, percent: nextPercent, label, detail };
      });
    }, 900);
  };

  const updateGenerationProgress = (percent: number, label: string, detail = '') => {
    setGenerationProgress((prev) => ({
      ...prev,
      active: true,
      percent: Math.max(prev.percent, Math.min(96, percent)),
      label,
      detail,
    }));
  };

  const mapBackendProgressToUi = (progress: any) => {
    if (!progress || typeof progress !== 'object') return;
    const percent = Number(progress.percent || 0);
    const label = String(progress.label || '').trim();
    const detail = String(progress.detail || '').trim();
    const taskRaw = String(progress.task || '').toLowerCase();
    const task: GenerationProgressTask =
      taskRaw === 'mascot' ? 'mascot' : taskRaw === 'visual' ? 'visual' : 'content';
    setGenerationProgress((prev) => ({
      ...prev,
      active: true,
      task,
      percent: Math.max(prev.percent, Math.min(99, Number.isFinite(percent) ? percent : prev.percent)),
      label: label || prev.label || 'Generating content',
      detail: detail || prev.detail,
    }));
  };

  const chooseLikelyActiveContentJob = (items: GenerationJobItem[]) => {
    const now = Date.now();
    const candidates = (Array.isArray(items) ? items : [])
      .filter((job) => job?.job_type === 'content_generation')
      .filter((job) => ['scheduled', 'processing', 'retrying', 'completed'].includes(String(job?.status || '')))
      .sort((a, b) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
    if (!candidates.length) return null;
    if (activeGenerationJobIdRef.current) {
      const exact = candidates.find((job) => Number(job.id) === Number(activeGenerationJobIdRef.current));
      if (exact) return exact;
    }
    const fresh = candidates.find((job) => {
      const createdAt = new Date(job?.created_at || 0).getTime();
      return Number.isFinite(createdAt) && createdAt > now - 15 * 60 * 1000;
    });
    return fresh || candidates[0];
  };

  const pollGenerationJobProgress = async () => {
    if (generationJobPollBusyRef.current) return;
    generationJobPollBusyRef.current = true;
    try {
      const res = await modulesAPI.getGenerationJobs({ limit: 20, scope: 'mine' });
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      const job = chooseLikelyActiveContentJob(items);
      if (!job) return;
      activeGenerationJobIdRef.current = Number(job.id) || activeGenerationJobIdRef.current;
      mapBackendProgressToUi(job?.result?.progress || null);
    } catch (_) {
      // best effort fallback only
    } finally {
      generationJobPollBusyRef.current = false;
    }
  };

  const startJobProgressStream = (jobId: number) => {
    clearGenerationJobPoller();
    jobStreamCleanupRef.current = contentAPI.streamJobProgress(jobId, {
      onProgress: (data) => {
        mapBackendProgressToUi(data.progress);
      },
      onDone: () => {
        // Generation complete — the caller's own API response handler finalizes the UI
      },
      onError: () => {
        // SSE failed — fall back to polling
        if (jobStreamCleanupRef.current) {
          jobStreamCleanupRef.current = null;
        }
        pollGenerationJobProgress();
        generationJobPollTimerRef.current = window.setInterval(() => {
          pollGenerationJobProgress();
        }, 1500);
      },
    });
  };

  const startGenerationJobPoller = () => {
    const jobId = activeGenerationJobIdRef.current;
    if (jobId) {
      startJobProgressStream(jobId);
    } else {
      clearGenerationJobPoller();
      pollGenerationJobProgress();
      generationJobPollTimerRef.current = window.setInterval(() => {
        pollGenerationJobProgress();
      }, 1500);
    }
  };

  const completeGenerationProgress = (success: boolean, message?: string) => {
    clearGenerationProgressTimer();
    clearGenerationJobPoller();
    setGenerationProgress((prev) => ({
      ...prev,
      active: true,
      percent: success ? 100 : Math.max(prev.percent, 12),
      label: success ? 'Done' : 'Generation interrupted',
      detail: message || (success ? 'Your content is ready' : 'Please try again'),
    }));
    generationProgressHideTimerRef.current = window.setTimeout(() => {
      setGenerationProgress({
        active: false,
        task: 'content',
        percent: 0,
        label: '',
        detail: '',
      });
      generationProgressHideTimerRef.current = null;
    }, success ? 900 : 2200);
  };

  // Called once a /content/generate request returns its job id, so the SSE stream
  // (rather than the "guess the active job" poller) drives progress from then on.
  const notifyJobStarted = (jobId: number) => {
    activeGenerationJobIdRef.current = jobId;
    startJobProgressStream(jobId);
  };

  // Called at the start of a fresh generation so job recovery/selection doesn't
  // latch onto a stale job id from a previous run.
  const resetActiveJob = () => {
    activeGenerationJobIdRef.current = null;
  };

  useEffect(() => {
    return () => {
      clearGenerationProgressTimer();
      clearGenerationJobPoller();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recoverBackgroundContentGeneration = async () => {
    try {
      const res = await modulesAPI.getGenerationJobs({ limit: 40, scope: 'mine' });
      const items = Array.isArray(res.data?.items) ? res.data.items : [];
      const jobs = items
        .filter((job: any) => job?.job_type === 'content_generation')
        .sort((a: any, b: any) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
      let latest = jobs[0];
      if (!latest) return;

      if (['scheduled', 'processing', 'retrying'].includes(String(latest.status || ''))) {
        setBackgroundGenerationNotice('A content generation is still running in the background. This page will auto-recover it when it finishes.');
        const jobId = Number(latest.id);
        if (jobId && jobStreamCleanupRef.current === null) {
          jobStreamCleanupRef.current = contentAPI.streamJobProgress(jobId, {
            onProgress: (data) => mapBackendProgressToUi(data.progress),
            onDone: () => {
              jobStreamCleanupRef.current = null;
              recoverBackgroundContentGeneration();
            },
            onError: () => { jobStreamCleanupRef.current = null; },
          });
        }
        return;
      }

      if (latest.status === 'completed' && latest.result?.has_content) {
        const fullRes = await modulesAPI.getGenerationJobs({ limit: 40, scope: 'mine', include_full_result: true });
        const fullItems = Array.isArray(fullRes.data?.items) ? fullRes.data.items : [];
        latest = fullItems.find((job: any) => Number(job.id) === Number(latest.id)) || latest;
      }

      if (
        latest.status === 'completed' &&
        latest.result?.content &&
        recoveredContentJobIdRef.current !== Number(latest.id || 0) &&
        (isGeneratingRef.current || !generatedContentRef.current)
      ) {
        recoveredContentJobIdRef.current = Number(latest.id || 0);
        onJobRecovered(latest.result.content, latest.result?.generation_trace || null);
        setBackgroundGenerationNotice('Recovered your generated content from a background job.');
        completeGenerationProgress(true, 'Recovered generated content from background job');
      }
    } catch (_) {
      // Best-effort recovery only; ignore poll failures.
    }
  };

  useEffect(() => {
    recoverBackgroundContentGeneration();
    // 15s fallback poll in case the SSE stream fails to connect
    const timer = window.setInterval(() => {
      if (!jobStreamCleanupRef.current) recoverBackgroundContentGeneration();
    }, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    generationProgress,
    backgroundGenerationNotice,
    setBackgroundGenerationNotice,
    startGenerationProgress,
    updateGenerationProgress,
    completeGenerationProgress,
    startGenerationJobPoller,
    clearGenerationJobPoller,
    notifyJobStarted,
    resetActiveJob,
  };
}
