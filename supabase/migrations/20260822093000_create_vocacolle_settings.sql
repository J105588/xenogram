-- =====================================================================
-- ボカコレ監視の実行時設定
--   1. vocacolle_settings       : 監視全体のON/OFF（/vc_toggle から変更、再起動不要）
--   2. vocacolle_ranking_sources: nvapi の内部ランキングIDのキャッシュ
--                                  （ページのHTMLには含まれないため、一度ブラウザで
--                                   解決した結果をここに保存し、通常運転時は
--                                   ブラウザなしで直接APIを叩けるようにする）
-- =====================================================================

CREATE TABLE vocacolle_settings (
    id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- 常に1行だけの設定テーブル
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO vocacolle_settings (id, enabled) VALUES (1, TRUE);

CREATE TABLE vocacolle_ranking_sources (
    page_id      TEXT PRIMARY KEY,
    ranking_id   TEXT NOT NULL,
    frontend_id  TEXT NOT NULL,
    resolved_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
