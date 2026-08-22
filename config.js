require('dotenv').config();

module.exports = {
  NICO_USER_ID: "143305795", // 対象のニコニコユーザーID
  CHART_COLOR: "3498db", // XENOGRAMブランドカラー (Hex)
  FOOTER_TEXT: "XENOGRAM Analytics",
  
  // Environment variables
  DISCORD: {
    TOKEN: process.env.DISCORD_TOKEN,
    CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    GUILD_ID: process.env.DISCORD_GUILD_ID, // 開発用
    CHANNEL_ID: process.env.DISCORD_CHANNEL_ID, // 通知を送信するチャンネルID
  },
  SUPABASE: {
    URL: process.env.SUPABASE_URL,
    KEY: process.env.SUPABASE_KEY,
  },
  PORT: process.env.PORT || 3000,
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,

  // ボカコレ（VOCALOID COLLECTION）ランキング監視
  VOCACOLLE: {
    ENABLED: process.env.VOCACOLLE_ENABLED !== 'false',
    // 監視対象ランキングのURL（ルーキー以外を見たい場合は環境変数で差し替える）
    RANKING_URL: process.env.VOCACOLLE_RANKING_URL || 'https://vocaloid-collection.jp/ranking/rookie/',
    // 実行スケジュール（既定: 毎時5分）
    CRON: process.env.VOCACOLLE_CRON || '5 * * * *',
    // 通知先。未指定なら通常の通知チャンネルを使う
    CHANNEL_ID: process.env.VOCACOLLE_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID,
    // ページ取得のタイムアウト(ms)
    FETCH_TIMEOUT_MS: Number(process.env.VOCACOLLE_FETCH_TIMEOUT_MS || 15000),
  },

  // Puppeteer によるスクリーンショット設定
  SCREENSHOT: {
    ENABLED: process.env.SCREENSHOT_ENABLED !== 'false',
    // Render/Docker等でシステムのChromeを使う場合に指定（未指定ならpuppeteer同梱版）
    EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // Render等の低スペック環境ではページ描画に1分以上かかることがあるため、
    // デフォルトを長めに取っている（十分速い環境ではもっと短くしてよい）
    TIMEOUT_MS: Number(process.env.SCREENSHOT_TIMEOUT_MS || 90000),
    VIEWPORT_WIDTH: Number(process.env.SCREENSHOT_VIEWPORT_WIDTH || 1280),
    VIEWPORT_HEIGHT: Number(process.env.SCREENSHOT_VIEWPORT_HEIGHT || 1000),
    // 低メモリ環境（Render無料枠など）では 1 のままにしておく
    DEVICE_SCALE_FACTOR: Number(process.env.SCREENSHOT_SCALE || 1),
  },
};
