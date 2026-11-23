import type { IntegrityEvent, IntegrityPreset } from '../services/api';

// Plain-language text for exam integrity settings and events, shared by the
// lecturer reports, the settings panel and the student preview.

export const PRESET_LABELS: Record<IntegrityPreset, string> = {
  quiz: 'Low-stakes quiz',
  test: 'Test',
  exam: 'Formal exam',
  custom: 'Custom'
};

export const formatDuration = (ms: number | null | undefined) => {
  const totalSeconds = Math.round((ms || 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
};

export const describeEvent = (event: Pick<IntegrityEvent, 'type' | 'duration_ms' | 'question_number' | 'details'>) => {
  const chars = event.details?.chars;
  const blocked = event.details?.blocked ? ' (blocked)' : '';
  const where = event.question_number ? ` in Q${event.question_number}` : '';
  switch (event.type) {
    case 'attempt_started': return 'Started the assessment';
    case 'attempt_resumed': return 'Reopened the assessment page';
    case 'focus_lost': return `Left the assessment for ${formatDuration(event.duration_ms)}`;
    case 'fullscreen_exit': return `Out of full screen for ${formatDuration(event.duration_ms)}`;
    case 'fullscreen_unsupported': return 'Browser does not support full screen';
    case 'paste': return `${event.details?.source === 'drop' ? 'Dropped' : 'Pasted'} ${chars ?? 0} characters${where}${blocked}`;
    case 'copy': return `Copied ${chars ?? 0} characters${where}${blocked}`;
    case 'cut': return `Cut ${chars ?? 0} characters${where}${blocked}`;
    case 'context_menu': return `Right-clicked${blocked}`;
    case 'text_burst': return `${chars ?? 0} characters appeared at once${where} (faster than typing)`;
    case 'print_attempt': return `Tried to print${blocked}`;
    case 'extension_injected': return `Browser extension added content (${event.details?.signature || 'unknown'})`;
    case 'second_tab': return 'Assessment open in a second tab';
    case 'duplicate_session': return 'Assessment open on a second device or browser';
    case 'ip_changed': return `IP address changed from ${event.details?.from} to ${event.details?.to}`;
    case 'ip_outside_range': return `Connected from outside the allowed network (${event.details?.ip})`;
    case 'connection_gap': return `No contact from the browser for ${formatDuration(event.duration_ms)}`;
    case 'submitted': return 'Submitted and exited';
    case 'exited': return 'Exited without submitting';
    case 'reopened': return 'Reopened by staff';
    default: return event.type;
  }
};
