const { query } = require('../database/connection');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');

function parsePositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function getBudgetGuardrailConfig() {
  const enabledRaw = String(process.env.AI_BUDGET_GUARDRAIL_ENABLED || 'true').trim().toLowerCase();
  const enabled = !(enabledRaw === '0' || enabledRaw === 'false' || enabledRaw === 'off');
  return {
    enabled,
    daily_budget_usd: parsePositiveNumber(process.env.AI_DAILY_BUDGET_USD, 5),
    warning_threshold_percent: parsePositiveNumber(process.env.AI_BUDGET_WARNING_PERCENT, 80),
  };
}

async function getUserSpendLast24hUsd(userId) {
  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId) || numericUserId <= 0) return 0;

  const sql = isMySQL()
    ? `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS spent_usd
       FROM generation_telemetry_events
       WHERE user_id = ?
         AND status = 'success'
         AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`
    : `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS spent_usd
       FROM generation_telemetry_events
       WHERE user_id = $1
         AND status = 'success'
         AND created_at >= NOW() - INTERVAL '24 hours'`;
  const result = await query(sql, [numericUserId]);
  const rows = Array.isArray(result) ? result : (result?.rows || []);
  return Number(rows[0]?.spent_usd || 0);
}

async function getUserBudgetStatus({ userId, projectedCostUsd = 0 } = {}) {
  const config = getBudgetGuardrailConfig();
  const projectedCost = Math.max(0, Number(projectedCostUsd) || 0);
  if (!config.enabled) {
    return {
      guardrail_enabled: false,
      allowed: true,
      daily_budget_usd: config.daily_budget_usd,
      spent_last_24h_usd: 0,
      projected_cost_usd: projectedCost,
      projected_total_usd: projectedCost,
      remaining_usd: config.daily_budget_usd,
      usage_percent: 0,
      warning_threshold_percent: config.warning_threshold_percent,
      warning: false,
    };
  }

  let spentLast24hUsd = 0;
  try {
    spentLast24hUsd = await getUserSpendLast24hUsd(userId);
  } catch (error) {
    // Fail-open if telemetry read is unavailable.
    return {
      guardrail_enabled: true,
      allowed: true,
      daily_budget_usd: config.daily_budget_usd,
      spent_last_24h_usd: 0,
      projected_cost_usd: projectedCost,
      projected_total_usd: projectedCost,
      remaining_usd: config.daily_budget_usd,
      usage_percent: 0,
      warning_threshold_percent: config.warning_threshold_percent,
      warning: false,
      telemetry_unavailable: true,
    };
  }

  const projectedTotalUsd = spentLast24hUsd + projectedCost;
  const remainingUsd = Math.max(0, config.daily_budget_usd - spentLast24hUsd);
  const usagePercent = config.daily_budget_usd > 0
    ? Number(((spentLast24hUsd / config.daily_budget_usd) * 100).toFixed(1))
    : 0;
  const allowed = projectedTotalUsd <= config.daily_budget_usd;
  const warning = usagePercent >= config.warning_threshold_percent;

  return {
    guardrail_enabled: true,
    allowed,
    daily_budget_usd: config.daily_budget_usd,
    spent_last_24h_usd: Number(spentLast24hUsd.toFixed(4)),
    projected_cost_usd: Number(projectedCost.toFixed(4)),
    projected_total_usd: Number(projectedTotalUsd.toFixed(4)),
    remaining_usd: Number(remainingUsd.toFixed(4)),
    usage_percent: usagePercent,
    warning_threshold_percent: config.warning_threshold_percent,
    warning,
  };
}

async function assertWithinBudgetOrThrow({
  userId,
  projectedCostUsd = 0,
  generationType = 'generation',
} = {}) {
  const status = await getUserBudgetStatus({ userId, projectedCostUsd });
  if (status.allowed) return status;

  const error = new Error(
    `Daily AI budget limit reached. Cannot start ${generationType} until budget resets.`
  );
  error.code = 'BUDGET_GUARDRAIL_EXCEEDED';
  error.statusCode = 429;
  error.budget_status = status;
  throw error;
}

module.exports = {
  getBudgetGuardrailConfig,
  getUserSpendLast24hUsd,
  getUserBudgetStatus,
  assertWithinBudgetOrThrow,
};
