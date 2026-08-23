const { db } = require('./db');

/* =====================================================================
 * 動画マスタ（videos）と、鯖ごとの監視リスト（guild_videos）。
 *
 * 再生数などの統計は「動画そのものの事実」で鯖によって変わらないため、
 * videos / video_stats はグローバルに1本だけ持ち、
 * 「どの鯖がその動画を監視しているか」を guild_videos で表す。
 * 同じ動画をN鯖が監視してもAPI取得もDB容量も1本で済み、
 * 後から監視を始めた鯖もその動画の過去履歴グラフをすぐ見られる。
 * ===================================================================== */

/**
 * その鯖が監視中の動画かどうか
 */
async function hasVideo(guildId, videoId) {
  const row = db.prepare('SELECT 1 FROM guild_videos WHERE guild_id = ? AND video_id = ?').get(guildId, videoId);
  return !!row;
}

/**
 * 動画マスタに存在するか（鯖を問わず）。統計だけ先に溜まっている動画の判定に使う。
 */
async function videoExists(videoId) {
  return !!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId);
}

/**
 * 動画を監視対象に追加する。
 * 動画マスタが無ければ作り、その鯖の監視リストに紐付ける。
 */
async function addVideo(guildId, videoId, title, tags, thumbnailUrl, publishedAt) {
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO videos (id, title, tags, thumbnail_url, published_at, added_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        tags = COALESCE(excluded.tags, videos.tags),
        thumbnail_url = COALESCE(excluded.thumbnail_url, videos.thumbnail_url),
        published_at = COALESCE(excluded.published_at, videos.published_at)
    `).run(
      videoId,
      title,
      tags,
      thumbnailUrl,
      publishedAt ? new Date(publishedAt).toISOString() : null,
      now
    );

    db.prepare('INSERT OR IGNORE INTO guild_videos (guild_id, video_id, added_at) VALUES (?, ?, ?)')
      .run(guildId, videoId, now);
    return true;
  } catch (error) {
    console.error("Error adding video:", error);
    return false;
  }
}

/**
 * その鯖が監視中の全動画を取得（投稿日時が新しい順）
 */
async function getAllVideos(guildId) {
  try {
    // published_at が NULL の行が先頭に来ないよう、NULLは末尾に回す
    return db.prepare(`
      SELECT v.* FROM videos v
      JOIN guild_videos gv ON gv.video_id = v.id
      WHERE gv.guild_id = ?
      ORDER BY (v.published_at IS NULL), v.published_at DESC
    `).all(guildId);
  } catch (error) {
    console.error("Error getting all videos:", error);
    return [];
  }
}

/**
 * いずれかの鯖が監視している動画のIDを重複なく取得する。
 * 毎時の統計取得を「鯖ごと」ではなく「動画ごと」に1回で済ませるために使う。
 */
async function getAllWatchedVideoIds() {
  try {
    return db.prepare(`
      SELECT DISTINCT v.id, v.title FROM videos v
      JOIN guild_videos gv ON gv.video_id = v.id
      ORDER BY v.id
    `).all();
  } catch (error) {
    console.error("Error getting watched video ids:", error);
    return [];
  }
}

/**
 * 動画情報を更新（サムネやタグが変更された場合用）。動画マスタは鯖共通。
 */
async function updateVideoInfo(videoId, tags, thumbnailUrl) {
  try {
    db.prepare('UPDATE videos SET tags = ?, thumbnail_url = ? WHERE id = ?')
      .run(tags, thumbnailUrl, videoId);
  } catch (error) {
    console.error("Error updating video info:", error);
  }
}

/**
 * その鯖の監視リストから外す。
 * 動画マスタと統計履歴は残す（他の鯖が監視している可能性があり、
 * また再登録したときに過去のグラフが復活するため）。
 */
async function removeVideo(guildId, videoId) {
  try {
    const info = db.prepare('DELETE FROM guild_videos WHERE guild_id = ? AND video_id = ?').run(guildId, videoId);
    return info.changes > 0;
  } catch (error) {
    console.error("Error removing video:", error);
    return false;
  }
}

module.exports = {
  hasVideo,
  videoExists,
  addVideo,
  getAllVideos,
  getAllWatchedVideoIds,
  updateVideoInfo,
  removeVideo,
};
