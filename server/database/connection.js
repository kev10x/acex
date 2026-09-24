const { Pool } = require('pg');
const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;
let isMySQL = false;

const getPool = () => {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    const redactedUrl = connectionString.replace(/:([^:@]+)@/, ':***@');

    // Check if using MySQL
    if (connectionString.startsWith('mysql:')) {
      isMySQL = true;
      console.log('Using MySQL database:', redactedUrl);
      const mysqlDb = require('./mysql');
      return mysqlDb;
    } else {
      console.log('Using PostgreSQL database:', redactedUrl);
    }

    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    // Handle pool errors
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      process.exit(-1);
    });
  }
  
  return pool;
};

const query = async (text, params) => {
  const db = getPool();
  const start = Date.now();
  try {
    let res;
    if (isMySQL) {
      // Convert PostgreSQL placeholders ($1, $2, etc.) to MySQL placeholders (?, ?, etc.)
      let convertedText = text;
      if (params && params.length > 0) {
        // Replace $1, $2, $3, etc. with ?, ?, ?, etc.
        convertedText = text.replace(/\$(\d+)/g, '?');
      }
      res = await db.query(convertedText, params);
    } else {
      res = await db.query(text, params);
    }
    const duration = Date.now() - start;
    console.log('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
};

const initDatabase = async () => {
  try {
    // Check database type before initializing
    const connectionString = process.env.DATABASE_URL;
    const usingMySQL = connectionString && connectionString.startsWith('mysql:');
    console.log('Initializing database, isMySQL:', usingMySQL);
    
    if (usingMySQL) {
      await query(`
        CREATE TABLE IF NOT EXISTS organisations (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          features JSON DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS departments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          organisation_id INT NOT NULL,
          name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_department_per_org (organisation_id, name),
          FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE
        )
      `);
      // Create users table first
      await query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(255),
          account_type VARCHAR(50) DEFAULT 'individual',
          organisation_name VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          last_login TIMESTAMP,
          is_active TINYINT(1) DEFAULT 1,
          email_verified TINYINT(1) DEFAULT 0,
          verification_token VARCHAR(255),
          verification_token_expires TIMESTAMP,
          role VARCHAR(50) DEFAULT 'lecturer',
          is_approved TINYINT(1) DEFAULT 0,
          organisation_id INT NULL,
          department_id INT NULL,
          FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE SET NULL,
          FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
        )
      `);

      // MySQL table creation
      await query(`
        CREATE TABLE IF NOT EXISTS rubrics (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          criteria JSON NOT NULL,
          total_points INT NOT NULL,
          rubric_type VARCHAR(50) DEFAULT 'rubric',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          user_id INT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // Ensure rubric_type column exists (for older installations)
      const rubricTypeCheck = await query(`
        SELECT COUNT(*) as count 
        FROM information_schema.COLUMNS 
        WHERE table_schema = DATABASE() 
        AND table_name = 'rubrics' 
        AND column_name = 'rubric_type'
      `);
      const hasRubricType = (rubricTypeCheck.rows?.[0]?.count || rubricTypeCheck?.[0]?.count || 0) > 0;
      
      if (!hasRubricType) {
        console.log('Adding rubric_type column to rubrics table...');
        await query(`ALTER TABLE rubrics ADD COLUMN rubric_type VARCHAR(50) DEFAULT 'rubric'`);
      }

      await query(`
        CREATE TABLE IF NOT EXISTS batches (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          user_id INT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS assignments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          filename VARCHAR(255) NOT NULL,
          file_path VARCHAR(500) NOT NULL,
          file_size INT,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status VARCHAR(50) DEFAULT 'uploaded',
          batch_id INT,
          processing_job_id INT NULL,
          extracted_text LONGTEXT,
          user_id INT,
          FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS marking_results (
          id INT AUTO_INCREMENT PRIMARY KEY,
          assignment_id INT,
          rubric_id INT,
          student_name VARCHAR(255),
          scores JSON NOT NULL,
          feedback TEXT,
          total_score DECIMAL(5,2),
          marked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          version INT DEFAULT 1,
          is_current TINYINT(1) DEFAULT 1,
          strictness_level VARCHAR(50),
          provider VARCHAR(50),
          corrections JSON,
          user_id INT,
          FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS feedback_videos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          result_id INT NOT NULL,
          user_id INT NOT NULL,
          openai_video_id VARCHAR(255),
          status VARCHAR(50) DEFAULT 'queued',
          file_path VARCHAR(500),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_result (result_id),
          FOREIGN KEY (result_id) REFERENCES marking_results(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS published_assessments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(32) NOT NULL UNIQUE,
          assessment_json LONGTEXT NOT NULL,
          rubric_id INT NOT NULL,
          batch_id INT NULL,
          user_id INT NOT NULL,
          course_id INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE CASCADE,
          FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS assessment_submissions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          submission_code VARCHAR(32) NOT NULL UNIQUE,
          published_assessment_id INT NOT NULL,
          assignment_id INT NOT NULL UNIQUE,
          result_id INT NULL,
          student_user_id INT NULL,
          student_name VARCHAR(255) NOT NULL,
          status VARCHAR(50) DEFAULT 'queued',
          failure_reason TEXT NULL,
          submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP NULL,
          KEY idx_assessment_submissions_student_pub (student_user_id, published_assessment_id),
          FOREIGN KEY (published_assessment_id) REFERENCES published_assessments(id) ON DELETE CASCADE,
          FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
          FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (result_id) REFERENCES marking_results(id) ON DELETE SET NULL
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS published_content (
          id INT AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(32) NOT NULL UNIQUE,
          title VARCHAR(500) NOT NULL,
          content_json LONGTEXT NOT NULL,
          rubric_id INT NULL,
          user_id INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS courses (
          id INT AUTO_INCREMENT PRIMARY KEY,
          organisation_id INT NULL,
          name VARCHAR(255) NOT NULL,
          code VARCHAR(64) NULL,
          description TEXT NULL,
          term VARCHAR(100) NULL,
          start_date DATE NULL,
          end_date DATE NULL,
          owner_user_id INT NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_courses_owner (owner_user_id),
          FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS course_staff (
          id INT AUTO_INCREMENT PRIMARY KEY,
          course_id INT NOT NULL,
          user_id INT NOT NULL,
          role VARCHAR(20) NOT NULL DEFAULT 'lecturer',
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_course_staff (course_id, user_id),
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS course_enrollments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          course_id INT NOT NULL,
          student_user_id INT NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          enrolled_by INT NULL,
          UNIQUE KEY uniq_course_enrollment (course_id, student_user_id),
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
          FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (enrolled_by) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS grade_categories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          course_id INT NOT NULL,
          name VARCHAR(255) NOT NULL,
          weight_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS grade_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          course_id INT NOT NULL,
          grade_category_id INT NULL,
          item_type VARCHAR(32) NOT NULL,
          item_id INT NOT NULL,
          title VARCHAR(500) NULL,
          max_points DECIMAL(10,2) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_grade_item (course_id, item_type, item_id),
          KEY idx_grade_items_category (grade_category_id),
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
          FOREIGN KEY (grade_category_id) REFERENCES grade_categories(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS modules (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          name VARCHAR(255) NOT NULL,
          course_id INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS module_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          module_id INT NOT NULL,
          item_type VARCHAR(32) NOT NULL,
          item_id INT NOT NULL,
          snapshot_title VARCHAR(500) NULL,
          snapshot_code VARCHAR(64) NULL,
          position INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_module_item (module_id, item_type, item_id),
          KEY idx_module_items_order (module_id, position),
          FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS module_students (
          id INT AUTO_INCREMENT PRIMARY KEY,
          module_id INT NOT NULL,
          student_user_id INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_module_student (module_id, student_user_id),
          KEY idx_module_students_module (module_id),
          FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
          FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS homework_module_workflows (
          id INT AUTO_INCREMENT PRIMARY KEY,
          homework_module_id INT NOT NULL UNIQUE,
          user_id INT NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'draft',
          review_notes TEXT NULL,
          reason_summary TEXT NULL,
          reason_payload_json LONGTEXT NULL,
          reviewed_at TIMESTAMP NULL,
          reviewed_by_user_id INT NULL,
          published_at TIMESTAMP NULL,
          published_by_user_id INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_homework_workflows_status (status),
          KEY idx_homework_workflows_user (user_id),
          FOREIGN KEY (homework_module_id) REFERENCES modules(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS uploaded_ppt_templates (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          name VARCHAR(255) NOT NULL,
          file_name VARCHAR(500) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content_generation_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          title VARCHAR(500) NOT NULL,
          generated_content_json LONGTEXT NOT NULL,
          input_json LONGTEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS custom_homework_telemetry (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          status VARCHAR(20) NOT NULL,
          duration_ms INT NOT NULL,
          content_generation_ms INT NULL,
          assessment_generation_ms INT NULL,
          assessment_generation_mode VARCHAR(20) NULL,
          prompt_tokens INT NULL,
          completion_tokens INT NULL,
          total_tokens INT NULL,
          estimated_cost_usd DECIMAL(12, 6) NULL,
          error_message TEXT NULL,
          metadata_json LONGTEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_custom_homework_telemetry_user_created (user_id, created_at),
          KEY idx_custom_homework_telemetry_status_created (status, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NULL,
          target_user_id INT NULL,
          category VARCHAR(50) NOT NULL,
          action VARCHAR(100) NOT NULL,
          outcome VARCHAR(30) NOT NULL DEFAULT 'success',
          organisation_id INT NULL,
          department_id INT NULL,
          metadata_json LONGTEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_audit_events_created (created_at),
          KEY idx_audit_events_user_created (user_id, created_at),
          KEY idx_audit_events_category_created (category, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE SET NULL,
          FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS homework_workflow_events (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          action VARCHAR(60) NOT NULL,
          status VARCHAR(20) NULL,
          target_count INT NOT NULL DEFAULT 0,
          updated_count INT NOT NULL DEFAULT 0,
          skipped_count INT NOT NULL DEFAULT 0,
          module_ids_json LONGTEXT NULL,
          metadata_json LONGTEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_homework_workflow_events_user_created (user_id, created_at),
          KEY idx_homework_workflow_events_action_created (action, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS generation_telemetry_events (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          generation_type VARCHAR(40) NOT NULL,
          status VARCHAR(20) NOT NULL,
          provider VARCHAR(50) NULL,
          model VARCHAR(120) NULL,
          duration_ms INT NOT NULL,
          prompt_tokens INT NULL,
          completion_tokens INT NULL,
          total_tokens INT NULL,
          estimated_cost_usd DECIMAL(12, 6) NULL,
          error_type VARCHAR(80) NULL,
          error_message TEXT NULL,
          metadata_json LONGTEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_generation_telemetry_created (created_at),
          KEY idx_generation_telemetry_type_created (generation_type, created_at),
          KEY idx_generation_telemetry_status_created (status, created_at),
          KEY idx_generation_telemetry_user_created (user_id, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS prompt_registry (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NULL,
          generation_type VARCHAR(60) NOT NULL,
          prompt_key VARCHAR(80) NOT NULL DEFAULT 'default',
          version INT NOT NULL,
          prompt_text LONGTEXT NOT NULL,
          provider VARCHAR(50) NULL,
          model VARCHAR(120) NULL,
          temperature DECIMAL(6, 3) NULL,
          max_tokens INT NULL,
          notes TEXT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_prompt_registry_lookup (generation_type, prompt_key, user_id, is_active),
          KEY idx_prompt_registry_user_created (user_id, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS generation_jobs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          job_type VARCHAR(60) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
          source_route VARCHAR(120) NULL,
          payload_json LONGTEXT NULL,
          result_json LONGTEXT NULL,
          error_message TEXT NULL,
          retry_count INT NOT NULL DEFAULT 0,
          max_retries INT NOT NULL DEFAULT 2,
          scheduled_for TIMESTAMP NULL,
          started_at TIMESTAMP NULL,
          completed_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_generation_jobs_user_created (user_id, created_at),
          KEY idx_generation_jobs_type_status_created (job_type, status, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS generation_job_dead_letters (
          id INT AUTO_INCREMENT PRIMARY KEY,
          job_id INT NOT NULL UNIQUE,
          user_id INT NOT NULL,
          job_type VARCHAR(60) NOT NULL,
          status VARCHAR(20) NOT NULL,
          retry_count INT NOT NULL DEFAULT 0,
          max_retries INT NOT NULL DEFAULT 0,
          error_message TEXT NULL,
          payload_json LONGTEXT NULL,
          result_json LONGTEXT NULL,
          dead_letter_reason VARCHAR(120) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_generation_job_dead_letters_user_created (user_id, created_at),
          KEY idx_generation_job_dead_letters_type_created (job_type, created_at),
          FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS assessment_generation_history (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          title VARCHAR(500) NOT NULL,
          generated_assessment_json LONGTEXT NOT NULL,
          input_json LONGTEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content_planner_jobs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          topics TEXT NOT NULL,
          level VARCHAR(120) NULL,
          num_sections INT DEFAULT 5,
          template_id VARCHAR(60) DEFAULT 'classroom',
          rubric_id INT NULL,
          rubric_context TEXT NULL,
          include_diagrams TINYINT(1) DEFAULT 1,
          include_images TINYINT(1) DEFAULT 1,
          include_mascot TINYINT(1) DEFAULT 0,
          scheduled_for TIMESTAMP NOT NULL,
          status VARCHAR(50) DEFAULT 'scheduled',
          error_message TEXT NULL,
          generated_content_json LONGTEXT NULL,
          published_content_id INT NULL,
          published_code VARCHAR(32) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE SET NULL,
          FOREIGN KEY (published_content_id) REFERENCES published_content(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content_videos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          published_content_id INT NOT NULL,
          openai_video_id VARCHAR(255) NOT NULL,
          openai_video_ids TEXT NULL,
          status VARCHAR(50) DEFAULT 'queued',
          file_path TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (published_content_id) REFERENCES published_content(id) ON DELETE CASCADE,
          UNIQUE(published_content_id)
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS video_generations (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          prompt TEXT NOT NULL,
          model VARCHAR(60) NOT NULL DEFAULT 'grok-imagine-video-1.5',
          duration_seconds INT NOT NULL DEFAULT 10,
          aspect_ratio VARCHAR(20) NOT NULL DEFAULT '16:9',
          resolution VARCHAR(20) NOT NULL DEFAULT '720p',
          generate_audio TINYINT(1) NOT NULL DEFAULT 1,
          xai_request_id VARCHAR(255) NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'processing',
          file_path VARCHAR(500) NULL,
          error_message TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_video_generations_user_created (user_id, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS lesson_summary_videos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          published_content_id INT NOT NULL,
          video_generation_id INT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          error_message TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          applied_at TIMESTAMP NULL,
          section_index INT NOT NULL DEFAULT 0,
          UNIQUE KEY uniq_lesson_summary_section (published_content_id, section_index),
          KEY idx_lesson_summary_status (status),
          FOREIGN KEY (published_content_id) REFERENCES published_content(id) ON DELETE CASCADE,
          FOREIGN KEY (video_generation_id) REFERENCES video_generations(id) ON DELETE SET NULL
        )
      `);
      // Summary videos were originally one per lesson; they are now one per section.
      const lsvSectionCol = await query(`
        SELECT COUNT(*) as count FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE() AND table_name = 'lesson_summary_videos' AND column_name = 'section_index'
      `);
      if ((lsvSectionCol.rows?.[0]?.count || lsvSectionCol?.[0]?.count || 0) === 0) {
        await query(`ALTER TABLE lesson_summary_videos ADD COLUMN section_index INT NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE lesson_summary_videos ADD UNIQUE KEY uniq_lesson_summary_section (published_content_id, section_index)`);
        await query(`ALTER TABLE lesson_summary_videos DROP INDEX uniq_lesson_summary_content`);
      }
      await query(`
        CREATE TABLE IF NOT EXISTS course_build_jobs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          course_id INT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'queued',
          config_json LONGTEXT NOT NULL,
          progress_json LONGTEXT NULL,
          error_message TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_course_build_jobs_user (user_id, created_at),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content_progress (
          id INT AUTO_INCREMENT PRIMARY KEY,
          published_content_id INT NOT NULL,
          student_name VARCHAR(255) NOT NULL,
          current_section INT DEFAULT 0,
          checkpoint_answers_json LONGTEXT NULL,
          completed TINYINT(1) DEFAULT 0,
          score DECIMAL(6,2) DEFAULT NULL,
          progress_json LONGTEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_content_progress (published_content_id, student_name),
          FOREIGN KEY (published_content_id) REFERENCES published_content(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS marking_jobs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          batch_id INT NOT NULL,
          rubric_id INT NOT NULL,
          user_id INT NOT NULL,
          provider VARCHAR(50) DEFAULT 'openai',
          processing_mode VARCHAR(50) DEFAULT 'standard',
          status VARCHAR(50) DEFAULT 'scheduled',
          scheduled_for TIMESTAMP NULL,
          started_at TIMESTAMP NULL,
          completed_at TIMESTAMP NULL,
          request_count INT DEFAULT 0,
          total_count INT DEFAULT 0,
          processed_count INT DEFAULT 0,
          success_count INT DEFAULT 0,
          failed_count INT DEFAULT 0,
          openai_batch_id VARCHAR(255) NULL,
          openai_input_file_id VARCHAR(255) NULL,
          openai_output_file_id VARCHAR(255) NULL,
          openai_error_file_id VARCHAR(255) NULL,
          completion_window VARCHAR(20) NULL,
          retry_count INT DEFAULT 0,
          max_retries INT DEFAULT 3,
          next_retry_at TIMESTAMP NULL,
          last_status_at TIMESTAMP NULL,
          last_error TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS marking_result_moderation (
          id INT AUTO_INCREMENT PRIMARY KEY,
          result_id INT NOT NULL,
          user_id INT NOT NULL,
          flagged_for_moderation TINYINT(1) DEFAULT 0,
          moderation_reason TEXT NULL,
          custom_feedback LONGTEXT NULL,
          override_total_score DECIMAL(7,2) NULL,
          updated_by_user_id INT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_result_moderation (result_id),
          FOREIGN KEY (result_id) REFERENCES marking_results(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS revision_series (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          rubric_id INT NOT NULL,
          name VARCHAR(255) NOT NULL,
          student_name VARCHAR(255) NOT NULL,
          student_user_id INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE CASCADE,
          FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS revision_submissions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          series_id INT NOT NULL,
          revision_number INT NOT NULL,
          assignment_id INT NOT NULL,
          marking_result_id INT NULL,
          progress_score DECIMAL(5,2) DEFAULT 0,
          comparison_json LONGTEXT NULL,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (series_id) REFERENCES revision_series(id) ON DELETE CASCADE,
          FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
          FOREIGN KEY (marking_result_id) REFERENCES marking_results(id) ON DELETE SET NULL
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          jti VARCHAR(36) NOT NULL,
          ip_address VARCHAR(45) NULL,
          user_agent TEXT NULL,
          is_active TINYINT(1) DEFAULT 1,
          logged_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY uq_user_sessions_jti (jti),
          INDEX idx_user_sessions_user (user_id)
        )
      `);

      // Migrate existing tables: Add new columns if they don't exist
      try {
        const orgIdCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE()
          AND table_name = 'users'
          AND column_name = 'organisation_id'
        `);
        const hasOrgId = (orgIdCheck.rows?.[0]?.count || orgIdCheck?.[0]?.count || 0) > 0;
        if (!hasOrgId) {
          await query(`ALTER TABLE users ADD COLUMN organisation_id INT NULL`);
          await query(`ALTER TABLE users ADD CONSTRAINT fk_users_organisation FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE SET NULL`);
        }
        const departmentIdCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE()
          AND table_name = 'users'
          AND column_name = 'department_id'
        `);
        const hasDepartmentId = (departmentIdCheck.rows?.[0]?.count || departmentIdCheck?.[0]?.count || 0) > 0;
        if (!hasDepartmentId) {
          await query(`ALTER TABLE users ADD COLUMN department_id INT NULL`);
          await query(`ALTER TABLE users ADD CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL`);
        }

        // Check if version column exists
        const versionCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND column_name = 'version'
        `);
        const hasVersion = (versionCheck.rows?.[0]?.count || versionCheck?.[0]?.count || 0) > 0;
        
        if (!hasVersion) {
          console.log('Adding version column to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN version INT DEFAULT 1`);
        }
        
        // Check if is_current column exists
        const isCurrentCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND column_name = 'is_current'
        `);
        const hasIsCurrent = (isCurrentCheck.rows?.[0]?.count || isCurrentCheck?.[0]?.count || 0) > 0;
        
        if (!hasIsCurrent) {
          console.log('Adding is_current column to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN is_current TINYINT(1) DEFAULT 1`);
          // Set all existing records as current
          await query(`UPDATE marking_results SET is_current = 1 WHERE is_current IS NULL`);
        }
        
        // Check if strictness_level column exists
        const strictnessCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND column_name = 'strictness_level'
        `);
        const hasStrictness = (strictnessCheck.rows?.[0]?.count || strictnessCheck?.[0]?.count || 0) > 0;
        
        if (!hasStrictness) {
          console.log('Adding strictness_level column to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN strictness_level VARCHAR(50)`);
        }
        
        // Check if provider column exists
        const providerCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND column_name = 'provider'
        `);
        const hasProvider = (providerCheck.rows?.[0]?.count || providerCheck?.[0]?.count || 0) > 0;
        
        if (!hasProvider) {
          console.log('Adding provider column to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN provider VARCHAR(50)`);
        }
        
        // Check if corrections column exists
        const correctionsCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND column_name = 'corrections'
        `);
        const hasCorrections = (correctionsCheck.rows?.[0]?.count || correctionsCheck?.[0]?.count || 0) > 0;
        
        if (!hasCorrections) {
          console.log('Adding corrections column to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN corrections JSON`);
        }
        
        // Check if language_errors column exists
        const languageErrorsCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND column_name = 'language_errors'
        `);
        const hasLanguageErrors = (languageErrorsCheck.rows?.[0]?.count || languageErrorsCheck?.[0]?.count || 0) > 0;
        
        if (!hasLanguageErrors) {
          console.log('Adding language_errors column to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN language_errors JSON`);
        }
        
        // Check if batch_id column exists in assignments
        const batchIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'assignments' 
          AND column_name = 'batch_id'
        `);
        const hasBatchId = (batchIdCheck.rows?.[0]?.count || batchIdCheck?.[0]?.count || 0) > 0;
        
        if (!hasBatchId) {
          console.log('Adding batch_id column to assignments table...');
          await query(`ALTER TABLE assignments ADD COLUMN batch_id INT`);
        }

        const processingJobIdCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE()
          AND table_name = 'assignments'
          AND column_name = 'processing_job_id'
        `);
        if ((processingJobIdCheck.rows?.[0]?.count || processingJobIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN processing_job_id INT NULL`);
        }
        
        // Check if extracted_text column exists
        const extractedTextCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'assignments' 
          AND column_name = 'extracted_text'
        `);
        const hasExtractedText = (extractedTextCheck.rows?.[0]?.count || extractedTextCheck?.[0]?.count || 0) > 0;
        
        if (!hasExtractedText) {
          console.log('Adding extracted_text column to assignments table...');
          await query(`ALTER TABLE assignments ADD COLUMN extracted_text LONGTEXT`);
        }
        
        // Add user_id columns if they don't exist
        const rubricUserIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'rubrics' 
          AND column_name = 'user_id'
        `);
        if ((rubricUserIdCheck.rows?.[0]?.count || rubricUserIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE rubrics ADD COLUMN user_id INT`);
        }
        
        const batchesUserIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'batches' 
          AND column_name = 'user_id'
        `);
        if ((batchesUserIdCheck.rows?.[0]?.count || batchesUserIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE batches ADD COLUMN user_id INT`);
        }
        
        const assignmentsUserIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'assignments' 
          AND column_name = 'user_id'
        `);
        if ((assignmentsUserIdCheck.rows?.[0]?.count || assignmentsUserIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN user_id INT`);
        }
        
        const markingResultsUserIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND column_name = 'user_id'
        `);
        if ((markingResultsUserIdCheck.rows?.[0]?.count || markingResultsUserIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN user_id INT`);
        }

        const handwritingConfCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND column_name = 'handwriting_recognition_confidence'
        `);
        if ((handwritingConfCheck.rows?.[0]?.count || handwritingConfCheck?.[0]?.count || 0) === 0) {
          console.log('Adding handwriting_recognition_confidence column to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN handwriting_recognition_confidence INT DEFAULT NULL`);
        }

        const promptTokensCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'prompt_tokens'
        `);
        if ((promptTokensCheck.rows?.[0]?.count || promptTokensCheck?.[0]?.count || 0) === 0) {
          console.log('Adding token usage columns to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN prompt_tokens INT DEFAULT NULL`);
          await query(`ALTER TABLE marking_results ADD COLUMN completion_tokens INT DEFAULT NULL`);
          await query(`ALTER TABLE marking_results ADD COLUMN total_tokens INT DEFAULT NULL`);
          await query(`ALTER TABLE marking_results ADD COLUMN estimated_cost_usd DECIMAL(12,6) DEFAULT NULL`);
        }

        const markingJobProviderCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'provider'
        `);
        if ((markingJobProviderCheck.rows?.[0]?.count || markingJobProviderCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN provider VARCHAR(50) DEFAULT 'openai'`);
        }

        const markingJobModeCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'processing_mode'
        `);
        if ((markingJobModeCheck.rows?.[0]?.count || markingJobModeCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN processing_mode VARCHAR(50) DEFAULT 'standard'`);
        }

        const markingJobRequestCountCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'request_count'
        `);
        if ((markingJobRequestCountCheck.rows?.[0]?.count || markingJobRequestCountCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN request_count INT DEFAULT 0`);
        }

        const markingJobBatchIdCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'openai_batch_id'
        `);
        if ((markingJobBatchIdCheck.rows?.[0]?.count || markingJobBatchIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN openai_batch_id VARCHAR(255) DEFAULT NULL`);
          await query(`ALTER TABLE marking_jobs ADD COLUMN openai_input_file_id VARCHAR(255) DEFAULT NULL`);
          await query(`ALTER TABLE marking_jobs ADD COLUMN openai_output_file_id VARCHAR(255) DEFAULT NULL`);
          await query(`ALTER TABLE marking_jobs ADD COLUMN openai_error_file_id VARCHAR(255) DEFAULT NULL`);
          await query(`ALTER TABLE marking_jobs ADD COLUMN completion_window VARCHAR(20) DEFAULT NULL`);
        }

        const markingJobRetryCountCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'retry_count'
        `);
        if ((markingJobRetryCountCheck.rows?.[0]?.count || markingJobRetryCountCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN retry_count INT DEFAULT 0`);
        }

        const markingJobMaxRetriesCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'max_retries'
        `);
        if ((markingJobMaxRetriesCheck.rows?.[0]?.count || markingJobMaxRetriesCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN max_retries INT DEFAULT 3`);
        }

        const markingJobNextRetryCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'next_retry_at'
        `);
        if ((markingJobNextRetryCheck.rows?.[0]?.count || markingJobNextRetryCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN next_retry_at TIMESTAMP NULL`);
        }

        const markingJobLastStatusCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'last_status_at'
        `);
        if ((markingJobLastStatusCheck.rows?.[0]?.count || markingJobLastStatusCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN last_status_at TIMESTAMP NULL`);
        }

        const markingJobStrictnessCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'strictness_level'
        `);
        if ((markingJobStrictnessCheck.rows?.[0]?.count || markingJobStrictnessCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN strictness_level VARCHAR(50) DEFAULT 'strict'`);
        }

        const markingJobFeedbackTypeCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'feedback_type'
        `);
        if ((markingJobFeedbackTypeCheck.rows?.[0]?.count || markingJobFeedbackTypeCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN feedback_type VARCHAR(50) DEFAULT 'standard'`);
        }

        const markingJobFeedbackVerbosityCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_jobs' AND column_name = 'feedback_verbosity'
        `);
        if ((markingJobFeedbackVerbosityCheck.rows?.[0]?.count || markingJobFeedbackVerbosityCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN feedback_verbosity VARCHAR(50) DEFAULT 'standard'`);
        }

        const publishedAssessmentBatchCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'published_assessments' AND column_name = 'batch_id'
        `);
        if ((publishedAssessmentBatchCheck.rows?.[0]?.count || publishedAssessmentBatchCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE published_assessments ADD COLUMN batch_id INT NULL`);
        }

        const assessmentSubmissionsTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'assessment_submissions'
        `);
        if ((assessmentSubmissionsTableCheck.rows?.[0]?.count || assessmentSubmissionsTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE assessment_submissions (
              id INT AUTO_INCREMENT PRIMARY KEY,
              submission_code VARCHAR(32) NOT NULL UNIQUE,
              published_assessment_id INT NOT NULL,
              assignment_id INT NOT NULL UNIQUE,
              result_id INT NULL,
              student_user_id INT NULL,
              student_name VARCHAR(255) NOT NULL,
              status VARCHAR(50) DEFAULT 'queued',
              failure_reason TEXT NULL,
              submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              completed_at TIMESTAMP NULL,
              FOREIGN KEY (published_assessment_id) REFERENCES published_assessments(id) ON DELETE CASCADE,
              FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
              FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE SET NULL,
              FOREIGN KEY (result_id) REFERENCES marking_results(id) ON DELETE SET NULL
            )
          `);
        }

        const assessmentSubmissionsStudentUserCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'assessment_submissions' AND column_name = 'student_user_id'
        `);
        if ((assessmentSubmissionsStudentUserCheck.rows?.[0]?.count || assessmentSubmissionsStudentUserCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assessment_submissions ADD COLUMN student_user_id INT NULL`);
        }
        const assessmentSubmissionsStudentPubIndexCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.STATISTICS
          WHERE table_schema = DATABASE() AND table_name = 'assessment_submissions' AND index_name = 'idx_assessment_submissions_student_pub'
        `);
        if ((assessmentSubmissionsStudentPubIndexCheck.rows?.[0]?.count || assessmentSubmissionsStudentPubIndexCheck?.[0]?.count || 0) === 0) {
          await query(`CREATE INDEX idx_assessment_submissions_student_pub ON assessment_submissions (student_user_id, published_assessment_id)`);
        }
        const homeworkWorkflowTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'homework_module_workflows'
        `);
        if ((homeworkWorkflowTableCheck.rows?.[0]?.count || homeworkWorkflowTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE homework_module_workflows (
              id INT AUTO_INCREMENT PRIMARY KEY,
              homework_module_id INT NOT NULL UNIQUE,
              user_id INT NOT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'draft',
              review_notes TEXT NULL,
              reason_summary TEXT NULL,
              reason_payload_json LONGTEXT NULL,
              reviewed_at TIMESTAMP NULL,
              reviewed_by_user_id INT NULL,
              published_at TIMESTAMP NULL,
              published_by_user_id INT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              KEY idx_homework_workflows_status (status),
              KEY idx_homework_workflows_user (user_id),
              FOREIGN KEY (homework_module_id) REFERENCES modules(id) ON DELETE CASCADE,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
              FOREIGN KEY (reviewed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
              FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON DELETE SET NULL
            )
          `);
        }
        const homeworkWorkflowReasonSummaryCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'homework_module_workflows' AND column_name = 'reason_summary'
        `);
        if ((homeworkWorkflowReasonSummaryCheck.rows?.[0]?.count || homeworkWorkflowReasonSummaryCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE homework_module_workflows ADD COLUMN reason_summary TEXT NULL`);
        }
        const homeworkWorkflowReasonPayloadCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'homework_module_workflows' AND column_name = 'reason_payload_json'
        `);
        if ((homeworkWorkflowReasonPayloadCheck.rows?.[0]?.count || homeworkWorkflowReasonPayloadCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE homework_module_workflows ADD COLUMN reason_payload_json LONGTEXT NULL`);
        }
        const homeworkWorkflowEventsTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'homework_workflow_events'
        `);
        if ((homeworkWorkflowEventsTableCheck.rows?.[0]?.count || homeworkWorkflowEventsTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE homework_workflow_events (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT NOT NULL,
              action VARCHAR(60) NOT NULL,
              status VARCHAR(20) NULL,
              target_count INT NOT NULL DEFAULT 0,
              updated_count INT NOT NULL DEFAULT 0,
              skipped_count INT NOT NULL DEFAULT 0,
              module_ids_json LONGTEXT NULL,
              metadata_json LONGTEXT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              KEY idx_homework_workflow_events_user_created (user_id, created_at),
              KEY idx_homework_workflow_events_action_created (action, created_at),
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
          `);
        }
        const generationTelemetryEventsTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'generation_telemetry_events'
        `);
        if ((generationTelemetryEventsTableCheck.rows?.[0]?.count || generationTelemetryEventsTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE generation_telemetry_events (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT NOT NULL,
              generation_type VARCHAR(40) NOT NULL,
              status VARCHAR(20) NOT NULL,
              provider VARCHAR(50) NULL,
              model VARCHAR(120) NULL,
              duration_ms INT NOT NULL,
              prompt_tokens INT NULL,
              completion_tokens INT NULL,
              total_tokens INT NULL,
              estimated_cost_usd DECIMAL(12, 6) NULL,
              error_type VARCHAR(80) NULL,
              error_message TEXT NULL,
              metadata_json LONGTEXT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              KEY idx_generation_telemetry_created (created_at),
              KEY idx_generation_telemetry_type_created (generation_type, created_at),
              KEY idx_generation_telemetry_status_created (status, created_at),
              KEY idx_generation_telemetry_user_created (user_id, created_at),
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
          `);
        }
        const promptRegistryTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'prompt_registry'
        `);
        if ((promptRegistryTableCheck.rows?.[0]?.count || promptRegistryTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE prompt_registry (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT NULL,
              generation_type VARCHAR(60) NOT NULL,
              prompt_key VARCHAR(80) NOT NULL DEFAULT 'default',
              version INT NOT NULL,
              prompt_text LONGTEXT NOT NULL,
              provider VARCHAR(50) NULL,
              model VARCHAR(120) NULL,
              temperature DECIMAL(6, 3) NULL,
              max_tokens INT NULL,
              notes TEXT NULL,
              is_active TINYINT(1) NOT NULL DEFAULT 1,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              KEY idx_prompt_registry_lookup (generation_type, prompt_key, user_id, is_active),
              KEY idx_prompt_registry_user_created (user_id, created_at),
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
          `);
        }
        const generationJobsTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'generation_jobs'
        `);
        if ((generationJobsTableCheck.rows?.[0]?.count || generationJobsTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE generation_jobs (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT NOT NULL,
              job_type VARCHAR(60) NOT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
              source_route VARCHAR(120) NULL,
              payload_json LONGTEXT NULL,
              result_json LONGTEXT NULL,
              error_message TEXT NULL,
              retry_count INT NOT NULL DEFAULT 0,
              max_retries INT NOT NULL DEFAULT 2,
              scheduled_for TIMESTAMP NULL,
              started_at TIMESTAMP NULL,
              completed_at TIMESTAMP NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              KEY idx_generation_jobs_user_created (user_id, created_at),
              KEY idx_generation_jobs_type_status_created (job_type, status, created_at),
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
          `);
        }
        const generationDeadLettersTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'generation_job_dead_letters'
        `);
        if ((generationDeadLettersTableCheck.rows?.[0]?.count || generationDeadLettersTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE generation_job_dead_letters (
              id INT AUTO_INCREMENT PRIMARY KEY,
              job_id INT NOT NULL UNIQUE,
              user_id INT NOT NULL,
              job_type VARCHAR(60) NOT NULL,
              status VARCHAR(20) NOT NULL,
              retry_count INT NOT NULL DEFAULT 0,
              max_retries INT NOT NULL DEFAULT 0,
              error_message TEXT NULL,
              payload_json LONGTEXT NULL,
              result_json LONGTEXT NULL,
              dead_letter_reason VARCHAR(120) NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              KEY idx_generation_job_dead_letters_user_created (user_id, created_at),
              KEY idx_generation_job_dead_letters_type_created (job_type, created_at),
              FOREIGN KEY (job_id) REFERENCES generation_jobs(id) ON DELETE CASCADE,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
          `);
        }
        await query(`
          UPDATE assessment_submissions s
          INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
          SET s.student_user_id = (
            SELECT MIN(ms.student_user_id)
            FROM module_items mi
            INNER JOIN modules m ON m.id = mi.module_id
            INNER JOIN module_students ms ON ms.module_id = mi.module_id
            INNER JOIN users u ON u.id = ms.student_user_id
            WHERE mi.item_type = 'assessment'
              AND mi.item_id = s.published_assessment_id
              AND m.user_id = pa.user_id
              AND (
                LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
                OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
                OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(SUBSTRING_INDEX(COALESCE(u.email, ''), '@', 1)))
              )
          )
          WHERE s.student_user_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM module_items mi
              INNER JOIN modules m ON m.id = mi.module_id
              INNER JOIN module_students ms ON ms.module_id = mi.module_id
              INNER JOIN users u ON u.id = ms.student_user_id
              WHERE mi.item_type = 'assessment'
                AND mi.item_id = s.published_assessment_id
                AND m.user_id = pa.user_id
                AND (
                  LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
                  OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
                  OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(SUBSTRING_INDEX(COALESCE(u.email, ''), '@', 1)))
                )
            )
        `);
        
        const accountTypeCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'users' 
          AND column_name = 'account_type'
        `);
        if ((accountTypeCheck.rows?.[0]?.count || accountTypeCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN account_type VARCHAR(50) DEFAULT 'individual'`);
        }
        
        const orgNameCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'users' 
          AND column_name = 'organisation_name'
        `);
        if ((orgNameCheck.rows?.[0]?.count || orgNameCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN organisation_name VARCHAR(255)`);
        }
        
        const emailVerifiedCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'users' 
          AND column_name = 'email_verified'
        `);
        if ((emailVerifiedCheck.rows?.[0]?.count || emailVerifiedCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN email_verified TINYINT(1) DEFAULT 0`);
        }
        
        const verificationTokenCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'users' 
          AND column_name = 'verification_token'
        `);
        if ((verificationTokenCheck.rows?.[0]?.count || verificationTokenCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN verification_token VARCHAR(255)`);
        }
        
        const verificationTokenExpiresCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'users' 
          AND column_name = 'verification_token_expires'
        `);
        if ((verificationTokenExpiresCheck.rows?.[0]?.count || verificationTokenExpiresCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN verification_token_expires TIMESTAMP`);
        }

        // One-time account setup / password reset links (only a hash of the token is stored).
        const SetupTokenHashCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'setup_token_hash'
        `);
        if ((SetupTokenHashCheck.rows?.[0]?.count || SetupTokenHashCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN setup_token_hash VARCHAR(64) NULL`);
        }

        const SetupTokenExpiresCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'setup_token_expires'
        `);
        if ((SetupTokenExpiresCheck.rows?.[0]?.count || SetupTokenExpiresCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN setup_token_expires TIMESTAMP NULL`);
        }

        const SetupTokenPurposeCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'setup_token_purpose'
        `);
        if ((SetupTokenPurposeCheck.rows?.[0]?.count || SetupTokenPurposeCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN setup_token_purpose VARCHAR(20) NULL`);
        }
        
        const roleCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'users' 
          AND column_name = 'role'
        `);
        if ((roleCheck.rows?.[0]?.count || roleCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'lecturer'`);
        }
        
        const isApprovedCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'users' 
          AND column_name = 'is_approved'
        `);
        if ((isApprovedCheck.rows?.[0]?.count || isApprovedCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN is_approved TINYINT(1) DEFAULT 0`);
        }
        const featuresCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.COLUMNS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'users' 
          AND column_name = 'features'
        `);
        if ((featuresCheck.rows?.[0]?.count || featuresCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN features JSON DEFAULT NULL`);
        }
        const orgFeaturesCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE()
          AND table_name = 'organisations'
          AND column_name = 'features'
        `);
        if ((orgFeaturesCheck.rows?.[0]?.count || orgFeaturesCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE organisations ADD COLUMN features JSON DEFAULT NULL`);
        }
        const videoIdsCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'feedback_videos' AND column_name = 'openai_video_ids'
        `);
        if ((videoIdsCheck.rows?.[0]?.count || videoIdsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE feedback_videos ADD COLUMN openai_video_ids TEXT DEFAULT NULL`);
        }
        const contentVideoIdsCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'content_videos' AND column_name = 'openai_video_ids'
        `);
        if ((contentVideoIdsCheck.rows?.[0]?.count || contentVideoIdsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE content_videos ADD COLUMN openai_video_ids TEXT DEFAULT NULL`);
        }
        const modulesCourseIdCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'modules' AND column_name = 'course_id'
        `);
        if ((modulesCourseIdCheck.rows?.[0]?.count || modulesCourseIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE modules ADD COLUMN course_id INT NULL`);
          await query(`ALTER TABLE modules ADD FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE SET NULL`);
        }
        // Libraries can be separated by course (course_id is set on publish; existing items are filed from their module).
        const published_contentCourseIdCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'published_content' AND column_name = 'course_id'
        `);
        if ((published_contentCourseIdCheck.rows?.[0]?.count || published_contentCourseIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE published_content ADD COLUMN course_id INT NULL`);
          try {
            await query(`
              UPDATE published_content SET course_id = (
                SELECT m.course_id FROM module_items mi
                INNER JOIN modules m ON m.id = mi.module_id
                WHERE mi.item_type = 'content' AND mi.item_id = published_content.id AND m.course_id IS NOT NULL
                ORDER BY mi.id LIMIT 1
              )
            `);
          } catch (backfillError) {
            console.warn('Could not backfill published_content.course_id:', backfillError?.message || backfillError);
          }
        }
        // Libraries can be separated by course (course_id is set on publish; existing items are filed from their module).
        const published_assessmentsCourseIdCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'published_assessments' AND column_name = 'course_id'
        `);
        if ((published_assessmentsCourseIdCheck.rows?.[0]?.count || published_assessmentsCourseIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE published_assessments ADD COLUMN course_id INT NULL`);
          try {
            await query(`
              UPDATE published_assessments SET course_id = (
                SELECT m.course_id FROM module_items mi
                INNER JOIN modules m ON m.id = mi.module_id
                WHERE mi.item_type = 'assessment' AND mi.item_id = published_assessments.id AND m.course_id IS NOT NULL
                ORDER BY mi.id LIMIT 1
              )
            `);
          } catch (backfillError) {
            console.warn('Could not backfill published_assessments.course_id:', backfillError?.message || backfillError);
          }
        }
        const plannerIncludeDiagramsCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'content_planner_jobs' AND column_name = 'include_diagrams'
        `);
        if ((plannerIncludeDiagramsCheck.rows?.[0]?.count || plannerIncludeDiagramsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE content_planner_jobs ADD COLUMN include_diagrams TINYINT(1) DEFAULT 1`);
        }
        const plannerIncludeImagesCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'content_planner_jobs' AND column_name = 'include_images'
        `);
        if ((plannerIncludeImagesCheck.rows?.[0]?.count || plannerIncludeImagesCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE content_planner_jobs ADD COLUMN include_images TINYINT(1) DEFAULT 1`);
        }
        const plannerIncludeMascotCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'content_planner_jobs' AND column_name = 'include_mascot'
        `);
        if ((plannerIncludeMascotCheck.rows?.[0]?.count || plannerIncludeMascotCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE content_planner_jobs ADD COLUMN include_mascot TINYINT(1) DEFAULT 0`);
        }

        const feedbackTypeCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'feedback_type'
        `);
        if ((feedbackTypeCheck.rows?.[0]?.count || feedbackTypeCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN feedback_type VARCHAR(50) DEFAULT 'standard'`);
        }

        const feedbackVerbosityCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'feedback_verbosity'
        `);
        if ((feedbackVerbosityCheck.rows?.[0]?.count || feedbackVerbosityCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN feedback_verbosity VARCHAR(50) DEFAULT 'standard'`);
        }

        const prescriptiveTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'prescriptive_table'
        `);
        if ((prescriptiveTableCheck.rows?.[0]?.count || prescriptiveTableCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN prescriptive_table JSON`);
          await query(`ALTER TABLE marking_results ADD COLUMN reflective_questions JSON`);
          await query(`ALTER TABLE marking_results ADD COLUMN critical_table JSON`);
          await query(`ALTER TABLE marking_results ADD COLUMN genie_output JSON`);
        }

        const improvementForecastCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'improvement_forecast'
        `);
        if ((improvementForecastCheck.rows?.[0]?.count || improvementForecastCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN improvement_forecast TEXT`);
        }

        const comparativeInsightCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'comparative_insight'
        `);
        if ((comparativeInsightCheck.rows?.[0]?.count || comparativeInsightCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN comparative_insight TEXT`);
        }

        const criterionFeedbackTypesCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'criterion_feedback_types'
        `);
        if ((criterionFeedbackTypesCheck.rows?.[0]?.count || criterionFeedbackTypesCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN criterion_feedback_types JSON`);
        }

        const customNameCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'custom_name'
        `);
        if ((customNameCheck.rows?.[0]?.count || customNameCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN custom_name VARCHAR(500) DEFAULT NULL`);
        }

        const overallConfidenceCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'overall_confidence'
        `);
        if ((overallConfidenceCheck.rows?.[0]?.count || overallConfidenceCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN overall_confidence INT DEFAULT NULL`);
        }

        const confidenceLevelCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'confidence_level'
        `);
        if ((confidenceLevelCheck.rows?.[0]?.count || confidenceLevelCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN confidence_level VARCHAR(20) DEFAULT NULL`);
        }

        const needsReviewCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'needs_review'
        `);
        if ((needsReviewCheck.rows?.[0]?.count || needsReviewCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN needs_review TINYINT(1) DEFAULT 0`);
        }

        const minCriterionConfidenceCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'min_criterion_confidence'
        `);
        if ((minCriterionConfidenceCheck.rows?.[0]?.count || minCriterionConfidenceCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN min_criterion_confidence INT DEFAULT NULL`);
        }

        const hasLowCriterionConfidenceCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'marking_results' AND column_name = 'has_low_criterion_confidence'
        `);
        if ((hasLowCriterionConfidenceCheck.rows?.[0]?.count || hasLowCriterionConfidenceCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN has_low_criterion_confidence TINYINT(1) DEFAULT 0`);
        }

        const mediaTypeCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'assignments' AND column_name = 'media_type'
        `);
        if ((mediaTypeCheck.rows?.[0]?.count || mediaTypeCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN media_type VARCHAR(20) NULL`);
        }

        const mediaDurationCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'assignments' AND column_name = 'media_duration_seconds'
        `);
        if ((mediaDurationCheck.rows?.[0]?.count || mediaDurationCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN media_duration_seconds INT NULL`);
        }

        const mediaFramePathsCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'assignments' AND column_name = 'media_frame_paths'
        `);
        if ((mediaFramePathsCheck.rows?.[0]?.count || mediaFramePathsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN media_frame_paths LONGTEXT NULL`);
        }

        const mediaTranscriptSegmentsCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.COLUMNS
          WHERE table_schema = DATABASE() AND table_name = 'assignments' AND column_name = 'media_transcript_segments'
        `);
        if ((mediaTranscriptSegmentsCheck.rows?.[0]?.count || mediaTranscriptSegmentsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN media_transcript_segments LONGTEXT NULL`);
        }

        const mediaProcessingJobsTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'media_processing_jobs'
        `);
        if ((mediaProcessingJobsTableCheck.rows?.[0]?.count || mediaProcessingJobsTableCheck?.[0]?.count || 0) === 0) {
          console.log('Creating media_processing_jobs table...');
          await query(`
            CREATE TABLE media_processing_jobs (
              id INT AUTO_INCREMENT PRIMARY KEY,
              assignment_id INT NOT NULL UNIQUE,
              user_id INT NOT NULL,
              media_type VARCHAR(20) NOT NULL,
              status VARCHAR(50) DEFAULT 'queued',
              stage VARCHAR(50) NULL,
              error_message TEXT NULL,
              retry_count INT DEFAULT 0,
              max_retries INT DEFAULT 3,
              next_retry_at TIMESTAMP NULL,
              started_at TIMESTAMP NULL,
              completed_at TIMESTAMP NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
          `);
        }

        const revisionSeriesTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'revision_series'
        `);
        if ((revisionSeriesTableCheck.rows?.[0]?.count || revisionSeriesTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE revision_series (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT NOT NULL,
              rubric_id INT NOT NULL,
              name VARCHAR(255) NOT NULL,
              student_name VARCHAR(255) NOT NULL,
              student_user_id INT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
              FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE CASCADE,
              FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE SET NULL
            )
          `);
        } else {
          const revisionSeriesStudentUserIdCheck = await query(`
            SELECT COUNT(*) as count FROM information_schema.COLUMNS
            WHERE table_schema = DATABASE() AND table_name = 'revision_series' AND column_name = 'student_user_id'
          `);
          if ((revisionSeriesStudentUserIdCheck.rows?.[0]?.count || revisionSeriesStudentUserIdCheck?.[0]?.count || 0) === 0) {
            await query(`ALTER TABLE revision_series ADD COLUMN student_user_id INT NULL`);
            await query(`ALTER TABLE revision_series ADD FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE SET NULL`);
          }
        }
        const revisionSubmissionsTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'revision_submissions'
        `);
        if ((revisionSubmissionsTableCheck.rows?.[0]?.count || revisionSubmissionsTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE revision_submissions (
              id INT AUTO_INCREMENT PRIMARY KEY,
              series_id INT NOT NULL,
              revision_number INT NOT NULL,
              assignment_id INT NOT NULL,
              marking_result_id INT NULL,
              progress_score DECIMAL(5,2) DEFAULT 0,
              comparison_json LONGTEXT NULL,
              uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (series_id) REFERENCES revision_series(id) ON DELETE CASCADE,
              FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
              FOREIGN KEY (marking_result_id) REFERENCES marking_results(id) ON DELETE SET NULL
            )
          `);
        }
        const userSessionsTableCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.TABLES
          WHERE table_schema = DATABASE() AND table_name = 'user_sessions'
        `);
        if ((userSessionsTableCheck.rows?.[0]?.count || userSessionsTableCheck?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE user_sessions (
              id INT AUTO_INCREMENT PRIMARY KEY,
              user_id INT NOT NULL,
              jti VARCHAR(36) NOT NULL,
              ip_address VARCHAR(45) NULL,
              user_agent TEXT NULL,
              is_active TINYINT(1) DEFAULT 1,
              logged_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
              UNIQUE KEY uq_user_sessions_jti (jti),
              INDEX idx_user_sessions_user (user_id)
            )
          `);
        }
      } catch (err) {
        console.error('Error migrating tables:', err.message);
        // Continue anyway - columns might already exist
      }

      // Add indexes for better query performance (MySQL doesn't support IF NOT EXISTS)
      // Check if indexes exist before creating them
      try {
        const assignmentIndexCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.STATISTICS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND index_name = 'idx_marking_results_assignment'
        `);
        const hasAssignmentIndex = (assignmentIndexCheck.rows?.[0]?.count || assignmentIndexCheck?.[0]?.count || 0) > 0;
        
        if (!hasAssignmentIndex) {
          console.log('Creating index idx_marking_results_assignment...');
          await query(`CREATE INDEX idx_marking_results_assignment ON marking_results(assignment_id)`);
        }
      } catch (err) {
        console.log('Note: Could not create index idx_marking_results_assignment:', err.message);
      }
      
      try {
        const currentIndexCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.STATISTICS 
          WHERE table_schema = DATABASE() 
          AND table_name = 'marking_results' 
          AND index_name = 'idx_marking_results_current'
        `);
        const hasCurrentIndex = (currentIndexCheck.rows?.[0]?.count || currentIndexCheck?.[0]?.count || 0) > 0;
        
        if (!hasCurrentIndex) {
          console.log('Creating index idx_marking_results_current...');
          await query(`CREATE INDEX idx_marking_results_current ON marking_results(assignment_id, is_current)`);
        }
      } catch (err) {
        console.log('Note: Could not create index idx_marking_results_current:', err.message);
      }
    } else {
      await query(`
        CREATE TABLE IF NOT EXISTS organisations (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL UNIQUE,
          features JSONB DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS departments (
          id SERIAL PRIMARY KEY,
          organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(organisation_id, name)
        )
      `);
      // Create users table first
      await query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(255),
          account_type VARCHAR(50) DEFAULT 'individual',
          organisation_name VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login TIMESTAMP,
          is_active BOOLEAN DEFAULT TRUE,
          email_verified BOOLEAN DEFAULT FALSE,
          verification_token VARCHAR(255),
          verification_token_expires TIMESTAMP,
          role VARCHAR(50) DEFAULT 'lecturer',
          is_approved BOOLEAN DEFAULT FALSE,
          organisation_id INTEGER NULL REFERENCES organisations(id) ON DELETE SET NULL,
          department_id INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL
        )
      `);

      // PostgreSQL table creation
      await query(`
        CREATE TABLE IF NOT EXISTS rubrics (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          criteria JSONB NOT NULL,
          total_points INTEGER NOT NULL,
          rubric_type VARCHAR(50) DEFAULT 'rubric',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // Ensure rubric_type column exists
      try {
        await query(`ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS rubric_type VARCHAR(50) DEFAULT 'rubric'`);
      } catch (err) {
        console.log('Note: Could not ensure rubric_type column:', err.message);
      }

      await query(`
        CREATE TABLE IF NOT EXISTS batches (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS assignments (
          id SERIAL PRIMARY KEY,
          filename VARCHAR(255) NOT NULL,
          file_path VARCHAR(500) NOT NULL,
          file_size INTEGER,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status VARCHAR(50) DEFAULT 'uploaded',
          batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
          processing_job_id INTEGER NULL,
          extracted_text TEXT,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS marking_results (
          id SERIAL PRIMARY KEY,
          assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
          rubric_id INTEGER REFERENCES rubrics(id) ON DELETE CASCADE,
          student_name VARCHAR(255),
          scores JSONB NOT NULL,
          feedback TEXT,
          total_score DECIMAL(5,2),
          marked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          version INTEGER DEFAULT 1,
          is_current BOOLEAN DEFAULT TRUE,
          strictness_level VARCHAR(50),
          provider VARCHAR(50),
          corrections JSONB,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS feedback_videos (
          id SERIAL PRIMARY KEY,
          result_id INTEGER NOT NULL REFERENCES marking_results(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          openai_video_id VARCHAR(255),
          status VARCHAR(50) DEFAULT 'queued',
          file_path TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(result_id)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS published_assessments (
          id SERIAL PRIMARY KEY,
          code VARCHAR(32) NOT NULL UNIQUE,
          assessment_json TEXT NOT NULL,
          rubric_id INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
          batch_id INTEGER NULL REFERENCES batches(id) ON DELETE SET NULL,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS assessment_submissions (
          id SERIAL PRIMARY KEY,
          submission_code VARCHAR(32) NOT NULL UNIQUE,
          published_assessment_id INTEGER NOT NULL REFERENCES published_assessments(id) ON DELETE CASCADE,
          assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
          result_id INTEGER NULL REFERENCES marking_results(id) ON DELETE SET NULL,
          student_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
          student_name VARCHAR(255) NOT NULL,
          status VARCHAR(50) DEFAULT 'queued',
          failure_reason TEXT NULL,
          submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP NULL
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_assessment_submissions_student_pub ON assessment_submissions(student_user_id, published_assessment_id)`);

      await query(`
        CREATE TABLE IF NOT EXISTS published_content (
          id SERIAL PRIMARY KEY,
          code VARCHAR(32) NOT NULL UNIQUE,
          title VARCHAR(500) NOT NULL,
          content_json TEXT NOT NULL,
          rubric_id INTEGER NULL REFERENCES rubrics(id) ON DELETE SET NULL,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS courses (
          id SERIAL PRIMARY KEY,
          organisation_id INTEGER NULL REFERENCES organisations(id) ON DELETE SET NULL,
          name VARCHAR(255) NOT NULL,
          code VARCHAR(64) NULL,
          description TEXT NULL,
          term VARCHAR(100) NULL,
          start_date DATE NULL,
          end_date DATE NULL,
          owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_courses_owner ON courses(owner_user_id)
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS course_staff (
          id SERIAL PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role VARCHAR(20) NOT NULL DEFAULT 'lecturer',
          added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(course_id, user_id)
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS course_enrollments (
          id SERIAL PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'active',
          enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          enrolled_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
          UNIQUE(course_id, student_user_id)
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS grade_categories (
          id SERIAL PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          weight_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS grade_items (
          id SERIAL PRIMARY KEY,
          course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          grade_category_id INTEGER NULL REFERENCES grade_categories(id) ON DELETE SET NULL,
          item_type VARCHAR(32) NOT NULL,
          item_id INTEGER NOT NULL,
          title VARCHAR(500) NULL,
          max_points DECIMAL(10,2) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(course_id, item_type, item_id)
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_grade_items_category ON grade_items(grade_category_id)
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS modules (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          course_id INTEGER NULL REFERENCES courses(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS module_items (
          id SERIAL PRIMARY KEY,
          module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
          item_type VARCHAR(32) NOT NULL,
          item_id INTEGER NOT NULL,
          snapshot_title VARCHAR(500) NULL,
          snapshot_code VARCHAR(64) NULL,
          position INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (module_id, item_type, item_id)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_module_items_order ON module_items(module_id, position)`);
      await query(`
        CREATE TABLE IF NOT EXISTS module_students (
          id SERIAL PRIMARY KEY,
          module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
          student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (module_id, student_user_id)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_module_students_module ON module_students(module_id)`);
      await query(`
        CREATE TABLE IF NOT EXISTS homework_module_workflows (
          id SERIAL PRIMARY KEY,
          homework_module_id INTEGER NOT NULL UNIQUE REFERENCES modules(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'draft',
          review_notes TEXT NULL,
          reason_summary TEXT NULL,
          reason_payload_json TEXT NULL,
          reviewed_at TIMESTAMP NULL,
          reviewed_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
          published_at TIMESTAMP NULL,
          published_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_homework_workflows_status ON homework_module_workflows(status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_homework_workflows_user ON homework_module_workflows(user_id)`);
      await query(`
        CREATE TABLE IF NOT EXISTS uploaded_ppt_templates (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          file_name VARCHAR(500) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content_generation_history (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(500) NOT NULL,
          generated_content_json TEXT NOT NULL,
          input_json TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS custom_homework_telemetry (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL,
          duration_ms INTEGER NOT NULL,
          content_generation_ms INTEGER NULL,
          assessment_generation_ms INTEGER NULL,
          assessment_generation_mode VARCHAR(20) NULL,
          prompt_tokens INTEGER NULL,
          completion_tokens INTEGER NULL,
          total_tokens INTEGER NULL,
          estimated_cost_usd NUMERIC(12, 6) NULL,
          error_message TEXT NULL,
          metadata_json TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_custom_homework_telemetry_user_created ON custom_homework_telemetry(user_id, created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_custom_homework_telemetry_status_created ON custom_homework_telemetry(status, created_at)`);
      await query(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
          target_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
          category VARCHAR(50) NOT NULL,
          action VARCHAR(100) NOT NULL,
          outcome VARCHAR(30) NOT NULL DEFAULT 'success',
          organisation_id INTEGER NULL REFERENCES organisations(id) ON DELETE SET NULL,
          department_id INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL,
          metadata_json TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_user_created ON audit_events(user_id, created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_category_created ON audit_events(category, created_at)`);
      await query(`
        CREATE TABLE IF NOT EXISTS homework_workflow_events (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          action VARCHAR(60) NOT NULL,
          status VARCHAR(20) NULL,
          target_count INTEGER NOT NULL DEFAULT 0,
          updated_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          module_ids_json TEXT NULL,
          metadata_json TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_homework_workflow_events_user_created ON homework_workflow_events(user_id, created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_homework_workflow_events_action_created ON homework_workflow_events(action, created_at)`);
      await query(`
        CREATE TABLE IF NOT EXISTS generation_telemetry_events (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          generation_type VARCHAR(40) NOT NULL,
          status VARCHAR(20) NOT NULL,
          provider VARCHAR(50) NULL,
          model VARCHAR(120) NULL,
          duration_ms INTEGER NOT NULL,
          prompt_tokens INTEGER NULL,
          completion_tokens INTEGER NULL,
          total_tokens INTEGER NULL,
          estimated_cost_usd NUMERIC(12, 6) NULL,
          error_type VARCHAR(80) NULL,
          error_message TEXT NULL,
          metadata_json TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_generation_telemetry_created ON generation_telemetry_events(created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_generation_telemetry_type_created ON generation_telemetry_events(generation_type, created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_generation_telemetry_status_created ON generation_telemetry_events(status, created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_generation_telemetry_user_created ON generation_telemetry_events(user_id, created_at)`);
      await query(`
        CREATE TABLE IF NOT EXISTS prompt_registry (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
          generation_type VARCHAR(60) NOT NULL,
          prompt_key VARCHAR(80) NOT NULL DEFAULT 'default',
          version INTEGER NOT NULL,
          prompt_text TEXT NOT NULL,
          provider VARCHAR(50) NULL,
          model VARCHAR(120) NULL,
          temperature NUMERIC(6, 3) NULL,
          max_tokens INTEGER NULL,
          notes TEXT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_prompt_registry_lookup ON prompt_registry(generation_type, prompt_key, user_id, is_active)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_prompt_registry_user_created ON prompt_registry(user_id, created_at)`);
      await query(`
        CREATE TABLE IF NOT EXISTS generation_jobs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_type VARCHAR(60) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
          source_route VARCHAR(120) NULL,
          payload_json TEXT NULL,
          result_json TEXT NULL,
          error_message TEXT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 2,
          scheduled_for TIMESTAMP NULL,
          started_at TIMESTAMP NULL,
          completed_at TIMESTAMP NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_created ON generation_jobs(user_id, created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_generation_jobs_type_status_created ON generation_jobs(job_type, status, created_at)`);
      await query(`
        CREATE TABLE IF NOT EXISTS generation_job_dead_letters (
          id SERIAL PRIMARY KEY,
          job_id INTEGER NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          job_type VARCHAR(60) NOT NULL,
          status VARCHAR(20) NOT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL DEFAULT 0,
          error_message TEXT NULL,
          payload_json TEXT NULL,
          result_json TEXT NULL,
          dead_letter_reason VARCHAR(120) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_generation_job_dead_letters_user_created ON generation_job_dead_letters(user_id, created_at)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_generation_job_dead_letters_type_created ON generation_job_dead_letters(job_type, created_at)`);
      await query(`
        CREATE TABLE IF NOT EXISTS assessment_generation_history (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(500) NOT NULL,
          generated_assessment_json TEXT NOT NULL,
          input_json TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content_planner_jobs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          topics TEXT NOT NULL,
          level VARCHAR(120) NULL,
          num_sections INTEGER DEFAULT 5,
          template_id VARCHAR(60) DEFAULT 'classroom',
          rubric_id INTEGER NULL REFERENCES rubrics(id) ON DELETE SET NULL,
          rubric_context TEXT NULL,
          include_diagrams BOOLEAN DEFAULT TRUE,
          include_images BOOLEAN DEFAULT TRUE,
          include_mascot BOOLEAN DEFAULT FALSE,
          scheduled_for TIMESTAMP NOT NULL,
          status VARCHAR(50) DEFAULT 'scheduled',
          error_message TEXT NULL,
          generated_content_json TEXT NULL,
          published_content_id INTEGER NULL REFERENCES published_content(id) ON DELETE SET NULL,
          published_code VARCHAR(32) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content_videos (
          id SERIAL PRIMARY KEY,
          published_content_id INTEGER NOT NULL REFERENCES published_content(id) ON DELETE CASCADE,
          openai_video_id VARCHAR(255) NOT NULL,
          openai_video_ids TEXT NULL,
          status VARCHAR(50) DEFAULT 'queued',
          file_path TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(published_content_id)
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS video_generations (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL,
          model VARCHAR(60) NOT NULL DEFAULT 'grok-imagine-video-1.5',
          duration_seconds INTEGER NOT NULL DEFAULT 10,
          aspect_ratio VARCHAR(20) NOT NULL DEFAULT '16:9',
          resolution VARCHAR(20) NOT NULL DEFAULT '720p',
          generate_audio BOOLEAN NOT NULL DEFAULT true,
          xai_request_id VARCHAR(255) NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'processing',
          file_path VARCHAR(500) NULL,
          error_message TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_video_generations_user_created ON video_generations(user_id, created_at)
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS lesson_summary_videos (
          id SERIAL PRIMARY KEY,
          published_content_id INTEGER NOT NULL REFERENCES published_content(id) ON DELETE CASCADE,
          video_generation_id INTEGER NULL REFERENCES video_generations(id) ON DELETE SET NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending',
          error_message TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          applied_at TIMESTAMP NULL,
          section_index INTEGER NOT NULL DEFAULT 0,
          UNIQUE (published_content_id, section_index)
        )
      `);
      const lsvSectionColPg = await query(`
        SELECT COUNT(*) as count FROM information_schema.columns
        WHERE table_name = 'lesson_summary_videos' AND column_name = 'section_index'
      `);
      if ((lsvSectionColPg.rows?.[0]?.count || lsvSectionColPg?.[0]?.count || 0) === 0) {
        await query(`ALTER TABLE lesson_summary_videos ADD COLUMN section_index INTEGER NOT NULL DEFAULT 0`);
        await query(`ALTER TABLE lesson_summary_videos DROP CONSTRAINT IF EXISTS lesson_summary_videos_published_content_id_key`);
        await query(`ALTER TABLE lesson_summary_videos ADD CONSTRAINT uniq_lesson_summary_section UNIQUE (published_content_id, section_index)`);
      }
      await query(`
        CREATE TABLE IF NOT EXISTS course_build_jobs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          course_id INTEGER NULL REFERENCES courses(id) ON DELETE SET NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'queued',
          config_json TEXT NOT NULL,
          progress_json TEXT NULL,
          error_message TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS content_progress (
          id SERIAL PRIMARY KEY,
          published_content_id INTEGER NOT NULL REFERENCES published_content(id) ON DELETE CASCADE,
          student_name VARCHAR(255) NOT NULL,
          current_section INTEGER DEFAULT 0,
          checkpoint_answers_json TEXT NULL,
          completed BOOLEAN DEFAULT FALSE,
          score DECIMAL(6,2) DEFAULT NULL,
          progress_json TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (published_content_id, student_name)
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS marking_jobs (
          id SERIAL PRIMARY KEY,
          batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
          rubric_id INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider VARCHAR(50) DEFAULT 'openai',
          processing_mode VARCHAR(50) DEFAULT 'standard',
          status VARCHAR(50) DEFAULT 'scheduled',
          scheduled_for TIMESTAMP NULL,
          started_at TIMESTAMP NULL,
          completed_at TIMESTAMP NULL,
          request_count INTEGER DEFAULT 0,
          total_count INTEGER DEFAULT 0,
          processed_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          failed_count INTEGER DEFAULT 0,
          openai_batch_id VARCHAR(255) NULL,
          openai_input_file_id VARCHAR(255) NULL,
          openai_output_file_id VARCHAR(255) NULL,
          openai_error_file_id VARCHAR(255) NULL,
          completion_window VARCHAR(20) NULL,
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3,
          next_retry_at TIMESTAMP NULL,
          last_status_at TIMESTAMP NULL,
          last_error TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS marking_result_moderation (
          id SERIAL PRIMARY KEY,
          result_id INTEGER NOT NULL UNIQUE REFERENCES marking_results(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          flagged_for_moderation BOOLEAN DEFAULT FALSE,
          moderation_reason TEXT NULL,
          custom_feedback TEXT NULL,
          override_total_score DECIMAL(7,2) NULL,
          updated_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS revision_series (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          rubric_id INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          student_name VARCHAR(255) NOT NULL,
          student_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS revision_submissions (
          id SERIAL PRIMARY KEY,
          series_id INTEGER NOT NULL REFERENCES revision_series(id) ON DELETE CASCADE,
          revision_number INTEGER NOT NULL,
          assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
          marking_result_id INTEGER NULL REFERENCES marking_results(id) ON DELETE SET NULL,
          progress_score DECIMAL(5,2) DEFAULT 0,
          comparison_json TEXT NULL,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          jti VARCHAR(36) NOT NULL UNIQUE,
          ip_address VARCHAR(45) NULL,
          user_agent TEXT NULL,
          is_active BOOLEAN DEFAULT TRUE,
          logged_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_jti ON user_sessions(jti)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)`);

      // Migrate existing tables: Add new columns if they don't exist (PostgreSQL)
      try {
        const orgIdCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_name = 'users'
          AND column_name = 'organisation_id'
        `);
        if ((orgIdCheck.rows?.[0]?.count || orgIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN organisation_id INTEGER NULL REFERENCES organisations(id) ON DELETE SET NULL`);
        }
        const departmentIdCheckPg = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_name = 'users'
          AND column_name = 'department_id'
        `);
        if ((departmentIdCheckPg.rows?.[0]?.count || departmentIdCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN department_id INTEGER NULL REFERENCES departments(id) ON DELETE SET NULL`);
        }

        // Check and add columns if they don't exist
        const versionCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'marking_results' 
          AND column_name = 'version'
        `);
        if ((versionCheck.rows?.[0]?.count || versionCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN version INTEGER DEFAULT 1`);
        }
        
        const isCurrentCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'marking_results' 
          AND column_name = 'is_current'
        `);
        if ((isCurrentCheck.rows?.[0]?.count || isCurrentCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN is_current BOOLEAN DEFAULT TRUE`);
          await query(`UPDATE marking_results SET is_current = TRUE WHERE is_current IS NULL`);
        }
        
        const strictnessCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'marking_results' 
          AND column_name = 'strictness_level'
        `);
        if ((strictnessCheck.rows?.[0]?.count || strictnessCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN strictness_level VARCHAR(50)`);
        }
        
        const providerCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'marking_results' 
          AND column_name = 'provider'
        `);
        if ((providerCheck.rows?.[0]?.count || providerCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN provider VARCHAR(50)`);
        }
        
        const correctionsCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'marking_results' 
          AND column_name = 'corrections'
        `);
        if ((correctionsCheck.rows?.[0]?.count || correctionsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN corrections JSONB`);
        }
        
        const languageErrorsCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'marking_results' 
          AND column_name = 'language_errors'
        `);
        if ((languageErrorsCheck.rows?.[0]?.count || languageErrorsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN language_errors JSONB`);
        }
        
        // Check if batch_id column exists in assignments
        const batchIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'assignments' 
          AND column_name = 'batch_id'
        `);
        if ((batchIdCheck.rows?.[0]?.count || batchIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL`);
        }

        const processingJobIdCheckPg = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_name = 'assignments'
          AND column_name = 'processing_job_id'
        `);
        if ((processingJobIdCheckPg.rows?.[0]?.count || processingJobIdCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN processing_job_id INTEGER NULL`);
        }
        
        // Check if extracted_text column exists
        const extractedTextCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'assignments' 
          AND column_name = 'extracted_text'
        `);
        if ((extractedTextCheck.rows?.[0]?.count || extractedTextCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN extracted_text TEXT`);
        }
        
        // Add user_id columns if they don't exist
        const rubricUserIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'rubrics' 
          AND column_name = 'user_id'
        `);
        if ((rubricUserIdCheck.rows?.[0]?.count || rubricUserIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE rubrics ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
        }
        
        const batchesUserIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'batches' 
          AND column_name = 'user_id'
        `);
        if ((batchesUserIdCheck.rows?.[0]?.count || batchesUserIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE batches ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
        }
        
        const assignmentsUserIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'assignments' 
          AND column_name = 'user_id'
        `);
        if ((assignmentsUserIdCheck.rows?.[0]?.count || assignmentsUserIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
        }
        
        const markingResultsUserIdCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'marking_results' 
          AND column_name = 'user_id'
        `);
        if ((markingResultsUserIdCheck.rows?.[0]?.count || markingResultsUserIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
        }

        const handwritingConfCheckPg = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'marking_results' 
          AND column_name = 'handwriting_recognition_confidence'
        `);
        if ((handwritingConfCheckPg.rows?.[0]?.count || handwritingConfCheckPg?.[0]?.count || 0) === 0) {
          console.log('Adding handwriting_recognition_confidence column to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN handwriting_recognition_confidence INTEGER DEFAULT NULL`);
        }

        const promptTokensCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'prompt_tokens'
        `);
        if ((promptTokensCheckPg.rows?.[0]?.count || promptTokensCheckPg?.[0]?.count || 0) === 0) {
          console.log('Adding token usage columns to marking_results table...');
          await query(`ALTER TABLE marking_results ADD COLUMN prompt_tokens INTEGER DEFAULT NULL`);
          await query(`ALTER TABLE marking_results ADD COLUMN completion_tokens INTEGER DEFAULT NULL`);
          await query(`ALTER TABLE marking_results ADD COLUMN total_tokens INTEGER DEFAULT NULL`);
          await query(`ALTER TABLE marking_results ADD COLUMN estimated_cost_usd DECIMAL(12,6) DEFAULT NULL`);
        }

        const markingJobProviderCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'provider'
        `);
        if ((markingJobProviderCheckPg.rows?.[0]?.count || markingJobProviderCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN provider VARCHAR(50) DEFAULT 'openai'`);
        }

        const markingJobModeCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'processing_mode'
        `);
        if ((markingJobModeCheckPg.rows?.[0]?.count || markingJobModeCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN processing_mode VARCHAR(50) DEFAULT 'standard'`);
        }

        const markingJobRequestCountCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'request_count'
        `);
        if ((markingJobRequestCountCheckPg.rows?.[0]?.count || markingJobRequestCountCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN request_count INTEGER DEFAULT 0`);
        }

        const markingJobBatchIdCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'openai_batch_id'
        `);
        if ((markingJobBatchIdCheckPg.rows?.[0]?.count || markingJobBatchIdCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN openai_batch_id VARCHAR(255) DEFAULT NULL`);
          await query(`ALTER TABLE marking_jobs ADD COLUMN openai_input_file_id VARCHAR(255) DEFAULT NULL`);
          await query(`ALTER TABLE marking_jobs ADD COLUMN openai_output_file_id VARCHAR(255) DEFAULT NULL`);
          await query(`ALTER TABLE marking_jobs ADD COLUMN openai_error_file_id VARCHAR(255) DEFAULT NULL`);
          await query(`ALTER TABLE marking_jobs ADD COLUMN completion_window VARCHAR(20) DEFAULT NULL`);
        }

        const markingJobRetryCountCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'retry_count'
        `);
        if ((markingJobRetryCountCheckPg.rows?.[0]?.count || markingJobRetryCountCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN retry_count INTEGER DEFAULT 0`);
        }

        const markingJobMaxRetriesCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'max_retries'
        `);
        if ((markingJobMaxRetriesCheckPg.rows?.[0]?.count || markingJobMaxRetriesCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN max_retries INTEGER DEFAULT 3`);
        }

        const markingJobNextRetryCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'next_retry_at'
        `);
        if ((markingJobNextRetryCheckPg.rows?.[0]?.count || markingJobNextRetryCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN next_retry_at TIMESTAMP NULL`);
        }

        const markingJobLastStatusCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'last_status_at'
        `);
        if ((markingJobLastStatusCheckPg.rows?.[0]?.count || markingJobLastStatusCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN last_status_at TIMESTAMP NULL`);
        }

        const markingJobStrictnessCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'strictness_level'
        `);
        if ((markingJobStrictnessCheckPg.rows?.[0]?.count || markingJobStrictnessCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN strictness_level VARCHAR(50) DEFAULT 'strict'`);
        }

        const markingJobFeedbackTypeCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'feedback_type'
        `);
        if ((markingJobFeedbackTypeCheckPg.rows?.[0]?.count || markingJobFeedbackTypeCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN feedback_type VARCHAR(50) DEFAULT 'standard'`);
        }

        const markingJobFeedbackVerbosityCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_jobs' AND column_name = 'feedback_verbosity'
        `);
        if ((markingJobFeedbackVerbosityCheckPg.rows?.[0]?.count || markingJobFeedbackVerbosityCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_jobs ADD COLUMN feedback_verbosity VARCHAR(50) DEFAULT 'standard'`);
        }

        const publishedAssessmentBatchCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'published_assessments' AND column_name = 'batch_id'
        `);
        if ((publishedAssessmentBatchCheckPg.rows?.[0]?.count || publishedAssessmentBatchCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE published_assessments ADD COLUMN batch_id INTEGER NULL REFERENCES batches(id) ON DELETE SET NULL`);
        }

        const assessmentSubmissionsTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'assessment_submissions'
        `);
        if ((assessmentSubmissionsTableCheckPg.rows?.[0]?.count || assessmentSubmissionsTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE assessment_submissions (
              id SERIAL PRIMARY KEY,
              submission_code VARCHAR(32) NOT NULL UNIQUE,
              published_assessment_id INTEGER NOT NULL REFERENCES published_assessments(id) ON DELETE CASCADE,
              assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
              result_id INTEGER NULL REFERENCES marking_results(id) ON DELETE SET NULL,
              student_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
              student_name VARCHAR(255) NOT NULL,
              status VARCHAR(50) DEFAULT 'queued',
              failure_reason TEXT NULL,
              submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              completed_at TIMESTAMP NULL
            )
          `);
        }

        const assessmentSubmissionsStudentUserCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'assessment_submissions' AND column_name = 'student_user_id'
        `);
        if ((assessmentSubmissionsStudentUserCheckPg.rows?.[0]?.count || assessmentSubmissionsStudentUserCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assessment_submissions ADD COLUMN student_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL`);
        }
        await query(`CREATE INDEX IF NOT EXISTS idx_assessment_submissions_student_pub ON assessment_submissions(student_user_id, published_assessment_id)`);
        const homeworkWorkflowTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'homework_module_workflows'
        `);
        if ((homeworkWorkflowTableCheckPg.rows?.[0]?.count || homeworkWorkflowTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE homework_module_workflows (
              id SERIAL PRIMARY KEY,
              homework_module_id INTEGER NOT NULL UNIQUE REFERENCES modules(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              status VARCHAR(20) NOT NULL DEFAULT 'draft',
              review_notes TEXT NULL,
              reason_summary TEXT NULL,
              reason_payload_json TEXT NULL,
              reviewed_at TIMESTAMP NULL,
              reviewed_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
              published_at TIMESTAMP NULL,
              published_by_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
          await query(`CREATE INDEX IF NOT EXISTS idx_homework_workflows_status ON homework_module_workflows(status)`);
          await query(`CREATE INDEX IF NOT EXISTS idx_homework_workflows_user ON homework_module_workflows(user_id)`);
        }
        const homeworkWorkflowReasonSummaryCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'homework_module_workflows' AND column_name = 'reason_summary'
        `);
        if ((homeworkWorkflowReasonSummaryCheckPg.rows?.[0]?.count || homeworkWorkflowReasonSummaryCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE homework_module_workflows ADD COLUMN reason_summary TEXT NULL`);
        }
        const homeworkWorkflowReasonPayloadCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'homework_module_workflows' AND column_name = 'reason_payload_json'
        `);
        if ((homeworkWorkflowReasonPayloadCheckPg.rows?.[0]?.count || homeworkWorkflowReasonPayloadCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE homework_module_workflows ADD COLUMN reason_payload_json TEXT NULL`);
        }
        const homeworkWorkflowEventsTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'homework_workflow_events'
        `);
        if ((homeworkWorkflowEventsTableCheckPg.rows?.[0]?.count || homeworkWorkflowEventsTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE homework_workflow_events (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              action VARCHAR(60) NOT NULL,
              status VARCHAR(20) NULL,
              target_count INTEGER NOT NULL DEFAULT 0,
              updated_count INTEGER NOT NULL DEFAULT 0,
              skipped_count INTEGER NOT NULL DEFAULT 0,
              module_ids_json TEXT NULL,
              metadata_json TEXT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
          await query(`CREATE INDEX IF NOT EXISTS idx_homework_workflow_events_user_created ON homework_workflow_events(user_id, created_at)`);
          await query(`CREATE INDEX IF NOT EXISTS idx_homework_workflow_events_action_created ON homework_workflow_events(action, created_at)`);
        }
        const generationTelemetryEventsTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'generation_telemetry_events'
        `);
        if ((generationTelemetryEventsTableCheckPg.rows?.[0]?.count || generationTelemetryEventsTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE generation_telemetry_events (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              generation_type VARCHAR(40) NOT NULL,
              status VARCHAR(20) NOT NULL,
              provider VARCHAR(50) NULL,
              model VARCHAR(120) NULL,
              duration_ms INTEGER NOT NULL,
              prompt_tokens INTEGER NULL,
              completion_tokens INTEGER NULL,
              total_tokens INTEGER NULL,
              estimated_cost_usd NUMERIC(12, 6) NULL,
              error_type VARCHAR(80) NULL,
              error_message TEXT NULL,
              metadata_json TEXT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
          await query(`CREATE INDEX IF NOT EXISTS idx_generation_telemetry_created ON generation_telemetry_events(created_at)`);
          await query(`CREATE INDEX IF NOT EXISTS idx_generation_telemetry_type_created ON generation_telemetry_events(generation_type, created_at)`);
          await query(`CREATE INDEX IF NOT EXISTS idx_generation_telemetry_status_created ON generation_telemetry_events(status, created_at)`);
          await query(`CREATE INDEX IF NOT EXISTS idx_generation_telemetry_user_created ON generation_telemetry_events(user_id, created_at)`);
        }
        const promptRegistryTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'prompt_registry'
        `);
        if ((promptRegistryTableCheckPg.rows?.[0]?.count || promptRegistryTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE prompt_registry (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE,
              generation_type VARCHAR(60) NOT NULL,
              prompt_key VARCHAR(80) NOT NULL DEFAULT 'default',
              version INTEGER NOT NULL,
              prompt_text TEXT NOT NULL,
              provider VARCHAR(50) NULL,
              model VARCHAR(120) NULL,
              temperature NUMERIC(6, 3) NULL,
              max_tokens INTEGER NULL,
              notes TEXT NULL,
              is_active BOOLEAN NOT NULL DEFAULT TRUE,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
          await query(`CREATE INDEX IF NOT EXISTS idx_prompt_registry_lookup ON prompt_registry(generation_type, prompt_key, user_id, is_active)`);
          await query(`CREATE INDEX IF NOT EXISTS idx_prompt_registry_user_created ON prompt_registry(user_id, created_at)`);
        }
        const generationJobsTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'generation_jobs'
        `);
        if ((generationJobsTableCheckPg.rows?.[0]?.count || generationJobsTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE generation_jobs (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              job_type VARCHAR(60) NOT NULL,
              status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
              source_route VARCHAR(120) NULL,
              payload_json TEXT NULL,
              result_json TEXT NULL,
              error_message TEXT NULL,
              retry_count INTEGER NOT NULL DEFAULT 0,
              max_retries INTEGER NOT NULL DEFAULT 2,
              scheduled_for TIMESTAMP NULL,
              started_at TIMESTAMP NULL,
              completed_at TIMESTAMP NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
          await query(`CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_created ON generation_jobs(user_id, created_at)`);
          await query(`CREATE INDEX IF NOT EXISTS idx_generation_jobs_type_status_created ON generation_jobs(job_type, status, created_at)`);
        }
        const generationDeadLettersTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'generation_job_dead_letters'
        `);
        if ((generationDeadLettersTableCheckPg.rows?.[0]?.count || generationDeadLettersTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE generation_job_dead_letters (
              id SERIAL PRIMARY KEY,
              job_id INTEGER NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              job_type VARCHAR(60) NOT NULL,
              status VARCHAR(20) NOT NULL,
              retry_count INTEGER NOT NULL DEFAULT 0,
              max_retries INTEGER NOT NULL DEFAULT 0,
              error_message TEXT NULL,
              payload_json TEXT NULL,
              result_json TEXT NULL,
              dead_letter_reason VARCHAR(120) NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
          await query(`CREATE INDEX IF NOT EXISTS idx_generation_job_dead_letters_user_created ON generation_job_dead_letters(user_id, created_at)`);
          await query(`CREATE INDEX IF NOT EXISTS idx_generation_job_dead_letters_type_created ON generation_job_dead_letters(job_type, created_at)`);
        }
        await query(`
          WITH candidates AS (
            SELECT
              s.id AS submission_id,
              MIN(ms.student_user_id) AS matched_student_user_id
            FROM assessment_submissions s
            INNER JOIN published_assessments pa ON pa.id = s.published_assessment_id
            INNER JOIN module_items mi ON mi.item_type = 'assessment' AND mi.item_id = s.published_assessment_id
            INNER JOIN modules m ON m.id = mi.module_id AND m.user_id = pa.user_id
            INNER JOIN module_students ms ON ms.module_id = mi.module_id
            INNER JOIN users u ON u.id = ms.student_user_id
            WHERE s.student_user_id IS NULL
              AND (
                LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.name, '')))
                OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(COALESCE(u.email, '')))
                OR LOWER(TRIM(COALESCE(s.student_name, ''))) = LOWER(TRIM(SPLIT_PART(COALESCE(u.email, ''), '@', 1)))
              )
            GROUP BY s.id
          )
          UPDATE assessment_submissions s
          SET student_user_id = c.matched_student_user_id
          FROM candidates c
          WHERE s.id = c.submission_id
            AND s.student_user_id IS NULL
        `);
        
        const accountTypeCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'account_type'
        `);
        if ((accountTypeCheck.rows?.[0]?.count || accountTypeCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN account_type VARCHAR(50) DEFAULT 'individual'`);
        }
        
        const orgNameCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'organisation_name'
        `);
        if ((orgNameCheck.rows?.[0]?.count || orgNameCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN organisation_name VARCHAR(255)`);
        }
        
        const emailVerifiedCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'email_verified'
        `);
        if ((emailVerifiedCheck.rows?.[0]?.count || emailVerifiedCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE`);
        }
        
        const verificationTokenCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'verification_token'
        `);
        if ((verificationTokenCheck.rows?.[0]?.count || verificationTokenCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN verification_token VARCHAR(255)`);
        }
        
        const verificationTokenExpiresCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'verification_token_expires'
        `);
        if ((verificationTokenExpiresCheck.rows?.[0]?.count || verificationTokenExpiresCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN verification_token_expires TIMESTAMP`);
        }

        // One-time account setup / password reset links (only a hash of the token is stored).
        const SetupTokenHashCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'setup_token_hash'
        `);
        if ((SetupTokenHashCheck.rows?.[0]?.count || SetupTokenHashCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN setup_token_hash VARCHAR(64) NULL`);
        }

        const SetupTokenExpiresCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'setup_token_expires'
        `);
        if ((SetupTokenExpiresCheck.rows?.[0]?.count || SetupTokenExpiresCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN setup_token_expires TIMESTAMP`);
        }

        const SetupTokenPurposeCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'setup_token_purpose'
        `);
        if ((SetupTokenPurposeCheck.rows?.[0]?.count || SetupTokenPurposeCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN setup_token_purpose VARCHAR(20) NULL`);
        }
        
        const roleCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'role'
        `);
        if ((roleCheck.rows?.[0]?.count || roleCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN role VARCHAR(50) DEFAULT 'lecturer'`);
        }
        
        const isApprovedCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'is_approved'
        `);
        if ((isApprovedCheck.rows?.[0]?.count || isApprovedCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN is_approved BOOLEAN DEFAULT FALSE`);
        }
        const featuresCheck = await query(`
          SELECT COUNT(*) as count 
          FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'features'
        `);
        if ((featuresCheck.rows?.[0]?.count || featuresCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE users ADD COLUMN features JSONB DEFAULT NULL`);
        }
        const orgFeaturesCheck = await query(`
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_name = 'organisations'
          AND column_name = 'features'
        `);
        if ((orgFeaturesCheck.rows?.[0]?.count || orgFeaturesCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE organisations ADD COLUMN features JSONB DEFAULT NULL`);
        }
        const videoIdsCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'feedback_videos' AND column_name = 'openai_video_ids'
        `);
        if ((videoIdsCheck.rows?.[0]?.count || videoIdsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE feedback_videos ADD COLUMN openai_video_ids TEXT DEFAULT NULL`);
        }
        const contentVideoIdsCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'content_videos' AND column_name = 'openai_video_ids'
        `);
        if ((contentVideoIdsCheck.rows?.[0]?.count || contentVideoIdsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE content_videos ADD COLUMN openai_video_ids TEXT DEFAULT NULL`);
        }
        const modulesCourseIdCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'modules' AND column_name = 'course_id'
        `);
        if ((modulesCourseIdCheck.rows?.[0]?.count || modulesCourseIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE modules ADD COLUMN course_id INTEGER NULL REFERENCES courses(id) ON DELETE SET NULL`);
        }
        // Libraries can be separated by course (course_id is set on publish; existing items are filed from their module).
        const published_contentCourseIdCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'published_content' AND column_name = 'course_id'
        `);
        if ((published_contentCourseIdCheck.rows?.[0]?.count || published_contentCourseIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE published_content ADD COLUMN course_id INTEGER NULL`);
          try {
            await query(`
              UPDATE published_content SET course_id = (
                SELECT m.course_id FROM module_items mi
                INNER JOIN modules m ON m.id = mi.module_id
                WHERE mi.item_type = 'content' AND mi.item_id = published_content.id AND m.course_id IS NOT NULL
                ORDER BY mi.id LIMIT 1
              )
            `);
          } catch (backfillError) {
            console.warn('Could not backfill published_content.course_id:', backfillError?.message || backfillError);
          }
        }
        // Libraries can be separated by course (course_id is set on publish; existing items are filed from their module).
        const published_assessmentsCourseIdCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'published_assessments' AND column_name = 'course_id'
        `);
        if ((published_assessmentsCourseIdCheck.rows?.[0]?.count || published_assessmentsCourseIdCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE published_assessments ADD COLUMN course_id INTEGER NULL`);
          try {
            await query(`
              UPDATE published_assessments SET course_id = (
                SELECT m.course_id FROM module_items mi
                INNER JOIN modules m ON m.id = mi.module_id
                WHERE mi.item_type = 'assessment' AND mi.item_id = published_assessments.id AND m.course_id IS NOT NULL
                ORDER BY mi.id LIMIT 1
              )
            `);
          } catch (backfillError) {
            console.warn('Could not backfill published_assessments.course_id:', backfillError?.message || backfillError);
          }
        }
        const plannerIncludeDiagramsCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'content_planner_jobs' AND column_name = 'include_diagrams'
        `);
        if ((plannerIncludeDiagramsCheck.rows?.[0]?.count || plannerIncludeDiagramsCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE content_planner_jobs ADD COLUMN include_diagrams BOOLEAN DEFAULT TRUE`);
        }
        const plannerIncludeImagesCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'content_planner_jobs' AND column_name = 'include_images'
        `);
        if ((plannerIncludeImagesCheck.rows?.[0]?.count || plannerIncludeImagesCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE content_planner_jobs ADD COLUMN include_images BOOLEAN DEFAULT TRUE`);
        }
        const plannerIncludeMascotCheck = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'content_planner_jobs' AND column_name = 'include_mascot'
        `);
        if ((plannerIncludeMascotCheck.rows?.[0]?.count || plannerIncludeMascotCheck?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE content_planner_jobs ADD COLUMN include_mascot BOOLEAN DEFAULT FALSE`);
        }

        const feedbackTypeCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'feedback_type'
        `);
        if ((feedbackTypeCheckPg.rows?.[0]?.count || feedbackTypeCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN feedback_type VARCHAR(50) DEFAULT 'standard'`);
        }

        const feedbackVerbosityCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'feedback_verbosity'
        `);
        if ((feedbackVerbosityCheckPg.rows?.[0]?.count || feedbackVerbosityCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN feedback_verbosity VARCHAR(50) DEFAULT 'standard'`);
        }

        const prescriptiveTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'prescriptive_table'
        `);
        if ((prescriptiveTableCheckPg.rows?.[0]?.count || prescriptiveTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN prescriptive_table JSONB`);
          await query(`ALTER TABLE marking_results ADD COLUMN reflective_questions JSONB`);
          await query(`ALTER TABLE marking_results ADD COLUMN critical_table JSONB`);
          await query(`ALTER TABLE marking_results ADD COLUMN genie_output JSONB`);
        }

        const improvementForecastCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'improvement_forecast'
        `);
        if ((improvementForecastCheckPg.rows?.[0]?.count || improvementForecastCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN improvement_forecast TEXT`);
        }

        const comparativeInsightCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'comparative_insight'
        `);
        if ((comparativeInsightCheckPg.rows?.[0]?.count || comparativeInsightCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN comparative_insight TEXT`);
        }

        const criterionFeedbackTypesCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'criterion_feedback_types'
        `);
        if ((criterionFeedbackTypesCheckPg.rows?.[0]?.count || criterionFeedbackTypesCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN criterion_feedback_types JSONB`);
        }

        const overallConfidenceCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'overall_confidence'
        `);
        if ((overallConfidenceCheckPg.rows?.[0]?.count || overallConfidenceCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN overall_confidence INTEGER DEFAULT NULL`);
        }

        const confidenceLevelCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'confidence_level'
        `);
        if ((confidenceLevelCheckPg.rows?.[0]?.count || confidenceLevelCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN confidence_level VARCHAR(20) DEFAULT NULL`);
        }

        const needsReviewCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'needs_review'
        `);
        if ((needsReviewCheckPg.rows?.[0]?.count || needsReviewCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN needs_review BOOLEAN DEFAULT FALSE`);
        }

        const minCriterionConfidenceCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'min_criterion_confidence'
        `);
        if ((minCriterionConfidenceCheckPg.rows?.[0]?.count || minCriterionConfidenceCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN min_criterion_confidence INTEGER DEFAULT NULL`);
        }

        const hasLowCriterionConfidenceCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'marking_results' AND column_name = 'has_low_criterion_confidence'
        `);
        if ((hasLowCriterionConfidenceCheckPg.rows?.[0]?.count || hasLowCriterionConfidenceCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE marking_results ADD COLUMN has_low_criterion_confidence BOOLEAN DEFAULT FALSE`);
        }

        const mediaTypeCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'assignments' AND column_name = 'media_type'
        `);
        if ((mediaTypeCheckPg.rows?.[0]?.count || mediaTypeCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN media_type VARCHAR(20) NULL`);
        }

        const mediaDurationCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'assignments' AND column_name = 'media_duration_seconds'
        `);
        if ((mediaDurationCheckPg.rows?.[0]?.count || mediaDurationCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN media_duration_seconds INTEGER NULL`);
        }

        const mediaFramePathsCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'assignments' AND column_name = 'media_frame_paths'
        `);
        if ((mediaFramePathsCheckPg.rows?.[0]?.count || mediaFramePathsCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN media_frame_paths TEXT NULL`);
        }

        const mediaTranscriptSegmentsCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.columns
          WHERE table_name = 'assignments' AND column_name = 'media_transcript_segments'
        `);
        if ((mediaTranscriptSegmentsCheckPg.rows?.[0]?.count || mediaTranscriptSegmentsCheckPg?.[0]?.count || 0) === 0) {
          await query(`ALTER TABLE assignments ADD COLUMN media_transcript_segments TEXT NULL`);
        }

        const mediaProcessingJobsTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'media_processing_jobs'
        `);
        if ((mediaProcessingJobsTableCheckPg.rows?.[0]?.count || mediaProcessingJobsTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE media_processing_jobs (
              id SERIAL PRIMARY KEY,
              assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              media_type VARCHAR(20) NOT NULL,
              status VARCHAR(50) DEFAULT 'queued',
              stage VARCHAR(50) NULL,
              error_message TEXT NULL,
              retry_count INTEGER DEFAULT 0,
              max_retries INTEGER DEFAULT 3,
              next_retry_at TIMESTAMP NULL,
              started_at TIMESTAMP NULL,
              completed_at TIMESTAMP NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
        }

        const revisionSeriesTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'revision_series'
        `);
        if ((revisionSeriesTableCheckPg.rows?.[0]?.count || revisionSeriesTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE revision_series (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              rubric_id INTEGER NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
              name VARCHAR(255) NOT NULL,
              student_name VARCHAR(255) NOT NULL,
              student_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
        } else {
          const revisionSeriesStudentUserIdCheckPg = await query(`
            SELECT COUNT(*) as count FROM information_schema.columns
            WHERE table_name = 'revision_series' AND column_name = 'student_user_id'
          `);
          if ((revisionSeriesStudentUserIdCheckPg.rows?.[0]?.count || revisionSeriesStudentUserIdCheckPg?.[0]?.count || 0) === 0) {
            await query(`ALTER TABLE revision_series ADD COLUMN student_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL`);
          }
        }
        const revisionSubmissionsTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'revision_submissions'
        `);
        if ((revisionSubmissionsTableCheckPg.rows?.[0]?.count || revisionSubmissionsTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE revision_submissions (
              id SERIAL PRIMARY KEY,
              series_id INTEGER NOT NULL REFERENCES revision_series(id) ON DELETE CASCADE,
              revision_number INTEGER NOT NULL,
              assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
              marking_result_id INTEGER NULL REFERENCES marking_results(id) ON DELETE SET NULL,
              progress_score DECIMAL(5,2) DEFAULT 0,
              comparison_json TEXT NULL,
              uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
        }
        const userSessionsTableCheckPg = await query(`
          SELECT COUNT(*) as count FROM information_schema.tables
          WHERE table_name = 'user_sessions'
        `);
        if ((userSessionsTableCheckPg.rows?.[0]?.count || userSessionsTableCheckPg?.[0]?.count || 0) === 0) {
          await query(`
            CREATE TABLE user_sessions (
              id SERIAL PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              jti VARCHAR(36) NOT NULL UNIQUE,
              ip_address VARCHAR(45) NULL,
              user_agent TEXT NULL,
              is_active BOOLEAN DEFAULT TRUE,
              logged_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
          `);
          await query(`CREATE INDEX idx_user_sessions_jti ON user_sessions(jti)`);
          await query(`CREATE INDEX idx_user_sessions_user ON user_sessions(user_id)`);
        }
      } catch (err) {
        console.log('Note: Migration may have failed (columns may already exist):', err.message);
      }

      // Add indexes for better query performance (PostgreSQL supports IF NOT EXISTS)
      try {
        await query(`CREATE INDEX IF NOT EXISTS idx_marking_results_assignment ON marking_results(assignment_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_marking_results_current ON marking_results(assignment_id, is_current)`);
      } catch (err) {
        // Index might already exist, ignore
        console.log('Note: Some indexes may already exist');
      }
    }

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
};

// Normalize DB result shapes across MySQL and PostgreSQL drivers.
// MySQL driver returns an array directly; PostgreSQL returns { rows: [...] }.
const rowsOf = (result) => (Array.isArray(result) ? result : (result?.rows || []));
const firstRow = (result) => rowsOf(result)[0] ?? null;

module.exports = {
  query,
  initDatabase,
  getPool,
  rowsOf,
  firstRow
};
