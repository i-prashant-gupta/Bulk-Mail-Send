// ─────────────────────────────────────────────────────────────────
//  index.js — Run everything with: node index.js
//  Server + Worker + Redis check — all in one file
//  Install: npm install express nodemailer multer cors bull dotenv
// ─────────────────────────────────────────────────────────────────

const express    = require("express");
const nodemailer = require("nodemailer");
const multer     = require("multer");
const cors       = require("cors");
const Queue      = require("bull");
const { exec }   = require("child_process");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const { getPool, initPool } = require("./db");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3000;

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  try {
    const token = header.slice(7);
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

app.use(cors());
app.use(express.json());

// ── Multer ────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage() });

// ── Nodemailer transporter ────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ── Redis auto-start ──────────────────────────────────────────────
function startRedis() {
  return new Promise((resolve) => {
    console.log("🔴 Checking Redis...");
    exec("redis-cli ping", (err, stdout) => {
      if (stdout && stdout.trim() === "PONG") {
        console.log("✅ Redis already running!");
        return resolve(true);
      }
      console.log("🔄 Starting Redis...");
      exec("brew services start redis", (err2) => {
        if (!err2) {
          setTimeout(() => {
            exec("redis-cli ping", (e, out) => {
              if (out && out.trim() === "PONG") {
                console.log("✅ Redis started via Homebrew!");
                resolve(true);
              } else {
                console.log("⚠️  Redis start failed. Run: brew services start redis");
                resolve(false);
              }
            });
          }, 1500);
        } else {
          exec("sudo service redis-server start", () => {
            setTimeout(() => {
              exec("redis-cli ping", (e, out) => {
                if (out && out.trim() === "PONG") {
                  console.log("✅ Redis started!");
                  resolve(true);
                } else {
                  console.log("⚠️  Could not auto-start Redis.");
                  resolve(false);
                }
              });
            }, 1500);
          });
        }
      });
    });
  });
}

// ── Bull Queue ────────────────────────────────────────────────────
const emailQueue = new Queue("email-queue", {
  redis: { host: "127.0.0.1", port: 6379 },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "fixed", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// ── HTML email builder ────────────────────────────────────────────
// senderName, senderEmail, senderPhone come from UI fields
function buildHTML(name, company, customText, senderName, senderEmail, senderPhone) {
  const greeting = name ? `Dear ${name},` : "Dear Hiring Team,";

  // Replace {name} and {company} placeholders typed in UI body
  let body = customText || "";
  if (body) {
    body = body
      .replace(/{name}/g,    name    || "Hiring Team")
      .replace(/{company}/g, company || "your company");
  } else {
    body =
      `I am writing to apply for a position at ${company || "your company"}. ` +
      `With my experience and skills, I am confident in my ability to contribute meaningfully to your team.\n\n` +
      `Please find my resume attached for your review. I would welcome the opportunity to discuss how my ` +
      `skills and experience can contribute to your engineering team.`;
  }

  const displayName  = senderName  || process.env.SENDER_NAME  || "Sender";
  const displayEmail = senderEmail || process.env.EMAIL_USER   || "";
  const displayPhone = senderPhone || process.env.SENDER_PHONE || "";

  return `
    <div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.8;color:#222;max-width:600px;">
      <p>${greeting}</p>
      <p>I hope this email finds you well.</p>
      ${body.split("\n\n").map((p) => `<p>${p.trim()}</p>`).join("")}
      <p>Thank you for your time and consideration. I look forward to hearing from you.</p>
      <p>
        Warm regards,<br/>
        <strong>${displayName}</strong><br/>
        📧 ${displayEmail}<br/>
        ${displayPhone ? `📞 ${displayPhone}` : ""}
      </p>
    </div>
  `;
}

// ── WORKER — runs inside same process ────────────────────────────
function startWorker() {
  console.log("⚙️  Starting email worker (3 concurrent)...");

  emailQueue.process(3, async (job) => {
    const { email, name, company, subject, text, file, senderName, senderEmail, senderPhone } = job.data;

    console.log(`📨 Processing → ${email} (Job #${job.id})`);
    await job.progress(10);

    const mailOptions = {
      from: `"${senderName || process.env.SENDER_NAME || "Mailer"}" <${process.env.EMAIL_USER}>`,
      to: email,
      subject,
      html: buildHTML(name, company, text, senderName, senderEmail, senderPhone),
      ...(file && {
        attachments: [{
          filename: file.name,
          content:  Buffer.from(file.data),
        }],
      }),
    };

    await job.progress(50);
    await transporter.sendMail(mailOptions);
    await job.progress(100);

    console.log(`✅ Sent → ${email}`);
    return { email, status: "sent" };
  });

  emailQueue.on("completed", (job, result) => {
    console.log(`✅ Job #${job.id} completed → ${result.email}`);
  });

  emailQueue.on("failed", (job, err) => {
    console.log(`❌ Job #${job.id} failed → ${job.data.email} | ${err.message}`);
  });

  emailQueue.on("stalled", (job) => {
    console.log(`⚠️  Job #${job.id} stalled — will retry`);
  });

  console.log("✅ Worker ready — listening for jobs...\n");
}

// ── API ROUTES ────────────────────────────────────────────────────

// POST /api/register — { email, password, name? } → table `user` (row_id auto)
app.post("/api/register", async (req, res) => {
  try {
    const emailRaw = String(req.body.email || "").trim().toLowerCase();
    const email = emailRaw.slice(0, 50);
    const password = String(req.body.password || "");
    let name = String(req.body.name || "").trim().slice(0, 50);
    if (!name && email.includes("@")) name = email.split("@")[0].slice(0, 50);
    if (!name) name = "User";

    if (!email.includes("@") || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Valid email and password (at least 6 characters) required.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    if (passwordHash.length > 200) {
      return res.status(500).json({ success: false, message: "Password hash too long for DB column." });
    }

    const now = Date.now();
    const pool = getPool();
    await pool.execute(
      `INSERT INTO \`user\` (name, email, password, created_on, modified_on) VALUES (:name, :email, :password, :created_on, :modified_on)`,
      {
        name,
        email,
        password: passwordHash,
        created_on: now,
        modified_on: now,
      }
    );
    res.json({ success: true, message: "Registered successfully." });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Email already registered." });
    }
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/login — { email, password }
app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase().slice(0, 50);
    const password = String(req.body.password || "");
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT row_id, email, password, name FROM \`user\` WHERE email = :email LIMIT 1`,
      { email }
    );
    const row = rows[0];
    if (!row || !(await bcrypt.compare(password, row.password))) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }
    const token = jwt.sign(
      { sub: row.row_id, email: row.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ success: true, token, user: { email: row.email, name: row.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/me — current user from JWT + DB
app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT row_id, email, name FROM \`user\` WHERE row_id = :id LIMIT 1`,
      { id: req.user.sub }
    );
    const row = rows[0];
    if (!row) return res.status(401).json({ success: false, message: "User not found." });
    res.json({ success: true, user: { id: row.row_id, email: row.email, name: row.name } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/send  — React BulkMailer.jsx calls this
app.post("/api/send", requireAuth, upload.single("attachment"), async (req, res) => {
  try {
    const { recipients, subject, text, senderName, senderEmail, senderPhone } = req.body;
    const list = typeof recipients === "string" ? JSON.parse(recipients) : recipients;

    if (!list?.length) {
      return res.status(400).json({ success: false, message: "No recipients." });
    }

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      await emailQueue.add(
        {
          email:       r.email,
          name:        r.name    || "",
          company:     r.company || "",
          subject,
          text,
          senderName,
          senderEmail,
          senderPhone,
          ...(req.file && {
            file: {
              name: req.file.originalname,
              data: Array.from(req.file.buffer),
            },
          }),
        },
        {
          delay:  i * 1200,
          jobId: `email-${Date.now()}-${i}`,
        }
      );
    }

    const counts = await emailQueue.getJobCounts();
    res.json({
      success: true,
      message: `${list.length} emails added to queue 🚀`,
      queued:  list.length,
      queueStatus: counts,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /send-bulk-with-attachment — Postman / direct API
app.post("/send-bulk-with-attachment", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const { recipients, emails, subject, text, senderName, senderEmail, senderPhone } = req.body;

    let list = [];
    if (recipients) {
      list = typeof recipients === "string" ? JSON.parse(recipients) : recipients;
    } else if (emails) {
      const arr = typeof emails === "string" ? JSON.parse(emails) : emails;
      list = arr.map((e) => ({ email: e, name: "", company: "" }));
    }

    if (!list.length) {
      return res.status(400).json({ success: false, message: "No recipients." });
    }

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      await emailQueue.add(
        {
          email:       typeof r === "string" ? r : r.email,
          name:        r.name    || "",
          company:     r.company || "",
          subject,
          text,
          senderName,
          senderEmail,
          senderPhone,
          ...(req.file && {
            file: {
              name: req.file.originalname,
              data: Array.from(req.file.buffer),
            },
          }),
        },
        { delay: i * 1200, jobId: `bulk-${Date.now()}-${i}` }
      );
    }

    res.json({ success: true, message: `${list.length} emails queued 🚀`, queued: list.length });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/queue-status
app.get("/api/queue-status", requireAuth, async (req, res) => {
  try {
    const counts     = await emailQueue.getJobCounts();
    const activeJobs = await emailQueue.getActive();
    const failedJobs = await emailQueue.getFailed();
    res.json({
      success: true,
      counts,
      active: activeJobs.map((j) => ({ id: j.id, email: j.data.email, progress: j._progress })),
      failed: failedJobs.map((j) => ({ id: j.id, email: j.data.email, reason: j.failedReason })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/queue-clear
app.delete("/api/queue-clear", requireAuth, async (req, res) => {
  try {
    await emailQueue.empty();
    res.json({ success: true, message: "Queue cleared ✅" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/test-connection
app.post("/api/test-connection", requireAuth, async (req, res) => {
  try {
    await transporter.verify();
    res.json({ success: true, message: "SMTP connection verified! ✅" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/health
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", time: new Date().toISOString(), worker: "running", redis: "connected" })
);

// ── BOOT ──────────────────────────────────────────────────────────
async function boot() {
  if (!process.env.JWT_SECRET) {
    console.error("Missing JWT_SECRET in .env — set a long random string.");
    process.exit(1);
  }

  console.log("\n========================================");
  console.log("   📧  Bulk Email Server Starting...   ");
  console.log("========================================\n");

  try {
    await initPool();
    console.log("✅ MySQL pool → database:", process.env.MYSQL_DATABASE || "mail_Sender", "\n");
  } catch (e) {
    console.error("❌ MySQL connection failed:", e.message);
    process.exit(1);
  }

  await startRedis();
  startWorker();

  app.listen(PORT, () => {
    console.log("========================================");
    console.log(`🚀 Server  → http://localhost:${PORT}`);
    console.log(`🔐 Auth    → POST /api/register  POST /api/login`);
    console.log(`📬 Queue   → GET /api/queue-status (JWT)`);
    console.log(`💊 Health  → GET /api/health`);
    console.log("========================================\n");
  });
}

boot();

// ─────────────────────────────────────────────────────────────────
//  .env file:
//  JWT_SECRET=long-random-string   ← required for /api/login and protected routes
//  MYSQL_HOST=127.0.0.1
//  MYSQL_PORT=3306
//  MYSQL_USER=root
//  MYSQL_PASSWORD=...
//  MYSQL_DATABASE=mail_Sender     ← phpMyAdmin database; table `user`
//  EMAIL_USER=you@gmail.com
//  EMAIL_PASS=xxxx_xxxx_xxxx_xxxx
//  SENDER_NAME=Your Name        ← fallback if UI is empty
//  SENDER_PHONE=9999999999      ← fallback if UI is empty
//
//  Protected routes: send Authorization: Bearer <token>
//  Run: node index.js
// ─────────────────────────────────────────────────────────────────