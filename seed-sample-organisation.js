const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const PDFDocument = require('pdfkit');
const { query, initDatabase } = require('./server/database/connection');

const SEED = {
  organisation: {
    name: 'Seeded Demo Academy'
  },
  users: {
    admin: {
      email: 'admin@seeded-demo.academy',
      password: 'Admin123!',
      name: 'Amina Admin',
      role: 'management'
    },
    lecturer: {
      email: 'lecturer@seeded-demo.academy',
      password: 'Lecturer123!',
      name: 'Lebo Lecturer',
      role: 'lecturer',
      features: {
        generate_assessments: true,
        download_results: true,
        feedback_video: true
      }
    },
    student: {
      email: 'student@seeded-demo.academy',
      password: 'Student123!',
      name: 'Sibusiso Student',
      role: 'student'
    }
  },
  rubric: {
    name: 'Seeded Demo Essay Rubric',
    total_points: 100,
    criteria: [
      {
        name: 'Argument and Understanding',
        max_points: 40,
        description: 'Shows understanding of the question, develops a clear argument, and uses relevant evidence.'
      },
      {
        name: 'Structure and Coherence',
        max_points: 25,
        description: 'Organizes ideas clearly with an introduction, body, and conclusion.'
      },
      {
        name: 'Language and Style',
        max_points: 20,
        description: 'Uses clear academic language with mostly correct grammar and sentence structure.'
      },
      {
        name: 'Referencing and Accuracy',
        max_points: 15,
        description: 'Uses supporting references accurately and avoids factual mistakes.'
      }
    ]
  },
  batch: {
    name: 'Seeded Demo Batch'
  },
  assignment: {
    filename: 'Seeded Demo Script.pdf',
    pdfFileName: 'seeded-demo-script.pdf',
    studentName: 'Sibusiso Student'
  },
  markingResult: {
    scores: [
      {
        criterion_name: 'Argument and Understanding',
        points_awarded: 31,
        max_points: 40,
        feedback: 'You show a solid understanding of the question and your main argument is mostly clear. A few supporting points could be developed with more specific evidence.'
      },
      {
        criterion_name: 'Structure and Coherence',
        points_awarded: 20,
        max_points: 25,
        feedback: 'Your essay follows a sensible structure and the progression of ideas is easy to follow. The conclusion could link back to your main claim more sharply.'
      },
      {
        criterion_name: 'Language and Style',
        points_awarded: 16,
        max_points: 20,
        feedback: 'Your tone is appropriate and generally clear. There are some awkward sentences and punctuation slips that reduce precision in a few places.'
      },
      {
        criterion_name: 'Referencing and Accuracy',
        points_awarded: 11,
        max_points: 15,
        feedback: 'You use supporting material, but some references are too general. A bit more care with source detail would strengthen the paper.'
      }
    ],
    feedback: 'This is a thoughtful piece of work with a clear attempt to answer the question directly. Your strongest area is the way you organize the essay, and your core ideas are understandable throughout. To move this into a stronger band, focus on developing evidence in more detail and tightening the final conclusion. You should also revise a few sentence-level language issues so that your argument reads with more confidence and accuracy.',
    totalScore: 78,
    overallConfidence: 87,
    minCriterionConfidence: 74,
    handwritingRecognitionConfidence: null,
    promptTokens: 1420,
    completionTokens: 615,
    totalTokens: 2035,
    estimatedCostUsd: 0.0314
  },
  moderation: {
    customFeedback: 'Lecturer review: strong structure and engagement with the topic. Next time, support claims with more precise evidence and cleaner referencing.',
    moderationReason: 'Sample seeded moderation note for demo purposes.',
    overrideTotalScore: 80
  }
};

