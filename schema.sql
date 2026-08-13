-- ============================================================
--  mail_Sender  —  schema (code se reverse-engineer kiya gaya)
--  Run: mysql -u root -p < schema.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS `mail_Sender`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `mail_Sender`;

-- ------------------------------------------------------------
--  user  →  /api/register, /api/login, /api/me
--  NOTE: code me dono `phone` aur `phone_no` use hote hain:
--    register  → INSERT ... phone_no
--    login/me  → SELECT COALESCE(phone, phone_no)
--  Isliye dono columns rakhe hain. Baad me code saaf karke
--  ek hi column pe aa jaana (recommended: phone_no).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user` (
  `row_id`      int          NOT NULL AUTO_INCREMENT,
  `name`        varchar(50)  NOT NULL,
  `email`       varchar(50)  NOT NULL,
  `phone`       varchar(20)  DEFAULT NULL,
  `phone_no`    varchar(20)  DEFAULT NULL,
  `password`    varchar(200) NOT NULL,   -- bcrypt hash (~60 chars)
  `created_on`  bigint       NOT NULL,   -- Date.now() milliseconds
  `modified_on` bigint       NOT NULL,
  PRIMARY KEY (`row_id`),
  UNIQUE KEY `uq_user_email` (`email`)   -- ER_DUP_ENTRY isi pe depend karta hai
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
--  send_email_inquary  →  har bheji hui mail ka audit log
--  IMPORTANT: column ka naam `created_on` hai (NOT `create_on`).
--  Purane db.js me `create_on` tha jabki index.js `created_on`
--  insert karta hai → wahi bug tha.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `send_email_inquary` (
  `row_id`      int          NOT NULL AUTO_INCREMENT,
  `user_id`     int          NOT NULL,
  `from_email`  varchar(255) NOT NULL,
  `to_email`    varchar(255) NOT NULL,
  `mail_msg`    text         NOT NULL,
  `created_on`  bigint       NOT NULL,
  `modified_on` bigint       NOT NULL,
  PRIMARY KEY (`row_id`),
  KEY `idx_send_email_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
--  App ke liye alag user (root ko app me kabhi use na karo)
--  'STRONG_PASS' ko apne password se replace karo.
-- ------------------------------------------------------------
-- CREATE USER 'mailapp'@'localhost' IDENTIFIED BY 'STRONG_PASS';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `mail_Sender`.* TO 'mailapp'@'localhost';
-- FLUSH PRIVILEGES;

-- RDS ke liye host '%' rakho:
-- CREATE USER 'mailapp'@'%' IDENTIFIED BY 'STRONG_PASS';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON `mail_Sender`.* TO 'mailapp'@'%';

-- Verify:
-- SHOW TABLES;
-- DESCRIBE `user`;
-- DESCRIBE `send_email_inquary`;
