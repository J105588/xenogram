-- =====================================================================
-- 鯖ごとの「最後に通知判定した時点の数値」
--
-- 統計（video_stats）は動画単位でグローバル共有にしたため、キリ番・急上昇の
-- 判定に video_stats の最新行をそのまま使うと取りこぼしが起きる:
--   鯖Aのジョブが先に走って最新値を書き込む
--   → 直後に走った鯖Bは「前回値＝Aが書いた最新値」を見るので伸びがほぼ0に見え、
--      キリ番を跨いでいても通知されない
-- 既定のcronは全鯖とも毎時0分なので、これは確実に踏むバグになる。
--
-- 「共有してよい事実（再生数の履歴）」と「鯖ごとに独立して持つべき状態
-- （どこまで通知済みか）」を分け、後者をこの表で持つ。
-- =====================================================================

CREATE TABLE IF NOT EXISTS guild_video_notify_state (
  guild_id   TEXT    NOT NULL,
  video_id   TEXT    NOT NULL,
  views      INTEGER NOT NULL DEFAULT 0,
  comments   INTEGER NOT NULL DEFAULT 0,
  mylists    INTEGER NOT NULL DEFAULT 0,
  likes      INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT    NOT NULL,
  PRIMARY KEY (guild_id, video_id)
);

-- 既存の監視分は現在の最新統計で初期化する。
-- 空のまま始めると「前回値0 → 現在値1万」となり、移行直後に過去のキリ番が
-- 一斉に通知されてしまうため。
INSERT OR IGNORE INTO guild_video_notify_state
  (guild_id, video_id, views, comments, mylists, likes, checked_at)
  SELECT gv.guild_id, gv.video_id, vs.views, vs.comments, vs.mylists, vs.likes, vs.recorded_at
  FROM guild_videos gv
  JOIN video_stats vs ON vs.id = (
    SELECT id FROM video_stats WHERE video_id = gv.video_id ORDER BY recorded_at DESC LIMIT 1
  );
