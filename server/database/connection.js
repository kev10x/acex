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

    // Check if using MySQL
    if (connectionString.startsWith('mysql:')) {
      isMySQL = true;
      console.log('Using MySQL database:', connectionString);
      const mysqlDb = require('./mysql');
      return mysqlDb;
    } else {
      console.log('Using PostgreSQL database:', connectionString);
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
          student_name VARCHAR(255) NOT NULL,
          status VARCHAR(50) DEFAULT 'queued',
          failure_reason TEXT NULL,
          submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP NULL,
          FOREIGN KEY (published_assessment_id) REFERENCES published_assessments(id) ON DELETE CASCADE,
          FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
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
        CREATE TABLE IF NOT EXISTS content_planner_jobs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          topics TEXT NOT NULL,
          level VARCHAR(120) NULL,
          num_sections INT DEFAULT 5,
          template_id VARCHAR(60) DEFAULT 'classroom',
          rubric_id INT NULL,
          rubric_context TEXT NULL,
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
              student_name VARCHAR(255) NOT NULL,
              status VARCHAR(50) DEFAULT 'queued',
              failure_reason TEXT NULL,
              submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              completed_at TIMESTAMP NULL,
              FOREIGN KEY (published_assessment_id) REFERENCES published_assessments(id) ON DELETE CASCADE,
              FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
              FOREIGN KEY (result_id) REFERENCES marking_results(id) ON DELETE SET NULL
            )
          `);
        }
        
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
          student_name VARCHAR(255) NOT NULL,
          status VARCHAR(50) DEFAULT 'queued',
          failure_reason TEXT NULL,
          submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMP NULL
        )
      `);

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
        CREATE TABLE IF NOT EXISTS content_planner_jobs (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          topics TEXT NOT NULL,
          level VARCHAR(120) NULL,
          num_sections INTEGER DEFAULT 5,
          template_id VARCHAR(60) DEFAULT 'classroom',
          rubric_id INTEGER NULL REFERENCES rubrics(id) ON DELETE SET NULL,
          rubric_context TEXT NULL,
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
              student_name VARCHAR(255) NOT NULL,
              status VARCHAR(50) DEFAULT 'queued',
              failure_reason TEXT NULL,
              submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              completed_at TIMESTAMP NULL
            )
          `);
        }
        
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

module.exports = {
  query,
  initDatabase,
  getPool
};
