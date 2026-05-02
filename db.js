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
  await pool.execute(
    "ALTER TABLE `user` ADD COLUMN IF NOT EXISTS `phone` varchar(20) NULL AFTER `email`"
  );
  return pool;
}

/** Ensures outbound email audit table exists (`send_email_inquary`). */
async function ensureSendEmailTable() {
  const p = getPool();
  await p.execute(
    "CREATE TABLE IF NOT EXISTS `send_email_inquary` (" +
      "`row_id` int NOT NULL AUTO_INCREMENT," +
      "`user_id` int NOT NULL," +
      "`from_email` varchar(255) NOT NULL," +
      "`to_email` varchar(255) NOT NULL," +
      "`mail_msg` text NOT NULL," +
      "`create_on` bigint NOT NULL," +
      "`modified_on` bigint NOT NULL," +
      "PRIMARY KEY (`row_id`)," +
      "KEY `idx_send_email_user` (`user_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
  );
}

module.exports = { getPool, initPool, ensureSendEmailTable };
