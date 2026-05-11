const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

// Initialize Supabase client
const supabaseUrl = config.SUPABASE.URL;
const supabaseKey = config.SUPABASE.KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase URL or Key is not set. Database features will fail.");
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

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
 * 特定の動画の最新の統計情報を取得
 */
async function getLatestStats(videoId) {
  const { data, error } = await supabase
    .from('video_stats')
    .select('*')
    .eq('video_id', videoId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error("Error getting latest stats:", error);
  }
  return data || null;
}

/**
 * 統計情報をDBに記録（同じ日のデータがあれば上書き、なければ新規追加）
 */
async function recordStats(videoId, views, comments, mylists, likes) {
  // システムのTZ（index.jsでAsia/Tokyoに設定済み）に基づき、本日の開始時刻と終了時刻を取得
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();

  // 1. 本日中に既に記録されたレコードがあるか検索
  const { data: existingToday } = await supabase
    .from('video_stats')
    .select('id')
    .eq('video_id', videoId)
    .gte('recorded_at', startOfDay)
    .lte('recorded_at', endOfDay)
    .single();

  let error;
  
  if (existingToday) {
    // 2. 既に存在すれば、そのレコードを最新の数値で上書きアップデートする
    const response = await supabase
      .from('video_stats')
      .update({ views, comments, mylists, likes, recorded_at: new Date().toISOString() })
      .eq('id', existingToday.id);
    error = response.error;
  } else {
    // 3. まだ無ければ、新規にインサートする
    const response = await supabase
      .from('video_stats')
      .insert([{ video_id: videoId, views, comments, mylists, likes }]);
    error = response.error;
  }

  if (error) console.error("Error recording stats:", error);
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
 * グラフ用に過去の統計を取得 (直近7回分など)
 */
async function getStatsHistory(videoId, limit = 7) {
  const { data, error } = await supabase
    .from('video_stats')
    .select('views, recorded_at')
    .eq('video_id', videoId)
    .order('recorded_at', { ascending: true }) // グラフ用なので古い順が扱いやすいが、一旦全て取得してから切り出すのもあり
  
  if (error) {
    console.error("Error getting stats history:", error);
    return [];
  }
  
  // 直近 limit 件だけ取得して古い順に並べる
  return data.slice(-limit);
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

/**
 * 全動画の最新の統計情報を取得する（ランキングや成長率計算用）
 */
async function getAllLatestStats() {
  // video_statsテーブルから、各video_idの最新行を取得したい
  // Supabase/PostgreSQLで簡単にやるには、videosテーブルと最新のstatsを結合するか、
  // 最新のレコードだけを抽出するクエリが必要です。
  // ここではシンプルに全件取得してJSでソート・フィルタするか、RPCを呼ぶ必要がありますが、
  // 簡易的に全動画を取得し、それぞれ最新1件を取得します。
  const videos = await getAllVideos();
  const results = [];
  for (const v of videos) {
    const stats = await getLatestStats(v.id);
    if (stats) {
      results.push({ video: v, stats });
    }
  }
  return results;
}

module.exports = {
  supabase,
  hasVideo,
  addVideo,
  removeVideo,
  getAllVideos,
  getLatestStats,
  getAllLatestStats,
  recordStats,
  updateVideoInfo,
  getStatsHistory
};
