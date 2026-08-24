-- vocaloid-collection.jp が nvapi.nicovideo.jp への直接プロキシ（クライアント側XHR）を
-- やめ、自前の Next.js データAPI（/_next/data/{buildId}/ranking/{pageId}.json）で
-- ランキングを配信する構成に変わった（2026-08時点で確認）。
-- これに伴いキャッシュすべき値が「nvapiのランキングID＋frontendId」から
-- 「NextのbuildId」1つだけになったため、列名をその実態に合わせる。
ALTER TABLE vocacolle_ranking_sources RENAME COLUMN ranking_id TO build_id;
ALTER TABLE vocacolle_ranking_sources DROP COLUMN frontend_id;
