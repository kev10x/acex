import { studentFacingInstructions } from './assessmentInstructions';

describe('studentFacingInstructions', () => {
  it('rewrites the reported instructions in plain language', () => {
    const raw = 'Answer all questions. For multiple_choice (MCQ) choose one option (enter the letter). For short_answer and essay provide concise, evidence-based responses. For mix_and_match, match items from the left column to the right column by indicating the pairing numbers (provided as objects in correct_pairings). For problem questions, give a structured proposed solution; hints are provided where applicable. Write clearly and justify recommendations with brief rationale or evidence where requested.';
    expect(studentFacingInstructions(raw)).toBe(
      'Answer all questions. For multiple-choice questions, choose one option. For short-answer and essay questions, provide concise, evidence-based responses. For matching questions, match items from the left column to the right column. For problem questions, give a structured proposed solution; hints are provided where applicable. Write clearly and justify recommendations with brief rationale or evidence where requested.'
    );
  });

  it('never shows answer-key field names', () => {
    const result = studentFacingInstructions('Match the terms (see correct_answer for the format). Use the left_column items.');
    expect(result).not.toMatch(/correct_answer/);
    expect(result).toBe('Match the terms. Use the left_column items.');
  });

  it('leaves ordinary instructions alone', () => {
    const plain = 'Answer all 5 questions. You have 30 minutes. Show your working (marks are given for method).';
    expect(studentFacingInstructions(plain)).toBe(plain);
    expect(studentFacingInstructions('')).toBe('');
    expect(studentFacingInstructions(null)).toBe('');
  });
});
