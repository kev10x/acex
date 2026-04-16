const express = require('express');
const { query } = require('../database/connection');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const isMySQL = () => (process.env.DATABASE_URL || '').startsWith('mysql');

function rowList(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

function groupModules(modules, items, students) {
  const grouped = new Map();
  modules.forEach((m) => grouped.set(m.id, { ...m, items: [], students: [] }));
  items.forEach((i) => {
    const mod = grouped.get(i.module_id);
    if (!mod) return;
    mod.items.push({
      id: i.id,
      module_id: i.module_id,
      item_type: i.item_type,
      item_id: i.item_id,
      title: i.snapshot_title || `${i.item_type} ${i.item_id}`,
      code: i.snapshot_code || '',
      position: i.position ?? 0,
      created_at: i.created_at,
    });
  });
  students.forEach((s) => {
    const mod = grouped.get(s.module_id);
    if (!mod) return;
    mod.students.push({
      id: s.student_user_id,
      name: s.name || s.email,
      email: s.email,
      created_at: s.created_at,
    });
  });
  for (const mod of grouped.values()) {
    mod.items.sort((a, b) => (a.position - b.position) || (a.id - b.id));
    mod.students.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }
  return Array.from(grouped.values());
}

async function moduleBelongsToUser(moduleId, userId) {
  const moduleQ = isMySQL()
    ? await query('SELECT id, user_id FROM modules WHERE id = ? AND user_id = ?', [moduleId, userId])
    : await query('SELECT id, user_id FROM modules WHERE id = $1 AND user_id = $2', [moduleId, userId]);
  return rowList(moduleQ)[0] || null;
}

async function getEligibleStudent(studentUserId, requester) {
  if (requester.organisation_id) {
    const q = isMySQL()
      ? await query(
          `SELECT id, name, email, organisation_id
           FROM users
           WHERE id = ? AND is_active = 1
             AND LOWER(role) = 'student'
             AND organisation_id = ?`,
          [studentUserId, requester.organisation_id]
        )
      : await query(
          `SELECT id, name, email, organisation_id
           FROM users
           WHERE id = $1 AND is_active = TRUE
             AND LOWER(role) = 'student'
             AND organisation_id = $2`,
          [studentUserId, requester.organisation_id]
        );
    return rowList(q)[0] || null;
  }

  const q = isMySQL()
    ? await query(
        `SELECT id, name, email, organisation_id
         FROM users
         WHERE id = ? AND is_active = 1
           AND LOWER(role) = 'student'`,
        [studentUserId]
      )
    : await query(
        `SELECT id, name, email, organisation_id
         FROM users
         WHERE id = $1 AND is_active = TRUE
           AND LOWER(role) = 'student'`,
        [studentUserId]
      );
  return rowList(q)[0] || null;
}

async function getAssessmentMeta(itemId, userId) {
  const q = isMySQL()
    ? await query(
        'SELECT code, assessment_json FROM published_assessments WHERE id = ? AND user_id = ?',
        [itemId, userId]
      )
    : await query(
        'SELECT code, assessment_json FROM published_assessments WHERE id = $1 AND user_id = $2',
        [itemId, userId]
      );
  const row = rowList(q)[0];
  if (!row) return null;
  let title = '';
  try {
    const parsed = typeof row.assessment_json === 'string' ? JSON.parse(row.assessment_json) : row.assessment_json;
    title = parsed?.title || '';
  } catch (_) {}
  return { title: title || `Assessment ${itemId}`, code: row.code || '' };
}

async function getContentMeta(itemId, userId) {
  const q = isMySQL()
    ? await query('SELECT code, title FROM published_content WHERE id = ? AND user_id = ?', [itemId, userId])
    : await query('SELECT code, title FROM published_content WHERE id = $1 AND user_id = $2', [itemId, userId]);
  const row = rowList(q)[0];
  if (!row) return null;
  return { title: row.title || `Content ${itemId}`, code: row.code || '' };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const modulesQ = isMySQL()
      ? await query('SELECT id, name, created_at FROM modules WHERE user_id = ? ORDER BY created_at DESC', [req.user.id])
      : await query('SELECT id, name, created_at FROM modules WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    const modules = rowList(modulesQ);
    if (modules.length === 0) return res.json({ success: true, modules: [] });

    const itemsQ = isMySQL()
      ? await query(
          `SELECT mi.id, mi.module_id, mi.item_type, mi.item_id, mi.snapshot_title, mi.snapshot_code, mi.position, mi.created_at
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           WHERE m.user_id = ?
           ORDER BY mi.position ASC, mi.created_at ASC`,
          [req.user.id]
        )
      : await query(
          `SELECT mi.id, mi.module_id, mi.item_type, mi.item_id, mi.snapshot_title, mi.snapshot_code, mi.position, mi.created_at
           FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           WHERE m.user_id = $1
           ORDER BY mi.position ASC, mi.created_at ASC`,
          [req.user.id]
        );
    const items = rowList(itemsQ);
    const studentsQ = isMySQL()
      ? await query(
          `SELECT ms.module_id, ms.student_user_id, ms.created_at, u.name, u.email
           FROM module_students ms
           INNER JOIN modules m ON m.id = ms.module_id
           INNER JOIN users u ON u.id = ms.student_user_id
           WHERE m.user_id = ?`,
          [req.user.id]
        )
      : await query(
          `SELECT ms.module_id, ms.student_user_id, ms.created_at, u.name, u.email
           FROM module_students ms
           INNER JOIN modules m ON m.id = ms.module_id
           INNER JOIN users u ON u.id = ms.student_user_id
           WHERE m.user_id = $1`,
          [req.user.id]
        );
    const students = rowList(studentsQ);
    res.json({ success: true, modules: groupModules(modules, items, students) });
  } catch (error) {
    console.error('List modules error:', error);
    res.status(500).json({ error: 'Failed to list modules' });
  }
});

