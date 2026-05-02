# Bulk Mail Send (Email Sender API)

Node.js bulk email queue server (Express + Bull + Redis + Nodemailer) with JWT registration/login backed by MySQL.

## Setup

1. Copy `.env.example` to `.env` and fill values.
2. Ensure Redis and MySQL are running (`mail_Sender` database, `` `user` `` table).
3. Install and run:

```bash
npm install
node index.js
```

Do not commit `.env` (see `.gitignore`).
