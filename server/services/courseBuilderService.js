/**
 * Course Builder: builds a whole course (course, modules, an AI lesson and quiz per
 * module, optional summary videos, and student enrolment) from one configuration.
 *
 * It runs as a background job so the lecturer does not need to keep a browser open
 * (a full course takes many minutes). Rather than duplicating the generation logic,
 * the runner calls this app's own API over loopback as the lecturer, so every rule
 * the normal screens enforce (feature flags, budgets, ownership, grade items,
 * enrolment emails) applies unchanged.
 *
 * Progress lives in course_build_jobs.progress_json and is updated after every
 * step, which also makes a job resumable: finished pieces are skipped on a re-run.
 */

const { query } = require('../database/connection');
const { generateToken } = require('../middleware/auth');

const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');
const rowList = (result) => (Array.isArray(result) ? result : (result?.rows || []));

const LIMITS = { modules: 15, sections: 8, questions: 15, students: 300, topicChars: 1500 };
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const running = new Set();

const clampInt = (v, min, max, dflt) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const clip = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// Validate and normalise what the wizard sends. Throws with a user-facing message.
function normalizeConfig(raw) {
  const c = raw || {};
  const existingCourseId = Number(c.existing_course_id) > 0 ? Number(c.existing_course_id) : null;
  const course = {
    name: clip(c.course?.name, 255),
    code: clip(c.course?.code, 50),
    term: clip(c.course?.term, 100),
    description: clip(c.course?.description, 2000),
  };
  if (!existingCourseId && !course.name) throw new Error('A course name is required');

  const modules = (Array.isArray(c.modules) ? c.modules : []).slice(0, LIMITS.modules).map((m) => ({
    name: clip(m?.name, 255),
    lesson_topics: clip(m?.lesson_topics, LIMITS.topicChars),
    quiz_topics: clip(m?.quiz_topics, LIMITS.topicChars),
    lesson: m?.lesson !== false,
    quiz: m?.quiz !== false,
  })).filter((m) => m.name);
  if (modules.length === 0) throw new Error('Add at least one module');
  for (const m of modules) {
    if (m.lesson && !m.lesson_topics) m.lesson_topics = m.name;
    if (m.quiz && !m.quiz_topics) m.quiz_topics = m.lesson_topics || m.name;
  }

  const o = c.options || {};
  const options = {
    level: clip(o.level, 60),
    lesson_sections: clampInt(o.lesson_sections, 2, LIMITS.sections, 4),
    lesson_images: o.lesson_images !== false,
    quiz_questions: clampInt(o.quiz_questions, 3, LIMITS.questions, 5),
    summary_videos: o.summary_videos === true,
  };

  const students = [...new Set((Array.isArray(c.students) ? c.students : [])
    .map((e) => clip(e, 254).toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, LIMITS.students);

  return { existing_course_id: existingCourseId, course, modules, options, students };
}

function freshProgress(config) {
  return {
    phase: 'queued',
    course: { status: existingOr(config), id: config.existing_course_id || null },
    category: { status: config.existing_course_id ? 'skipped' : 'pending' },
    modules: config.modules.map((m) => ({
      name: m.name,
      status: 'pending',
      module_id: null,
      lesson: m.lesson ? 'pending' : 'skipped',
      quiz: m.quiz ? 'pending' : 'skipped',
      error: null,
    })),
    students: { status: config.students.length ? 'pending' : 'skipped', enrolled: 0, invited: 0, emailed: 0, failed: 0 },
  };
}
const existingOr = (config) => (config.existing_course_id ? 'done' : 'pending');

async function saveJob(jobId, fields) {
  const sets = [];
  const vals = [];
  Object.entries(fields).forEach(([k, v], idx) => {
    sets.push(isMySQL() ? `${k} = ?` : `${k} = $${idx + 1}`);
    vals.push(v);
  });
  const n = vals.length;
  if (isMySQL()) await query(`UPDATE course_build_jobs SET ${sets.join(', ')} WHERE id = ?`, [...vals, jobId]);
  else await query(`UPDATE course_build_jobs SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${n + 1}`, [...vals, jobId]);
}

async function getJobRow(jobId) {
  const q = isMySQL()
    ? await query('SELECT * FROM course_build_jobs WHERE id = ?', [jobId])
    : await query('SELECT * FROM course_build_jobs WHERE id = $1', [jobId]);
  return rowList(q)[0] || null;
}

async function getUser(userId) {
  const q = isMySQL()
    ? await query('SELECT id FROM users WHERE id = ? AND is_active = 1', [userId])
    : await query('SELECT id FROM users WHERE id = $1 AND is_active = TRUE', [userId]);
  return rowList(q)[0] || null;
}

function makeApi(userId) {
  const token = generateToken(userId);
  const base = `http://127.0.0.1:${process.env.PORT || 3001}/api`;
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON error page */ }
    if (!res.ok) throw new Error(json?.error || json?.message || `Request failed (${res.status})`);
    return json || {};
  };
}

