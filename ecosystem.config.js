// PM2 config — start: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "email-sender",
      script: "index.js",
      // ⚠️ instances 1 hi rakho. Worker isi process me chalta hai —
      // cluster mode (2+) me har mail multiple baar bhej sakta hai.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "400M",
      kill_timeout: 30000, // graceful shutdown ko time do (running mails finish)
      env: { NODE_ENV: "production" },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      time: true,
    },
  ],
};
