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
    console.log('MySQL query:', { sql, params });
    
    const [rows] = await conn.execute(sql, params);
    
    console.log('MySQL query result:', { rows, rowCount: rows.length });
    
    return {
      rows: Array.isArray(rows) ? rows : [rows],
      rowCount: rows.length,
      lastID: rows.insertId
    };
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
