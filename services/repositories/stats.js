const { db } = require('./db');

/**
 * 特定の動画の最新の統計情報を取得
 */
async function getLatestStats(videoId) {
  try {
    const row = db.prepare(`
      SELECT * FROM video_stats
      WHERE video_id = ?
      ORDER BY recorded_at DESC
      LIMIT 1
    `).get(videoId);
    return row || null;
  } catch (error) {
    console.error("Error getting latest stats:", error);
    return null;
  }
}

/**
 * 「昨日まで」の最新の統計情報を取得（今日のレポート等で前日比を出す用）
 */
async function getYesterdayStats(videoId) {
  try {
    const now = new Date();
    // 本日の 00:00:00 JST（システムのTZはAsia/Tokyoに設定済み）
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).toISOString();

    const row = db.prepare(`
      SELECT * FROM video_stats
      WHERE video_id = ? AND recorded_at < ?
      ORDER BY recorded_at DESC
      LIMIT 1
    `).get(videoId, startOfToday);
    return row || null;
  } catch (error) {
    console.error("Error getting yesterday stats:", error);
    return null;
  }
}

/**
 * N日前時点の最新の統計情報を取得（週次レポートの週初比較などに使う）
 */
async function getStatsAsOf(videoId, daysAgo) {
  try {
    const cutoff = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const row = db.prepare(`
      SELECT * FROM video_stats
      WHERE video_id = ? AND recorded_at <= ?
      ORDER BY recorded_at DESC
      LIMIT 1
    `).get(videoId, cutoff);
    return row || null;
  } catch (error) {
    console.error("Error getting stats as-of:", error);
    return null;
  }
}

/**
 * 統計情報をDBに記録する。毎時実行される updateVideoList のたびに新規行を追加するため、
 * video_stats は日次ではなく時間単位の履歴になる
 * （日次グラフ等、1日1点で十分な用途は getStatsHistory 側で1日ごとに間引く）。
 */
async function recordStats(videoId, views, comments, mylists, likes) {
  try {
    db.prepare(`
      INSERT INTO video_stats (video_id, views, comments, mylists, likes, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(videoId, views, comments, mylists, likes, new Date().toISOString());
  } catch (error) {
    console.error("Error recording stats:", error);
  }
}

/**
 * グラフ・前日比用に、日次の統計履歴を取得する (直近7日分など)。
 * 各日の最後（＝最新）の記録だけを残して1日1点に間引く。
 */
async function getStatsHistory(videoId, limit = 7) {
  try {
    const rows = db.prepare(`
      SELECT views, recorded_at FROM video_stats
      WHERE video_id = ?
      ORDER BY recorded_at ASC
    `).all(videoId);

    // 同じ日（JST）の行は後勝ちで上書きしていくことで、各日最後の値だけが残る
    const byDay = new Map();
    for (const row of rows) {
      const day = new Date(row.recorded_at).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
      byDay.set(day, row);
    }

    return [...byDay.values()].slice(-limit);
  } catch (error) {
    console.error("Error getting stats history:", error);
    return [];
  }
}

/**
 * グラフ等の間引きをせず、生の記録をそのまま取得する（直近N時間の伸び計算等に使う）。
 */
async function getRecentStatsHistory(videoId, hours = 24) {
  try {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return db.prepare(`
      SELECT views, comments, mylists, likes, recorded_at FROM video_stats
      WHERE video_id = ? AND recorded_at >= ?
      ORDER BY recorded_at ASC
    `).all(videoId, since);
  } catch (error) {
    console.error("Error getting recent stats history:", error);
    return [];
  }
}

/**
 * 全動画の最新の統計情報を取得する（ランキングや成長率計算用）。
 * 以前は動画本数ぶんSELECTを繰り返すN+1構成だったが、相関サブクエリで
 * 「動画ごとの最新video_stats行のid」を求めてJOINする1回のクエリにまとめた
 * （既存の idx_video_stats_video_id_recorded_at インデックスがそのまま効く）。
 * 返す形（[{video, stats}, ...]）と並び順（published_at降順・NULLは末尾）は変更していない。
 */
async function getAllLatestStats() {
  try {
    const rows = db.prepare(`
      SELECT
        v.id AS video_id, v.title AS video_title, v.published_at AS video_published_at,
        v.added_at, v.tags, v.thumbnail_url,
        vs.id AS stats_id, vs.video_id AS stats_video_id, vs.views, vs.comments,
        vs.mylists, vs.likes, vs.recorded_at
      FROM videos v
      JOIN video_stats vs ON vs.id = (
        SELECT id FROM video_stats WHERE video_id = v.id ORDER BY recorded_at DESC LIMIT 1
      )
      ORDER BY (v.published_at IS NULL), v.published_at DESC
    `).all();

    return rows.map((row) => ({
      video: {
        id: row.video_id,
        title: row.video_title,
        published_at: row.video_published_at,
        added_at: row.added_at,
        tags: row.tags,
        thumbnail_url: row.thumbnail_url,
      },
      stats: {
        id: row.stats_id,
        video_id: row.stats_video_id,
        views: row.views,
        comments: row.comments,
        mylists: row.mylists,
        likes: row.likes,
        recorded_at: row.recorded_at,
      },
    }));
  } catch (error) {
    console.error("Error getting all latest stats:", error);
    return [];
  }
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
