const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
  apps: [
    {
      name: 'k-server',
      script: './dist/index.js',
      cwd: __dirname,
      env: {
        // 只注入纯 ASCII 的必要项；其余变量（含中文的 APP_UPDATE_NOTES）由应用自身的
        // dotenv 直接读 /var/www/k/.env——经 PM2 守护进程转发的非 ASCII 值会出现编码损坏
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