router.get('/students/available', requireAuth, async (req, res) => {
  try {
    const rows = req.user.organisation_id
      ? rowList(
          isMySQL()
            ? await query(
                `SELECT id, name, email
                 FROM users
                 WHERE is_active = 1
                   AND LOWER(role) = 'student'
                   AND organisation_id = ?
                 ORDER BY name ASC, email ASC`,
                [req.user.organisation_id]
              )
            : await query(
                `SELECT id, name, email
                 FROM users
                 WHERE is_active = TRUE
                   AND LOWER(role) = 'student'
                   AND organisation_id = $1
                 ORDER BY name ASC, email ASC`,
                [req.user.organisation_id]
              )
        )
      : rowList(
          isMySQL()
            ? await query(
                `SELECT id, name, email
                 FROM users
                 WHERE is_active = 1
                   AND LOWER(role) = 'student'
                 ORDER BY name ASC, email ASC
                 LIMIT 200`,
                []
              )
            : await query(
                `SELECT id, name, email
                 FROM users
                 WHERE is_active = TRUE
                   AND LOWER(role) = 'student'
                 ORDER BY name ASC, email ASC
                 LIMIT 200`,
                []
              )
        );
    res.json({ success: true, students: rows });
  } catch (error) {
    console.error('List available students error:', error);
    res.status(500).json({ error: 'Failed to list students' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const cleanName = name.slice(0, 255);
    let inserted;
    if (isMySQL()) {
      inserted = await query('INSERT INTO modules (user_id, name) VALUES (?, ?)', [req.user.id, cleanName]);
      const id = inserted.insertId ?? inserted.lastID;
      const q = await query('SELECT id, name, created_at FROM modules WHERE id = ? AND user_id = ?', [id, req.user.id]);
      const row = rowList(q)[0];
      return res.json({ success: true, module: { ...row, items: [], students: [] } });
    }
    inserted = await query(
      'INSERT INTO modules (user_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [req.user.id, cleanName]
    );
    const row = rowList(inserted)[0];
    res.json({ success: true, module: { ...row, items: [], students: [] } });
  } catch (error) {
    console.error('Create module error:', error);
    res.status(500).json({ error: 'Failed to create module' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim().slice(0, 255);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (isMySQL()) {
      await query('UPDATE modules SET name = ? WHERE id = ? AND user_id = ?', [name, id, req.user.id]);
    } else {
      await query('UPDATE modules SET name = $1 WHERE id = $2 AND user_id = $3', [name, id, req.user.id]);
    }
    res.json({ success: true, message: 'Module updated' });
  } catch (error) {
    console.error('Update module error:', error);
    res.status(500).json({ error: 'Failed to update module' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid module id' });
    const deleted = isMySQL()
      ? await query('DELETE FROM modules WHERE id = ? AND user_id = ?', [id, req.user.id])
      : await query('DELETE FROM modules WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'Module not found' });
    res.json({ success: true, message: 'Module deleted' });
  } catch (error) {
    console.error('Delete module error:', error);
    res.status(500).json({ error: 'Failed to delete module' });
  }
});

router.post('/:id/items', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const itemType = String(req.body?.item_type || '').trim().toLowerCase();
    const itemId = Number(req.body?.item_id);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!['content', 'assessment'].includes(itemType)) {
      return res.status(400).json({ error: 'item_type must be content or assessment' });
    }
    if (!Number.isFinite(itemId) || itemId <= 0) return res.status(400).json({ error: 'Invalid item_id' });

    const moduleRow = await moduleBelongsToUser(moduleId, req.user.id);
    if (!moduleRow) return res.status(404).json({ error: 'Module not found' });

    const meta = itemType === 'content'
      ? await getContentMeta(itemId, req.user.id)
      : await getAssessmentMeta(itemId, req.user.id);
    if (!meta) return res.status(404).json({ error: `${itemType} item not found` });

    const maxQ = isMySQL()
      ? await query('SELECT COALESCE(MAX(position), -1) AS max_position FROM module_items WHERE module_id = ?', [moduleId])
      : await query('SELECT COALESCE(MAX(position), -1) AS max_position FROM module_items WHERE module_id = $1', [moduleId]);
    const nextPos = Number(rowList(maxQ)[0]?.max_position ?? -1) + 1;

    if (isMySQL()) {
      await query(
        `INSERT INTO module_items (module_id, item_type, item_id, snapshot_title, snapshot_code, position)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [moduleId, itemType, itemId, meta.title, meta.code, nextPos]
      );
    } else {
      await query(
        `INSERT INTO module_items (module_id, item_type, item_id, snapshot_title, snapshot_code, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [moduleId, itemType, itemId, meta.title, meta.code, nextPos]
      );
    }
    res.json({ success: true, message: 'Item added to module' });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' || String(error?.message || '').toLowerCase().includes('unique')) {
      return res.status(409).json({ error: 'Item already exists in this module' });
    }
    console.error('Add module item error:', error);
    res.status(500).json({ error: 'Failed to add item to module' });
  }
});

router.post('/:id/students', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const studentUserId = Number(req.body?.student_user_id);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!Number.isFinite(studentUserId) || studentUserId <= 0) {
      return res.status(400).json({ error: 'student_user_id is required' });
    }

    const moduleRow = await moduleBelongsToUser(moduleId, req.user.id);
    if (!moduleRow) return res.status(404).json({ error: 'Module not found' });

    const student = await getEligibleStudent(studentUserId, req.user);
    if (!student) {
      return res.status(404).json({ error: 'Student not found or not eligible for this module' });
    }

    if (isMySQL()) {
      await query(
        'INSERT INTO module_students (module_id, student_user_id) VALUES (?, ?)',
        [moduleId, studentUserId]
      );
    } else {
      await query(
        'INSERT INTO module_students (module_id, student_user_id) VALUES ($1, $2)',
        [moduleId, studentUserId]
      );
    }
    res.json({ success: true, message: 'Student added to module' });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' || String(error?.message || '').toLowerCase().includes('unique')) {
      return res.status(409).json({ error: 'Student already added to this module' });
    }
    console.error('Add module student error:', error);
    res.status(500).json({ error: 'Failed to add student to module' });
  }
});

