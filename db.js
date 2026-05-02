const mysql = require("mysql2/promise");

let pool;

function getPool() {
  if (!pool) throw new Error("MySQL pool not initialized. Call initPool() during boot.");
  return pool;
}

/** Connection pool → database `mail_Sender`, table `user` (phpMyAdmin schema). */
async function initPool() {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE || "mail_Sender",
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
  });

  await pool.execute("SELECT 1");
  return pool;
}

module.exports = { getPool, initPool };
