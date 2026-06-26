const crypto = require('crypto');
const path = require('path');
const { query } = require('../database/connection');
const contentService = require('./contentService');

const POLL_INTERVAL_MS = Math.max(5000, Number(process.env.CONTENT_PLANNER_POLL_INTERVAL_MS || 15000));
const CLAIM_LIMIT = Math.max(1, Number(process.env.CONTENT_PLANNER_CLAIM_LIMIT || 5));
const PLANNER_CONCURRENCY = Math.max(1, Number(process.env.CONTENT_PLANNER_CONCURRENCY || 1));
const MAX_CONTENT_SECTIONS = Math.max(20, Number.parseInt(process.env.CONTENT_MAX_SECTIONS || '120', 10) || 120);

let plannerTimer = null;
let cycleInProgress = false;

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const TEMPLATE_DIR = path.join(__dirname, '../uploads/content-templates');

function generateCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8);
}

async function updatePlannerJobStatus(jobId, status, extra = {}) {
  const keys = Object.keys(extra);
  if (keys.length === 0) {
    if (isMySQL()) {
      await query('UPDATE content_planner_jobs SET status = ?, updated_at = NOW() WHERE id = ?', [status, jobId]);
    } else {
      await query('UPDATE content_planner_jobs SET status = $1, updated_at = NOW() WHERE id = $2', [status, jobId]);
    }
    return;
  }

  if (isMySQL()) {
    const sets = ['status = ?', 'updated_at = NOW()'];
    const values = [status];
    keys.forEach((k) => {
      sets.push(`${k} = ?`);
      values.push(extra[k]);
    });
    values.push(jobId);
    await query(`UPDATE content_planner_jobs SET ${sets.join(', ')} WHERE id = ?`, values);
  } else {
    const sets = ['status = $1', 'updated_at = NOW()'];
    const values = [status];
    let idx = 2;
    keys.forEach((k) => {
      sets.push(`${k} = $${idx++}`);
      values.push(extra[k]);
    });
    values.push(jobId);
    await query(`UPDATE content_planner_jobs SET ${sets.join(', ')} WHERE id = $${idx}`, values);
  }
}

async function publishGeneratedContent(userId, rubricId, content) {
  let code = null;
  for (let i = 0; i < 8; i++) {
    const candidate = generateCode();
    try {
      if (isMySQL()) {
        await query(
          'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES (?, ?, ?, ?, ?)',
          [candidate, content.title, JSON.stringify(content), rubricId || null, userId]
        );
      } else {
        await query(
          'INSERT INTO published_content (code, title, content_json, rubric_id, user_id) VALUES ($1, $2, $3, $4, $5)',
          [candidate, content.title, JSON.stringify(content), rubricId || null, userId]
        );
      }
      code = candidate;
      break;
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY' || error.message?.includes('unique') || error.code === '23505') {
        continue;
      }
      throw error;
    }
  }

  if (!code) {
    throw new Error('Failed to generate unique published code for planner job');
  }

  const selectResult = isMySQL()
    ? await query('SELECT id FROM published_content WHERE code = ?', [code])
    : await query('SELECT id FROM published_content WHERE code = $1', [code]);
  const row = rowsOf(selectResult)[0];
  if (!row?.id) {
    throw new Error('Failed to load published content id for planner job');
  }

  return { code, id: row.id };
}

