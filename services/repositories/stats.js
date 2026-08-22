const { supabase } = require('./client');
const { getAllVideos } = require('./videos');

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
 * N日前時点の最新の統計情報を取得（週次レポートの週初比較などに使う）
 */
async function getStatsAsOf(videoId, daysAgo) {
  const cutoff = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('video_stats')
    .select('*')
    .eq('video_id', videoId)
    .lte('recorded_at', cutoff)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error("Error getting stats as-of:", error);
  }
  return data || null;
}

/**
 * 統計情報をDBに記録する。
 *
 * 以前は「同じ日の記録があれば上書き」で1日1行に潰していたが、
 * 毎時実行される updateVideoList のたびに新規行を追加するように変更した。
 * これにより video_stats は日次ではなく時間単位の履歴になり、
 * 「直近24時間の伸び」のような、より細かい比較が可能になる。
 * （日次グラフ等、1日1点で十分な用途は getStatsHistory 側で1日ごとに間引く）
 */
async function recordStats(videoId, views, comments, mylists, likes) {
  const { error } = await supabase
    .from('video_stats')
    .insert([{ video_id: videoId, views, comments, mylists, likes }]);

  if (error) console.error("Error recording stats:", error);
}

/**
 * グラフ・前日比用に、日次の統計履歴を取得する (直近7日分など)。
 *
 * video_stats は毎時1行記録されるようになったため、そのまま返すと
 * 「日次グラフ」のつもりが「時間単位グラフ」になってしまう。
 * ここでは各日の最後（＝最新）の記録だけを残して1日1点に間引く。
 */
async function getStatsHistory(videoId, limit = 7) {
  const { data, error } = await supabase
    .from('video_stats')
    .select('views, recorded_at')
    .eq('video_id', videoId)
    .order('recorded_at', { ascending: true });

  if (error) {
    console.error("Error getting stats history:", error);
    return [];
  }

  // 同じ日（JST）の行は後勝ちで上書きしていくことで、各日最後の値だけが残る
  const byDay = new Map();
  for (const row of data) {
    const day = new Date(row.recorded_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
    byDay.set(day, row);
  }

  return [...byDay.values()].slice(-limit);
}

/**
 * グラフ等の間引きをせず、生の記録をそのまま取得する（直近N時間の伸び計算等に使う）。
 * @param {string} videoId
 * @param {number} hours 遡る時間数
 */
async function getRecentStatsHistory(videoId, hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('video_stats')
    .select('views, comments, mylists, likes, recorded_at')
    .eq('video_id', videoId)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });

  if (error) {
    console.error("Error getting recent stats history:", error);
    return [];
  }
  return data;
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

module.exports = {
  getLatestStats,
  getYesterdayStats,
  getStatsAsOf,
  recordStats,
  getStatsHistory,
  getRecentStatsHistory,
  getAllLatestStats,
};
