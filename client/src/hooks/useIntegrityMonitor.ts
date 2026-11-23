import { useCallback, useEffect, useRef, useState } from 'react';
import { integrityAPI, IntegrityClientEvent, IntegritySettings } from '../services/api';

/**
 * Watches a monitored assessment attempt in the browser and reports what happened to the
 * server in small batches. It records facts (how long the student was away, how many
 * characters were pasted), never what they typed or pasted; the server decides what is
 * worth flagging.
 */

const FLUSH_INTERVAL_MS = 10000;
const BURST_MIN_CHARS = 50;
const MAX_QUEUE = 500;
// Low-value events (right-clicks, short copies) are capped so a fidgety student does not flood the log.
const MAX_PER_INFO_TYPE = 30;

const randomId = () => {
  const bytes = new Uint8Array(12);
  (window.crypto || (window as any).msCrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Session id for this browser tab and assessment; survives a reload of the same tab. */
export const getAttemptSessionId = (code: string) => {
  const key = `acex-attempt-session-${code}`;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = randomId();
    window.sessionStorage.setItem(key, created);
    return created;
  } catch (_) {
    return randomId();
  }
};

export const isFullscreenSupported = () =>
  typeof document !== 'undefined' && Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen);

export const enterFullscreen = async () => {
  if (!isFullscreenSupported() || document.fullscreenElement) return;
  try {
    await document.documentElement.requestFullscreen();
  } catch (_) {
    // Some browsers refuse outside a user gesture; the overlay offers a button to retry.
  }
};

const questionNumberOf = (target: EventTarget | null) => {
  const element = target instanceof Element ? target.closest('[data-question-number]') : null;
  const value = element?.getAttribute('data-question-number');
  return value ? Number(value) : null;
};

const selectedTextLength = (target: EventTarget | null) => {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    if (end > start) return end - start;
  }
  return window.getSelection()?.toString().length ?? 0;
};

interface Options {
  active: boolean;
  token: string | null;
  sessionId: string;
  settings: IntegritySettings | null;
  getAnswers: () => Record<number, string>;
}

