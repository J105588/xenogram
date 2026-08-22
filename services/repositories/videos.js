const { supabase } = require('./client');

/**
 * 動画が既にDBに存在するかチェック
 */
async function hasVideo(videoId) {
  const { data, error } = await supabase
    .from('videos')
    .select('id')
    .eq('id', videoId)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 is "Row not found"
    console.error("DB check error:", error);
  }
  return !!data;
}

/**
 * 新しい動画をDBに登録
 */
async function addVideo(videoId, title, tags, thumbnailUrl, publishedAt) {
  const { error } = await supabase
    .from('videos')
    .insert([{
      id: videoId,
      title,
      tags,
      thumbnail_url: thumbnailUrl,
      published_at: publishedAt ? new Date(publishedAt).toISOString() : null
    }]);

  if (error) console.error("Error adding video:", error);
}

/**
 * 監視中の全動画を取得（投稿日時が新しい順に並べ替え）
 */
async function getAllVideos() {
  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .order('published_at', { ascending: false }); // 投稿日時の降順

  if (error) {
    console.error("Error getting all videos:", error);
    return [];
  }
  return data;
}

/**
 * 動画情報を更新（サムネやタグが変更された場合用）
 */
async function updateVideoInfo(videoId, tags, thumbnailUrl) {
  const { error } = await supabase
    .from('videos')
    .update({ tags, thumbnail_url: thumbnailUrl })
    .eq('id', videoId);

  if (error) console.error("Error updating video info:", error);
}

/**
 * 動画を監視リストから削除
 */
async function removeVideo(videoId) {
  const { error } = await supabase
    .from('videos')
    .delete()
    .eq('id', videoId);

  if (error) {
    console.error("Error removing video:", error);
    return false;
  }
  return true;
}

module.exports = {
  hasVideo,
  addVideo,
  getAllVideos,
  updateVideoInfo,
  removeVideo,
};
