const { Pool } = require('pg');
const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;
let isSQLite = false;
let isMySQL = false;

const getPool = () => {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    // Check if using SQLite
    if (connectionString.startsWith('sqlite:')) {
      isSQLite = true;
      console.log('Using SQLite database:', connectionString);
      const sqliteDb = require('./sqlite');
      return sqliteDb;
    } else if (connectionString.startsWith('mysql:')) {
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
    if (isSQLite || isMySQL) {
      // Convert PostgreSQL placeholders ($1, $2, etc.) to SQLite/MySQL placeholders (?, ?, etc.)
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
    const usingSQLite = connectionString && connectionString.startsWith('sqlite:');
    const usingMySQL = connectionString && connectionString.startsWith('mysql:');
    console.log('Initializing database, isSQLite:', usingSQLite, 'isMySQL:', usingMySQL);
    
    if (usingSQLite) {
      // Create users table first
      await query(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          name TEXT,
          account_type TEXT DEFAULT 'individual',
          organisation_name TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_login DATETIME,
          is_active INTEGER DEFAULT 1
        )
      `);

      // SQLite table creation with proper syntax
      await query(`
        CREATE TABLE IF NOT EXISTS rubrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          criteria TEXT NOT NULL,
          total_points INTEGER NOT NULL,
          rubric_type TEXT DEFAULT 'rubric',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      // Ensure rubric_type column exists (for older installations)
      try {
        await query(`ALTER TABLE rubrics ADD COLUMN rubric_type TEXT DEFAULT 'rubric'`);
      } catch (err) {
        // Column may already exist
      }

      await query(`
        CREATE TABLE IF NOT EXISTS batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          status TEXT DEFAULT 'uploaded',
          batch_id INTEGER,
          extracted_text TEXT,
          user_id INTEGER,
          FOREIGN KEY (batch_id) REFERENCES batches (id) ON DELETE SET NULL,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS marking_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          assignment_id INTEGER,
          rubric_id INTEGER,
          student_name TEXT,
          scores TEXT NOT NULL,
          feedback TEXT,
          total_score REAL,
          marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          version INTEGER DEFAULT 1,
          is_current INTEGER DEFAULT 1,
          strictness_level TEXT,
          provider TEXT,
          corrections TEXT,
          user_id INTEGER,
          FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics (id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);
      
      // Migrate existing tables: Add new columns if they don't exist (SQLite)
      try {
        // SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS directly
        // We'll try to add columns and ignore errors if they exist
        try {
          await query(`ALTER TABLE marking_results ADD COLUMN version INTEGER DEFAULT 1`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE marking_results ADD COLUMN is_current INTEGER DEFAULT 1`);
          await query(`UPDATE marking_results SET is_current = 1 WHERE is_current IS NULL`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE marking_results ADD COLUMN strictness_level TEXT`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE marking_results ADD COLUMN provider TEXT`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE marking_results ADD COLUMN corrections TEXT`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE marking_results ADD COLUMN language_errors TEXT`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE assignments ADD COLUMN batch_id INTEGER`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE assignments ADD COLUMN extracted_text TEXT`);
        } catch (err) {
          // Column may already exist
        }
        // Add user_id columns if they don't exist
        try {
          await query(`ALTER TABLE rubrics ADD COLUMN user_id INTEGER`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE batches ADD COLUMN user_id INTEGER`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE assignments ADD COLUMN user_id INTEGER`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE marking_results ADD COLUMN user_id INTEGER`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE users ADD COLUMN account_type TEXT DEFAULT 'individual'`);
        } catch (err) {
          // Column may already exist
        }
        try {
          await query(`ALTER TABLE users ADD COLUMN organisation_name TEXT`);
        } catch (err) {
          // Column may already exist
        }
      } catch (err) {
        console.log('Note: Migration may have failed (columns may already exist)');
      }
      
      // Add indexes for better query performance (SQLite supports IF NOT EXISTS)
      try {
        await query(`CREATE INDEX IF NOT EXISTS idx_marking_results_assignment ON marking_results(assignment_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_marking_results_current ON marking_results(assignment_id, is_current)`);
      } catch (err) {
        // Index might already exist, ignore
        console.log('Note: Some indexes may already exist');
      }
    } else if (usingMySQL) {
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
          is_active TINYINT(1) DEFAULT 1
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
      
      // Migrate existing tables: Add new columns if they don't exist
      try {
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
          is_active BOOLEAN DEFAULT TRUE
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
      
      // Migrate existing tables: Add new columns if they don't exist (PostgreSQL)
      try {
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