export function useIntegrityMonitor({ active, token, sessionId, settings, getAnswers }: Options) {
  const [away, setAway] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(() => Boolean(typeof document !== 'undefined' && document.fullscreenElement));
  const [connectionProblem, setConnectionProblem] = useState(false);

  const queueRef = useRef<IntegrityClientEvent[]>([]);
  const typeCountsRef = useRef<Record<string, number>>({});
  const awaySinceRef = useRef<number | null>(null);
  const fullscreenExitSinceRef = useRef<number | null>(null);
  const flushingRef = useRef(false);
  const getAnswersRef = useRef(getAnswers);
  getAnswersRef.current = getAnswers;

  const push = useCallback((event: Omit<IntegrityClientEvent, 'client_time'> & { client_time?: number }) => {
    const isLowValue = event.type === 'context_menu' || ((event.type === 'copy' || event.type === 'cut') && (event.chars ?? 0) < 20);
    if (isLowValue) {
      const count = typeCountsRef.current[event.type] || 0;
      if (count >= MAX_PER_INFO_TYPE) return;
      typeCountsRef.current[event.type] = count + 1;
    }
    queueRef.current.push({ client_time: Date.now(), ...event });
    if (queueRef.current.length > MAX_QUEUE) queueRef.current.splice(0, queueRef.current.length - MAX_QUEUE);
  }, []);

  const markAway = useCallback(() => {
    if (awaySinceRef.current == null) awaySinceRef.current = Date.now();
    setAway(true);
  }, []);

  const markBack = useCallback(() => {
    if (document.hidden || !document.hasFocus()) return;
    if (awaySinceRef.current != null) {
      const now = Date.now();
      push({ type: 'focus_lost', duration_ms: now - awaySinceRef.current, client_time: now });
      awaySinceRef.current = null;
    }
    setAway(false);
  }, [push]);

  /** Close any open away/fullscreen periods and hand back everything not yet sent. */
  const drain = useCallback(() => {
    const now = Date.now();
    if (awaySinceRef.current != null) {
      push({ type: 'focus_lost', duration_ms: now - awaySinceRef.current, client_time: now });
      awaySinceRef.current = document.hidden || !document.hasFocus() ? now : null;
    }
    if (fullscreenExitSinceRef.current != null) {
      push({ type: 'fullscreen_exit', duration_ms: now - fullscreenExitSinceRef.current, client_time: now });
      fullscreenExitSinceRef.current = document.fullscreenElement ? null : now;
    }
    const events = queueRef.current;
    queueRef.current = [];
    return events;
  }, [push]);

  const flush = useCallback(async () => {
    if (!active || !token || flushingRef.current) return;
    flushingRef.current = true;
    const events = queueRef.current;
    queueRef.current = [];
    try {
      await integrityAPI.sendEvents(token, {
        session_id: sessionId,
        events,
        answers: getAnswersRef.current(),
        away: awaySinceRef.current != null
      });
      setConnectionProblem(false);
    } catch (error: any) {
      // Keep the events for the next try; a finished attempt (409) is handled by the page.
      if (error?.response?.status !== 409) {
        queueRef.current = [...events, ...queueRef.current].slice(-MAX_QUEUE);
        setConnectionProblem(true);
      }
    } finally {
      flushingRef.current = false;
    }
  }, [active, token, sessionId]);

  // Track full screen at all times: the student enters it on the start button, before monitoring begins.
  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  useEffect(() => {
    if (!active || !token || !settings) return undefined;
    const blockCopyPaste = settings.copy_paste === 'block';
    const blockRightClick = settings.right_click === 'block';

    if (settings.require_fullscreen && !isFullscreenSupported()) {
      push({ type: 'fullscreen_unsupported' });
    }
    if (document.hidden || !document.hasFocus()) markAway();

    const onBlur = () => markAway();
    const onFocus = () => markBack();
    const onVisibility = () => (document.hidden ? markAway() : markBack());

    const onFullscreenChange = () => {
      const inFullscreen = Boolean(document.fullscreenElement);
      if (!inFullscreen) {
        if (fullscreenExitSinceRef.current == null) fullscreenExitSinceRef.current = Date.now();
      } else if (fullscreenExitSinceRef.current != null) {
        const now = Date.now();
        push({ type: 'fullscreen_exit', duration_ms: now - fullscreenExitSinceRef.current, client_time: now });
        fullscreenExitSinceRef.current = null;
      }
    };

    const onCopyOrCut = (event: ClipboardEvent) => {
      if (blockCopyPaste) event.preventDefault();
      push({
        type: event.type as 'copy' | 'cut',
        chars: selectedTextLength(event.target),
        question_number: questionNumberOf(event.target),
        blocked: blockCopyPaste || undefined
      });
    };

    const onPaste = (event: ClipboardEvent) => {
      if (blockCopyPaste) event.preventDefault();
      push({
        type: 'paste',
        chars: event.clipboardData?.getData('text')?.length ?? 0,
        question_number: questionNumberOf(event.target),
        blocked: blockCopyPaste || undefined
      });
    };

    const onDrop = (event: DragEvent) => {
      const text = event.dataTransfer?.getData('text') ?? '';
      if (!text) return; // the matching question uses drag and drop without text
      if (blockCopyPaste) event.preventDefault();
      push({ type: 'paste', source: 'drop', chars: text.length, question_number: questionNumberOf(event.target), blocked: blockCopyPaste || undefined });
    };

    const onContextMenu = (event: MouseEvent) => {
      if (blockRightClick) event.preventDefault();
      push({ type: 'context_menu', blocked: blockRightClick || undefined });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        if (blockCopyPaste) event.preventDefault();
        push({ type: 'print_attempt', blocked: blockCopyPaste || undefined });
      }
    };
    const onBeforePrint = () => push({ type: 'print_attempt' });

    // Text arriving faster than anyone types (AI tools that type into the page, autotypers).
    const lengths = new WeakMap<EventTarget, number>();
    const lastInputType = new WeakMap<EventTarget, string>();
    const burstFlaggedAt = new WeakMap<EventTarget, number>();
    const onBeforeInput = (event: Event) => {
      const input = event as InputEvent;
      if (!input.target) return;
      lastInputType.set(input.target, input.inputType || '');
      if (input.inputType === 'insertFromPaste' || input.inputType === 'insertFromDrop') return;
      if (typeof input.data === 'string' && input.data.length >= BURST_MIN_CHARS) {
        burstFlaggedAt.set(input.target, Date.now());
        push({ type: 'text_burst', chars: input.data.length, question_number: questionNumberOf(input.target) });
      }
    };
    const onInput = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      const previous = lengths.get(target) ?? target.defaultValue.length;
      const current = target.value.length;
      lengths.set(target, current);
      const inputType = lastInputType.get(target) || '';
      lastInputType.delete(target);
      if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop') return;
      if (Date.now() - (burstFlaggedAt.get(target) || 0) < 1000) return;
      if (current - previous >= BURST_MIN_CHARS) {
        push({ type: 'text_burst', chars: current - previous, question_number: questionNumberOf(target) });
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) lengths.set(target, target.value.length);
    };

    // AI browser extensions usually inject custom elements or iframes straight into <html> or <body>.
    const seenSignatures = new Set<string>();
    const inspectNode = (node: Node) => {
      if (!(node instanceof Element)) return;
      const tag = node.tagName.toLowerCase();
      if (!tag.includes('-') && tag !== 'iframe') return;
      if (tag === 'vite-error-overlay') return;
      const signature = `${tag}${node.id ? `#${node.id}` : ''}`.slice(0, 80);
      if (seenSignatures.has(signature) || seenSignatures.size >= 5) return;
      seenSignatures.add(signature);
      push({ type: 'extension_injected', signature });
    };
    Array.from(document.documentElement.children).forEach(inspectNode);
    Array.from(document.body.children).forEach(inspectNode);
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => mutation.addedNodes.forEach(inspectNode));
    });
    observer.observe(document.documentElement, { childList: true });
    observer.observe(document.body, { childList: true });

    // The same attempt open in another tab of this browser.
    const tabId = randomId();
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(`acex-attempt-${token}`);
      channel.onmessage = (message) => {
        const data = message.data || {};
        if (data.tabId === tabId) return;
        push({ type: 'second_tab' });
        if (data.kind === 'hello') channel?.postMessage({ kind: 'here', tabId });
      };
      channel.postMessage({ kind: 'hello', tabId });
    }

    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('copy', onCopyOrCut, true);
    document.addEventListener('cut', onCopyOrCut, true);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('beforeprint', onBeforePrint);

    const interval = window.setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      observer.disconnect();
      channel?.close();
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('copy', onCopyOrCut, true);
      document.removeEventListener('cut', onCopyOrCut, true);
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('beforeprint', onBeforePrint);
    };
  }, [active, token, settings, push, markAway, markBack, flush]);

  return { away, isFullscreen, connectionProblem, drain, flush };
}
