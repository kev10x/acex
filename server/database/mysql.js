const mysql = require('mysql2/promise');
require('dotenv').config();

let connection;

const getConnection = async () => {
  if (!connection) {
    const connectionString = process.env.DATABASE_URL;
    
    // Parse MySQL connection string: mysql://user:password@host:port/database
    const url = new URL(connectionString);
    const config = {
      host: url.hostname,
      port: parseInt(url.port) || 3306,
      user: url.username,
      password: url.password,
      database: url.pathname.substring(1), // Remove leading slash
      charset: 'utf8mb4', // Use utf8mb4 for full UTF-8 support including emojis
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      typeCast: function (field, next) {
        if (field.type === 'JSON') {
          // Properly handle UTF-8 encoding for JSON columns
          return JSON.parse(field.string('utf8'));
        }
        return next();
      }
    };

    connection = await mysql.createConnection(config);
    console.log('Connected to MySQL database');
  }
  
  return connection;
};

const query = async (sql, params = []) => {
  try {
    const conn = await getConnection();
    
    // Convert PostgreSQL placeholders ($1, $2, etc.) to MySQL placeholders (?, ?, etc.)
    let mysqlSql = sql;
    if (params && params.length > 0) {
      mysqlSql = sql.replace(/\$(\d+)/g, '?');
    }
    
    console.log('MySQL query:', { sql: mysqlSql, params });
    
    const [rows] = await conn.execute(mysqlSql, params);
    
    // Handle result format
    const result = {
      rows: Array.isArray(rows) ? rows : [rows],
      rowCount: Array.isArray(rows) ? rows.length : (rows ? 1 : 0),
      insertId: rows.insertId,
      changes: rows.affectedRows || 0
    };
    
    // For compatibility, also add lastID
    if (rows.insertId) {
      result.lastID = rows.insertId;
    }
    
    console.log('MySQL query result:', { rowCount: result.rowCount, insertId: result.insertId });
    
    return result;
  } catch (error) {
    console.error('MySQL query error:', error);
    throw error;
  }
};

const initDatabase = async () => {
  // MySQL initialization is handled in connection.js
  console.log('MySQL database initialization handled by connection.js');
};

const closeDatabase = async () => {
  if (connection) {
    await connection.end();
    connection = null;
    console.log('MySQL connection closed');
  }
};

module.exports = {
  query,
  initDatabase,
  closeDatabase
};
