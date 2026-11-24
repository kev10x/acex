/**
 * Tidy AI-written assessment instructions for students.
 *
 * Generated instructions sometimes use the generator's internal names
 * ("multiple_choice", "mix_and_match"), mention answer-key fields
 * ("correct_pairings") or describe answering on paper ("enter the letter",
 * "indicating the pairing numbers"), which does not match the on-screen
 * controls. This rewrites those parts and leaves everything else as written.
 */

const TYPE_NAMES: [RegExp, string][] = [
  [/\bmultiple[_ ]choice\b/gi, 'multiple-choice'],
  [/\bshort[_ ]answer\b/gi, 'short-answer'],
  [/\bmix[_ ]and[_ ]match\b/gi, 'matching'],
  [/\btrue[_ ]false\b/gi, 'true/false'],
  [/\bfill[_ ]in[_ ]the[_ ]blank\b/gi, 'fill-in-the-blank']
];

const TYPE_LABEL = '(?:multiple-choice|short-answer|matching|true\\/false|fill-in-the-blank|essay|problem)';

// Field names from the assessment data, which mean nothing to students (and reveal the answer key exists).
const INTERNAL_FIELDS = /\b(?:correct_pairings|correct_answer|left_column|right_column|related_criteria|question_number|model_answer)\b/i;

export function studentFacingInstructions(text: string | null | undefined): string {
  let result = String(text || '');
  if (!result.trim()) return '';

  for (const [pattern, name] of TYPE_NAMES) result = result.replace(pattern, name);

  result = result
    // Parentheticals that mention internal fields, e.g. "(provided as objects in correct_pairings)".
    .replace(/\s*\(([^()]*)\)/g, (match, inner) => (INTERNAL_FIELDS.test(inner) ? '' : match))
    // Paper-style answering hints that do not match the on-screen controls.
    .replace(/\s*\((?:enter|write|type|circle)\s+the\s+(?:letter|number)s?\)/gi, '')
    .replace(/\s+by\s+(?:indicating|writing|entering|drawing)\s+(?:the\s+)?(?:pairing\s+numbers|pairs|lines)\b/gi, '')
    // "multiple-choice (MCQ)" -> "multiple-choice"
    .replace(/(multiple-choice)\s*\((?:MCQ|MCQs)\)/gi, '$1')
    // "For multiple-choice choose" / "For short-answer and essay provide" -> "For ... questions, ..."
    .replace(
      new RegExp(`\\bFor (${TYPE_LABEL}(?:(?:,\\s*|\\s+(?:and|or)\\s+)${TYPE_LABEL})*)(?:\\s+questions)?\\s*,?\\s+`, 'gi'),
      'For $1 questions, '
    )
    // Tidy spacing and punctuation left behind.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/,\s*\./g, '.');

  return result.trim();
}
