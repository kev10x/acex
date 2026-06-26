const { query } = require('../database/connection');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

function toSafeString(value, max = 255) {
  const str = String(value || '').trim();
  if (!str) return null;
  return str.slice(0, max);
}

async function listPromptRegistry({
  user_id = null,
  generation_type = null,
  scope = 'mine',
  limit = 50,
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeGenerationType = toSafeString(generation_type, 60);
  const safeScope = String(scope || 'mine').toLowerCase() === 'all' ? 'all' : 'mine';

  if (isMySQL()) {
    if (safeScope === 'all') {
      const allRows = safeGenerationType
        ? await query(
            `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
             FROM prompt_registry
             WHERE generation_type = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [safeGenerationType, safeLimit]
          )
        : await query(
            `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
             FROM prompt_registry
             ORDER BY created_at DESC
             LIMIT ?`,
            [safeLimit]
          );
      return rowsOf(allRows);
    }

    const mineRows = safeGenerationType
      ? await query(
          `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
           FROM prompt_registry
           WHERE generation_type = ?
             AND (user_id IS NULL OR user_id = ?)
           ORDER BY created_at DESC
           LIMIT ?`,
          [safeGenerationType, Number(user_id) || 0, safeLimit]
        )
      : await query(
          `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
           FROM prompt_registry
           WHERE user_id IS NULL OR user_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          [Number(user_id) || 0, safeLimit]
        );
    return rowsOf(mineRows);
  }

  if (safeScope === 'all') {
    const allRows = safeGenerationType
      ? await query(
          `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
           FROM prompt_registry
           WHERE generation_type = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [safeGenerationType, safeLimit]
        )
      : await query(
          `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
           FROM prompt_registry
           ORDER BY created_at DESC
           LIMIT $1`,
          [safeLimit]
        );
    return rowsOf(allRows);
  }

  const mineRows = safeGenerationType
    ? await query(
        `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
         FROM prompt_registry
         WHERE generation_type = $1
           AND (user_id IS NULL OR user_id = $2)
         ORDER BY created_at DESC
         LIMIT $3`,
        [safeGenerationType, Number(user_id) || 0, safeLimit]
      )
    : await query(
        `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
         FROM prompt_registry
         WHERE user_id IS NULL OR user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [Number(user_id) || 0, safeLimit]
      );
  return rowsOf(mineRows);
}

async function createPromptRegistryVersion({
  user_id = null,
  generation_type,
  prompt_key = 'default',
  prompt_text,
  provider = null,
  model = null,
  temperature = null,
  max_tokens = null,
  notes = null,
  is_active = true,
} = {}) {
  const generationType = toSafeString(generation_type, 60);
  const promptKey = toSafeString(prompt_key, 80) || 'default';
  const promptText = toSafeString(prompt_text, 16000);
  if (!generationType || !promptText) {
    throw new Error('generation_type and prompt_text are required');
  }

  const ownerId = user_id == null ? null : (Number(user_id) || null);

  const maxVersionRow = isMySQL()
    ? rowsOf(await query(
        `SELECT COALESCE(MAX(version), 0) AS max_version
         FROM prompt_registry
         WHERE generation_type = ?
           AND prompt_key = ?
           AND ${ownerId == null ? 'user_id IS NULL' : 'user_id = ?'}`,
        ownerId == null ? [generationType, promptKey] : [generationType, promptKey, ownerId]
      ))[0]
    : rowsOf(await query(
        `SELECT COALESCE(MAX(version), 0) AS max_version
         FROM prompt_registry
         WHERE generation_type = $1
           AND prompt_key = $2
           AND ${ownerId == null ? 'user_id IS NULL' : 'user_id = $3'}`,
        ownerId == null ? [generationType, promptKey] : [generationType, promptKey, ownerId]
      ))[0];
  const nextVersion = Number(maxVersionRow?.max_version || 0) + 1;

  if (is_active) {
    if (isMySQL()) {
      await query(
        `UPDATE prompt_registry
         SET is_active = 0
         WHERE generation_type = ?
           AND prompt_key = ?
           AND ${ownerId == null ? 'user_id IS NULL' : 'user_id = ?'}`,
        ownerId == null ? [generationType, promptKey] : [generationType, promptKey, ownerId]
      );
    } else {
      await query(
        `UPDATE prompt_registry
         SET is_active = FALSE
         WHERE generation_type = $1
           AND prompt_key = $2
           AND ${ownerId == null ? 'user_id IS NULL' : 'user_id = $3'}`,
        ownerId == null ? [generationType, promptKey] : [generationType, promptKey, ownerId]
      );
    }
  }

  if (isMySQL()) {
    const inserted = await query(
      `INSERT INTO prompt_registry (
        user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ownerId,
        generationType,
        promptKey,
        nextVersion,
        promptText,
        toSafeString(provider, 50),
        toSafeString(model, 120),
        temperature == null ? null : Number(temperature),
        max_tokens == null ? null : Number(max_tokens),
        toSafeString(notes, 2000),
        is_active ? 1 : 0,
      ]
    );
    const insertedId = Number(inserted.insertId ?? inserted.lastID ?? 0) || null;
    if (!insertedId) return null;
    const row = rowsOf(await query(
      `SELECT id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at
       FROM prompt_registry
       WHERE id = ?`,
      [insertedId]
    ))[0];
    return row || null;
  }

  const inserted = await query(
    `INSERT INTO prompt_registry (
      user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id, user_id, generation_type, prompt_key, version, prompt_text, provider, model, temperature, max_tokens, notes, is_active, created_at`,
    [
      ownerId,
      generationType,
      promptKey,
      nextVersion,
      promptText,
      toSafeString(provider, 50),
      toSafeString(model, 120),
      temperature == null ? null : Number(temperature),
      max_tokens == null ? null : Number(max_tokens),
      toSafeString(notes, 2000),
      is_active,
    ]
  );
  return rowsOf(inserted)[0] || null;
}

async function resolvePromptRegistryVersion({
  user_id,
  generation_type,
  prompt_key = 'default',
  prompt_text,
  provider = null,
  model = null,
  temperature = null,
  max_tokens = null,
} = {}) {
  const generationType = toSafeString(generation_type, 60);
  const promptKey = toSafeString(prompt_key, 80) || 'default';
  if (!generationType) return null;
  const ownerId = Number(user_id) || null;

  const activeRow = isMySQL()
    ? rowsOf(await query(
        `SELECT id, user_id, generation_type, prompt_key, version, provider, model, temperature, max_tokens
         FROM prompt_registry
         WHERE generation_type = ?
           AND prompt_key = ?
           AND is_active = 1
           AND (user_id = ? OR user_id IS NULL)
         ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, version DESC
         LIMIT 1`,
        [generationType, promptKey, ownerId, ownerId]
      ))[0]
    : rowsOf(await query(
        `SELECT id, user_id, generation_type, prompt_key, version, provider, model, temperature, max_tokens
         FROM prompt_registry
         WHERE generation_type = $1
           AND prompt_key = $2
           AND is_active = TRUE
           AND (user_id = $3 OR user_id IS NULL)
         ORDER BY CASE WHEN user_id = $3 THEN 0 ELSE 1 END, version DESC
         LIMIT 1`,
        [generationType, promptKey, ownerId]
      ))[0];

  if (activeRow) {
    return {
      prompt_registry_id: Number(activeRow.id),
      generation_type: activeRow.generation_type,
      prompt_key: activeRow.prompt_key,
      prompt_version: Number(activeRow.version || 1),
      provider: activeRow.provider || null,
      model: activeRow.model || null,
      temperature: activeRow.temperature == null ? null : Number(activeRow.temperature),
      max_tokens: activeRow.max_tokens == null ? null : Number(activeRow.max_tokens),
      source: activeRow.user_id == null ? 'global' : 'user',
    };
  }

  if (!prompt_text) return null;
  const created = await createPromptRegistryVersion({
    user_id: ownerId,
    generation_type: generationType,
    prompt_key: promptKey,
    prompt_text,
    provider,
    model,
    temperature,
    max_tokens,
    notes: 'Auto-registered baseline prompt',
    is_active: true,
  });
  if (!created) return null;
  return {
    prompt_registry_id: Number(created.id),
    generation_type: created.generation_type,
    prompt_key: created.prompt_key,
    prompt_version: Number(created.version || 1),
    provider: created.provider || null,
    model: created.model || null,
    temperature: created.temperature == null ? null : Number(created.temperature),
    max_tokens: created.max_tokens == null ? null : Number(created.max_tokens),
    source: created.user_id == null ? 'global' : 'user',
  };
}

module.exports = {
  listPromptRegistry,
  createPromptRegistryVersion,
  resolvePromptRegistryVersion,
};
