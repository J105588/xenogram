// Supabase（外部PostgreSQL）から node:sqlite（Node.js組み込み・追加依存なし）への移行。
// PM2でローカル/自宅PC運用にした今、ネットワーク越しの外部DBに依存する理由が無くなったため、
// このプロセスと同じマシン上のファイルにデータを持つ構成に切り替えた。
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'xenogram.sqlite');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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

CREATE TABLE IF NOT EXISTS vocacolle_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

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

-- 監視対象のニコニコユーザーID。空ならconfig.js（NICO_USER_IDS環境変数）にフォールバックする
CREATE TABLE IF NOT EXISTS nico_users (
  user_id    TEXT PRIMARY KEY,
  label      TEXT,
  added_at   TEXT NOT NULL
);

-- X（旧Twitter）キーワード監視（読み取り専用）。twitter-cli の検索結果を
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

// 設定行は常に1行だけ存在する前提（無ければ有効な状態で作る）
db.prepare(`INSERT OR IGNORE INTO vocacolle_settings (id, enabled, updated_at) VALUES (1, 1, ?)`)
  .run(new Date().toISOString());

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