router.delete('/:id/students/:studentUserId', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const studentUserId = Number(req.params.studentUserId);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!Number.isFinite(studentUserId) || studentUserId <= 0) return res.status(400).json({ error: 'Invalid student id' });
    const deleted = isMySQL()
      ? await query(
          `DELETE ms FROM module_students ms
           INNER JOIN modules m ON m.id = ms.module_id
           WHERE ms.module_id = ? AND ms.student_user_id = ? AND m.user_id = ?`,
          [moduleId, studentUserId, req.user.id]
        )
      : await query(
          `DELETE FROM module_students
           WHERE module_id = $1
             AND student_user_id = $2
             AND module_id IN (SELECT id FROM modules WHERE id = $1 AND user_id = $3)`,
          [moduleId, studentUserId, req.user.id]
        );
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'Student not enrolled in this module' });
    res.json({ success: true, message: 'Student removed from module' });
  } catch (error) {
    console.error('Remove module student error:', error);
    res.status(500).json({ error: 'Failed to remove student from module' });
  }
});

router.delete('/:id/items/:moduleItemId', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const moduleItemId = Number(req.params.moduleItemId);
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (!Number.isFinite(moduleItemId) || moduleItemId <= 0) return res.status(400).json({ error: 'Invalid module item id' });
    const deleted = isMySQL()
      ? await query(
          `DELETE mi FROM module_items mi
           INNER JOIN modules m ON m.id = mi.module_id
           WHERE mi.id = ? AND mi.module_id = ? AND m.user_id = ?`,
          [moduleItemId, moduleId, req.user.id]
        )
      : await query(
          `DELETE FROM module_items
           WHERE id = $1 AND module_id = $2
             AND module_id IN (SELECT id FROM modules WHERE id = $2 AND user_id = $3)`,
          [moduleItemId, moduleId, req.user.id]
        );
    const affected = deleted?.affectedRows ?? deleted?.rowCount ?? deleted?.changes ?? 0;
    if (!affected) return res.status(404).json({ error: 'Module item not found' });
    res.json({ success: true, message: 'Item removed' });
  } catch (error) {
    console.error('Delete module item error:', error);
    res.status(500).json({ error: 'Failed to remove item' });
  }
});