function rowsOf(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

async function ensureOrganisation(name) {
  const existing = await query('SELECT id, name FROM organisations WHERE name = ?', [name]);
  const row = rowsOf(existing)[0];
  if (row) {
    return row;
  }

  const inserted = await query('INSERT INTO organisations (name) VALUES (?)', [name]);
  return { id: inserted.insertId, name };
}

async function ensureUser(userConfig, organisationId, organisationName) {
  const existing = await query(
    'SELECT id, email, name, role FROM users WHERE email = ?',
    [userConfig.email]
  );
  const existingRow = rowsOf(existing)[0];
  const passwordHash = await bcrypt.hash(userConfig.password, 10);
  const featuresJson = userConfig.features ? JSON.stringify(userConfig.features) : null;

  if (existingRow) {
    await query(
      `UPDATE users
       SET password_hash = ?, name = ?, role = ?, account_type = ?, organisation_name = ?, organisation_id = ?,
           email_verified = 1, is_approved = 1, is_active = 1, features = ?
       WHERE id = ?`,
      [
        passwordHash,
        userConfig.name,
        userConfig.role,
        'organisation',
        organisationName,
        organisationId,
        featuresJson,
        existingRow.id
      ]
    );

    return { ...existingRow, name: userConfig.name, role: userConfig.role, email: userConfig.email };
  }

  const inserted = await query(
    `INSERT INTO users
      (email, password_hash, name, account_type, organisation_name, organisation_id, email_verified, role, is_approved, is_active, features)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userConfig.email,
      passwordHash,
      userConfig.name,
      'organisation',
      organisationName,
      organisationId,
      1,
      userConfig.role,
      1,
      1,
      featuresJson
    ]
  );

  return {
    id: inserted.insertId,
    email: userConfig.email,
    name: userConfig.name,
    role: userConfig.role
  };
}

function createSeedPdf(filePath, studentName) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(filePath);

    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);

    doc.pipe(stream);
    doc.fontSize(18).text('Seeded Demo Script', { underline: true });
    doc.moveDown();
    doc.fontSize(12).text(`Student: ${studentName}`);
    doc.text('Module: Introduction to Academic Writing');
    doc.text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown();
    doc.text('Essay Prompt: Discuss the importance of evidence-based reasoning in academic writing.');
    doc.moveDown();
    doc.text(
      'Evidence-based reasoning matters because it helps writers move beyond opinion and support their claims with credible material. ' +
      'In academic work, this creates trust and allows readers to follow the logic of an argument. ' +
      'A strong essay does not simply state what the writer believes; it shows how the conclusion is supported by examples, references, and clear explanation.'
    );
    doc.moveDown();
    doc.text(
      'This sample script is intentionally moderate in quality. It includes a clear structure and relevant ideas, but some arguments could be developed with more specific examples and tighter referencing.'
    );
    doc.end();
  });
}

async function ensureRubric(lecturerId) {
  const existing = await query(
    'SELECT id, name FROM rubrics WHERE user_id = ? AND name = ?',
    [lecturerId, SEED.rubric.name]
  );
  const row = rowsOf(existing)[0];
  if (row) {
    await query(
      'UPDATE rubrics SET criteria = ?, total_points = ?, rubric_type = ? WHERE id = ?',
      [
        JSON.stringify(SEED.rubric.criteria),
        SEED.rubric.total_points,
        'rubric',
        row.id
      ]
    );
    return row;
  }

  const inserted = await query(
    'INSERT INTO rubrics (name, criteria, total_points, rubric_type, user_id) VALUES (?, ?, ?, ?, ?)',
    [
      SEED.rubric.name,
      JSON.stringify(SEED.rubric.criteria),
      SEED.rubric.total_points,
      'rubric',
      lecturerId
    ]
  );

  return { id: inserted.insertId, name: SEED.rubric.name };
}

async function ensureBatch(lecturerId) {
  const existing = await query(
    'SELECT id, name FROM batches WHERE user_id = ? AND name = ?',
    [lecturerId, SEED.batch.name]
  );
  const row = rowsOf(existing)[0];
  if (row) {
    return row;
  }

  const inserted = await query(
    'INSERT INTO batches (name, description, user_id) VALUES (?, ?, ?)',
    [SEED.batch.name, 'Seeded demo batch for walkthroughs.', lecturerId]
  );

  return { id: inserted.insertId, name: SEED.batch.name };
}

async function ensureAssignment(lecturerId, batchId, filePath) {
  const existing = await query(
    'SELECT id, filename, file_path FROM assignments WHERE user_id = ? AND filename = ?',
    [lecturerId, SEED.assignment.filename]
  );
  const row = rowsOf(existing)[0];
  const fileSize = fs.statSync(filePath).size;

  if (row) {
    await query(
      'UPDATE assignments SET file_path = ?, file_size = ?, status = ?, batch_id = ? WHERE id = ?',
      [filePath, fileSize, 'completed', batchId, row.id]
    );
    return { ...row, file_path: filePath };
  }

  const inserted = await query(
    'INSERT INTO assignments (filename, file_path, file_size, status, batch_id, extracted_text, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      SEED.assignment.filename,
      filePath,
      fileSize,
      'completed',
      batchId,
      'Seeded sample essay text for product walkthroughs.',
      lecturerId
    ]
  );

  return { id: inserted.insertId, filename: SEED.assignment.filename, file_path: filePath };
}

async function ensureMarkedResult(assignmentId, rubricId, lecturerId, studentName) {
  const existing = await query(
    'SELECT id FROM marking_results WHERE assignment_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
    [assignmentId, lecturerId]
  );
  const row = rowsOf(existing)[0];
  const payload = [
    rubricId,
    studentName,
    JSON.stringify(SEED.markingResult.scores),
    SEED.markingResult.feedback,
    SEED.markingResult.totalScore,
    1,
    1,
    'moderate',
    'openai',
    JSON.stringify([]),
    JSON.stringify([]),
    SEED.markingResult.handwritingRecognitionConfidence,
    SEED.markingResult.promptTokens,
    SEED.markingResult.completionTokens,
    SEED.markingResult.totalTokens,
    SEED.markingResult.estimatedCostUsd,
    lecturerId
  ];

  if (row) {
    await query(
      `UPDATE marking_results
       SET rubric_id = ?, student_name = ?, scores = ?, feedback = ?, total_score = ?, version = ?, is_current = ?,
           strictness_level = ?, provider = ?, corrections = ?, language_errors = ?,
           handwriting_recognition_confidence = ?, prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
           estimated_cost_usd = ?, user_id = ?
       WHERE id = ?`,
      [...payload, row.id]
    );
    return { id: row.id };
  }

  const inserted = await query(
    `INSERT INTO marking_results
      (assignment_id, rubric_id, student_name, scores, feedback, total_score, version, is_current, strictness_level, provider, corrections, language_errors, handwriting_recognition_confidence, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [assignmentId, ...payload]
  );

  return { id: inserted.insertId };
}

async function ensureModeration(resultId, lecturerId) {
  await query(
    `INSERT INTO marking_result_moderation
      (result_id, user_id, flagged_for_moderation, moderation_reason, custom_feedback, override_total_score, updated_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       flagged_for_moderation = VALUES(flagged_for_moderation),
       moderation_reason = VALUES(moderation_reason),
       custom_feedback = VALUES(custom_feedback),
       override_total_score = VALUES(override_total_score),
       updated_by_user_id = VALUES(updated_by_user_id)`,
    [
      resultId,
      lecturerId,
      1,
      SEED.moderation.moderationReason,
      SEED.moderation.customFeedback,
      SEED.moderation.overrideTotalScore,
      lecturerId
    ]
  );
}

async function seedSampleOrganisation() {
  await initDatabase();

  const organisation = await ensureOrganisation(SEED.organisation.name);
  const admin = await ensureUser(SEED.users.admin, organisation.id, organisation.name);
  const lecturer = await ensureUser(SEED.users.lecturer, organisation.id, organisation.name);
  const student = await ensureUser(SEED.users.student, organisation.id, organisation.name);

  const uploadsDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
  const seedUploadsDir = path.join(uploadsDir, 'seed-data');
  const pdfPath = path.join(seedUploadsDir, SEED.assignment.pdfFileName);
  await createSeedPdf(pdfPath, SEED.assignment.studentName);

  const rubric = await ensureRubric(lecturer.id);
  const batch = await ensureBatch(lecturer.id);
  const assignment = await ensureAssignment(lecturer.id, batch.id, pdfPath);
  const result = await ensureMarkedResult(assignment.id, rubric.id, lecturer.id, SEED.assignment.studentName);
  await ensureModeration(result.id, lecturer.id);

  console.log('\nSeeded sample organisation data successfully.\n');
  console.log(`Organisation: ${organisation.name}`);
  console.log(`Admin:    ${SEED.users.admin.email} / ${SEED.users.admin.password}`);
  console.log(`Lecturer: ${SEED.users.lecturer.email} / ${SEED.users.lecturer.password}`);
  console.log(`Student:  ${SEED.users.student.email} / ${SEED.users.student.password}`);
  console.log(`Sample PDF: ${pdfPath}`);
  console.log(`Rubric: ${SEED.rubric.name}`);
  console.log(`Batch: ${SEED.batch.name}`);
  console.log(`Assignment: ${SEED.assignment.filename}`);
  console.log(`Student-facing result name: ${SEED.assignment.studentName}`);
  console.log('\nThe script is idempotent: running it again updates the same seeded records.\n');
}

if (require.main === module) {
  seedSampleOrganisation()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Failed to seed sample organisation:', error);
      process.exit(1);
    });
}

module.exports = seedSampleOrganisation;
