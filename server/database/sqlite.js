const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

let db;

const getDatabase = () => {
  if (!db) {
    const dbPath = process.env.DATABASE_URL?.replace('sqlite:', '') || './database.sqlite';
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        console.error('Error opening database:', err.message);
        throw err;
      }
      console.log('Connected to SQLite database');
    });
  }
  return db;
};

const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    const database = getDatabase();
    console.log('SQLite query:', { sql, params });
    database.all(sql, params, (err, rows) => {
      if (err) {
        console.error('Database query error:', err);
        reject(err);
      } else {
        console.log('SQLite query result:', { rows, rowCount: rows.length });
        resolve({ rows, rowCount: rows.length });
      }
    });
  });
};

const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    const database = getDatabase();
    console.log('SQLite run:', { sql, params });
    database.run(sql, params, function(err) {
      if (err) {
        console.error('Database run error:', err);
        reject(err);
      } else {
        console.log('SQLite run result:', { lastID: this.lastID, changes: this.changes });
        resolve({ 
          lastID: this.lastID, 
          changes: this.changes,
          rows: [{ id: this.lastID }]
        });
      }
    });
  });
};

const initDatabase = async () => {
  try {
    const database = getDatabase();
    
    // Create tables
    await run(`
      CREATE TABLE IF NOT EXISTS rubrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        criteria TEXT NOT NULL,
        total_points INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await run(`
      CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'uploaded'
      )
    `);

    await run(`
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

    console.log('SQLite database initialized successfully');
  } catch (error) {
    console.error('SQLite database initialization error:', error);
    throw error;
  }
};

const closeDatabase = () => {
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err.message);
      } else {
        console.log('Database connection closed');
      }
    });
  }
};

module.exports = {
  query,
  run,
  initDatabase,
  closeDatabase,
  getDatabase
};