router.put('/:id/reorder', requireAuth, async (req, res) => {
  try {
    const moduleId = Number(req.params.id);
    const orderedIds = Array.isArray(req.body?.item_ids) ? req.body.item_ids.map((v) => Number(v)) : [];
    if (!Number.isFinite(moduleId) || moduleId <= 0) return res.status(400).json({ error: 'Invalid module id' });
    if (orderedIds.length === 0) return res.status(400).json({ error: 'item_ids is required' });

    const moduleRow = await moduleBelongsToUser(moduleId, req.user.id);
    if (!moduleRow) return res.status(404).json({ error: 'Module not found' });

    const existingQ = isMySQL()
      ? await query('SELECT id FROM module_items WHERE module_id = ?', [moduleId])
      : await query('SELECT id FROM module_items WHERE module_id = $1', [moduleId]);
    const existingIds = rowList(existingQ).map((r) => Number(r.id)).sort((a, b) => a - b);
    const requestedIds = orderedIds.slice().sort((a, b) => a - b);
    if (existingIds.length !== requestedIds.length || existingIds.some((v, idx) => v !== requestedIds[idx])) {
      return res.status(400).json({ error: 'item_ids must include all module item ids exactly once' });
    }

    for (let i = 0; i < orderedIds.length; i += 1) {
      const itemId = orderedIds[i];
      if (isMySQL()) {
        await query('UPDATE module_items SET position = ? WHERE id = ? AND module_id = ?', [i, itemId, moduleId]);
      } else {
        await query('UPDATE module_items SET position = $1 WHERE id = $2 AND module_id = $3', [i, itemId, moduleId]);
      }
    }
    res.json({ success: true, message: 'Module items reordered' });
  } catch (error) {
    console.error('Reorder module items error:', error);
    res.status(500).json({ error: 'Failed to reorder module items' });
  }
});

module.exports = router;
