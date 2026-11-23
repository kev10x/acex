'use strict';

/**
 * Tests for question-by-question ("horizontal") marking.
 *
 * Run:  node --test server/services/questionMarkingService.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadWithMocks } = require('../test-utils/loadWithMocks');

const { module: svc } = loadWithMocks(path.join(__dirname, 'questionMarkingService.js'), {
  '../config/ai-config': {
    getConfig: () => ({ provider: 'openai', model: 'test-model', maxTokens: 16000 }),
    estimateCost: (prompt, completion) => (prompt + completion) / 1e6
  }
});

const memoRubric = {
  name: 'Test memo',
  rubric_type: 'answer_key',
  total_points: 7,
  criteria: [
    { name: 'Question 1', description: 'Define osmosis.', max_points: 3 },
    { name: 'Question 2', description: 'Give two examples.', max_points: 4 }
  ]
};

// Scripts are written as "Q1: <answer> || Q2: <answer>"; an answer "score=N" earns N points.
const fakeAI = ({ skipLabels = [], failSegmentFor = null } = {}) => {
  const calls = { segment: 0, mark: 0, synth: 0, prompts: [] };
  const callAI = async ({ messages }) => {
    const prompt = messages[0].content;
    calls.prompts.push(prompt);
    const usage = { prompt_tokens: 100, completion_tokens: 20 };

    if (prompt.includes('Split it into the student')) {
      calls.segment += 1;
      const script = prompt.split('STUDENT SCRIPT:\n')[1].split('\n\nReturn ONLY')[0];
      if (failSegmentFor && script.includes(failSegmentFor)) {
        return { content: 'not json at all', usage };
      }
      const answers = script.split('||').map((part) => {
        const match = part.trim().match(/^Q(\d+):\s*(.*)$/s);
        return match ? { question: Number(match[1]), found: true, answer_text: match[2].trim() } : null;
      }).filter(Boolean);
      return { content: JSON.stringify({ answers }), usage };
    }

    if (prompt.includes('=== S1 ===')) {
      calls.mark += 1;
      const blocks = [...prompt.matchAll(/=== (S\d+) ===\n([\s\S]*?)(?=\n\n=== S\d+ ===|\n\nFor every label)/g)];
      const marks = blocks
        .filter(([, label]) => !(blocks.length > 1 && skipLabels.some((text) => prompt.includes(`=== ${label} ===\n${text}`))))
        .filter(([, , text]) => !(blocks.length === 1 && skipLabels.includes(text.trim())))
        .map(([, label, text]) => ({
          label,
          points_awarded: Number((text.match(/score=([\d.]+)/) || [])[1] || 0),
          rubric_basis: 'basis',
          feedback: `feedback for ${text.trim()}`,
          confidence: 90
        }));
      return { content: JSON.stringify({ marks }), usage };
    }

    calls.synth += 1;
    return { content: JSON.stringify({ overall_feedback: 'Overall, good work.', improvement_forecast: 'By fixing X...' }), usage };
  };
  return { callAI, calls };
};

test('memo rubric: marks each question across all scripts in one call', async () => {
  const { callAI, calls } = fakeAI();
  const { markByQuestion } = svc.createQuestionMarker({ callAI });
  const { results, errors, cancelled } = await markByQuestion({
    scripts: [
      { assignment_id: 1, text: 'Q1: score=3 || Q2: score=4' },
      { assignment_id: 2, text: 'Q1: score=1.4 || Q2: score=9' },
      { assignment_id: 3, text: 'Q1: score=2' }
    ],
    rubric: memoRubric,
    isMemo: true
  });

  assert.equal(cancelled, false);
  assert.deepEqual(errors, []);
  assert.equal(calls.segment, 3);
  assert.equal(calls.mark, 2, 'one call per question, not per script');
  assert.equal(calls.synth, 3);

  const first = results.get(1);
  assert.equal(first.total_score, 7);
  assert.deepEqual(first.scores.map((s) => s.points_awarded), [3, 4]);
  assert.equal(first.overall_feedback, 'Overall, good work.');
  assert.equal(first.needs_review, false);
  assert.equal(first.items[0].answer_text, 'score=3');

  // Rounded to the nearest half mark and clamped to the question's maximum.
  assert.deepEqual(results.get(2).scores.map((s) => s.points_awarded), [1.5, 4]);

  // A missing answer gets zero and a low confidence so the script lands in review.
  const third = results.get(3);
  assert.equal(third.total_score, 2);
  assert.equal(third.items[1].answer_found, false);
  assert.equal(third.scores[1].points_awarded, 0);
  assert.equal(third.has_low_criterion_confidence, true);

  // Usage is shared out per script so per-result cost tracking keeps working.
  assert.ok(first.usage.total_tokens > 0);
  assert.ok(first.estimated_cost_usd > 0);
});

test('criterion rubric: no splitting, every criterion sees the whole script', async () => {
  const { callAI, calls } = fakeAI();
  const { markByQuestion } = svc.createQuestionMarker({ callAI });
  const { results } = await markByQuestion({
    scripts: [{ assignment_id: 1, text: 'An essay score=2' }],
    rubric: {
      total_points: 10,
      criteria: [
        { name: 'Argument', max_points: 5 },
        { name: 'Structure', levels: [{ level: 'Good', points: 5, description: 'clear' }] }
      ]
    },
    isMemo: false
  });

  assert.equal(calls.segment, 0);
  assert.equal(calls.mark, 2);
  const markPrompts = calls.prompts.filter((p) => p.includes('=== S1 ==='));
  assert.ok(markPrompts.every((p) => p.includes('An essay score=2')));
  assert.equal(results.get(1).total_score, 4);
  assert.equal(results.get(1).scores[1].max_points, 5, 'max points taken from levels');
  assert.equal(results.get(1).items[0].answer_text, null, 'whole script is not copied into every item');
});

test('a script the model skips is retried alone, and only that script fails if the retry fails', async () => {
  const { callAI } = fakeAI({ skipLabels: ['score=1'] });
  const { markByQuestion } = svc.createQuestionMarker({ callAI });
  const { results, errors } = await markByQuestion({
    scripts: [
      { assignment_id: 1, text: 'Q1: score=3 || Q2: score=4' },
      { assignment_id: 2, text: 'Q1: score=1 || Q2: score=2' }
    ],
    rubric: memoRubric,
    isMemo: true
  });

  assert.equal(results.size, 1);
  assert.ok(results.has(1));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].assignment_id, 2);
  assert.match(errors[0].error, /Question 1/);
});

test('a script that cannot be split fails on its own without stopping the batch', async () => {
  const { callAI } = fakeAI({ failSegmentFor: 'broken' });
  const { markByQuestion } = svc.createQuestionMarker({ callAI });
  const { results, errors } = await markByQuestion({
    scripts: [
      { assignment_id: 1, text: 'Q1: score=3 || Q2: score=4' },
      { assignment_id: 2, text: 'broken script' }
    ],
    rubric: memoRubric,
    isMemo: true
  });

  assert.deepEqual([...results.keys()], [1]);
  assert.equal(errors[0].assignment_id, 2);
  assert.match(errors[0].error, /Splitting into answers failed/);
});

test('cancelling stops before further AI calls', async () => {
  const { callAI, calls } = fakeAI();
  const { markByQuestion } = svc.createQuestionMarker({ callAI });
  const outcome = await markByQuestion({
    scripts: [{ assignment_id: 1, text: 'Q1: score=3 || Q2: score=4' }],
    rubric: memoRubric,
    isMemo: true,
    isCancelled: () => calls.segment > 0
  });
  assert.equal(outcome.cancelled, true);
  assert.equal(calls.mark, 0);
});

test('chunkAnswers packs answers by character budget and per-call cap', () => {
  const answers = [10, 10, 10, 50, 5].map((n, i) => ({ assignment_id: i, text: 'x'.repeat(n) }));
  const byBudget = svc.chunkAnswers(answers, { charBudget: 30, maxPerCall: 10 });
  assert.deepEqual(byBudget.map((c) => c.length), [3, 1, 1]);
  const byCap = svc.chunkAnswers(answers, { charBudget: 1000, maxPerCall: 2 });
  assert.deepEqual(byCap.map((c) => c.length), [2, 2, 1]);
});
