import { useCallback, useEffect, useRef, useState } from 'react';
import { integrityAPI } from '../services/api';

/**
 * Webcam capture for monitored attempts where the lecturer (and the organisation's POPIA
 * policy) allow it. Small JPEG snapshots every 30 seconds and on serious flags, or
 * low-resolution video uploaded in 30-second chunks. Images are for a person to review:
 * nothing here analyses faces.
 */

const SNAPSHOT_INTERVAL_MS = 30000;
const VIDEO_CHUNK_MS = 30000;
const FLAG_SNAPSHOT_GAP_MS = 5000;
const WIDTH = 320;
const HEIGHT = 240;

export type WebcamMode = 'off' | 'snapshots' | 'video';
export type CameraState = 'idle' | 'requesting' | 'on' | 'denied' | 'unavailable';

interface Options {
  mode: WebcamMode;
  active: boolean;
  token: string | null;
  dryRun?: boolean;
  onStopped?: () => void;
}

export function useWebcamCapture({ mode, active, token, dryRun = false, onStopped }: Options) {
  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captured, setCaptured] = useState(0);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  streamRef.current = stream;
  const lastFlagRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const pendingRef = useRef<Set<Promise<void>>>(new Set());
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;

  /** Ask for the camera (call from a click, so the browser shows its permission prompt). */
  const requestCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('unavailable');
      return null;
    }
    setCameraState('requesting');
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: WIDTH }, height: { ideal: HEIGHT }, frameRate: { ideal: 10, max: 15 } },
        audio: false
      });
      setStream(media);
      setCameraState('on');
      return media;
    } catch (error: any) {
      setCameraState(error?.name === 'NotAllowedError' ? 'denied' : 'unavailable');
      return null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    setStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
    setCameraState((state) => (state === 'on' ? 'idle' : state));
  }, []);

  // Callback ref: the consent-screen preview and the in-exam self-view are different elements,
  // so attach the camera to whichever one is mounted.
  const attach = (element: HTMLVideoElement | null, media: MediaStream | null) => {
    if (!element || element.srcObject === media) return;
    element.srcObject = media;
    if (media) element.play().catch(() => {});
  };
  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    videoElRef.current = element;
    attach(element, streamRef.current);
  }, []);
  useEffect(() => { attach(videoElRef.current, stream); }, [stream]);

  const upload = useCallback((kind: 'snapshot' | 'video', reason: 'interval' | 'flag', blob: Blob) => {
    setCaptured((count) => count + 1);
    if (dryRun || !token) return Promise.resolve();
    const pending = integrityAPI.uploadWebcamMedia(token, kind, reason, blob)
      .then(() => undefined)
      // A missed snapshot is not worth interrupting the student for.
      .catch(() => undefined)
      .finally(() => { pendingRef.current.delete(pending); });
    pendingRef.current.add(pending);
    return pending;
  }, [dryRun, token]);

  /** Before submitting or exiting: save the last video chunk and wait for uploads in flight. */
  const finish = useCallback(async () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.stop();
      });
    }
    await Promise.allSettled([...pendingRef.current]);
  }, []);

  const snapshot = useCallback((reason: 'interval' | 'flag') => {
    const video = videoElRef.current;
    if (!video || !stream || video.readyState < 2) return;
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    canvas.getContext('2d')?.drawImage(video, 0, 0, WIDTH, HEIGHT);
    canvas.toBlob((blob) => { if (blob) void upload('snapshot', reason, blob); }, 'image/jpeg', 0.6);
  }, [stream, upload]);

  /** Extra snapshot when something serious is recorded (at most one every 5 seconds). */
  const flagSnapshot = useCallback(() => {
    if (mode === 'off' || !active) return;
    const now = Date.now();
    if (now - lastFlagRef.current < FLAG_SNAPSHOT_GAP_MS) return;
    lastFlagRef.current = now;
    snapshot('flag');
  }, [mode, active, snapshot]);

  // Periodic snapshots, or chunked video, while the attempt is active.
  useEffect(() => {
    if (!active || !stream || mode === 'off') return undefined;
    const [track] = stream.getVideoTracks();
    const onEnded = () => {
      setCameraState('unavailable');
      onStoppedRef.current?.();
    };
    track?.addEventListener('ended', onEnded);

    let interval: number | undefined;
    let recorder: MediaRecorder | null = null;
    const firstSnapshot = window.setTimeout(() => snapshot('interval'), 1500);
    interval = window.setInterval(() => snapshot('interval'), SNAPSHOT_INTERVAL_MS);

    if (mode === 'video' && typeof MediaRecorder !== 'undefined') {
      const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      if (mimeType) {
        // Video replaces the periodic snapshots; flag snapshots still happen.
        window.clearInterval(interval);
        interval = undefined;
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 150000 });
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            void upload('video', 'interval', new Blob([event.data], { type: 'video/webm' }));
          }
        };
        recorder.start(VIDEO_CHUNK_MS);
        recorderRef.current = recorder;
      }
    }

    return () => {
      window.clearTimeout(firstSnapshot);
      if (interval) window.clearInterval(interval);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      recorderRef.current = null;
      track?.removeEventListener('ended', onEnded);
    };
  }, [active, stream, mode, snapshot, upload]);

  // Always release the camera when leaving the page.
  useEffect(() => () => {
    stream?.getTracks().forEach((track) => track.stop());
  }, [stream]);

  return { cameraState, stream, videoRef, requestCamera, stopCamera, flagSnapshot, finish, captured };
}
