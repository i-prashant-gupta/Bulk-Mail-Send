require("dotenv").config();
const Queue = require("bull");
const nodemailer = require("nodemailer");

const emailQueue = new Queue("email-queue", {
  redis: { host: "127.0.0.1", port: 6379 },
});

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// process jobs
emailQueue.process(5, async (job) => {
  const { email, subject, text, file } = job.data;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject,
    html: text,
    attachments: [
      {
        filename: file.name,
        content: file.data,
      },
    ],
  });

  console.log("Sent to:", email);
});