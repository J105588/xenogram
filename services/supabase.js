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
 * 「昨日まで」の最新の統計情報を取得（今日のレポート等で前日比を出す用）
 */
async function getYesterdayStats(videoId) {
  const now = new Date();
  // 本日の 00:00:00 JST
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();

  const { data, error } = await supabase
    .from('video_stats')
    .select('*')
    .eq('video_id', videoId)
    .lt('recorded_at', startOfToday) // 本日0時より前のもの
    .order('recorded_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error("Error getting yesterday stats:", error);
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
  const videos = await getAllVideos();
  
  // パフォーマンス最適化: 直列ループではなく並列でクエリを実行し、レスポンスタイムを劇的に改善する
  const statsPromises = videos.map(async (v) => {
    const stats = await getLatestStats(v.id);
    return stats ? { video: v, stats } : null;
  });
  
  const allResults = await Promise.all(statsPromises);
  
  // nullでないものだけを抽出して返す
  return allResults.filter(r => r !== null);
}

/* =====================================================================
 * ボカコレ ランキング監視: キーワード管理と検知履歴
 * ===================================================================== */

/**
 * 有効なキーワードを全件取得する（期間判定は呼び出し側で行う）
 */
async function getVocacolleKeywords(includeDisabled = false) {
  let query = supabase
    .from('vocacolle_keywords')
    .select('*')
    .order('id', { ascending: true });

  if (!includeDisabled) query = query.eq('enabled', true);

  const { data, error } = await query;
  if (error) {
    console.error("Error getting vocacolle keywords:", error);
    return [];
  }
  return data || [];
}

/**
 * 監視キーワードを追加する
 */
async function addVocacolleKeyword({ keyword, target = 'title', pageId = 'rookie', activeFrom = null, activeUntil = null, note = null }) {
  const { data, error } = await supabase
    .from('vocacolle_keywords')
    .insert([{
      keyword,
      target,
      page_id: pageId,
      active_from: activeFrom,
      active_until: activeUntil,
      note
    }])
    .select()
    .single();

  if (error) {
    console.error("Error adding vocacolle keyword:", error);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * 監視キーワードを削除する
 */
async function removeVocacolleKeyword(id) {
  const { error } = await supabase
    .from('vocacolle_keywords')
    .delete()
    .eq('id', id);

  if (error) {
    console.error("Error removing vocacolle keyword:", error);
    return false;
  }
  return true;
}

/**
 * 既に通知済みの組み合わせかどうかを判定する
 */
async function hasVocacolleDetection(keywordId, pageId, watchId) {
  const { data, error } = await supabase
    .from('vocacolle_detections')
    .select('id')
    .eq('keyword_id', keywordId)
    .eq('page_id', pageId)
    .eq('watch_id', watchId)
    .maybeSingle();

  if (error) console.error("Error checking vocacolle detection:", error);
  return !!data;
}

/**
 * 検知履歴を保存する
 */
async function recordVocacolleDetection(detection) {
  const { error } = await supabase
    .from('vocacolle_detections')
    .insert([{
      keyword_id: detection.keywordId,
      page_id: detection.pageId,
      watch_id: detection.watchId,
      matched_keyword: detection.matchedKeyword,
      matched_target: detection.matchedTarget,
      rank_position: detection.rank,
      title: detection.title,
      artist: detection.artist,
      view_count: detection.view,
      screenshot_ok: !!detection.screenshotOk
    }]);

  if (error) console.error("Error recording vocacolle detection:", error);
}

/**
 * ボカコレ監視の有効/無効フラグを取得する（未取得時はデフォルトで有効扱い）
 */
async function getVocacolleWatchEnabled() {
  const { data, error } = await supabase
    .from('vocacolle_settings')
    .select('enabled')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    console.error("Error getting vocacolle settings:", error);
    return true;
  }
  return data ? data.enabled : true;
}

/**
 * ボカコレ監視の有効/無効を切り替える（/vc_toggle 用）
 */
async function setVocacolleWatchEnabled(enabled) {
  const { error } = await supabase
    .from('vocacolle_settings')
    .upsert({ id: 1, enabled, updated_at: new Date().toISOString() });

  if (error) {
    console.error("Error setting vocacolle watch enabled:", error);
    return false;
  }
  return true;
}

/**
 * キャッシュ済みの nvapi ランキングIDを取得する
 */
async function getVocacolleRankingSource(pageId) {
  const { data, error } = await supabase
    .from('vocacolle_ranking_sources')
    .select('ranking_id, frontend_id, resolved_at')
    .eq('page_id', pageId)
    .maybeSingle();

  if (error) {
    console.error("Error getting vocacolle ranking source:", error);
    return null;
  }
  if (!data) return null;
  return { rankingId: data.ranking_id, frontendId: data.frontend_id, resolvedAt: data.resolved_at };
}

/**
 * 解決した nvapi ランキングIDを保存する
 */
async function upsertVocacolleRankingSource(pageId, source) {
  const { error } = await supabase
    .from('vocacolle_ranking_sources')
    .upsert({
      page_id: pageId,
      ranking_id: source.rankingId,
      frontend_id: source.frontendId,
      resolved_at: source.resolvedAt
    });

  if (error) console.error("Error saving vocacolle ranking source:", error);
}

module.exports = {
  supabase,
  hasVideo,
  addVideo,
  removeVideo,
  getAllVideos,
  getLatestStats,
  getYesterdayStats,
  getAllLatestStats,
  recordStats,
  updateVideoInfo,
  getStatsHistory,
  getVocacolleKeywords,
  addVocacolleKeyword,
  removeVocacolleKeyword,
  hasVocacolleDetection,
  recordVocacolleDetection,
  getVocacolleWatchEnabled,
  setVocacolleWatchEnabled,
  getVocacolleRankingSource,
  upsertVocacolleRankingSource
};
