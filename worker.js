// ─────────────────────────────────────────────────────────────────
//  worker.js — OPTIONAL standalone worker
//
//  ⚠️  DEFAULT SETUP ME YE FILE CHALANI NAHI HAI.
//      Worker index.js ke andar hi chalta hai (startWorker()).
//      Dono ek saath chalaye to same job do baar process hoga
//      → duplicate emails.
//
//  Isko sirf tab chalao jab app ko scale karna ho:
//      1) index.js wale server ke .env me:  RUN_WORKER=false
//      2) phir alag process/machine pe:     node worker.js
// ─────────────────────────────────────────────────────────────────

require("dotenv").config();
const Queue = require("bull");
const nodemailer = require("nodemailer");
const { initPool, getPool, ensureSendEmailTable } = require("./db");

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 3);

const emailQueue = new Queue("email-queue", {
  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
    ...(process.env.REDIS_TLS === "true" && { tls: {} }),
  },
});

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true,
      maxConnections: 3,
    })
  : nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      pool: true,
      maxConnections: 3,
    });

/** index.js ke jaisa hi body builder — dono me output same rehna chahiye. */
function personalizedBodyText(customText, name, company) {
  const body = customText || "";
  if (body) {
    return body
      .replace(/{name}/g, name || "Hiring Team")
      .replace(/{company}/g, company || "your company");
  }
  return (
    `I am writing to apply for a position at ${company || "your company"}. ` +
    `With my experience and skills, I am confident in my ability to contribute meaningfully to your team.\n\n` +
    `Please find my resume attached for your review. I would welcome the opportunity to discuss how my ` +
    `skills and experience can contribute to your engineering team.`
  );
}

function buildHTML(name, company, customText, senderName, senderEmail, senderPhone) {
  const greeting = name ? `Dear ${name},` : "Dear Hiring Team,";
  const body = personalizedBodyText(customText, name, company);
  const displayName = senderName || process.env.SENDER_NAME || "Sender";
  const displayEmail = senderEmail || process.env.EMAIL_USER || "";
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

async function main() {
  await initPool();
  await ensureSendEmailTable();
  console.log(`⚙️  Standalone worker ready (${CONCURRENCY} concurrent)`);

  emailQueue.process(CONCURRENCY, async (job) => {
    const {
      email, name, company, subject, text, file,
      senderName, senderEmail, senderPhone, userId,
    } = job.data;

    const fromAddress =
      process.env.MAIL_FROM || process.env.EMAIL_USER || process.env.SMTP_USER;

    // FIX: pehle attachment na hone par `file.name` crash karta tha
    await transporter.sendMail({
      from: `"${senderName || process.env.SENDER_NAME || "Mailer"}" <${fromAddress}>`,
      to: email,
      subject,
      html: buildHTML(name, company, text, senderName, senderEmail, senderPhone),
      ...(file && {
        attachments: [{ filename: file.name, content: Buffer.from(file.data) }],
      }),
    });

    const uid = Number(userId ?? job.data.user_id);
    if (Number.isFinite(uid) && uid > 0) {
      try {
        const now = Date.now();
        const plainBody = personalizedBodyText(text, name, company);
        await getPool().execute(
          "INSERT INTO `send_email_inquary` (user_id, from_email, to_email, mail_msg, created_on, modified_on) VALUES (?, ?, ?, ?, ?, ?)",
          [
            uid,
            String(senderEmail || fromAddress || "(unknown)").slice(0, 255),
            String(email || "(unknown)").slice(0, 255),
            `${String(subject || "").trim()}\n\n${plainBody}`,
            now,
            now,
          ]
        );
      } catch (e) {
        console.error(`send_email_inquary insert failed → ${email}:`, e.code || "", e.message);
      }
    }

    console.log("✅ Sent to:", email);
    return { email, status: "sent" };
  });

  emailQueue.on("failed", (job, err) => {
    console.log(`❌ Job #${job.id} failed → ${job.data.email} | ${err.message}`);
  });

  const shutdown = async () => {
    console.log("\nShutting down worker...");
    await emailQueue.close();
    await getPool().end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("❌ Worker boot failed:", e.message);
  process.exit(1);
});
