const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadWithMocks } = require('../test-utils/loadWithMocks');

function loadMarkRoute() {
  return loadWithMocks(path.join(__dirname, 'mark.js'), {
    '../database/connection': {
      query: async () => []
    },
    '../services/aiService': {},
    '../services/pdfAnnotator': {
      annotatePdfWithIssues: async () => null,
      buildIssuesFromMarking: () => []
    },
    '../services/pdfReportGenerator': class MockPDFReportGenerator {},
    '../services/educationLevelService': {
      resolveEducationLevel: () => ({
        id: 'level_4',
        label: 'Undergraduate',
        marking_category: 'undergraduate'
      }),
      buildEducationLevelPromptBlock: () => ''
    },
    '../middleware/auth': {
      requireAuth: (_req, _res, next) => next()
    },
    '../services/pdfOCR': {
      extractTextFromPDF: async () => '',
      getPdfPageImages: async () => []
    }
  });
}

test('parseMarkingResponsePayload repairs quoted prose followed by commas inside JSON strings', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const malformedResponse = `{
    "scores": [
      {
        "criterion_name": "Title, Abstract & Keywords",
        "points_awarded": 1,
        "max_points": 5,
        "rubric_basis": "Rubric requires a clear title and a complete abstract.",
        "feedback": "Your title states "Gamification in Cybersecurity, Awareness, and Students", but the abstract is missing. Keep quoted phrases escaped in final JSON.",
        "confidence": 91
      }
    ],
    "corrections": [],
    "language_errors": [
      {
        "location": "Abstract, first sentence",
        "error_text": "The word "their", not "there", is needed here.",
        "error_type": "grammar",
        "correction": "Use their as the possessive form.",
        "explanation": "This is a homophone error."
      }
    ],
    "overall_feedback": "You have a workable focus, but the response needs a complete abstract.",
    "total_score": 1,
    "overall_confidence": 88
  }`;

  const parsed = router.parseMarkingResponsePayload(malformedResponse);

  assert.equal(parsed.scores[0].feedback.includes('"Gamification in Cybersecurity, Awareness, and Students"'), true);
  assert.equal(parsed.language_errors[0].error_text, 'The word "their", not "there", is needed here.');
  assert.equal(parsed.total_score, 1);
  assert.equal(parsed.overall_confidence, 88);
});

test('parseMarkingResponsePayload preserves valid escaped quotes in feedback text', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const validResponse = JSON.stringify({
    scores: [
      {
        criterion_name: 'Presentation',
        points_awarded: 2,
        max_points: 5,
        rubric_basis: 'Rubric requires clear presentation.',
        feedback: 'Your note says "Abstract:", which is fine as a heading but not enough as content.',
        confidence: 89
      }
    ],
    corrections: [],
    language_errors: [],
    overall_feedback: 'You need to expand the abstract into a complete summary.',
    total_score: 2,
    overall_confidence: 89
  });

  const parsed = router.parseMarkingResponsePayload(validResponse);

  assert.equal(
    parsed.scores[0].feedback,
    'Your note says "Abstract:", which is fine as a heading but not enough as content.'
  );
});
