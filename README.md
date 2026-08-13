# Bulk Mail Send (Email Sender API)

Node.js bulk email queue server — **Express 5 + Bull (Redis) + Nodemailer + MySQL + JWT**.
Server aur worker dono ek hi process me chalte hain (`index.js`).

---

## Quick start (local)

```bash
cp .env.example .env          # values bharo
openssl rand -hex 48          # → JWT_SECRET me paste karo
mysql -u root -p < schema.sql # database + tables banao
npm ci
npm start
```

Redis chalu hona chahiye: `redis-cli ping` → `PONG`
(Mac: `brew services start redis` · Linux: `sudo systemctl start redis-server`)

## AWS pe deploy

Poora step-by-step guide → **[DEPLOY_AWS.md](DEPLOY_AWS.md)**

Short version:
```bash
bash scripts/setup-ubuntu.sh          # Node + Redis + MySQL + Nginx + PM2
cp .env.example .env && nano .env
mysql -u root -p < schema.sql
npm ci --omit=dev
pm2 start ecosystem.config.js && pm2 save && pm2 startup
```

---

## Files

| File | Kya hai |
|---|---|
| `index.js` | API server + in-process email worker |
| `db.js` | MySQL pool + `send_email_inquary` auto-create |
| `worker.js` | **Optional** standalone worker (default me mat chalao — dekho neeche) |
| `schema.sql` | Database schema — **isko commit rakhna** |
| `.env.example` | Saare env variables, documented |
| `ecosystem.config.js` | PM2 config (single instance) |
| `scripts/setup-ubuntu.sh` | Fresh EC2 pe sab install |
| `scripts/backup-db.sh` | Daily mysqldump + optional S3 upload |
| `scripts/nginx-email-sender.conf` | Nginx reverse proxy config |

---

## Database

Do tables (`schema.sql` me):

- **`user`** — `row_id, name, email (unique), phone, phone_no, password (bcrypt), created_on, modified_on`
- **`send_email_inquary`** — har bheji hui mail ka audit log

> `phone` aur `phone_no` dono columns hain kyunki `/api/register` `phone_no` me likhta hai
> aur `/api/login` `COALESCE(phone, phone_no)` padhta hai. Aage jaake ek column me merge karna.

---

## API

| Method | Route | Auth | Kaam |
|---|---|---|---|
| POST | `/api/register` | — | `{ name, email, phone, password }` (password ≥ 6 chars) |
| POST | `/api/login` | — | `{ email, password }` → JWT (7 din) |
| GET | `/api/me` | JWT | current user |
| GET | `/api/compose-default` | JWT | default message template |
| POST | `/api/send` | JWT | multipart: `recipients` (JSON), `subject`, `text`, `senderName/Email/Phone`, `attachment` |
| POST | `/send-bulk-with-attachment` | JWT | wahi, field ka naam `file`; `emails` array bhi chalega |
| GET | `/api/queue-status` | JWT | waiting/active/failed counts |
| DELETE | `/api/queue-clear` | JWT | queue empty |
| POST | `/api/test-connection` | JWT | SMTP verify |
| GET | `/api/health` | — | MySQL + Redis real status |

Protected routes pe header: `Authorization: Bearer <token>`

Message body me placeholders: `{name}` aur `{company}` — per-recipient replace ho jaate hain.
Har mail ke beech 1200ms ka delay hai (rate-limit se bachne ke liye), 3 retries with 5s backoff.

---

## ⚠️ Zaroori baatein

**1. `worker.js` alag se mat chalao.**
Worker already `index.js` ke andar chal raha hai. Dono ek saath = same job do baar = **duplicate emails**.
Scale karna ho to: server ke `.env` me `RUN_WORKER=false`, phir alag process pe `npm run worker`.

**2. PM2 cluster mode mat use karo.**
`pm2 start index.js -i 4` = 4 worker = har mail 4 baar. `ecosystem.config.js` me `instances: 1` hai — waise hi rehne do.

**3. Gmail ki limit ~500 mails/day hai.**
Aur `EMAIL_PASS` me App Password chahiye, normal password nahi. Zyada volume ke liye `.env` me `SMTP_HOST` set karke Amazon SES pe shift kar do.

**4. Redis pe `maxmemory-policy noeviction` rakho.**
Warna memory bharne par Bull ke queued jobs chupchaap delete ho jaate hain. `setup-ubuntu.sh` ye kar deta hai.

**5. `.env` git me kabhi commit na karo.** (`.gitignore` me already hai)

---

## Fixed bugs (v1.1)

| Bug | Kya hota tha | Fix |
|---|---|---|
| `create_on` vs `created_on` | `db.js` table `create_on` se banata tha, `index.js` `created_on` insert karta tha → har audit log silently fail | column ka naam `created_on` |
| `ADD COLUMN IF NOT EXISTS` | MariaDB-only syntax; MySQL 8 pe syntax error → boot crash | `information_schema` se guard |
| `brew services start redis` | Mac-only command, Linux/AWS pe fail | hata diya; connectivity check + clear error message |
| Hardcoded `127.0.0.1:6379` | ElastiCache use nahi kar sakte the | `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_TLS` |
| `worker.js` attachment crash | attachment na ho to `file.name` pe TypeError | conditional attachments + DB logging add |
| `app.listen(PORT)` | localhost pe bind (Nginx se request fail) | `0.0.0.0` |
| No graceful shutdown | pm2 restart pe running mails beech me toot jaati thi | SIGTERM/SIGINT handler + 20s hard timeout |
| Fake `/api/health` | hamesha `redis: "connected"` bolta tha | real MySQL + Redis ping, 503 on degraded |
| No attachment limit | 100MB file bhi Redis me chali jaati | `MAX_ATTACHMENT_MB` (default 10) + 413 response |
| `cors()` open to all | koi bhi site API hit kar sakti thi | `CORS_ORIGIN` env |
| No SMTP timeouts | dead connection pe job minutes tak latka rehta | connection/greeting/socket timeouts |
