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
          FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics (id) ON DELETE CASCADE
        )
      `);
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
          FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
          FOREIGN KEY (rubric_id) REFERENCES rubrics(id) ON DELETE CASCADE
        )
      `);
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
          marked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
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
