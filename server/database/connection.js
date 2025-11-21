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
    if (isSQLite) {
      // Convert PostgreSQL placeholders ($1, $2, etc.) to SQLite placeholders (?, ?, etc.)
      let sqliteText = text;
      if (params && params.length > 0) {
        // Replace $1, $2, $3, etc. with ?, ?, ?, etc.
        sqliteText = text.replace(/\$(\d+)/g, '?');
      }
      res = await db.query(sqliteText, params);
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
      // SQLite table creation with proper syntax
      await query(`
        CREATE TABLE IF NOT EXISTS rubrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          criteria TEXT NOT NULL,
          total_points INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          status TEXT DEFAULT 'uploaded'
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
          FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics (id) ON DELETE CASCADE
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
      // MySQL table creation
      await query(`
        CREATE TABLE IF NOT EXISTS rubrics (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          criteria JSON NOT NULL,
          total_points INT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS assignments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          filename VARCHAR(255) NOT NULL,
          file_path VARCHAR(500) NOT NULL,
          file_size INT,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status VARCHAR(50) DEFAULT 'uploaded'
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
          FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE CASCADE
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
      } catch (err) {
        console.error('Error migrating marking_results table:', err.message);
        // Continue anyway - columns might already exist
      }
      
      // Add indexes for better query performance (MySQL doesn't support IF NOT EXISTS)
      // Try to create indexes, ignore errors if they already exist
      try {
        await query(`CREATE INDEX idx_marking_results_assignment ON marking_results(assignment_id)`);
      } catch (err) {
        // Index may already exist, which is fine
        if (!err.message?.includes('Duplicate key name')) {
          console.log('Note: Could not create index idx_marking_results_assignment:', err.message);
        }
      }
      try {
        await query(`CREATE INDEX idx_marking_results_current ON marking_results(assignment_id, is_current)`);
      } catch (err) {
        // Index may already exist, which is fine
        if (!err.message?.includes('Duplicate key name') && !err.message?.includes("doesn't exist")) {
          console.log('Note: Could not create index idx_marking_results_current:', err.message);
        }
      }
    } else {
      // PostgreSQL table creation
      await query(`
        CREATE TABLE IF NOT EXISTS rubrics (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          criteria JSONB NOT NULL,
          total_points INTEGER NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS assignments (
          id SERIAL PRIMARY KEY,
          filename VARCHAR(255) NOT NULL,
          file_path VARCHAR(500) NOT NULL,
          file_size INTEGER,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          status VARCHAR(50) DEFAULT 'uploaded'
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
          provider VARCHAR(50)
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
