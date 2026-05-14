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

test('parseMarkingResponsePayload repairs quoted prose before a colon inside JSON strings', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const malformedResponse = `{
    "scores": [
      {
        "criterion_name": "Argument",
        "points_awarded": 3,
        "max_points": 5,
        "rubric_basis": "Rubric requires a clear argument.",
        "feedback": "The response labels one section "Problem": this reads like a note rather than a developed argument.",
        "confidence": 84
      }
    ],
    "corrections": [],
    "language_errors": [],
    "overall_feedback": "The argument is present but underdeveloped.",
    "total_score": 3,
    "overall_confidence": 84
  }`;

  const parsed = router.parseMarkingResponsePayload(malformedResponse);

  assert.equal(
    parsed.scores[0].feedback,
    'The response labels one section "Problem": this reads like a note rather than a developed argument.'
  );
});

test('parseMarkingResponsePayload repairs invalid markdown-style JSON escapes in feedback text', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const malformedResponse = String.raw`{
    "scores": [
      {
        "criterion_name": "Writing",
        "points_awarded": 4,
        "max_points": 5,
        "rubric_basis": "Rubric requires clear academic writing.",
        "feedback": "The heading \: Introduction and \_methods\_ label are readable, but the discussion is too brief.",
        "confidence": 86
      }
    ],
    "corrections": [],
    "language_errors": [],
    "overall_feedback": "The response is mostly clear.",
    "total_score": 4,
    "overall_confidence": 86
  }`;

  const parsed = router.parseMarkingResponsePayload(malformedResponse);

  assert.equal(
    parsed.scores[0].feedback,
    'The heading : Introduction and _methods_ label are readable, but the discussion is too brief.'
  );
});

test('parseMarkingResponsePayload preserves likely literal backslashes while repairing invalid escapes', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const malformedResponse = String.raw`{
    "scores": [
      {
        "criterion_name": "Evidence",
        "points_awarded": 2,
        "max_points": 5,
        "rubric_basis": "Rubric requires traceable evidence.",
        "feedback": "The submitted path C:\Users\kev\Documents is mentioned, but evidence is not discussed.",
        "confidence": 80
      }
    ],
    "corrections": [],
    "language_errors": [],
    "overall_feedback": "Evidence needs clearer analysis.",
    "total_score": 2,
    "overall_confidence": 80
  }`;

  const parsed = router.parseMarkingResponsePayload(malformedResponse);

  assert.equal(
    parsed.scores[0].feedback,
    'The submitted path C:\\Users\\kev\\Documents is mentioned, but evidence is not discussed.'
  );
});

test('parseMarkingResponsePayload repairs single-quoted values with apostrophes', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const malformedResponse = `{
    "scores": [
      {
        "criterion_name": 'Analysis',
        "points_awarded": 3,
        "max_points": 5,
        "rubric_basis": 'Rubric requires analysis.',
        "feedback": 'The response is readable, but Don\\'t leave the findings unexplained.',
        "confidence": 82
      }
    ],
    "corrections": [],
    "language_errors": [],
    "overall_feedback": 'The analysis needs more explanation.',
    "total_score": 3,
    "overall_confidence": 82
  }`;

  const parsed = router.parseMarkingResponsePayload(malformedResponse);

  assert.equal(parsed.scores[0].criterion_name, 'Analysis');
  assert.equal(parsed.scores[0].feedback, "The response is readable, but Don't leave the findings unexplained.");
  assert.equal(parsed.overall_feedback, 'The analysis needs more explanation.');
});

test('parseMarkingResponsePayload repairs Python-style literals outside strings', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const malformedResponse = `{
    "scores": [
      {
        "criterion_name": "Structure",
        "points_awarded": 5,
        "max_points": 5,
        "rubric_basis": "Rubric requires coherent structure.",
        "feedback": "This is complete. The word True remains text here.",
        "confidence": 94,
        "flagged": False,
        "note": None
      }
    ],
    "corrections": [],
    "language_errors": [],
    "overall_feedback": "The structure is clear.",
    "total_score": 5,
    "overall_confidence": 94,
    "needs_manual_check": True
  }`;

  const parsed = router.parseMarkingResponsePayload(malformedResponse);

  assert.equal(parsed.scores[0].feedback.includes('True remains text'), true);
  assert.equal(parsed.total_score, 5);
  assert.equal(parsed.overall_confidence, 94);
});

test('parseMarkingResponsePayload accepts numeric strings for score fields', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const response = JSON.stringify({
    scores: [
      {
        criterion_name: 'Method',
        points_awarded: '2.5',
        max_points: '5',
        rubric_basis: 'Rubric requires method detail.',
        feedback: 'The method is present but thin.',
        confidence: '77'
      }
    ],
    corrections: [],
    language_errors: [],
    overall_feedback: 'The method needs more detail.',
    total_score: '2.5',
    overall_confidence: '77'
  });

  const parsed = router.parseMarkingResponsePayload(response);

  assert.equal(parsed.scores[0].points_awarded, 2.5);
  assert.equal(parsed.scores[0].max_points, 5);
  assert.equal(parsed.scores[0].confidence, 77);
  assert.equal(parsed.overall_confidence, 77);
  assert.equal(parsed.total_score, 2.5);
});

test('parseMarkingResponsePayload rejects empty scores instead of producing Infinity confidence metadata', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const response = JSON.stringify({
    scores: [],
    corrections: [],
    language_errors: [],
    overall_feedback: 'No scoring was returned.',
    total_score: 0,
    overall_confidence: 50
  });

  assert.throws(
    () => router.parseMarkingResponsePayload(response),
    /missing scores array/
  );
});

test('parseMarkingResponsePayload repairs quoted prose that resembles a property but has no JSON value', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const malformedResponse = `{
    "scores": [
      {
        "criterion_name": "Discussion",
        "points_awarded": 3,
        "max_points": 5,
        "rubric_basis": "Rubric requires discussion of findings.",
        "feedback": "The paragraph mentions "awareness", "students": this is phrased like a label in the sentence, but it is not a JSON property.",
        "confidence": 83
      }
    ],
    "corrections": [],
    "language_errors": [],
    "overall_feedback": "The discussion needs clearer synthesis.",
    "total_score": 3,
    "overall_confidence": 83
  }`;

  const parsed = router.parseMarkingResponsePayload(malformedResponse);

  assert.equal(
    parsed.scores[0].feedback,
    'The paragraph mentions "awareness", "students": this is phrased like a label in the sentence, but it is not a JSON property.'
  );
});

test('parseMarkingResponsePayload repairs quoted prose that resembles an unknown property with a JSON value', (t) => {
  const { module: router, restore } = loadMarkRoute();
  t.after(restore);

  const malformedResponse = `{
    "scores": [
      {
        "criterion_name": "Discussion",
        "points_awarded": 3,
        "max_points": 5,
        "rubric_basis": "Rubric requires discussion of findings.",
        "feedback": "The paragraph mentions "awareness", "students": 120 as a labelled figure in the sentence, but it is not a response field.",
        "confidence": 83
      }
    ],
    "corrections": [],
    "language_errors": [],
    "overall_feedback": "The discussion needs clearer synthesis.",
    "total_score": 3,
    "overall_confidence": 83
  }`;

  const parsed = router.parseMarkingResponsePayload(malformedResponse);

  assert.equal(
    parsed.scores[0].feedback,
    'The paragraph mentions "awareness", "students": 120 as a labelled figure in the sentence, but it is not a response field.'
  );
});