async function runJob(jobId) {
  if (running.has(jobId)) return;
  running.add(jobId);
  let job;
  try {
    job = await getJobRow(jobId);
    if (!job) return;
    const config = JSON.parse(job.config_json);
    const progress = job.progress_json ? JSON.parse(job.progress_json) : freshProgress(config);
    const persist = async (extra = {}) => saveJob(jobId, { progress_json: JSON.stringify(progress), ...extra });
    if (!(await getUser(job.user_id))) throw new Error('Your account is no longer active');
    const api = makeApi(job.user_id);

    progress.phase = 'running';
    await persist({ status: 'running', error_message: null });

    // 1. Course
    if (progress.course.status !== 'done') {
      progress.course.status = 'running';
      await persist();
      const res = await api('POST', '/courses', {
        name: config.course.name, code: config.course.code || undefined,
        term: config.course.term || undefined, description: config.course.description || undefined,
      });
      progress.course = { status: 'done', id: res.course.id };
      await persist({ course_id: res.course.id });
    } else if (progress.course.id) {
      await persist({ course_id: progress.course.id });
    }
    const courseId = progress.course.id;

    // 2. A grade category so quizzes count toward a weighted grade (they are filed
    //    under the course's first category when published).
    if (progress.category.status === 'pending') {
      try {
        await api('POST', `/courses/${courseId}/grade-categories`, { name: 'Quizzes', weight_percent: 100 });
        progress.category.status = 'done';
      } catch (err) {
        progress.category = { status: 'failed', error: err.message };
      }
      await persist();
    }

    // 3. Modules: create, then lesson, then quiz (so the lesson is listed first).
    for (let i = 0; i < config.modules.length; i += 1) {
      const m = config.modules[i];
      const p = progress.modules[i];
      if (p.status === 'done') continue;
      p.status = 'running';
      p.error = null;
      await persist();

      try {
        if (!p.module_id) {
          const res = await api('POST', '/modules', { name: m.name, course_id: courseId });
          p.module_id = res.module.id;
          await persist();
        }

        if (m.lesson && p.lesson !== 'done') {
          p.lesson = 'running';
          await persist();
          try {
            const gen = await api('POST', '/content/generate', {
              topics: m.lesson_topics, level: config.options.level || undefined,
              num_sections: config.options.lesson_sections, template_id: 'classroom',
              include_diagrams: config.options.lesson_images, include_images: config.options.lesson_images,
              include_mascot: false, include_beautify_text: true,
            });
            await api('POST', '/content/publish', {
              content: gen.content, module_id: p.module_id, summary_video: config.options.summary_videos,
            });
            p.lesson = 'done';
          } catch (err) {
            p.lesson = 'failed';
            p.error = `Lesson: ${err.message}`;
          }
          await persist();
        }

        if (m.quiz && p.quiz !== 'done') {
          p.quiz = 'running';
          await persist();
          try {
            const gen = await api('POST', '/assessments/generate', {
              custom_topics: m.quiz_topics, level: config.options.level || undefined,
              difficulty_level: 'moderate', question_count: config.options.quiz_questions,
              assessment_type: 'quiz', question_types: ['mix'],
            });
            await api('POST', '/assessments/publish', {
              assessment: gen.assessment, rubric_id: gen.saved_rubric_id, module_id: p.module_id,
            });
            p.quiz = 'done';
          } catch (err) {
            p.quiz = 'failed';
            p.error = [p.error, `Quiz: ${err.message}`].filter(Boolean).join(' | ');
          }
          await persist();
        }

        const failed = p.lesson === 'failed' || p.quiz === 'failed';
        p.status = failed ? 'failed' : 'done';
      } catch (err) {
        p.status = 'failed';
        p.error = err.message;
      }
      await persist();
    }

    // 4. Students last, so enrolment emails go out once the course is ready.
    if (progress.students.status === 'pending' && config.students.length) {
      progress.students.status = 'running';
      await persist();
      try {
        const res = await api('POST', `/courses/${courseId}/enrollments`, { emails: config.students });
        const results = res.results || [];
        progress.students = {
          status: 'done',
          enrolled: results.filter((r) => r.success).length,
          invited: results.filter((r) => r.success && r.invited).length,
          emailed: results.filter((r) => r.success && r.email_sent).length,
          failed: results.filter((r) => !r.success).length,
          failed_emails: results.filter((r) => !r.success).map((r) => r.email).slice(0, 20),
        };
      } catch (err) {
        progress.students = { ...progress.students, status: 'failed', error: err.message };
      }
      await persist();
    }

    progress.phase = 'finished';
    const anyFailed = progress.modules.some((mod) => mod.status === 'failed');
    await persist({ status: 'completed', error_message: anyFailed ? 'Some steps failed; you can resume to retry them.' : null });
  } catch (err) {
    console.error(`Course build job ${jobId} failed:`, err.message);
    try { await saveJob(jobId, { status: 'failed', error_message: String(err.message).slice(0, 2000) }); } catch (_) { /* ignore */ }
  } finally {
    running.delete(jobId);
  }
}

