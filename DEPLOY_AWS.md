# Email Sender → AWS Deployment Guide

Aapka project: **Express + Bull (Redis queue) + Nodemailer (Gmail) + MySQL + JWT**, sab kuch `index.js` ke ek hi process me chalta hai (server + worker dono).

DB purane system me tha, ab nahi hai — koi problem nahi. Data migrate karne ki zaroorat nahi, sirf **schema dobara banana hai** (`schema.sql` file di hui hai) aur users fresh register kar lenge.

---

## STEP 0 — Code already fixed hai ✅

Aapke purane code me 3 bugs the jo AWS pe boot hi fail kar dete (ya silently data kho dete).
**Ye sab is zip me fix ho chuke hain** — kuch edit karne ki zaroorat nahi:

| Bug | Kya hota tha | Ab |
|---|---|---|
| `db.js` `create_on` vs `index.js` `created_on` | mails jaati thi par audit log ki har entry silently fail | column `created_on` |
| `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` | MariaDB-only syntax — MySQL 8 / RDS pe syntax error → `process.exit(1)` | `information_schema` check se guard |
| `brew services start redis` | Mac-only, Linux/EC2 pe fail | hata diya — Redis systemd/ElastiCache handle karega |
| hardcoded `127.0.0.1:6379` | ElastiCache use nahi kar sakte the | `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_TLS` |
| `app.listen(PORT)` | localhost pe bind → Nginx se request fail | `0.0.0.0` pe bind |
| graceful shutdown nahi tha | `pm2 restart` pe beech ki mails toot jaati | SIGTERM handler + 20s hard timeout |
| fake `/api/health` | hamesha `redis: "connected"` bolta tha | real MySQL + Redis ping (503 on degraded) |

Sab kuch local pe test kiya gaya hai — boot, register, login, `/api/me`, JWT rejection, queue, audit-log insert, graceful shutdown.

**Ek warning yaad rakho:** `worker.js` alag se **mat** chalao aur PM2 me **cluster mode mat use karo**.
Worker `index.js` ke andar hi chalta hai — do jagah chalane se **har mail multiple baar jaayegi**.

---

## STEP 1 — Architecture choose karo

**Option A — Sab kuch ek EC2 pe (sasta, seekhne/demo ke liye best)**
```
EC2 (Ubuntu t3.micro) → Node app + MySQL + Redis + Nginx
```
Cost: free tier me ~₹0, uske baad ~$8-10/month. Downside: EC2 gaya to DB bhi gaya (isliye Step 9 backup zaroori).

**Option B — Managed services (production)**
```
EC2 (app) → RDS MySQL (db) + ElastiCache Redis (queue) + Nginx
```
Cost: ~$25-35/month. Fayda: automatic backups, DB dobara kabhi nahi khoyega.

Neeche **Option A** ke steps hain, aur jahan RDS/ElastiCache use karna ho wahan alag se likha hai.

---

## STEP 2 — EC2 instance launch karo

AWS Console → EC2 → **Launch instance**

| Setting | Value |
|---|---|
| Name | email-sender-prod |
| AMI | Ubuntu Server 24.04 LTS |
| Type | t3.micro (free tier: t2.micro) |
| Key pair | naya banao → `email-sender.pem` download karo (ye dobara nahi milega) |
| Storage | 20 GB gp3 |
| Region | ap-south-1 (Mumbai) — aap Bengaluru me ho, latency kam |

**Security Group rules (bahut important):**

| Type | Port | Source | Kyun |
|---|---|---|---|
| SSH | 22 | My IP | sirf aapka laptop |
| HTTP | 80 | 0.0.0.0/0 | Nginx |
| HTTPS | 443 | 0.0.0.0/0 | SSL ke baad |
| Custom TCP | 3000 | My IP | testing ke liye (Nginx lagne ke baad hata do) |

**3306 (MySQL) aur 6379 (Redis) ko kabhi 0.0.0.0/0 pe open na karo.** Public Redis/MySQL minutes me hack ho jaate hain.

Launch ke baad Elastic IP allot karke instance se associate kar do — warna restart pe IP badal jaayega.

---

## STEP 3 — Server pe login + basic setup

```bash
chmod 400 email-sender.pem
ssh -i email-sender.pem ubuntu@<YOUR_ELASTIC_IP>
```

**Sabse aasan raasta — repo clone karke setup script chalao:**
```bash
git clone https://github.com/<your-username>/<repo>.git Email_Sender
cd Email_Sender
bash scripts/setup-ubuntu.sh
```
Ye script install karta hai: Node 20 (nvm), PM2, Redis (+ `maxmemory-policy noeviction`),
Nginx, aur optionally MySQL. `.env` khud banana hai (STEP 6).

