const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadWithMocks } = require('../test-utils/loadWithMocks');

function withEnv(overrides, run) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

test('budget guardrail allows generation when user spend is within budget', async (t) => {
  const { module: budgetService, restore } = loadWithMocks(path.join(__dirname, 'budgetGuardrailService.js'), {
    '../database/connection': {
      query: async () => ({ rows: [{ spent_usd: 1.25 }] }),
    },
  });
  t.after(restore);

  await withEnv(
    {
      AI_BUDGET_GUARDRAIL_ENABLED: 'true',
      AI_DAILY_BUDGET_USD: '5',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/markmate',
    },
    async () => {
      const status = await budgetService.getUserBudgetStatus({ userId: 7, projectedCostUsd: 0.5 });
      assert.equal(status.allowed, true);
      assert.equal(status.daily_budget_usd, 5);
      assert.equal(status.spent_last_24h_usd, 1.25);
      assert.equal(status.projected_total_usd, 1.75);
    }
  );
});

test('budget guardrail blocks generation when projected spend exceeds budget', async (t) => {
  const { module: budgetService, restore } = loadWithMocks(path.join(__dirname, 'budgetGuardrailService.js'), {
    '../database/connection': {
      query: async () => ({ rows: [{ spent_usd: 4.95 }] }),
    },
  });
  t.after(restore);

  await withEnv(
    {
      AI_BUDGET_GUARDRAIL_ENABLED: 'true',
      AI_DAILY_BUDGET_USD: '5',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/markmate',
    },
    async () => {
      await assert.rejects(
        () => budgetService.assertWithinBudgetOrThrow({
          userId: 9,
          projectedCostUsd: 0.2,
          generationType: 'assessment generation',
        }),
        (error) => {
          assert.equal(error.code, 'BUDGET_GUARDRAIL_EXCEEDED');
          assert.equal(error.statusCode, 429);
          assert.equal(error.budget_status?.allowed, false);
          return true;
        }
      );
    }
  );
});

test('budget guardrail can be disabled via environment flag', async (t) => {
  const { module: budgetService, restore } = loadWithMocks(path.join(__dirname, 'budgetGuardrailService.js'), {
    '../database/connection': {
      query: async () => {
        throw new Error('query should not run when guardrail is disabled');
      },
    },
  });
  t.after(restore);

  await withEnv(
    {
      AI_BUDGET_GUARDRAIL_ENABLED: 'false',
      AI_DAILY_BUDGET_USD: '5',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/markmate',
    },
    async () => {
      const status = await budgetService.getUserBudgetStatus({ userId: 11, projectedCostUsd: 1 });
      assert.equal(status.guardrail_enabled, false);
      assert.equal(status.allowed, true);
    }
  );
});
