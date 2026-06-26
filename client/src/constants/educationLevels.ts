export const EDUCATION_LEVEL_OPTIONS = [
  { value: '', label: 'Any level' },
  { value: 'level_1', label: 'Level 1 (Grade 8-9)' },
  { value: 'level_2', label: 'Level 2 (Grade 10)' },
  { value: 'level_3', label: 'Level 3 (Grade 11)' },
  { value: 'level_4', label: 'Level 4 (Grade 12)' },
  { value: 'level_5', label: 'Level 5 (Higher Certificate / Year 1)' },
  { value: 'level_6', label: 'Level 6 (Diploma / Advanced Certificate / Year 2)' },
  { value: 'level_7', label: "Level 7 (Bachelor's Degree / Year 3)" },
  { value: 'level_8', label: 'Level 8 (Honours / Postgraduate Diploma)' },
  { value: 'level_9', label: "Level 9 (Master's Degree)" },
  { value: 'level_10', label: 'Level 10 (Doctorate / PhD)' },
] as const;

export const DEFAULT_MARKING_LEVEL = 'level_4';

const LEGACY_TO_LEVEL: Record<string, string> = {
  primary_school: 'level_1',
  high_school: 'level_4',
  undergraduate: 'level_7',
  postgraduate: 'level_9',
  ecd: 'level_1',
  'foundation phase': 'level_1',
  'grade 8': 'level_1',
  'grade 9': 'level_1',
  'grade 10': 'level_2',
  'grade 11': 'level_3',
  'grade 12': 'level_4',
  'year 1': 'level_5',
  'year 2': 'level_6',
  'year 3': 'level_7',
};

export function normalizeEducationLevelValue(input: string | null | undefined, fallback = ''): string {
  const raw = String(input || '').trim();
  if (!raw) return fallback;
  if (raw.startsWith('level_')) return raw;
  if (raw.startsWith('nqf_')) return raw.replace(/^nqf_/, 'level_');
  const key = raw.toLowerCase();
  return LEGACY_TO_LEVEL[key] || raw;
}
