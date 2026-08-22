require('dotenv').config();

module.exports = {
  // 監視対象のニコニコユーザーID（複数可・カンマ区切り）。
  // コラボ相手や他の投稿者も合わせて監視したい場合は環境変数 NICO_USER_IDS を使う。
  // 新着検知・マイルストーン一括取得のどちらも全ユーザー分をまとめて処理する。
  NICO_USER_IDS: (process.env.NICO_USER_IDS || "143305795").split(',').map(s => s.trim()).filter(Boolean),
  // 後方互換: 単一IDだけを期待しているコード向け（先頭のID）
  get NICO_USER_ID() { return this.NICO_USER_IDS[0]; },
  CHART_COLOR: "3498db", // XENOGRAMブランドカラー (Hex)
  FOOTER_TEXT: "XENOGRAM Analytics",
  // マイルストーン（キリ番）の判定単位。動画の再生数規模が大きくなってきたら
  // 100→1000のように環境変数で引き上げる
  MILESTONE_STEP: Number(process.env.MILESTONE_STEP || 100),

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
  // PORT / RENDER_EXTERNAL_URL は Render にデプロイする場合だけ使う設定。
  // PM2でのローカル/自宅サーバー運用では不要（index.js側もRENDER_EXTERNAL_URL未設定なら
  // 自己ping自体を行わないようになっている）
  PORT: process.env.PORT || 3000,
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,

  // ボカコレ（VOCALOID COLLECTION）ランキング監視
  //
  // ボカコレ専用ではなく「ページURL → nvapiランキングID解決 → キーワード照合」という
  // 仕組みそのものは、ニコニコの他のジャンル/タグ別ランキングにも転用できる。
  // VOCACOLLE_RANKING_URLS にカンマ区切りで複数URLを渡すと、それぞれ独立に
  // 監視・通知される（キーワード側の page_id で「どのページに対する登録か」を区別する）。
  VOCACOLLE: {
    ENABLED: process.env.VOCACOLLE_ENABLED !== 'false',
    // 監視対象ランキングのURL（複数可・カンマ区切り）。VOCACOLLE_RANKING_URL（単数形）も後方互換で読む
    RANKING_URLS: (process.env.VOCACOLLE_RANKING_URLS || process.env.VOCACOLLE_RANKING_URL || 'https://vocaloid-collection.jp/ranking/rookie/')
      .split(',').map(s => s.trim()).filter(Boolean),
    // 後方互換: 単一URLだけを期待している既存コード・テストスクリプト向け（先頭のURL）
    get RANKING_URL() { return this.RANKING_URLS[0]; },
    // 実行スケジュール（既定: 毎時5分）
    CRON: process.env.VOCACOLLE_CRON || '5 * * * *',
    // 通知先。未指定なら通常の通知チャンネルを使う
    CHANNEL_ID: process.env.VOCACOLLE_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID,
    // ページ取得のタイムアウト(ms)
    FETCH_TIMEOUT_MS: Number(process.env.VOCACOLLE_FETCH_TIMEOUT_MS || 15000),
    // 順位がこの数値以上動いたら「順位変動通知」を送る
    RANK_CHANGE_THRESHOLD: Number(process.env.VOCACOLLE_RANK_CHANGE_THRESHOLD || 10),
  },

  // 週次まとめレポート（既定: 毎週日曜 21:00 JST）
  WEEKLY_REPORT: {
    ENABLED: process.env.WEEKLY_REPORT_ENABLED !== 'false',
    CRON: process.env.WEEKLY_REPORT_CRON || '0 21 * * 0',
  },

  // 急上昇（バズ）検知: 毎時のチェックで、1時間あたりの再生数増加がこの値以上なら通知する
  SPIKE_DETECTION: {
    ENABLED: process.env.SPIKE_DETECTION_ENABLED !== 'false',
    VIEW_THRESHOLD_PER_HOUR: Number(process.env.SPIKE_VIEW_THRESHOLD_PER_HOUR || 500),
    // 同じ動画への連続通知を防ぐクールダウン（時間）
    COOLDOWN_HOURS: Number(process.env.SPIKE_COOLDOWN_HOURS || 6),
  },

  // Puppeteer によるスクリーンショット設定
  SCREENSHOT: {
    ENABLED: process.env.SCREENSHOT_ENABLED !== 'false',
    // システムのChromeを使う場合に指定（未指定ならpuppeteer同梱版）
    EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    TIMEOUT_MS: Number(process.env.SCREENSHOT_TIMEOUT_MS || 60000),
    VIEWPORT_WIDTH: Number(process.env.SCREENSHOT_VIEWPORT_WIDTH || 1440),
    VIEWPORT_HEIGHT: Number(process.env.SCREENSHOT_VIEWPORT_HEIGHT || 1000),
    // 2 にすると解像度2倍の高精細スクショになる（Discord上で文字がくっきりする）。
    // メモリ制約のあるホスティングでは 1 に落とすこと
    DEVICE_SCALE_FACTOR: Number(process.env.SCREENSHOT_SCALE || 2),
  },
};
