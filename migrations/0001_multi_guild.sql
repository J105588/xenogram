-- =====================================================================
-- マルチテナント化: 「1サーバー専用」から「鯖ごとに独立した設定・監視対象」へ
--
-- これまで通知先は .env の DISCORD_CHANNEL_ID 1つきり、監視対象（動画・
-- ボカコレKW・X KW・ニコ動ユーザー）と設定値はサーバーの区別を一切持たず、
-- Botを別のサーバーに入れても同じ内容が同じ場所に流れるだけだった。
-- 鯖ごとに別々の運用ができるよう、登録データと設定に guild_id を持たせる。
--
-- 方針:
--   * videos / video_stats は「動画そのものの事実」なのでグローバル共有のまま。
--     どの鯖が監視しているかは guild_videos で表現する。
--     → 同じ動画をN鯖が監視してもAPI取得もDB容量も1本で済み、後から
--        監視を始めた鯖もその動画の過去履歴グラフをすぐ見られる。
--   * 既存データはすべて現在のサーバー（__LEGACY_GUILD_ID__）の所有として引き継ぐ。
--
-- SQLiteは ALTER TABLE で主キー・UNIQUE制約を変更できないため、
-- guild_id を制約に含めるテーブルは「新テーブル作成 → コピー → 差し替え」で作り直す。
-- 実行側（migrate.js）が PRAGMA foreign_keys=OFF とトランザクションで包む。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. サーバー登録と、鯖ごとの通知先チャンネル
--    チャンネルが未設定(NULL)の鯖には通知を送らない（誤爆防止）。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guilds (
  guild_id             TEXT PRIMARY KEY,
  name                 TEXT,
  notify_channel_id    TEXT,
  vocacolle_channel_id TEXT,
  twitter_channel_id   TEXT,
  added_at             TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

INSERT OR IGNORE INTO guilds
  (guild_id, name, notify_channel_id, vocacolle_channel_id, twitter_channel_id, added_at, updated_at)
VALUES (
  __LEGACY_GUILD_ID__,
  '(移行元サーバー)',
  __LEGACY_NOTIFY_CHANNEL__,
  __LEGACY_VOCACOLLE_CHANNEL__,
  __LEGACY_TWITTER_CHANNEL__,
  __NOW__,
  __NOW__
);

-- ---------------------------------------------------------------------
-- 2. 鯖ごとの動画監視リスト
--    videos は動画マスタ（グローバル）として据え置き、
--    「どの鯖が監視しているか」だけをこの表で持つ。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guild_videos (
  guild_id TEXT NOT NULL,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_guild_videos_video_id ON guild_videos(video_id);

INSERT OR IGNORE INTO guild_videos (guild_id, video_id, added_at)
  SELECT __LEGACY_GUILD_ID__, id, added_at FROM videos;

-- ---------------------------------------------------------------------
-- 3. ボカコレ監視キーワード
--    UNIQUE を (page_id,target,keyword) → (guild_id,page_id,target,keyword) へ。
--    別の鯖が同じキーワードを登録できるようにするため。
-- ---------------------------------------------------------------------
CREATE TABLE vocacolle_keywords_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  keyword      TEXT NOT NULL,
  target       TEXT NOT NULL DEFAULT 'title' CHECK (target IN ('title', 'artist')),
  page_id      TEXT NOT NULL DEFAULT 'rookie',
  active_from  TEXT,
  active_until TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (guild_id, page_id, target, keyword)
);

INSERT INTO vocacolle_keywords_new
  (id, guild_id, keyword, target, page_id, active_from, active_until, enabled, note, created_at)
  SELECT id, __LEGACY_GUILD_ID__, keyword, target, page_id, active_from, active_until, enabled, note, created_at
  FROM vocacolle_keywords;

DROP TABLE vocacolle_keywords;
ALTER TABLE vocacolle_keywords_new RENAME TO vocacolle_keywords;
CREATE INDEX IF NOT EXISTS idx_vocacolle_keywords_enabled ON vocacolle_keywords(guild_id, enabled, page_id);

-- ---------------------------------------------------------------------
-- 4. X（旧Twitter）監視キーワード
--    UNIQUE(query) → UNIQUE(guild_id, query)
-- ---------------------------------------------------------------------
CREATE TABLE twitter_keywords_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id   TEXT NOT NULL,
  query      TEXT NOT NULL,
  note       TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, query)
);

INSERT INTO twitter_keywords_new (id, guild_id, query, note, enabled, created_at)
  SELECT id, __LEGACY_GUILD_ID__, query, note, enabled, created_at FROM twitter_keywords;

DROP TABLE twitter_keywords;
ALTER TABLE twitter_keywords_new RENAME TO twitter_keywords;
CREATE INDEX IF NOT EXISTS idx_twitter_keywords_guild ON twitter_keywords(guild_id, enabled);

-- ---------------------------------------------------------------------
-- 5. 監視対象のニコニコユーザー
--    PRIMARY KEY(user_id) → PRIMARY KEY(guild_id, user_id)
--    （別の鯖が同じ投稿者を監視できるようにするため）
-- ---------------------------------------------------------------------
CREATE TABLE nico_users_new (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  label    TEXT,
  added_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

INSERT INTO nico_users_new (guild_id, user_id, label, added_at)
  SELECT __LEGACY_GUILD_ID__, user_id, label, added_at FROM nico_users;

DROP TABLE nico_users;
ALTER TABLE nico_users_new RENAME TO nico_users;

-- ---------------------------------------------------------------------
-- 6. 設定値（キリ番の刻み・急上昇しきい値・cron式など）
--    PRIMARY KEY(key) → PRIMARY KEY(guild_id, key)
-- ---------------------------------------------------------------------
CREATE TABLE app_settings_new (
  guild_id   TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, key)
);

INSERT INTO app_settings_new (guild_id, key, value, updated_at)
  SELECT __LEGACY_GUILD_ID__, key, value, updated_at FROM app_settings;

DROP TABLE app_settings;
ALTER TABLE app_settings_new RENAME TO app_settings;

-- ---------------------------------------------------------------------
-- 7. ボカコレ監視のON/OFF
--    専用テーブル（1行固定）をやめ、他の設定と同じ app_settings へ移す。
--    鯖ごとの値を持つ場所が2種類あると取り違えるため。
--
--    新規DBではこのテーブルが存在しない（初期スキーマから除去済み）ので、
--    SELECT が「テーブルが無い」で落ちないよう、空の状態で作ってから移す。
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vocacolle_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (guild_id, key, value, updated_at)
  SELECT __LEGACY_GUILD_ID__, 'vocacolle_watch_enabled', CAST(enabled AS TEXT), updated_at
  FROM vocacolle_settings WHERE id = 1;

DROP TABLE IF EXISTS vocacolle_settings;

-- ---------------------------------------------------------------------
-- 8. 検知履歴は keyword_id 経由で所属サーバーが決まるため列の追加は不要。
--    ただし旧 vocacolle_keywords を作り直した際に外部キー参照が
--    宙に浮くため、参照先が新しい表を向いていることをここで確定させる。
--    （vocacolle_ranking_sources はページIDの解決キャッシュなのでグローバルのまま）
-- ---------------------------------------------------------------------
