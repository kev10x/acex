const express = require('express');
const axios = require('axios');
const { query } = require('../database/connection');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const isMy = () => (process.env.DATABASE_URL || '').startsWith('mysql');

// ── Auto-migration ────────────────────────────────────────────
;(async () => {
  try {
    if (isMy()) {
      await query(`
        CREATE TABLE IF NOT EXISTS moodle_connections (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL UNIQUE,
          moodle_url VARCHAR(500) NOT NULL,
          moodle_token VARCHAR(500) NOT NULL,
          site_name VARCHAR(255) DEFAULT NULL,
          moodle_user_id INT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
    } else {
      await query(`
        CREATE TABLE IF NOT EXISTS moodle_connections (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          moodle_url VARCHAR(500) NOT NULL,
          moodle_token VARCHAR(500) NOT NULL,
          site_name VARCHAR(255),
          moodle_user_id INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
  } catch (e) {
    console.warn('[moodle] migration warning:', e.message);
  }
})();

// ── Helpers ───────────────────────────────────────────────────

function rows(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

/**
 * Call a Moodle web service function via REST.
 * Handles nested/array params in Moodle's bracket notation.
 */
async function callMoodle(baseUrl, token, wsfunction, params = {}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/webservice/rest/server.php`;

  const flat = {};
  function flatten(obj, prefix) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) {
        v.forEach((item, i) => {
          if (item !== null && typeof item === 'object') {
            flatten(item, `${key}[${i}]`);
          } else {
            flat[`${key}[${i}]`] = String(item ?? '');
          }
        });
      } else if (v !== null && typeof v === 'object') {
        flatten(v, key);
      } else {
        flat[key] = String(v ?? '');
      }
    }
  }
  flatten(params, '');

  const body = new URLSearchParams({
    wstoken: token,
    wsfunction,
    moodlewsrestformat: 'json',
    ...flat,
  }).toString();

  const { data } = await axios.post(endpoint, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });

  if (data && (data.exception || data.errorcode)) {
    throw new Error(data.message || `Moodle error: ${data.errorcode || data.exception}`);
  }
  return data;
}

/** Get the saved Moodle connection for the current user (throws if none). */
async function getConnection(userId) {
  const q = isMy()
    ? await query('SELECT moodle_url, moodle_token, site_name, moodle_user_id FROM moodle_connections WHERE user_id = ?', [userId])
    : await query('SELECT moodle_url, moodle_token, site_name, moodle_user_id FROM moodle_connections WHERE user_id = $1', [userId]);
  const row = rows(q)[0];
  if (!row) throw Object.assign(new Error('No Moodle connection configured'), { status: 400 });
  return row;
}

// ── Moodle XML → Assessment parser ────────────────────────────

function stripTags(str) {
  return String(str || '').replace(/<[^>]+>/g, '').trim();
}
function extractCdata(str) {
  const m = String(str || '').match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : str;
}
function extractText(block) {
  const m = String(block || '').match(/<text>([\s\S]*?)<\/text>/);
  if (!m) return '';
  return stripTags(extractCdata(m[1]));
}

function parseMoodleXML(xml) {
  const questionRegex = /<question\s+type="([^"]+)">([\s\S]*?)<\/question>/g;
  const questions = [];
  let num = 1;
  let match;

  while ((match = questionRegex.exec(xml)) !== null) {
    const type = match[1];
    const body = match[2];
    if (type === 'category') continue;

    const qtBlock = body.match(/<questiontext[\s\S]*?>([\s\S]*?)<\/questiontext>/);
    const questionText = qtBlock ? extractText(qtBlock[1]) : '';
    if (!questionText) continue;

    const q = { number: num++, type: 'essay', question: questionText, points: 1 };

    if (type === 'multichoice' || type === 'truefalse') {
      q.type = 'multiple_choice';
      const options = [];
      let correctAnswer = '';
      const ansRegex = /<answer\s[^>]*fraction="([^"]*)"[^>]*>([\s\S]*?)<\/answer>/g;
      let am;
      while ((am = ansRegex.exec(body)) !== null) {
        const fraction = parseFloat(am[1]);
        const text = extractText(am[2]);
        if (text) {
          options.push(text);
          if (fraction > 0 && !correctAnswer) correctAnswer = text;
        }
      }
      q.options = options;
      q.correct_answer = correctAnswer || options[0] || '';
    } else if (type === 'shortanswer' || type === 'numerical') {
      q.type = 'short_answer';
      const ansBlock = body.match(/<answer\s[^>]*fraction="100"[^>]*>([\s\S]*?)<\/answer>/);
      if (ansBlock) q.correct_answer = extractText(ansBlock[1]);
    } else if (type === 'match') {
      q.type = 'mix_and_match';
      const leftCol = [], rightCol = [], pairings = [];
      const subRegex = /<subquestion[^>]*>([\s\S]*?)<\/subquestion>/g;
      let sm;
      let idx = 0;
      while ((sm = subRegex.exec(body)) !== null) {
        const sub = sm[1];
        const textMatch = sub.match(/<text>([\s\S]*?)<\/text>/);
        const ansBlock = sub.match(/<answer[^>]*>([\s\S]*?)<\/answer>/);
        const left = textMatch ? stripTags(extractCdata(textMatch[1])) : '';
        const right = ansBlock ? extractText(ansBlock[1]) : '';
        if (left || right) {
          leftCol.push(left);
          rightCol.push(right);
          pairings.push({ left_index: idx, right_index: idx });
          idx++;
        }
      }
      q.left_column = leftCol;
      q.right_column = rightCol;
      q.correct_pairings = pairings;
    }

    questions.push(q);
  }

  // Extract title from category text
  const catMatch = xml.match(/<category>[\s\S]*?<text>([\s\S]*?)<\/text>/);
  const rawCat = catMatch ? catMatch[1].replace(/^\$\$course\$\/top\//, '') : '';
  const title = stripTags(rawCat) || 'Imported from Moodle';

  return {
    title,
    topic: title,
    difficulty_level: 'moderate',
    assessment_type: 'quiz',
    instructions: 'Complete all questions.',
    questions,
    total_points: questions.reduce((s, q) => s + (q.points || 1), 0),
    estimated_time: `${Math.max(5, questions.length * 2)} minutes`,
    rubric_alignment: 'Imported from Moodle question bank',
  };
}

// ── Routes ────────────────────────────────────────────────────

/** GET /moodle/settings — return masked connection info */
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const q = isMy()
      ? await query('SELECT moodle_url, site_name, moodle_user_id FROM moodle_connections WHERE user_id = ?', [req.user.id])
      : await query('SELECT moodle_url, site_name, moodle_user_id FROM moodle_connections WHERE user_id = $1', [req.user.id]);
    const row = rows(q)[0];
    if (!row) return res.json({ success: true, connection: null });
    res.json({ success: true, connection: { moodle_url: row.moodle_url, site_name: row.site_name, moodle_user_id: row.moodle_user_id } });
  } catch (err) {
    console.error('moodle/settings GET:', err);
    res.status(500).json({ error: 'Failed to load Moodle settings' });
  }
});

/** POST /moodle/settings — save + verify a Moodle connection */
router.post('/settings', requireAuth, async (req, res) => {
  try {
    const moodleUrl = String(req.body?.moodle_url || '').trim().replace(/\/+$/, '');
    const moodleToken = String(req.body?.moodle_token || '').trim();
    if (!moodleUrl || !moodleToken) return res.status(400).json({ error: 'moodle_url and moodle_token are required' });

    // Verify the connection
    let siteInfo;
    try {
      siteInfo = await callMoodle(moodleUrl, moodleToken, 'core_webservice_get_site_info');
    } catch (e) {
      return res.status(400).json({ error: `Could not connect to Moodle: ${e.message}` });
    }

    const siteName = siteInfo.sitename || moodleUrl;
    const moodleUserId = siteInfo.userid || null;

    if (isMy()) {
      await query(
        `INSERT INTO moodle_connections (user_id, moodle_url, moodle_token, site_name, moodle_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE moodle_url = VALUES(moodle_url), moodle_token = VALUES(moodle_token),
           site_name = VALUES(site_name), moodle_user_id = VALUES(moodle_user_id)`,
        [req.user.id, moodleUrl, moodleToken, siteName, moodleUserId]
      );
    } else {
      await query(
        `INSERT INTO moodle_connections (user_id, moodle_url, moodle_token, site_name, moodle_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE SET moodle_url = EXCLUDED.moodle_url,
           moodle_token = EXCLUDED.moodle_token, site_name = EXCLUDED.site_name,
           moodle_user_id = EXCLUDED.moodle_user_id`,
        [req.user.id, moodleUrl, moodleToken, siteName, moodleUserId]
      );
    }

    res.json({ success: true, site_name: siteName, moodle_url: moodleUrl, moodle_user_id: moodleUserId });
  } catch (err) {
    console.error('moodle/settings POST:', err);
    res.status(500).json({ error: 'Failed to save Moodle settings' });
  }
});

/** DELETE /moodle/settings — disconnect */
router.delete('/settings', requireAuth, async (req, res) => {
  try {
    if (isMy()) {
      await query('DELETE FROM moodle_connections WHERE user_id = ?', [req.user.id]);
    } else {
      await query('DELETE FROM moodle_connections WHERE user_id = $1', [req.user.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('moodle/settings DELETE:', err);
    res.status(500).json({ error: 'Failed to remove Moodle connection' });
  }
});

/** GET /moodle/courses — list courses the token user is enrolled in */
router.get('/courses', requireAuth, async (req, res) => {
  try {
    const conn = await getConnection(req.user.id);
    const courses = await callMoodle(conn.moodle_url, conn.moodle_token, 'core_enrol_get_users_courses', {
      userid: conn.moodle_user_id,
    });
    const list = Array.isArray(courses) ? courses.map((c) => ({
      id: c.id,
      fullname: c.fullname,
      shortname: c.shortname,
      summary: c.summary ? stripTags(c.summary).slice(0, 200) : '',
    })) : [];
    res.json({ success: true, courses: list });
  } catch (err) {
    console.error('moodle/courses:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to fetch courses' });
  }
});

/** GET /moodle/courses/:courseId/assignments */
router.get('/courses/:courseId/assignments', requireAuth, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const conn = await getConnection(req.user.id);
    const data = await callMoodle(conn.moodle_url, conn.moodle_token, 'mod_assign_get_assignments', {
      courseids: [courseId],
    });
    const courseData = Array.isArray(data.courses) ? data.courses[0] : null;
    const assignments = (courseData?.assignments || []).map((a) => ({
      id: a.id,
      cmid: a.cmid,
      name: a.name,
      duedate: a.duedate,
      nosubmissions: a.nosubmissions,
    }));
    res.json({ success: true, assignments });
  } catch (err) {
    console.error('moodle/assignments:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to fetch assignments' });
  }
});

/** GET /moodle/courses/:courseId/quizzes */
router.get('/courses/:courseId/quizzes', requireAuth, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const conn = await getConnection(req.user.id);
    const data = await callMoodle(conn.moodle_url, conn.moodle_token, 'mod_quiz_get_quizzes_by_courses', {
      courseids: [courseId],
    });
    const quizzes = (Array.isArray(data.quizzes) ? data.quizzes : []).map((q) => ({
      id: q.id,
      coursemodule: q.coursemodule,
      name: q.name,
      intro: q.intro ? stripTags(q.intro).slice(0, 200) : '',
      timelimit: q.timelimit,
      sumgrades: q.sumgrades,
    }));
    res.json({ success: true, quizzes });
  } catch (err) {
    console.error('moodle/quizzes:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to fetch quizzes' });
  }
});

/** GET /moodle/courses/:courseId/users — enrolled users (for grade mapping) */
router.get('/courses/:courseId/users', requireAuth, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const conn = await getConnection(req.user.id);
    const users = await callMoodle(conn.moodle_url, conn.moodle_token, 'core_enrol_get_enrolled_users', {
      courseid: courseId,
    });
    const list = (Array.isArray(users) ? users : []).map((u) => ({
      id: u.id,
      fullname: u.fullname,
      email: u.email,
      username: u.username,
    }));
    res.json({ success: true, users: list });
  } catch (err) {
    console.error('moodle/users:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to fetch enrolled users' });
  }
});

/**
 * POST /moodle/grades/push
 * Body: { assignment_cmid, grades: [{ moodle_user_id, grade, feedback }] }
 * Pushes grades to Moodle via core_grades_update_grades.
 */
router.post('/grades/push', requireAuth, async (req, res) => {
  try {
    const conn = await getConnection(req.user.id);
    const { assignment_cmid, grades } = req.body || {};

    if (!assignment_cmid || !Array.isArray(grades) || grades.length === 0) {
      return res.status(400).json({ error: 'assignment_cmid and grades[] are required' });
    }

    const gradePayload = grades.map((g, i) => ({
      studentid: g.moodle_user_id,
      grade: String(g.grade ?? 0),
      str_feedback: g.feedback || '',
    }));

    await callMoodle(conn.moodle_url, conn.moodle_token, 'core_grades_update_grades', {
      component: 'mod_assign',
      activityid: assignment_cmid,
      itemnumber: 0,
      grades: gradePayload,
    });

    res.json({ success: true, pushed: grades.length });
  } catch (err) {
    console.error('moodle/grades/push:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to push grades' });
  }
});

/**
 * POST /moodle/import/xml
 * Body: { xml: "<quiz>...</quiz>" }
 * Parses Moodle question XML and saves as an assessment history entry.
 */
router.post('/import/xml', requireAuth, async (req, res) => {
  try {
    const xml = String(req.body?.xml || '').trim();
    if (!xml) return res.status(400).json({ error: 'xml is required' });
    if (!xml.includes('<quiz>') && !xml.includes('<quiz ')) {
      return res.status(400).json({ error: 'Does not appear to be a valid Moodle quiz XML file' });
    }

    const assessment = parseMoodleXML(xml);

    if (assessment.questions.length === 0) {
      return res.status(400).json({ error: 'No questions could be parsed from the XML' });
    }

    // Save to assessment history so it appears in the Assessment Generator
    let historyRow;
    const title = assessment.title.slice(0, 255);

    if (isMy()) {
      const ins = await query(
        `INSERT INTO assessment_generation_history (user_id, title, generated_assessment_json, input_json)
         VALUES (?, ?, ?, NULL)`,
        [req.user.id, title, JSON.stringify(assessment)]
      );
      const id = ins.insertId ?? ins.lastID;
      const r = await query('SELECT id, title, generated_assessment_json, created_at FROM assessment_generation_history WHERE id = ?', [id]);
      historyRow = rows(r)[0];
    } else {
      const r = await query(
        `INSERT INTO assessment_generation_history (user_id, title, generated_assessment_json)
         VALUES ($1, $2, $3)
         RETURNING id, title, generated_assessment_json, created_at`,
        [req.user.id, title, JSON.stringify(assessment)]
      );
      historyRow = rows(r)[0];
    }

    res.json({
      success: true,
      question_count: assessment.questions.length,
      title: assessment.title,
      history_id: historyRow?.id,
    });
  } catch (err) {
    console.error('moodle/import/xml:', err);
    res.status(500).json({ error: err.message || 'Failed to import XML' });
  }
});

module.exports = router;
