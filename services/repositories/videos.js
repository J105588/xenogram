const { db } = require('./db');

/**
 * 動画が既にDBに存在するかチェック
 */
async function hasVideo(videoId) {
  const row = db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId);
  return !!row;
}

/**
 * 新しい動画をDBに登録
 */
async function addVideo(videoId, title, tags, thumbnailUrl, publishedAt) {
  try {
    db.prepare(`
      INSERT INTO videos (id, title, tags, thumbnail_url, published_at, added_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      videoId,
      title,
      tags,
      thumbnailUrl,
      publishedAt ? new Date(publishedAt).toISOString() : null,
      new Date().toISOString()
    );
  } catch (error) {
    console.error("Error adding video:", error);
  }
}

/**
 * 監視中の全動画を取得（投稿日時が新しい順に並べ替え）
 */
async function getAllVideos() {
  try {
    // published_at が NULL の行が先頭に来ないよう、NULLは末尾に回す
    return db.prepare(`
      SELECT * FROM videos
      ORDER BY (published_at IS NULL), published_at DESC
    `).all();
  } catch (error) {
    console.error("Error getting all videos:", error);
    return [];
  }
}

/**
 * 動画情報を更新（サムネやタグが変更された場合用）
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
 * 動画を監視リストから削除
 */
async function removeVideo(videoId) {
  try {
    db.prepare('DELETE FROM videos WHERE id = ?').run(videoId);
    return true;
  } catch (error) {
    console.error("Error removing video:", error);
    return false;
  }
}

module.exports = {
  hasVideo,
  addVideo,
  getAllVideos,
  updateVideoInfo,
  removeVideo,
};
