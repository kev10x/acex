const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { loadWithMocks } = require('../test-utils/loadWithMocks');

function createApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/modules', router);
  return app;
}

function createStatefulQueryMock(state) {
  return async function query(sql, params = []) {
    const normalized = String(sql || '').replace(/\s+/g, ' ').trim().toLowerCase();

    if (
      normalized.startsWith('alter table module_items')
      || normalized.startsWith('show index from module_items')
      || normalized.includes('drop constraint module_items_module_id_item_type_item_id_key')
      || normalized.includes('add constraint uniq_module_item_v2')
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.includes('select id, name, user_id from modules where id = $1 and user_id = $2')) {
      const [moduleId, userId] = params;
      const rows = state.modules.filter((m) => Number(m.id) === Number(moduleId) && Number(m.user_id) === Number(userId));
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('from homework_module_workflows') && normalized.includes('where homework_module_id = $1')) {
      const [moduleId] = params;
      const row = state.workflows.get(Number(moduleId));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith('insert into homework_module_workflows')) {
      const [homeworkModuleId, userId, status, notes, reasonSummary, reasonPayloadJson] = params;
      const existing = state.workflows.get(Number(homeworkModuleId));
      const merged = {
        homework_module_id: Number(homeworkModuleId),
        user_id: Number(userId),
        status: String(status || existing?.status || 'draft'),
        review_notes: notes == null ? (existing?.review_notes || null) : notes,
        reason_summary: reasonSummary == null ? (existing?.reason_summary || null) : reasonSummary,
        reason_payload_json: reasonPayloadJson == null ? (existing?.reason_payload_json || null) : reasonPayloadJson,
        reviewed_at: existing?.reviewed_at || null,
        reviewed_by_user_id: existing?.reviewed_by_user_id || null,
        published_at: existing?.published_at || null,
        published_by_user_id: existing?.published_by_user_id || null,
      };
      state.workflows.set(Number(homeworkModuleId), merged);
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes('select module_id, item_type, count(*) as item_count') && normalized.includes('from module_items')) {
      const moduleIds = Array.isArray(params[0]) ? params[0].map(Number) : [];
      const rows = [];
      moduleIds.forEach((moduleId) => {
        const scoped = state.moduleItems.filter((item) => Number(item.module_id) === Number(moduleId));
        const contentCount = scoped.filter((item) => item.item_type === 'content').length;
        const assessmentCount = scoped.filter((item) => item.item_type === 'assessment').length;
        if (contentCount > 0) rows.push({ module_id: moduleId, item_type: 'content', item_count: contentCount });
        if (assessmentCount > 0) rows.push({ module_id: moduleId, item_type: 'assessment', item_count: assessmentCount });
      });
      return { rows, rowCount: rows.length };
    }

    if (normalized.startsWith('update homework_module_workflows') && normalized.includes('where homework_module_id = $7')) {
      const [status, reviewNotes, reviewedAt, reviewedBy, publishedAt, publishedBy, moduleId] = params;
      const existing = state.workflows.get(Number(moduleId));
      if (!existing) return { rows: [], rowCount: 0 };
      const updated = {
        ...existing,
        status,
        review_notes: reviewNotes,
        reviewed_at: reviewedAt,
        reviewed_by_user_id: reviewedBy,
        published_at: publishedAt,
        published_by_user_id: publishedBy,
      };
      state.workflows.set(Number(moduleId), updated);
      return { rows: [], rowCount: 1 };
    }

    if (normalized.startsWith('insert into homework_workflow_events')) {
      state.workflowEvents.push({
        user_id: Number(params[0] || 0),
        action: String(params[1] || ''),
        status: params[2] || null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalized.includes('from modules m') && normalized.includes('left join homework_module_workflows hmw') && normalized.includes('where m.user_id = $1') && normalized.includes("m.name like $2")) {
      const [userId, pattern] = params;
      const likeToken = String(pattern || '').replace(/%/g, '').toLowerCase();
      const rows = [];
      state.modules
        .filter((m) => Number(m.user_id) === Number(userId))
        .filter((m) => String(m.name || '').toLowerCase().includes(likeToken))
        .forEach((module) => {
          const workflow = state.workflows.get(Number(module.id)) || null;
          const student = state.moduleStudents.find((s) => Number(s.module_id) === Number(module.id)) || null;
          const items = state.moduleItems
            .filter((mi) => Number(mi.module_id) === Number(module.id))
            .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
          if (items.length === 0) {
            rows.push({
              homework_module_id: module.id,
              homework_module_name: module.name,
              homework_created_at: module.created_at,
              reason_payload_json: workflow?.reason_payload_json || null,
              student_user_id: student?.student_user_id || null,
              student_name: student?.name || null,
              student_email: student?.email || null,
              item_type: null,
              item_id: null,
              snapshot_title: null,
            });
          } else {
            items.forEach((item) => {
              rows.push({
                homework_module_id: module.id,
                homework_module_name: module.name,
                homework_created_at: module.created_at,
                reason_payload_json: workflow?.reason_payload_json || null,
                student_user_id: student?.student_user_id || null,
                student_name: student?.name || null,
                student_email: student?.email || null,
                item_type: item.item_type,
                item_id: item.item_id,
                snapshot_title: item.snapshot_title || null,
              });
            });
          }
        });
      return { rows, rowCount: rows.length };
    }

    if (normalized.includes('from assessment_submissions s') && normalized.includes('where s.published_assessment_id = any($1::int[])')) {
      const assessmentIds = Array.isArray(params[0]) ? params[0].map(Number) : [];
      const studentIds = Array.isArray(params[1]) ? params[1].map(Number) : [];
      const rows = state.submissions
        .filter((s) => assessmentIds.includes(Number(s.published_assessment_id)))
        .filter((s) => studentIds.includes(Number(s.student_user_id)))
        .filter((s) => ['completed', 'processing', 'queued'].includes(String(s.status)))
        .map((s) => ({
          published_assessment_id: s.published_assessment_id,
          student_user_id: s.student_user_id,
          status: s.status,
          submitted_at: s.submitted_at,
          completed_at: s.completed_at,
          assignment_id: s.assignment_id,
          scores: s.scores,
          total_score: s.total_score,
          effective_total_score: s.effective_total_score,
          marked_at: s.marked_at,
        }));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`Unhandled SQL in critical-path test mock: ${sql}`);
  };
}

test('critical path: homework review -> publish -> student completion updates trends', async (t) => {
  const reasonPayload = {
    weak_areas: [
      { criterion_name: 'Algebraic manipulation', avg_percent: 42.0 },
      { criterion_name: 'Function interpretation', avg_percent: 48.0 },
    ],
    rubric_criteria: [
      { name: 'Algebraic manipulation', max_points: 10 },
      { name: 'Function interpretation', max_points: 10 },
    ],
  };

  const state = {
    modules: [
      {
        id: 500,
        user_id: 7,
        name: 'Math Fundamentals - Homework for Student A',
        created_at: '2026-04-18T09:00:00.000Z',
      },
    ],
    workflows: new Map([
      [500, {
        homework_module_id: 500,
        user_id: 7,
        status: 'draft',
        review_notes: null,
        reason_summary: 'Generated from marked scripts.',
        reason_payload_json: JSON.stringify(reasonPayload),
        reviewed_at: null,
        reviewed_by_user_id: null,
        published_at: null,
        published_by_user_id: null,
      }],
    ]),
    moduleItems: [
      { id: 1, module_id: 500, item_type: 'content', item_id: 801, snapshot_title: 'Remedial Content', position: 0 },
      { id: 2, module_id: 500, item_type: 'assessment', item_id: 901, snapshot_title: 'Homework Quiz', position: 1 },
    ],
    moduleStudents: [
      { module_id: 500, student_user_id: 88, name: 'Student A', email: 'student-a@example.com' },
    ],
    submissions: [
      {
        published_assessment_id: 901,
        student_user_id: 88,
        status: 'queued',
        submitted_at: '2026-04-19T10:00:00.000Z',
        completed_at: null,
        assignment_id: 2001,
        scores: null,
        total_score: null,
        effective_total_score: null,
        marked_at: null,
      },
    ],
    workflowEvents: [],
  };

  const mockQuery = createStatefulQueryMock(state);
  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'modules.js'), {
    '../database/connection': { query: mockQuery },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { id: 7, role: 'lecturer', organisation_id: 11, department_id: 5 };
        next();
      },
      requireFeature: () => (_req, _res, next) => next(),
      requireRoles: () => (_req, _res, next) => next(),
    },
    '../services/contentService': {
      normalizeGeneratedContent: (content) => content,
      generateContentWithAI: async () => ({
        title: 'Generated Homework',
        instructions: 'Complete all tasks.',
        sections: [{ heading: 'Section 1', body: 'Practice problems.' }],
      }),
    },
    '../services/aiService': {
      createCompletionWithRetry: async () => ({
        content: JSON.stringify({
          title: 'Generated Assessment',
          difficulty_level: 'moderate',
          questions: [
            { number: 1, type: 'multiple_choice', question: 'Q1', points: 10, options: ['A', 'B'], correct_answer: 'A' },
            { number: 2, type: 'short_answer', question: 'Q2', points: 10 },
          ],
          suggested_rubric_criteria: [
            { name: 'Algebraic manipulation', max_points: 10, description: 'Criterion 1' },
            { name: 'Function interpretation', max_points: 10, description: 'Criterion 2' },
          ],
        }),
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      }),
    },
    '../config/ai-config': {
      getTaskConfig: () => ({ provider: 'openai', model: 'gpt-5.4-mini', temperature: 0.2, maxTokens: 2000 }),
      estimateCost: () => 0.01,
    },
    '../services/generationTelemetryService': {
      inferGenerationErrorType: () => 'runtime',
      logGenerationTelemetry: () => {},
      persistGenerationTelemetryEvent: async () => {},
    },
    '../services/generationJobService': {
      createGenerationJob: async () => 300,
      updateGenerationJob: async () => {},
      listGenerationJobs: async () => [],
      JOB_STATUS: { PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed' },
    },
    '../services/promptRegistryService': {
      listPromptRegistry: async () => [],
      createPromptRegistryVersion: async () => ({}),
      resolvePromptRegistryVersion: async () => ({ prompt_version: 1 }),
    },
    '../services/auditEventService': {
      recordAuditEvent: async () => {},
      getRequestMetadata: () => ({}),
    },
  });
  t.after(restore);

  const app = createApp(router);

  const reviewed = await request(app)
    .put('/modules/500/homework-workflow')
    .send({
      status: 'reviewed',
      review_notes: 'Reviewed and aligned with weak-area evidence from marked scripts.',
    });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body?.workflow?.status, 'reviewed');

  const published = await request(app)
    .put('/modules/500/homework-workflow')
    .send({
      status: 'published',
      review_notes: 'Reviewed and aligned with weak-area evidence from marked scripts.',
    });
  assert.equal(published.status, 200);
  assert.equal(published.body?.workflow?.status, 'published');
  assert.equal(state.workflows.get(500)?.status, 'published');

  const trendsBefore = await request(app).get('/modules/homework-trends?bypass_cache=1');
  assert.equal(trendsBefore.status, 200);
  assert.equal(trendsBefore.body?.summary?.total_cycles, 1);
  assert.equal(trendsBefore.body?.summary?.improved_cycles, 0);
  assert.equal(trendsBefore.body?.timeline?.[0]?.impact_status, 'unknown');

  state.submissions[0] = {
    ...state.submissions[0],
    status: 'completed',
    completed_at: '2026-04-20T08:00:00.000Z',
    marked_at: '2026-04-20T08:10:00.000Z',
    scores: JSON.stringify([
      { criterion_name: 'Algebraic manipulation', points_awarded: 8, max_points: 10 },
      { criterion_name: 'Function interpretation', points_awarded: 8, max_points: 10 },
    ]),
    total_score: 16,
    effective_total_score: 16,
  };

  const outcomesAfter = await request(app).get('/modules/homework-outcomes?bypass_cache=1');
  assert.equal(outcomesAfter.status, 200);
  assert.equal(outcomesAfter.body?.items?.[0]?.completed_attempts, 1);
  assert.equal(outcomesAfter.body?.items?.[0]?.summary?.impact_status, 'positive');
  assert.ok(Number(outcomesAfter.body?.items?.[0]?.summary?.impact_percent) > 0);

  const trendsAfter = await request(app).get('/modules/homework-trends?bypass_cache=1');
  assert.equal(trendsAfter.status, 200);
  assert.equal(trendsAfter.body?.summary?.total_cycles, 1);
  assert.equal(trendsAfter.body?.summary?.student_count, 1);
  assert.equal(trendsAfter.body?.summary?.improved_cycles, 1);
  assert.equal(trendsAfter.body?.timeline?.[0]?.impact_status, 'positive');
  assert.ok(Number(trendsAfter.body?.timeline?.[0]?.impact_percent) > 0);
});

