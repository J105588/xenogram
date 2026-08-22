const { db, toBool, fromBool, isUniqueConstraintError } = require('./db');

/* =====================================================================
 * ボカコレ / ランキング監視: キーワード管理と検知履歴
 * ===================================================================== */

function normalizeKeywordRow(row) {
  if (!row) return row;
  return { ...row, enabled: toBool(row.enabled) };
}

/**
 * 有効なキーワードを全件取得する（期間判定は呼び出し側で行う）
 */
async function getVocacolleKeywords(includeDisabled = false) {
  try {
    const rows = includeDisabled
      ? db.prepare('SELECT * FROM vocacolle_keywords ORDER BY id ASC').all()
      : db.prepare('SELECT * FROM vocacolle_keywords WHERE enabled = 1 ORDER BY id ASC').all();
    return rows.map(normalizeKeywordRow);
  } catch (error) {
    console.error("Error getting vocacolle keywords:", error);
    return [];
  }
}

/**
 * 監視キーワードを追加する
 */
async function addVocacolleKeyword({ keyword, target = 'title', pageId = 'rookie', activeFrom = null, activeUntil = null, note = null }) {
  try {
    const info = db.prepare(`
      INSERT INTO vocacolle_keywords (keyword, target, page_id, active_from, active_until, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(keyword, target, pageId, activeFrom, activeUntil, note, new Date().toISOString());

    const data = db.prepare('SELECT * FROM vocacolle_keywords WHERE id = ?').get(info.lastInsertRowid);
    return { data: normalizeKeywordRow(data), error: null };
  } catch (error) {
    console.error("Error adding vocacolle keyword:", error);
    // Supabase時代の error.code === '23505'（重複）と同じ判定ができるよう code を付与する
    if (isUniqueConstraintError(error)) error.code = '23505';
    return { data: null, error };
  }
}

/**
 * 監視キーワードを削除する
 */
async function removeVocacolleKeyword(id) {
  try {
    db.prepare('DELETE FROM vocacolle_keywords WHERE id = ?').run(id);
    return true;
  } catch (error) {
    console.error("Error removing vocacolle keyword:", error);
    return false;
  }
}

/**
 * 既に通知済みの組み合わせかどうかを判定する
 */
async function hasVocacolleDetection(keywordId, pageId, watchId) {
  try {
    const row = db.prepare(`
      SELECT id FROM vocacolle_detections
      WHERE keyword_id = ? AND page_id = ? AND watch_id = ?
    `).get(keywordId, pageId, watchId);
    return !!row;
  } catch (error) {
    console.error("Error checking vocacolle detection:", error);
    return false;
  }
}

/**
 * 検知履歴を保存する（新規ヒット時に1回だけ呼ばれる）
 */
async function recordVocacolleDetection(detection) {
  try {
    db.prepare(`
      INSERT INTO vocacolle_detections
        (keyword_id, page_id, watch_id, matched_keyword, matched_target, rank_position, title, artist, view_count, screenshot_ok, detected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      detection.keywordId,
      detection.pageId,
      detection.watchId,
      detection.matchedKeyword,
      detection.matchedTarget,
      detection.rank,
      detection.title,
      detection.artist,
      detection.view,
      fromBool(detection.screenshotOk),
      new Date().toISOString()
    );
  } catch (error) {
    console.error("Error recording vocacolle detection:", error);
  }
}

/**
 * 直近で記録されている順位を取得する（順位変動通知の「前回値」として使う）
 */
async function getVocacolleDetectionRank(keywordId, pageId, watchId) {
  try {
    const row = db.prepare(`
      SELECT rank_position FROM vocacolle_detections
      WHERE keyword_id = ? AND page_id = ? AND watch_id = ?
    `).get(keywordId, pageId, watchId);
    return row ? row.rank_position : null;
  } catch (error) {
    console.error("Error getting vocacolle detection rank:", error);
    return null;
  }
}

/**
 * 既存の検知履歴行の順位・再生数を最新値に更新する（順位変動の追跡用）。
 * 行が存在しない場合（＝まだ新規ヒットとして記録されていない）は何もしない。
 */
async function touchVocacolleDetection(keywordId, pageId, watchId, { rank, view }) {
  try {
    db.prepare(`
      UPDATE vocacolle_detections SET rank_position = ?, view_count = ?
      WHERE keyword_id = ? AND page_id = ? AND watch_id = ?
    `).run(rank, view, keywordId, pageId, watchId);
  } catch (error) {
    console.error("Error updating vocacolle detection rank:", error);
  }
}

/**
 * ボカコレ監視の有効/無効フラグを取得する（未取得時はデフォルトで有効扱い）
 */
async function getVocacolleWatchEnabled() {
  try {
    const row = db.prepare('SELECT enabled FROM vocacolle_settings WHERE id = 1').get();
    return row ? toBool(row.enabled) : true;
  } catch (error) {
    console.error("Error getting vocacolle settings:", error);
    return true;
  }
}

/**
 * ボカコレ監視の有効/無効を切り替える（/vc_toggle 用）
 */
async function setVocacolleWatchEnabled(enabled) {
  try {
    db.prepare(`
      INSERT INTO vocacolle_settings (id, enabled, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(fromBool(enabled), new Date().toISOString());
    return true;
  } catch (error) {
    console.error("Error setting vocacolle watch enabled:", error);
    return false;
  }
}

/**
 * キャッシュ済みの nvapi ランキングIDを取得する
 */
async function getVocacolleRankingSource(pageId) {
  try {
    const row = db.prepare(`
      SELECT ranking_id, frontend_id, resolved_at FROM vocacolle_ranking_sources WHERE page_id = ?
    `).get(pageId);
    if (!row) return null;
    return { rankingId: row.ranking_id, frontendId: row.frontend_id, resolvedAt: row.resolved_at };
  } catch (error) {
    console.error("Error getting vocacolle ranking source:", error);
    return null;
  }
}

/**
 * 解決した nvapi ランキングIDを保存する
 */
async function upsertVocacolleRankingSource(pageId, source) {
  try {
    db.prepare(`
      INSERT INTO vocacolle_ranking_sources (page_id, ranking_id, frontend_id, resolved_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(page_id) DO UPDATE SET ranking_id = excluded.ranking_id, frontend_id = excluded.frontend_id, resolved_at = excluded.resolved_at
    `).run(pageId, source.rankingId, source.frontendId, source.resolvedAt);
  } catch (error) {
    console.error("Error saving vocacolle ranking source:", error);
  }
}

module.exports = {
  getVocacolleKeywords,
  addVocacolleKeyword,
  removeVocacolleKeyword,
  hasVocacolleDetection,
  recordVocacolleDetection,
  getVocacolleDetectionRank,
  touchVocacolleDetection,
  getVocacolleWatchEnabled,
  setVocacolleWatchEnabled,
  getVocacolleRankingSource,
  upsertVocacolleRankingSource,
};
