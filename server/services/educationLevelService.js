const EDUCATION_LEVELS = [
  {
    id: 'level_1',
    level_number: 1,
    label: 'Level 1 (Grade 8-9)',
    grade_identifier: 'Grade 8-9',
    marking_category: 'primary_school',
    bloom_descriptors: 'Remember, Understand, and Apply foundational ideas using concrete examples and guided practice.',
  },
  {
    id: 'level_2',
    level_number: 2,
    label: 'Level 2 (Grade 10)',
    grade_identifier: 'Grade 10',
    marking_category: 'high_school',
    bloom_descriptors: 'Understand and Apply core concepts, then begin Analyze tasks with structured comparisons and evidence.',
  },
  {
    id: 'level_3',
    level_number: 3,
    label: 'Level 3 (Grade 11)',
    grade_identifier: 'Grade 11',
    marking_category: 'high_school',
    bloom_descriptors: 'Apply and Analyze concepts in unfamiliar contexts, with clearer justification and multi-step reasoning.',
  },
  {
    id: 'level_4',
    level_number: 4,
    label: 'Level 4 (Grade 12)',
    grade_identifier: 'Grade 12',
    marking_category: 'high_school',
    bloom_descriptors: 'Analyze and Evaluate responses with evidence-based argument, accuracy, and coherent synthesis.',
  },
  {
    id: 'level_5',
    level_number: 5,
    label: 'Level 5 (Higher Certificate / Year 1)',
    grade_identifier: 'Higher Certificate / Year 1',
    marking_category: 'undergraduate',
    bloom_descriptors: 'Apply, Analyze, and begin Evaluate ideas in discipline-specific contexts with sound academic conventions.',
  },
  {
    id: 'level_6',
    level_number: 6,
    label: 'Level 6 (Diploma / Advanced Certificate / Year 2)',
    grade_identifier: 'Diploma / Advanced Certificate / Year 2',
    marking_category: 'undergraduate',
    bloom_descriptors: 'Analyze and Evaluate practice-based and theoretical problems using justified decisions and method choice.',
  },
  {
    id: 'level_7',
    level_number: 7,
    label: "Level 7 (Bachelor's Degree / Year 3)",
    grade_identifier: "Bachelor's Degree / Year 3",
    marking_category: 'undergraduate',
    bloom_descriptors: 'Evaluate and Create discipline-informed solutions, integrating evidence, critique, and coherent argument.',
  },
  {
    id: 'level_8',
    level_number: 8,
    label: 'Level 8 (Honours / Postgraduate Diploma)',
    grade_identifier: 'Honours / Postgraduate Diploma',
    marking_category: 'postgraduate',
    bloom_descriptors: 'Evaluate and Create advanced responses with critical synthesis, methodological rigor, and independent judgement.',
  },
  {
    id: 'level_9',
    level_number: 9,
    label: "Level 9 (Master's Degree)",
    grade_identifier: "Master's Degree",
    marking_category: 'postgraduate',
    bloom_descriptors: 'Create and Evaluate original, research-informed arguments with deep theoretical framing and critical reflexivity.',
  },
  {
    id: 'level_10',
    level_number: 10,
    label: 'Level 10 (Doctorate / PhD)',
    grade_identifier: 'Doctorate / PhD',
    marking_category: 'postgraduate',
    bloom_descriptors: 'Create original scholarly contribution and Evaluate complex knowledge claims at a publishable standard.',
  },
];

const byId = new Map(EDUCATION_LEVELS.map((level) => [level.id, level]));

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\(\)\[\],]/g, ' ')
    .replace(/\s+/g, ' ');
}

const aliasMap = new Map([
  ['primary_school', 'level_1'],
  ['high_school', 'level_4'],
  ['undergraduate', 'level_7'],
  ['postgraduate', 'level_9'],
  ['ecd', 'level_1'],
  ['foundation phase', 'level_1'],
  ['grade 8', 'level_1'],
  ['grade 9', 'level_1'],
  ['grade 10', 'level_2'],
  ['grade 11', 'level_3'],
  ['grade 12', 'level_4'],
  ['year 1', 'level_5'],
  ['year 2', 'level_6'],
  ['year 3', 'level_7'],
  ['higher certificate', 'level_5'],
  ['advanced certificate', 'level_6'],
  ['diploma', 'level_6'],
  ["bachelor's", 'level_7'],
  ['bachelors', 'level_7'],
  ['honours', 'level_8'],
  ['postgraduate diploma', 'level_8'],
  ["master's", 'level_9'],
  ['masters', 'level_9'],
  ['doctorate', 'level_10'],
  ['phd', 'level_10'],
  ['nqf 1', 'level_1'],
  ['nqf 2', 'level_2'],
  ['nqf 3', 'level_3'],
  ['nqf 4', 'level_4'],
  ['nqf 5', 'level_5'],
  ['nqf 6', 'level_6'],
  ['nqf 7', 'level_7'],
  ['nqf 8', 'level_8'],
  ['nqf 9', 'level_9'],
  ['nqf 10', 'level_10'],
]);

function resolveEducationLevelId(input, fallbackId = 'level_4') {
  if (!input) return fallbackId;
  const raw = String(input).trim();
  if (byId.has(raw)) return raw;

  const key = normalizeKey(raw);
  if (aliasMap.has(key)) return aliasMap.get(key);

  const levelMatch = key.match(/\b(?:level|nqf)\s*(\d{1,2})\b/);
  if (levelMatch) {
    const parsed = Number.parseInt(levelMatch[1], 10);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 10) {
      return `level_${parsed}`;
    }
  }

  return fallbackId;
}

function resolveEducationLevel(input, fallbackId = 'level_4') {
  const id = resolveEducationLevelId(input, fallbackId);
  return byId.get(id) || byId.get(fallbackId) || EDUCATION_LEVELS[3];
}

function buildEducationLevelPromptBlock(input, fallbackId = 'level_4') {
  const level = resolveEducationLevel(input, fallbackId);
  return [
    `TARGET LEVEL BAND: ${level.label}`,
    `BLOOM TAXONOMY FOCUS: ${level.bloom_descriptors}`,
    `Write and assess at the cognitive demand expected for ${level.label}.`,
  ].join('\n');
}

function buildAcademicWritingGuidance(input, fallbackId = 'level_4') {
  const level = resolveEducationLevel(input, fallbackId);
  if (level.level_number <= 2) {
    return 'WRITING STYLE: Use accessible academic writing with clear, concrete explanations, short paragraphs, and explicit examples. Keep terminology accurate but learner-friendly.';
  }
  if (level.level_number <= 4) {
    return 'WRITING STYLE: Use secondary-school academic style with clear topic sentences, logical paragraph flow, and precise subject terminology. Include worked examples and structured comparisons.';
  }
  if (level.level_number <= 7) {
    return 'WRITING STYLE: Use undergraduate academic writing with formal clarity, argument structure, concept integration, and evidence-based reasoning. Define key terms and include analytical synthesis.';
  }
  return 'WRITING STYLE: Use advanced scholarly writing with strong theoretical framing, critical synthesis, nuanced evaluation, and discipline-specific terminology at postgraduate depth.';
}

module.exports = {
  EDUCATION_LEVELS,
  resolveEducationLevelId,
  resolveEducationLevel,
  buildEducationLevelPromptBlock,
  buildAcademicWritingGuidance,
};
