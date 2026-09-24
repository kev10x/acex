import React, { useEffect, useRef, useState } from 'react';
import { Clapperboard, Download, Loader2, Trash2, Video, Volume2, VolumeX } from 'lucide-react';
import { videoGenAPI, VideoGenJob, getApiErrorMessage } from '../services/api';
import { useNotification } from '../contexts/NotificationContext';

const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'];
const RESOLUTIONS: Array<{ value: string; label: string }> = [
  { value: '480p', label: '480p' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p (text-to-video only)' },
];
const POLL_INTERVAL_MS = 4000;

const VideoGenerator: React.FC = () => {
  const { notifySuccess, notifyError } = useNotification();
  const [prompt, setPrompt] = useState('');
  const [duration, setDuration] = useState(10);
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [resolution, setResolution] = useState('720p');
  const [generateAudio, setGenerateAudio] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<VideoGenJob[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [videoUrls, setVideoUrls] = useState<Record<number, string>>({});
  const pollTimerRef = useRef<number | null>(null);
  const videoUrlsRef = useRef(videoUrls);
  videoUrlsRef.current = videoUrls;

  const loadHistory = async () => {
    try {
      const res = await videoGenAPI.list(30);
      if (res.data.success) setJobs(res.data.jobs);
    } catch (_) {
      // best-effort; keep whatever was already loaded
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => {
    loadHistory();
    // Clean up any object URLs created for playback on unmount.
    return () => {
      Object.values(videoUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll while any job is still processing.
  useEffect(() => {
    const hasProcessing = jobs.some((job) => job.status === 'processing');
    if (!hasProcessing) {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    if (pollTimerRef.current) return;
    pollTimerRef.current = window.setInterval(() => {
      loadHistory();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  const ensureVideoBlobLoaded = async (job: VideoGenJob) => {
    if (job.status !== 'completed' || videoUrlsRef.current[job.id]) return;
    try {
      const res = await videoGenAPI.getVideoBlob(job.id);
      const url = URL.createObjectURL(res.data as Blob);
      setVideoUrls((prev) => ({ ...prev, [job.id]: url }));
    } catch (_) {
      // leave unplayable; user can still see the job status
    }
  };

  useEffect(() => {
    jobs.filter((j) => j.status === 'completed' && !videoUrlsRef.current[j.id]).forEach(ensureVideoBlobLoaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError('Please describe the video you want to generate.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await videoGenAPI.create({
        prompt: trimmed,
        duration,
        aspect_ratio: aspectRatio,
        resolution,
        generate_audio: generateAudio,
      });
      if (res.data.success) {
        setJobs((prev) => [res.data.job, ...prev]);
        notifySuccess('Video generation started — this can take a few minutes.', 'Video queued');
      }
    } catch (e: any) {
      const message = getApiErrorMessage(e, 'Failed to start video generation');
      setError(message);
      notifyError(message, 'Video generation failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (jobId: number) => {
    if (!window.confirm('Delete this generated video? This cannot be undone.')) return;
    try {
      await videoGenAPI.remove(jobId);
      setJobs((prev) => prev.filter((j) => j.id !== jobId));
      setVideoUrls((prev) => {
        const next = { ...prev };
        if (next[jobId]) {
          URL.revokeObjectURL(next[jobId]);
          delete next[jobId];
        }
        return next;
      });
    } catch (e: any) {
      notifyError(getApiErrorMessage(e, 'Failed to delete video'), 'Delete failed');
    }
  };

  return (
    <div className="w-full">
      <div className="bg-white rounded-2xl shadow-sm p-6 mb-6 border border-gray-200/70">
        <div className="flex items-center gap-3 mb-1">
          <Clapperboard className="w-8 h-8 text-primary-600" />
          <h1 className="text-2xl font-bold text-gray-900">Video Generator</h1>
        </div>
        <p className="text-gray-600 mb-6">
          Generate short AI video clips from a text prompt, powered by Grok Imagine.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor="video-prompt" className="block text-sm font-medium text-gray-700 mb-2">
              Prompt
            </label>
            <textarea
              id="video-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="A glowing crystal-powered rocket launching from red Martian dunes, ancient alien ruins lighting up in the background as it soars into a sky full of unfamiliar constellations"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 resize-y bg-white shadow-sm"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="video-duration" className="block text-sm font-medium text-gray-700 mb-2">
                Duration: {duration}s
              </label>
              <input
                id="video-duration"
                type="range"
                min={1}
                max={15}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="w-full accent-primary-600"
              />
            </div>

            <div>
              <label htmlFor="video-aspect" className="block text-sm font-medium text-gray-700 mb-2">
                Aspect ratio
              </label>
              <select
                id="video-aspect"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              >
                {ASPECT_RATIOS.map((ratio) => (
                  <option key={ratio} value={ratio}>{ratio}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="video-resolution" className="block text-sm font-medium text-gray-700 mb-2">
                Resolution
              </label>
              <select
                id="video-resolution"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 bg-white shadow-sm"
              >
                {RESOLUTIONS.map((res) => (
                  <option key={res.value} value={res.value}>{res.label}</option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setGenerateAudio((v) => !v)}
            className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            {generateAudio ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            {generateAudio ? 'Audio on' : 'Audio off'}
          </button>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
          )}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={submitting}
            className="inline-flex items-center justify-center gap-2 w-full sm:w-auto px-5 py-2.5 rounded-lg bg-primary-600 text-white font-semibold hover:bg-primary-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
            {submitting ? 'Starting...' : 'Generate video'}
          </button>
        </div>
      </div>

      <div>
        <h2 className="text-sm font-semibold text-gray-800 mb-3">History</h2>
        {loadingHistory ? (
          <div className="text-sm text-gray-500">Loading...</div>
        ) : jobs.length === 0 ? (
          <div className="text-sm text-gray-500 bg-white rounded-2xl shadow-sm p-6 text-center border border-gray-200/70">
            No videos generated yet — your generations will appear here.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {jobs.map((job) => (
              <div key={job.id} className="bg-white rounded-2xl shadow-sm p-4 border border-gray-200/70">
                <div className="aspect-video bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center mb-3">
                  {job.status === 'completed' && videoUrls[job.id] ? (
                    <video src={videoUrls[job.id]} controls className="w-full h-full object-contain bg-black" />
                  ) : job.status === 'failed' ? (
                    <div className="text-center px-4">
                      <p className="text-sm text-red-600 font-medium">Generation failed</p>
                      {job.error_message && (
                        <p className="text-xs text-gray-500 mt-1">{job.error_message}</p>
                      )}
                    </div>
                  ) : (
                    <div className="text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-gray-400" />
                      <p className="text-xs text-gray-500 mt-2">Generating...</p>
                    </div>
                  )}
                </div>
                <p className="text-sm text-gray-800 line-clamp-2" title={job.prompt}>{job.prompt}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                  <span>{job.duration_seconds}s · {job.aspect_ratio} · {job.resolution}</span>
                  <div className="flex items-center gap-3">
                    {job.status === 'completed' && videoUrls[job.id] && (
                      <a
                        href={videoUrls[job.id]}
                        download={`video-${job.id}.mp4`}
                        className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDelete(job.id)}
                      className="inline-flex items-center gap-1 text-gray-500 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoGenerator;
