// Supabase（外部PostgreSQL）から node:sqlite（Node.js組み込み・追加依存なし）への移行。
// PM2でローカル/自宅PC運用にした今、ネットワーク越しの外部DBに依存する理由が無くなったため、
// このプロセスと同じマシン上のファイルにデータを持つ構成に切り替えた。
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// 通常は data/xenogram.sqlite。XENOGRAM_DB_PATH を指定すると別のファイルを開く
// （本番DBに触れずにマイグレーションや破壊的な変更を検証するために使う）。
const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = process.env.XENOGRAM_DB_PATH || path.join(DATA_DIR, 'xenogram.sqlite');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL: 読み取りと書き込みが同時に走っても詰まりにくくなる（cronジョブとDiscordコマンドが重なる場面が多いため）
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS videos (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  published_at  TEXT,
  added_at      TEXT NOT NULL,
  tags          TEXT,
  thumbnail_url TEXT
);

CREATE TABLE IF NOT EXISTS video_stats (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  views       INTEGER NOT NULL DEFAULT 0,
  comments    INTEGER NOT NULL DEFAULT 0,
  mylists     INTEGER NOT NULL DEFAULT 0,
  likes       INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_stats_video_id_recorded_at ON video_stats(video_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS vocacolle_keywords (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT NOT NULL,
  target       TEXT NOT NULL DEFAULT 'title' CHECK (target IN ('title', 'artist')),
  page_id      TEXT NOT NULL DEFAULT 'rookie',
  active_from  TEXT,
  active_until TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (page_id, target, keyword)
);
CREATE INDEX IF NOT EXISTS idx_vocacolle_keywords_enabled ON vocacolle_keywords(enabled, page_id);

CREATE TABLE IF NOT EXISTS vocacolle_detections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id      INTEGER REFERENCES vocacolle_keywords(id) ON DELETE CASCADE,
  page_id         TEXT NOT NULL,
  watch_id        TEXT NOT NULL,
  matched_keyword TEXT NOT NULL,
  matched_target  TEXT NOT NULL,
  rank_position   INTEGER,
  title           TEXT,
  artist          TEXT,
  view_count      INTEGER,
  screenshot_ok   INTEGER NOT NULL DEFAULT 0,
  detected_at     TEXT NOT NULL,
  UNIQUE (keyword_id, page_id, watch_id)
);
CREATE INDEX IF NOT EXISTS idx_vocacolle_detections_detected_at ON vocacolle_detections(detected_at DESC);

-- 注意: ここは「初期スキーマ」であり、起動のたびに実行される。
-- マイグレーションで削除したテーブルをここに残しておくと、次回起動時に
-- CREATE TABLE IF NOT EXISTS が空のテーブルを作り直してしまう
-- （vocacolle_settings が実際にそうなっていた。0003 で除去済み）。
-- 構造を変えるときは、ここではなく migrations/ にSQLを足すこと。

CREATE TABLE IF NOT EXISTS vocacolle_ranking_sources (
  page_id     TEXT PRIMARY KEY,
  ranking_id  TEXT NOT NULL,
  frontend_id TEXT NOT NULL,
  resolved_at TEXT NOT NULL
);

-- 実行時に変更可能な設定値（マイルストーン刻み・急上昇閾値・cron式など）のキーバリューストア。
-- ここに行が無いキーは config.js の環境変数デフォルトにフォールバックする
-- （＝.envは「初期値」、ここは「実際に今使われている値」）
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 監視対象のニコニコユーザーID（サーバーごと）。登録が無い鯖は誰も監視しない
-- （0001以降 guild_id 付き。.envへのフォールバックは廃止済み）
CREATE TABLE IF NOT EXISTS nico_users (
  user_id    TEXT PRIMARY KEY,
  label      TEXT,
  added_at   TEXT NOT NULL
);

-- X（旧Twitter）キーワード監視（読み取り専用）。X内部APIの検索結果を
-- 定期的に照合し、ヒットしたツイートをDiscordに通知する（投稿は行わない）
CREATE TABLE IF NOT EXISTS twitter_keywords (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT NOT NULL UNIQUE,
  note       TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 通知済みツイートの重複防止（同じツイートを何度も通知しない）
CREATE TABLE IF NOT EXISTS twitter_detections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id  INTEGER NOT NULL REFERENCES twitter_keywords(id) ON DELETE CASCADE,
  tweet_id    TEXT NOT NULL,
  author      TEXT,
  detected_at TEXT NOT NULL,
  UNIQUE (keyword_id, tweet_id)
);
CREATE INDEX IF NOT EXISTS idx_twitter_detections_detected_at ON twitter_detections(detected_at DESC);
`);

// 上の CREATE TABLE 群は「初期スキーマ」。ここから先の構造変更は migrations/ 配下の
// SQLで行い、適用済みバージョンを schema_migrations に記録する
// （新規DBでも既存DBでも「初期スキーマ → 未適用マイグレーションを順に適用」で
//   同じ最終形になるため、経路が1本で済む）。
const config = require('../../config');
const { runMigrations } = require('./migrate');

// マルチテナント化以前のデータをどのサーバーの所有として引き継ぐか。
// DISCORD_GUILD_ID が未設定の環境では 'legacy' に退避し、起動ログで知らせる
// （後から /guild_setup を実行したサーバーが引き取れる状態にしておく）。
const LEGACY_GUILD_ID = config.DISCORD.GUILD_ID || 'legacy';
if (!config.DISCORD.GUILD_ID) {
  console.warn(
    "[MIGRATE] DISCORD_GUILD_ID が未設定のため、既存データを 'legacy' サーバーとして退避します。" +
    ' 引き継ぎたいサーバーで /guild_adopt を実行してください。'
  );
}

runMigrations(db, {
  __LEGACY_GUILD_ID__: LEGACY_GUILD_ID,
  __LEGACY_NOTIFY_CHANNEL__: config.DISCORD.CHANNEL_ID,
  __LEGACY_VOCACOLLE_CHANNEL__: config.VOCACOLLE.CHANNEL_ID,
  __LEGACY_TWITTER_CHANNEL__: config.TWITTER_MONITOR.CHANNEL_ID,
  __NOW__: new Date().toISOString(),
});

/**
 * SQLiteはBOOLEANを持たないため 0/1 で保存している。JS側の真偽値との変換ヘルパー。
 */
function toBool(value) {
  return value === 1 || value === true;
}
function fromBool(value) {
  return value ? 1 : 0;
}

/**
 * INSERT/UPDATE の UNIQUE制約違反かどうかを判定する
 * （Supabase時代の error.code === '23505' チェックの置き換え）
 */
function isUniqueConstraintError(error) {
  return !!error && typeof error.message === 'string' && error.message.includes('UNIQUE constraint failed');
}

module.exports = { db, toBool, fromBool, isUniqueConstraintError, DB_PATH };
