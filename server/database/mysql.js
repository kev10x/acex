const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

const getPool = () => {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;

    // Parse MySQL connection string: mysql://user:password@host:port/database
    const url = new URL(connectionString);
    const config = {
      host: url.hostname,
      port: parseInt(url.port) || 3306,
      user: url.username,
      password: url.password,
      database: url.pathname.substring(1), // Remove leading slash
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      // Keep connections alive so MySQL doesn't close them after wait_timeout (~2h on many hosts)
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000, // 10s
      typeCast: function (field, next) {
        if (field.type === 'JSON') {
          return JSON.parse(field.string('utf8'));
        }
        return next();
      }
    };

    pool = mysql.createPool(config);
    console.log('MySQL connection pool created');
  }

  return pool;
};

const query = async (sql, params = []) => {
  let conn;
  try {
    const poolInstance = getPool();

    // Convert PostgreSQL placeholders ($1, $2, etc.) to MySQL placeholders (?, ?, etc.)
    let mysqlSql = sql;
    if (params && params.length > 0) {
      mysqlSql = sql.replace(/\$(\d+)/g, '?');
    }

    conn = await poolInstance.getConnection();
    const [rows] = await conn.execute(mysqlSql, params);

    const result = {
      rows: Array.isArray(rows) ? rows : [rows],
      rowCount: Array.isArray(rows) ? rows.length : (rows ? 1 : 0),
      insertId: rows && rows.insertId,
      changes: (rows && rows.affectedRows) || 0
    };

    if (result.insertId) {
      result.lastID = result.insertId;
    }

    return result;
  } catch (error) {
    console.error('MySQL query error:', error);
    throw error;
  } finally {
    if (conn) {
      conn.release();
    }
  }
};

const initDatabase = async () => {
  // MySQL initialization is handled in connection.js
  console.log('MySQL database initialization handled by connection.js');
};

const closeDatabase = async () => {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('MySQL pool closed');
  }
};

module.exports = {
  query,
  initDatabase,
  closeDatabase
};