**Ya manually:**
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git build-essential curl nginx
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20 && nvm alias default 20
npm install -g pm2
node -v    # v20.x
```
Note: `express@5` aur `nodemailer@8` ke liye Node 18+ chahiye, isliye 20 lo.

---

## STEP 4 — MySQL setup + schema restore

### Option A — MySQL EC2 pe hi
```bash
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
sudo mysql_secure_installation      # root password set karo
```

Schema chadhao (`schema.sql` repo me commit kar dena):
```bash
cd ~/Email_Sender
sudo mysql < schema.sql
```

App ke liye alag user banao (root app me mat use karo):
```bash
sudo mysql
```
```sql
CREATE USER 'mailapp'@'localhost' IDENTIFIED BY 'STRONG_PASS_HERE';
GRANT SELECT, INSERT, UPDATE, DELETE ON `mail_Sender`.* TO 'mailapp'@'localhost';
FLUSH PRIVILEGES;
SHOW TABLES FROM `mail_Sender`;   -- user, send_email_inquary dikhne chahiye
EXIT;
```

### Option B — RDS MySQL
1. RDS → Create database → MySQL 8.0 → Free tier / db.t4g.micro
2. DB identifier: `mail-sender-db`, master user: `admin`
3. **Public access: No**, same VPC as EC2
4. RDS ka security group edit karo → Inbound: MySQL/Aurora 3306, Source = **EC2 ka security group** (IP nahi, SG select karo)
5. EC2 se schema chadhao:
```bash
sudo apt install -y mysql-client
mysql -h mail-sender-db.xxxx.ap-south-1.rds.amazonaws.com -u admin -p < schema.sql
```
6. `.env` me `MYSQL_HOST` = RDS endpoint, `MYSQL_SSL=true`

---

## STEP 5 — Redis setup

### Option A — Redis EC2 pe
```bash
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping        # PONG
```

`/etc/redis/redis.conf` me confirm karo ki `bind 127.0.0.1 -::1` hai (default hai) — bahar se access na ho.

**Bull ke liye ek zaroori setting** — Redis memory bharne par jobs silently delete ho jaate hain:
```bash
sudo sed -i 's/^# maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf
grep -n "maxmemory-policy" /etc/redis/redis.conf
sudo systemctl restart redis-server
```

### Option B — ElastiCache
ElastiCache → Redis OSS → cache.t4g.micro, cluster mode disabled. Security group me EC2 ka SG allow karo (port 6379). Endpoint `.env` ke `REDIS_HOST` me daalo.

---

## STEP 6 — Code deploy + .env

```bash
cd ~
git clone https://github.com/<your-username>/<repo>.git Email_Sender
cd Email_Sender
npm ci --omit=dev        # package-lock.json hai to `ci` best hai
```
(`concurrently` devDependency me move kar di gayi hai, production me install nahi hogi.)

`.env` banao — **ye git me kabhi commit nahi hoga**:
```bash
cp .env.example .env
openssl rand -hex 48        # output copy karo → JWT_SECRET
nano .env
```

`.gitignore` already set hai (`.env`, `node_modules/`, `*.pem`, `backups/`).

**Pehli baar manually test:**
```bash
npm start
```
Dikhna chahiye:
```
✅ MySQL pool → database: mail_Sender | table send_email_inquary OK
🔴 Checking Redis at 127.0.0.1:6379 ...
✅ Redis connected!
✅ Worker ready — listening for jobs...
🚀 Server  → http://0.0.0.0:3000
```
`Ctrl+C` karke aage badho.

---

## STEP 7 — Gmail App Password

Default me Gmail use hota hai, aur normal Gmail password kaam **nahi** karega — App Password chahiye.

1. Google Account → Security → **2-Step Verification** ON
2. https://myaccount.google.com/apppasswords → app password generate karo
3. 16-character password (spaces hata ke) `.env` ke `EMAIL_PASS` me daalo

**Limits jaan lo:** normal Gmail = ~500 recipients/day, Google Workspace = ~2000/day. Cross karne pe account temporarily block ho jaata hai. Aapka code har mail me 1200ms delay lagata hai — thoda safe hai, par daily limit alag cheez hai.

Agar volume zyada hona hai → **Amazon SES** pe shift karo (₹ me bahut sasta, ~$0.10 per 1000 mails). Nodemailer config sirf itna badlega:
```js
const transporter = nodemailer.createTransport({
  host: "email-smtp.ap-south-1.amazonaws.com",
  port: 587,
  secure: false,
  auth: { user: process.env.SES_SMTP_USER, pass: process.env.SES_SMTP_PASS },
});
```
SES pehle sandbox me hota hai (sirf verified emails pe bhej sakte ho) — production access ke liye support request daalni padti hai.

---

## STEP 8 — PM2 se 24x7 chalao

Zip me `ecosystem.config.js` already hai (single instance + graceful shutdown timeout):

```bash
cd ~/Email_Sender
pm2 start ecosystem.config.js
pm2 save
pm2 startup            # jo command output aaye use sudo ke saath chalao
```

Useful:
```bash
pm2 logs email-sender      # live logs
pm2 restart email-sender   # code change ke baad
pm2 monit                  # CPU/RAM
```

**Ek dhyan ki baat:** `pm2 start index.js -i 4` (cluster mode) **mat** karo. Worker isi process me hai — 4 instance = har mail 4 baar bhejne ka risk. Ek hi instance rakho.

---

## STEP 9 — Nginx reverse proxy + HTTPS

Config file zip me hai — `scripts/nginx-email-sender.conf`. Domain/IP edit karke copy karo:

```bash
nano scripts/nginx-email-sender.conf     # server_name badlo
sudo cp scripts/nginx-email-sender.conf /etc/nginx/sites-available/email-sender
```

(Manually likhna ho to content ye hai:)

```nginx
server {
    listen 80;
    server_name your-domain.com;    # domain na ho to Elastic IP daal do

    client_max_body_size 15M;       # resume/attachment upload ke liye

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/email-sender /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

Ab port 3000 ka rule security group se hata do.

**SSL (domain ho to):**
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```
Auto-renew certbot khud set kar deta hai.

---

## STEP 10 — Backup (jo galti pichli baar hui, dobara na ho)

**Local MySQL ke liye** — `scripts/backup-db.sh` zip me hai (credentials `.env` se leta hai,
gzip karta hai, 14 din se purane delete karta hai, aur `S3_BUCKET` set ho to S3 pe upload karta hai):

```bash
# test karo
bash scripts/backup-db.sh

# roz raat 2 baje
crontab -e
```
```cron
0 2 * * * /home/ubuntu/Email_Sender/scripts/backup-db.sh >> /home/ubuntu/backups/backup.log 2>&1
```

S3 upload chahiye to EC2 pe IAM role attach karo (keys hardcode na karo) aur:
```bash
sudo apt install -y awscli
echo 'S3_BUCKET=s3://your-bucket/db-backups' >> .env
```

**RDS use kar rahe ho to:** automated backups 7 din on hote hain — 14-30 din kar do, aur ek manual snapshot le lo.

Aur sabse important: **`schema.sql` ko repo me commit karo**. Aaj ki problem hi yahi thi ki schema kahin likha hua nahi tha.

---

## STEP 11 — Test karo

```bash
IP=<YOUR_ELASTIC_IP>

curl http://$IP/api/health

curl -X POST http://$IP/api/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","phone":"9999999999","password":"secret123"}'

TOKEN=$(curl -s -X POST http://$IP/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"secret123"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)

curl -X POST http://$IP/api/test-connection -H "Authorization: Bearer $TOKEN"

curl -X POST http://$IP/api/send \
  -H "Authorization: Bearer $TOKEN" \
  -F 'recipients=[{"email":"your-own@gmail.com","name":"Ravi","company":"TestCorp"}]' \
  -F 'subject=Test mail' \
  -F 'text=Hello {name}, applying at {company}.' \
  -F 'senderName=Your Name' \
  -F 'attachment=@resume.pdf'

curl http://$IP/api/queue-status -H "Authorization: Bearer $TOKEN"
```

DB me log verify karo:
```sql
SELECT row_id, user_id, to_email, created_on FROM send_email_inquary ORDER BY row_id DESC LIMIT 5;
```
Yahan row aa gaya = Bug 1 fix ho gaya.

---

## Common errors → fix

| Error | Kya karo |
|---|---|
| `Missing JWT_SECRET in .env` | `.env` me JWT_SECRET blank hai |
| `ER_ACCESS_DENIED_ERROR` | MYSQL_USER/PASSWORD galat, ya RDS user `'@%'` se nahi bana |
| `ETIMEDOUT` on MySQL | RDS security group me EC2 ka SG allow nahi hai |
| `ECONNREFUSED 127.0.0.1:6379` | `sudo systemctl start redis-server` |
| `ER_BAD_FIELD_ERROR: created_on` | purana `db.js` chal raha hai — fixed wala replace karo |
| `Invalid login: 535` (Gmail) | App Password use karo, normal password nahi |
| `ER_NO_SUCH_TABLE: user` | `schema.sql` run nahi hua |
| Mails queue me jaake atak gayi | `pm2 logs` dekho; Redis `maxmemory-policy noeviction` check karo |

---

## Aage ke improvements (deploy ke baad)

- Attachment poora Redis job data me base64-ish array ban ke jaata hai — 100 recipients × 2MB resume = Redis heavy. Better: file ek baar S3/disk pe rakho, job me sirf path bhejo.
- `/api/register` aur `/api/login` pe rate limit lagao (`express-rate-limit`) — public endpoints hain.
- `cors()` sabko allow karta hai; production me `cors({ origin: "https://your-frontend.com" })`.
- `user` table me `phone` aur `phone_no` dono ka confusion ek column me merge kar do.
- CloudWatch alarm laga do CPU aur disk ke liye.
