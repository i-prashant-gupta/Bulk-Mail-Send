const mysql = require("mysql2/promise");

let pool;

function getPool() {
  if (!pool) throw new Error("MySQL pool not initialized. Call initPool() during boot.");
  return pool;
}

/** Connection pool → database `mail_Sender`, table `user`. */
async function initPool() {
  pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE || "mail_Sender",
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_POOL_LIMIT || 10),
    namedPlaceholders: true,
    // RDS pe SSL chahiye to .env me MYSQL_SSL=true kar dena
    ...(process.env.MYSQL_SSL === "true" && { ssl: { rejectUnauthorized: true } }),
  });

  await pool.execute("SELECT 1");

  // FIX: `ADD COLUMN IF NOT EXISTS` MariaDB ka syntax hai — MySQL 8 pe
  // syntax error deta hai aur boot crash ho jaata tha. Ab guard kiya hua hai.
  try {
    const [cols] = await pool.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user' AND COLUMN_NAME = 'phone'"
    );
    if (cols.length === 0) {
      await pool.query("ALTER TABLE `user` ADD COLUMN `phone` varchar(20) NULL AFTER `email`");
      console.log("ℹ️  Added missing column `user`.`phone`");
    }
  } catch (e) {
    console.warn("⚠️  phone column check skipped:", e.code || e.message);
  }

  return pool;
}

/** Ensures outbound email audit table exists (`send_email_inquary`). */
async function ensureSendEmailTable() {
  const p = getPool();
  // FIX: `create_on` → `created_on` (index.js isi naam se INSERT karta hai)
  await p.execute(
    "CREATE TABLE IF NOT EXISTS `send_email_inquary` (" +
      "`row_id` int NOT NULL AUTO_INCREMENT," +
      "`user_id` int NOT NULL," +
      "`from_email` varchar(255) NOT NULL," +
      "`to_email` varchar(255) NOT NULL," +
      "`mail_msg` text NOT NULL," +
      "`created_on` bigint NOT NULL," +
      "`modified_on` bigint NOT NULL," +
      "PRIMARY KEY (`row_id`)," +
      "KEY `idx_send_email_user` (`user_id`)" +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
  );
}

module.exports = { getPool, initPool, ensureSendEmailTable };