async function startJob(userId, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const activeQ = isMySQL()
    ? await query("SELECT id FROM course_build_jobs WHERE user_id = ? AND status IN ('queued','running')", [userId])
    : await query("SELECT id FROM course_build_jobs WHERE user_id = $1 AND status IN ('queued','running')", [userId]);
  if (rowList(activeQ).length > 0) throw new Error('You already have a course build in progress. Wait for it to finish first.');

  const progress = freshProgress(config);
  const configJson = JSON.stringify(config);
  const progressJson = JSON.stringify(progress);
  let id;
  if (isMySQL()) {
    const ins = await query("INSERT INTO course_build_jobs (user_id, status, config_json, progress_json) VALUES (?, 'queued', ?, ?)", [userId, configJson, progressJson]);
    id = ins.insertId;
  } else {
    const ins = await query("INSERT INTO course_build_jobs (user_id, status, config_json, progress_json) VALUES ($1, 'queued', $2, $3) RETURNING id", [userId, configJson, progressJson]);
    id = rowList(ins)[0]?.id;
  }
  runJob(id).catch((err) => console.error('Course build runner error:', err.message));
  return id;
}

async function resumeJob(userId, jobId) {
  const job = await getJobRow(jobId);
  if (!job || Number(job.user_id) !== Number(userId)) throw new Error('Build not found');
  if (job.status === 'running' && running.has(Number(jobId))) throw new Error('This build is already running');
  const progress = job.progress_json ? JSON.parse(job.progress_json) : null;
  if (progress) {
    // Retry anything that failed; keep everything that finished.
    progress.modules.forEach((m) => {
      if (m.status === 'failed') { m.status = 'pending'; if (m.lesson === 'failed') m.lesson = 'pending'; if (m.quiz === 'failed') m.quiz = 'pending'; m.error = null; }
    });
    if (progress.category?.status === 'failed') progress.category.status = 'pending';
    if (progress.students?.status === 'failed') progress.students.status = 'pending';
    await saveJob(jobId, { status: 'queued', progress_json: JSON.stringify(progress), error_message: null });
  }
  runJob(Number(jobId)).catch((err) => console.error('Course build runner error:', err.message));
}

// A restart kills any in-flight runner, so flag those jobs so they can be resumed.
async function markInterruptedJobs() {
  const msg = 'The server restarted while this was running. Resume to continue where it stopped.';
  if (isMySQL()) await query("UPDATE course_build_jobs SET status = 'interrupted', error_message = ? WHERE status IN ('queued','running')", [msg]);
  else await query("UPDATE course_build_jobs SET status = 'interrupted', error_message = $1 WHERE status IN ('queued','running')", [msg]);
}

module.exports = { normalizeConfig, startJob, resumeJob, getJobRow, markInterruptedJobs, LIMITS };
