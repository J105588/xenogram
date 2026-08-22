// PM2 用の起動設定。
//   起動:   pm2 start ecosystem.config.js
//   停止:   pm2 stop xenogram
//   再起動: pm2 restart xenogram
//   ログ:   pm2 logs xenogram
//   状態:   pm2 status
module.exports = {
  apps: [
    {
      name: 'xenogram',
      script: 'index.js',
      cwd: __dirname,
      // クラッシュ時は自動再起動。ただし短時間に繰り返しクラッシュする場合は
      // 無限ループで再起動し続けないよう上限を設ける
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      watch: false,
      // このPCでは512MBのような制約はないが、万一の暴走に備えて上限を設定
      // （Renderのような低メモリ環境向けではなく、単なる安全弁）
      max_memory_restart: '1500M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Tokyo',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      time: true,
    },
  ],
};
