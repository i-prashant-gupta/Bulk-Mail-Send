#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Fresh Ubuntu 24.04 EC2 pe sab install kar deta hai.
#  Usage:  bash scripts/setup-ubuntu.sh
#  Ye .env NAHI banata aur app start NAHI karta — wo manual hai.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

echo "==> System update"
sudo apt-get update -y && sudo apt-get upgrade -y
sudo apt-get install -y git curl build-essential nginx

echo "==> Node.js 20 (nvm)"
if [ ! -d "$HOME/.nvm" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 20
nvm alias default 20
node -v

echo "==> PM2"
npm install -g pm2

echo "==> Redis"
sudo apt-get install -y redis-server
# Bull ke liye zaroori: memory full hone par jobs delete na ho
sudo sed -i 's/^# *maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf
grep -q "^maxmemory-policy noeviction" /etc/redis/redis.conf || \
  echo "maxmemory-policy noeviction" | sudo tee -a /etc/redis/redis.conf
sudo systemctl enable --now redis-server
sudo systemctl restart redis-server
redis-cli ping

echo "==> MySQL (skip karo agar RDS use kar rahe ho)"
read -rp "Local MySQL install karna hai? [y/N] " ans
if [[ "${ans,,}" == "y" ]]; then
  sudo apt-get install -y mysql-server
  sudo systemctl enable --now mysql
  echo "Ab chalao:  sudo mysql_secure_installation"
  echo "Phir:       sudo mysql < schema.sql"
else
  sudo apt-get install -y mysql-client
  echo "RDS ke liye:  mysql -h <RDS_ENDPOINT> -u admin -p < schema.sql"
fi

echo ""
echo "✅ Setup done. Aage:"
echo "   1) cp .env.example .env  &&  nano .env"
echo "   2) openssl rand -hex 48   → JWT_SECRET"
echo "   3) schema.sql chadhao (upar dekho)"
echo "   4) npm ci --omit=dev"
echo "   5) node index.js   (test)  →  pm2 start ecosystem.config.js"
