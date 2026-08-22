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
      // 再起動を繰り返すほど待ち時間を延ばす（ネットワーク断など一時的な障害から
      // 復帰しやすくしつつ、恒久的な不具合で連打し続けないようにする）
      exp_backoff_restart_delay: 5000,
      watch: false,
      // Chromiumを含めても通常は数百MB程度。万一のリークに備えた安全弁
      max_memory_restart: '2G',
      // 毎日午前4時に予防的な再起動をかけ、長期稼働で溜まるリソースをリセットする
      // （4時なら毎時5分のボカコレ監視・朝7時のデイリーレポートのどちらとも重ならない）
      cron_restart: '0 4 * * *',
      // SIGINT を受けてから強制終了するまでの猶予。
      // 撮影中のChromiumを閉じる時間を確保する（既定の1.6秒では短い）
      kill_timeout: 15000,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Tokyo',
      },
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      // ログが無限に肥大化しないよう日付でローテーションする
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      time: true,
    },
  ],
};
