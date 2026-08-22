-- =====================================================================
-- ボカコレ（VOCALOID COLLECTION）ランキング監視機能
--   1. vocacolle_keywords   : 監視キーワード（曲名 / アーティスト名、完全一致）
--   2. vocacolle_detections : 検知履歴（同じ曲を何度も通知しないための重複防止）
--
-- 既存の videos / video_stats と同様、RLS は有効化していない。
-- （Bot が service_role / anon キーで直接読み書きするため）
-- =====================================================================

-- ---------------------------------------------------------------------
-- 監視キーワード
--   target = 'title'  : 曲名（video.title）との完全一致
--   target = 'artist' : 投稿者名（video.owner.name）との完全一致
--   active_from / active_until で「特定の期間だけ」監視を有効にする。
--     NULL は無制限を意味し、両方 NULL なら常時有効。
-- ---------------------------------------------------------------------
CREATE TABLE vocacolle_keywords (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    keyword      TEXT        NOT NULL,
    target       TEXT        NOT NULL DEFAULT 'title'
                             CHECK (target IN ('title', 'artist')),
    page_id      TEXT        NOT NULL DEFAULT 'rookie',
    active_from  TIMESTAMP WITH TIME ZONE,
    active_until TIMESTAMP WITH TIME ZONE,
    enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
    note         TEXT,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 同じページ・同じ対象に同一キーワードを二重登録させない
CREATE UNIQUE INDEX vocacolle_keywords_unique
    ON vocacolle_keywords (page_id, target, keyword);

CREATE INDEX vocacolle_keywords_enabled_idx
    ON vocacolle_keywords (enabled, page_id);

-- ---------------------------------------------------------------------
-- 検知履歴
--   (keyword_id, page_id, watch_id) が一意。
--   既に行が存在するキーワード×動画の組み合わせは再通知しない。
-- ---------------------------------------------------------------------
CREATE TABLE vocacolle_detections (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    keyword_id      BIGINT      REFERENCES vocacolle_keywords(id) ON DELETE CASCADE,
    page_id         TEXT        NOT NULL,
    watch_id        TEXT        NOT NULL,
    matched_keyword TEXT        NOT NULL,
    matched_target  TEXT        NOT NULL,
    rank_position   INTEGER,
    title           TEXT,
    artist          TEXT,
    view_count      INTEGER,
    screenshot_ok   BOOLEAN     NOT NULL DEFAULT FALSE,
    detected_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX vocacolle_detections_unique
    ON vocacolle_detections (keyword_id, page_id, watch_id);

CREATE INDEX vocacolle_detections_detected_at_idx
    ON vocacolle_detections (detected_at DESC);
