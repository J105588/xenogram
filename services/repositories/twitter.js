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
function getTwitterKeywords(guildId, includeDisabled = false) {
  try {
    const rows = includeDisabled
      ? db.prepare('SELECT * FROM twitter_keywords WHERE guild_id = ? ORDER BY id ASC').all(guildId)
      : db.prepare('SELECT * FROM twitter_keywords WHERE guild_id = ? AND enabled = 1 ORDER BY id ASC').all(guildId);
    return rows.map(normalizeKeywordRow);
  } catch (error) {
    console.error("Error getting twitter keywords:", error);
    return [];
  }
}

/**
 * 監視キーワードを追加する
 */
function addTwitterKeyword(guildId, query, note = null) {
  try {
    const info = db.prepare(`
      INSERT INTO twitter_keywords (guild_id, query, note, created_at) VALUES (?, ?, ?, ?)
    `).run(guildId, query, note, new Date().toISOString());
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
 * IDを指定して1件取得する（編集フォームの初期値表示用）
 */
function getTwitterKeyword(guildId, id) {
  try {
    const row = db.prepare('SELECT * FROM twitter_keywords WHERE guild_id = ? AND id = ?').get(guildId, id);
    return row ? normalizeKeywordRow(row) : null;
  } catch (error) {
    console.error("Error getting twitter keyword:", error);
    return null;
  }
}

// patchのキー → 実際の列名（vocacolle側と同じ方針: 渡されたキーだけUPDATEする）
const KEYWORD_COLUMNS = { query: 'query', note: 'note', enabled: 'enabled' };

/**
 * 監視キーワードを編集する（クエリの修正・メモ更新・一時停止）。
 * @returns {{ok: boolean, data?: Object, reason?: string}}
 */
function updateTwitterKeyword(guildId, id, patch) {
  const existing = getTwitterKeyword(guildId, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(KEYWORD_COLUMNS)) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    params.push(column === 'enabled' ? (patch[key] ? 1 : 0) : patch[key]);
  }
  if (!sets.length) return { ok: true, data: existing };

  try {
    db.prepare(`UPDATE twitter_keywords SET ${sets.join(', ')} WHERE guild_id = ? AND id = ?`).run(...params, guildId, id);
    return { ok: true, data: getTwitterKeyword(guildId, id) };
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return { ok: false, reason: 'duplicate' };
    }
    console.error("Error updating twitter keyword:", error);
    return { ok: false, reason: 'error' };
  }
}

/**
 * 監視キーワードを削除する
 */
function removeTwitterKeyword(guildId, id) {
  try {
    const info = db.prepare('DELETE FROM twitter_keywords WHERE guild_id = ? AND id = ?').run(guildId, id);
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
function getTwitterMonitorEnabled(guildId) {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE guild_id = ? AND key = 'twitter_monitor_enabled'").get(guildId);
    return row ? row.value === '1' : true;
  } catch (error) {
    console.error("Error getting twitter monitor enabled:", error);
    return true;
  }
}

function setTwitterMonitorEnabled(guildId, enabled) {
  try {
    db.prepare(`
      INSERT INTO app_settings (guild_id, key, value, updated_at) VALUES (?, 'twitter_monitor_enabled', ?, ?)
      ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(guildId, enabled ? '1' : '0', new Date().toISOString());
    return true;
  } catch (error) {
    console.error("Error setting twitter monitor enabled:", error);
    return false;
  }
}

module.exports = {
  getTwitterKeywords,
  getTwitterKeyword,
  addTwitterKeyword,
  updateTwitterKeyword,
  removeTwitterKeyword,
  hasTwitterDetection,
  recordTwitterDetection,
  getTwitterMonitorEnabled,
  setTwitterMonitorEnabled,
};
