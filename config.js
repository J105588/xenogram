require('dotenv').config();

module.exports = {
  // 【廃止】監視対象のニコニコユーザーIDは .env ではなくサーバーごとにDBで管理する（/user_add）。
  //
  // 以前はここを「登録が無いときのフォールバック」として使っていたが、マルチテナント化で
  // 危険になった: Botを新しいサーバーに入れた瞬間、そのサーバーが何も登録していないのに
  // ここのユーザーの監視が始まり、その投稿者の全動画を「新着」として登録・通知してしまう。
  // 新しいサーバーは完全に空の状態から始まるべきなので、実行時には参照しない。
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
  PORT: process.env.PORT || 47810,

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

  // X（旧Twitter）キーワード監視（読み取り専用）
  //
  // 投稿は一切行わない。twitter-openapi-typescript
  // （https://github.com/fa0311/twitter-openapi-typescript）経由でX内部のGraphQL APIを
  // 直接叩き、検索結果に登録キーワードがヒットしたらDiscordに通知する。
  // 以前は外部CLI（twitter-cli）を子プロセスとして呼び出していたが、Xの新しいbot対策
  // （x-client-transaction-idヘッダ）に対応できず検索が失敗するようになったため、
  // このヘッダを自動生成できるライブラリに移行した（2026-08）。
  //
  // 公式APIキーではなくブラウザCookie/セッショントークンで動く非公式ライブラリのため、
  // 利用にはあらかじめ以下のセットアップが必要（詳細は .env.example を参照）：
  //   1. ブラウザでX(Twitter)にログインし、Cookieから ct0 と auth_token を控える
  //   2. .env に TWITTER_CT0 / TWITTER_AUTH_TOKEN を設定
  //   3. TWITTER_MONITOR_ENABLED=true にする
  // 上記が未設定の間は機能全体が無効（既定はfalse）になり、他機能には一切影響しない。
  TWITTER_MONITOR: {
    ENABLED: process.env.TWITTER_MONITOR_ENABLED === 'true',
    // ブラウザのCookieから取得するセッション情報（読み取り専用アカウントの利用を推奨）
    CT0: process.env.TWITTER_CT0 || null,
    AUTH_TOKEN: process.env.TWITTER_AUTH_TOKEN || null,
    // 実行スケジュール（既定: 毎時10分。ボカコレ監視(毎時5分)と被らないようずらしている）
    CRON: process.env.TWITTER_MONITOR_CRON || '10 * * * *',
    // 通知先。未指定なら通常の通知チャンネルを使う
    CHANNEL_ID: process.env.TWITTER_MONITOR_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID,
    // 1キーワードあたりの検索取得件数
    MAX_RESULTS: Number(process.env.TWITTER_MONITOR_MAX_RESULTS || 20),
    // API呼び出しのタイムアウト(ms)
    FETCH_TIMEOUT_MS: Number(process.env.TWITTER_MONITOR_TIMEOUT_MS || 20000),
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
