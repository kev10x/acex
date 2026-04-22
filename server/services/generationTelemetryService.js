const { query } = require('../database/connection');
const aiConfig = require('../config/ai-config');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');

function normalizeGenerationUsageMetrics(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens));
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : null,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : null,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : null,
  };
}

function estimateGenerationUsageCost(provider, usage) {
  const normalized = normalizeGenerationUsageMetrics(usage);
  if (!normalized) return null;
  try {
    return aiConfig.estimateCost(
      normalized.prompt_tokens || 0,
      normalized.completion_tokens || 0,
      provider || 'openai'
    );
  } catch (_) {
    return null;
  }
}

function inferGenerationErrorType(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('parse') || message.includes('json')) return 'parse_error';
  if (message.includes('timeout')) return 'timeout';
  if (message.includes('rate limit') || message.includes('429')) return 'rate_limit';
  if (message.includes('permission') || message.includes('forbidden') || message.includes('unauthorized')) return 'permission';
  if (message.includes('not found')) return 'not_found';
  if (message.includes('validation') || message.includes('required') || message.includes('invalid')) return 'validation';
  return 'runtime';
}

function logGenerationTelemetry(payload) {
  try {
    console.log('[telemetry][generation]', JSON.stringify(payload));
  } catch (_) {
    console.log('[telemetry][generation]', payload);
  }
}

async function persistGenerationTelemetryEvent(payload) {
  const toNullableNumber = (value) => {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  const usage = normalizeGenerationUsageMetrics(payload?.usage);
  const params = [
    Number(payload?.user_id) || null,
    String(payload?.generation_type || 'unknown').slice(0, 40),
    String(payload?.status || 'unknown').slice(0, 20),
    String(payload?.provider || '').trim() || null,
    String(payload?.model || '').trim() || null,
    Math.max(0, Number(payload?.duration_ms || 0) || 0),
    usage?.prompt_tokens ?? null,
    usage?.completion_tokens ?? null,
    usage?.total_tokens ?? null,
    toNullableNumber(payload?.estimated_cost_usd),
    String(payload?.error_type || '').trim().slice(0, 80) || null,
    payload?.error_message ? String(payload.error_message).slice(0, 2000) : null,
    payload?.metadata ? JSON.stringify(payload.metadata) : null,
  ];

  if (isMySQL()) {
    await query(
      `INSERT INTO generation_telemetry_events (
        user_id, generation_type, status, provider, model, duration_ms,
        prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
        error_type, error_message, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
    return;
  }

  await query(
    `INSERT INTO generation_telemetry_events (
      user_id, generation_type, status, provider, model, duration_ms,
      prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd,
      error_type, error_message, metadata_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    params
  );
}

module.exports = {
  normalizeGenerationUsageMetrics,
  estimateGenerationUsageCost,
  inferGenerationErrorType,
  logGenerationTelemetry,
  persistGenerationTelemetryEvent,
};