test('guardrail path: publishing homework is blocked when required artifacts are missing', async (t) => {
  const reasonPayload = {
    weak_areas: [],
    rubric_criteria: [],
  };

  const state = {
    modules: [
      {
        id: 700,
        user_id: 7,
        name: 'Physics Foundations - Homework for Student B',
        created_at: '2026-04-18T09:00:00.000Z',
      },
    ],
    workflows: new Map([
      [700, {
        homework_module_id: 700,
        user_id: 7,
        status: 'draft',
        review_notes: null,
        reason_summary: 'Initial draft.',
        reason_payload_json: JSON.stringify(reasonPayload),
        reviewed_at: null,
        reviewed_by_user_id: null,
        published_at: null,
        published_by_user_id: null,
      }],
    ]),
    moduleItems: [],
    moduleStudents: [
      { module_id: 700, student_user_id: 99, name: 'Student B', email: 'student-b@example.com' },
    ],
    submissions: [],
    workflowEvents: [],
  };

  const mockQuery = createStatefulQueryMock(state);
  const { module: router, restore } = loadWithMocks(path.join(__dirname, 'modules.js'), {
    '../database/connection': { query: mockQuery },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { id: 7, role: 'lecturer', organisation_id: 11, department_id: 5 };
        next();
      },
      requireFeature: () => (_req, _res, next) => next(),
      requireRoles: () => (_req, _res, next) => next(),
    },
    '../services/contentService': {
      normalizeGeneratedContent: (content) => content,
      generateContentWithAI: async () => ({
        title: 'Generated Homework',
        instructions: 'Complete all tasks.',
        sections: [{ heading: 'Section 1', body: 'Practice problems.' }],
      }),
    },
    '../services/aiService': {
      createCompletionWithRetry: async () => ({
        content: JSON.stringify({
          title: 'Generated Assessment',
          difficulty_level: 'moderate',
          questions: [{ number: 1, type: 'short_answer', question: 'Q1', points: 10 }],
        }),
      }),
    },
    '../config/ai-config': {
      getTaskConfig: () => ({ provider: 'openai', model: 'gpt-5.4-mini', temperature: 0.2, maxTokens: 2000 }),
      estimateCost: () => 0.01,
    },
    '../services/generationTelemetryService': {
      inferGenerationErrorType: () => 'runtime',
      logGenerationTelemetry: () => {},
      persistGenerationTelemetryEvent: async () => {},
    },
    '../services/generationJobService': {
      createGenerationJob: async () => 300,
      updateGenerationJob: async () => {},
      listGenerationJobs: async () => [],
      JOB_STATUS: { PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed' },
    },
    '../services/promptRegistryService': {
      listPromptRegistry: async () => [],
      createPromptRegistryVersion: async () => ({}),
      resolvePromptRegistryVersion: async () => ({ prompt_version: 1 }),
    },
    '../services/auditEventService': {
      recordAuditEvent: async () => {},
      getRequestMetadata: () => ({}),
    },
  });
  t.after(restore);

  const app = createApp(router);
  const blocked = await request(app)
    .put('/modules/700/homework-workflow')
    .send({
      status: 'published',
      review_notes: 'Ready to publish.',
    });

  assert.equal(blocked.status, 400);
  assert.equal(blocked.body?.error, 'Cannot publish homework module until all publish guardrails are satisfied');
  assert.ok(Array.isArray(blocked.body?.blockers));
  assert.ok(blocked.body.blockers.includes('Missing generated content item'));
  assert.ok(blocked.body.blockers.includes('Missing generated assessment item'));
  assert.equal(state.workflows.get(700)?.status, 'draft');
});
