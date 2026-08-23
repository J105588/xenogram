const { db } = require('./db');

/* =====================================================================
 * X（旧Twitter）キーワード監視: 読み取り専用。キーワード管理と検知履歴。
 * ===================================================================== */

function normalizeKeywordRow(row) {
  if (!row) return row;
  return { ...row, enabled: row.enabled === 1 };
}

/**
 * 監視キーワード（検索クエリ）を取得する
 */
function getTwitterKeywords(includeDisabled = false) {
  try {
    const rows = includeDisabled
      ? db.prepare('SELECT * FROM twitter_keywords ORDER BY id ASC').all()
      : db.prepare('SELECT * FROM twitter_keywords WHERE enabled = 1 ORDER BY id ASC').all();
    return rows.map(normalizeKeywordRow);
  } catch (error) {
    console.error("Error getting twitter keywords:", error);
    return [];
  }
}

/**
 * 監視キーワードを追加する
 */
function addTwitterKeyword(query, note = null) {
  try {
    const info = db.prepare(`
      INSERT INTO twitter_keywords (query, note, created_at) VALUES (?, ?, ?)
    `).run(query, note, new Date().toISOString());
    const data = db.prepare('SELECT * FROM twitter_keywords WHERE id = ?').get(info.lastInsertRowid);
    return { ok: true, data: normalizeKeywordRow(data) };
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return { ok: false, reason: 'duplicate' };
    }
    console.error("Error adding twitter keyword:", error);
    return { ok: false, reason: 'error' };
  }
}

/**
 * 監視キーワードを削除する
 */
function removeTwitterKeyword(id) {
  try {
    const info = db.prepare('DELETE FROM twitter_keywords WHERE id = ?').run(id);
    return info.changes > 0;
  } catch (error) {
    console.error("Error removing twitter keyword:", error);
    return false;
  }
}

/**
 * 既に通知済みのツイートかどうかを判定する
 */
function hasTwitterDetection(keywordId, tweetId) {
  try {
    const row = db.prepare(`
      SELECT id FROM twitter_detections WHERE keyword_id = ? AND tweet_id = ?
    `).get(keywordId, tweetId);
    return !!row;
  } catch (error) {
    console.error("Error checking twitter detection:", error);
    return false;
  }
}

/**
 * 検知履歴を保存する（新規ヒット時に1回だけ呼ばれる）
 */
function recordTwitterDetection({ keywordId, tweetId, author }) {
  try {
    db.prepare(`
      INSERT INTO twitter_detections (keyword_id, tweet_id, author, detected_at) VALUES (?, ?, ?, ?)
    `).run(keywordId, tweetId, author || null, new Date().toISOString());
  } catch (error) {
    console.error("Error recording twitter detection:", error);
  }
}

/**
 * X監視全体の有効/無効フラグ（/x_toggle 用）。
 * 汎用の app_settings テーブルを使う（値が無ければ既定で有効扱い）。
 */
function getTwitterMonitorEnabled() {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'twitter_monitor_enabled'").get();
    return row ? row.value === '1' : true;
  } catch (error) {
    console.error("Error getting twitter monitor enabled:", error);
    return true;
  }
}

function setTwitterMonitorEnabled(enabled) {
  try {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES ('twitter_monitor_enabled', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(enabled ? '1' : '0', new Date().toISOString());
    return true;
  } catch (error) {
    console.error("Error setting twitter monitor enabled:", error);
    return false;
  }
}

module.exports = {
  getTwitterKeywords,
  addTwitterKeyword,
  removeTwitterKeyword,
  hasTwitterDetection,
  recordTwitterDetection,
  getTwitterMonitorEnabled,
  setTwitterMonitorEnabled,
};