async function processPlannerJob(job) {
  await updatePlannerJobStatus(job.id, 'processing', { error_message: null });

  const numSections = Math.min(Math.max(parseInt(String(job.num_sections || 5), 10) || 5, 1), MAX_CONTENT_SECTIONS);
  let rubricContext = String(job.rubric_context || '');
  if (!rubricContext && job.rubric_id) {
    const rubricResult = isMySQL()
      ? await query('SELECT name, criteria FROM rubrics WHERE id = ?', [job.rubric_id])
      : await query('SELECT name, criteria FROM rubrics WHERE id = $1', [job.rubric_id]);
    const rubric = rowsOf(rubricResult)[0];
    if (rubric) {
      let criteria = rubric.criteria;
      try {
        criteria = typeof rubric.criteria === 'string' ? JSON.parse(rubric.criteria) : rubric.criteria;
      } catch (_) {}
      const criteriaNames = Array.isArray(criteria)
        ? criteria.map((c) => c?.name).filter(Boolean).join(', ')
        : '';
      rubricContext = `Rubric: ${rubric.name || 'Rubric'}. Criteria: ${criteriaNames}`;
    }
  }

  const includeDiagrams = job.include_diagrams !== false && job.include_diagrams !== 0;
  const includeImages = job.include_images !== false && job.include_images !== 0;
  const includeMascot = job.include_mascot === true || job.include_mascot === 1;
  const includeBeautifyText = job.include_beautify_text !== false && job.include_beautify_text !== 0;
  let templateContext = '';
  const uploadedTemplateMatch = String(job.template_id || '').match(/^uploaded:(\d+)$/i);
  if (uploadedTemplateMatch) {
    const templateId = Number(uploadedTemplateMatch[1]);
    const templateResult = isMySQL()
      ? await query('SELECT file_name FROM uploaded_ppt_templates WHERE id = ? AND user_id = ?', [templateId, job.user_id])
      : await query('SELECT file_name FROM uploaded_ppt_templates WHERE id = $1 AND user_id = $2', [templateId, job.user_id]);
    const uploadedTemplate = rowsOf(templateResult)[0];
    if (uploadedTemplate?.file_name) {
      try {
        templateContext = await contentService.summarizePptxTemplateForGeneration(path.join(TEMPLATE_DIR, uploadedTemplate.file_name));
      } catch (templateError) {
        console.warn('Planner template generation context extraction failed:', templateError?.message || templateError);
      }
    }
  }

  let generated = await contentService.generateContentWithAIResilient({
    topics: String(job.topics || '').trim(),
    level: String(job.level || ''),
    numSections,
    rubricContext,
    templateId: String(job.template_id || 'classroom'),
    templateContext,
    includeDiagrams,
    includeImages,
    includeMascot,
  });
  if (includeBeautifyText) {
    generated = await contentService.beautifyContentTextWithAI(generated, {
      level: String(job.level || ''),
    });
  }
  if (includeDiagrams || includeImages || includeMascot) {
    generated = await contentService.enrichContentWithImages(generated);
  }
  const normalizedContent = contentService.normalizeGeneratedContent(generated, job.template_id || 'classroom', {
    includeDiagrams,
    includeImages,
    includeMascot,
  });
  const published = await publishGeneratedContent(job.user_id, job.rubric_id, normalizedContent);

  await updatePlannerJobStatus(job.id, 'completed', {
    generated_content_json: JSON.stringify(normalizedContent),
    published_content_id: published.id,
    published_code: published.code,
  });
}

async function claimDueJobs() {
  const selectDue = isMySQL()
    ? await query(
        `SELECT * FROM content_planner_jobs
         WHERE status = ? AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC, created_at ASC
         LIMIT ?`,
        ['scheduled', CLAIM_LIMIT]
      )
    : await query(
        `SELECT * FROM content_planner_jobs
         WHERE status = $1 AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC, created_at ASC
         LIMIT $2`,
        ['scheduled', CLAIM_LIMIT]
      );

  return rowsOf(selectDue);
}

async function runContentPlannerCycle() {
  if (cycleInProgress) {
    return;
  }

  cycleInProgress = true;
  try {
    const jobs = await claimDueJobs();
    if (PLANNER_CONCURRENCY <= 1) {
      for (const job of jobs) {
        try {
          await processPlannerJob(job);
        } catch (error) {
          await updatePlannerJobStatus(job.id, 'failed', {
            error_message: String(error?.message || 'Planner job failed').slice(0, 2000),
          });
        }
      }
    } else {
      const queue = jobs.slice();
      const workers = Array.from({ length: Math.min(PLANNER_CONCURRENCY, queue.length) }, () => (async () => {
        while (queue.length > 0) {
          const job = queue.shift();
          if (!job) break;
          try {
            await processPlannerJob(job);
          } catch (error) {
            await updatePlannerJobStatus(job.id, 'failed', {
              error_message: String(error?.message || 'Planner job failed').slice(0, 2000),
            });
          }
        }
      })());
      await Promise.all(workers);
    }
  } finally {
    cycleInProgress = false;
  }
}

function startContentPlannerPolling() {
  if (plannerTimer) {
    return;
  }

  plannerTimer = setInterval(() => {
    runContentPlannerCycle().catch((error) => {
      console.error('Content planner polling tick failed:', error);
    });
  }, POLL_INTERVAL_MS);

  runContentPlannerCycle().catch((error) => {
    console.error('Initial content planner polling run failed:', error);
  });
}

module.exports = {
  startContentPlannerPolling,
  runContentPlannerCycle,
};
