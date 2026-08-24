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
async function getVocacolleKeywords(guildId, includeDisabled = false) {
  try {
    const rows = includeDisabled
      ? db.prepare('SELECT * FROM vocacolle_keywords WHERE guild_id = ? ORDER BY id ASC').all(guildId)
      : db.prepare('SELECT * FROM vocacolle_keywords WHERE guild_id = ? AND enabled = 1 ORDER BY id ASC').all(guildId);
    return rows.map(normalizeKeywordRow);
  } catch (error) {
    console.error("Error getting vocacolle keywords:", error);
    return [];
  }
}

/**
 * 監視キーワードを追加する
 */
async function addVocacolleKeyword({ guildId, keyword, target = 'title', pageId = 'rookie', activeFrom = null, activeUntil = null, note = null }) {
  try {
    const info = db.prepare(`
      INSERT INTO vocacolle_keywords (guild_id, keyword, target, page_id, active_from, active_until, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, keyword, target, pageId, activeFrom, activeUntil, note, new Date().toISOString());

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
 * IDを指定して1件取得する（編集フォームの初期値表示用）
 */
async function getVocacolleKeyword(guildId, id) {
  try {
    const row = db.prepare('SELECT * FROM vocacolle_keywords WHERE guild_id = ? AND id = ?').get(guildId, id);
    return row ? normalizeKeywordRow(row) : null;
  } catch (error) {
    console.error("Error getting vocacolle keyword:", error);
    return null;
  }
}

// patchのキー → 実際の列名。渡されたキーだけをUPDATE対象にする
// （undefinedの項目を「NULLで上書き」してしまわないようにするため）。
const KEYWORD_COLUMNS = {
  keyword: 'keyword',
  target: 'target',
  pageId: 'page_id',
  activeFrom: 'active_from',
  activeUntil: 'active_until',
  note: 'note',
  enabled: 'enabled',
};

/**
 * 監視キーワードを編集する。
 * 登録し直さないと直せなかった項目（キーワードの誤字・page_idの指定間違い・監視期間）を
 * その場で修正できるようにするためのもの。
 *
 * @param {number} id
 * @param {Object} patch 変更したい項目だけを持つオブジェクト
 * @returns {{ok: boolean, data?: Object, reason?: string}}
 */
async function updateVocacolleKeyword(guildId, id, patch) {
  const existing = await getVocacolleKeyword(guildId, id);
  if (!existing) return { ok: false, reason: 'not_found' };

  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(KEYWORD_COLUMNS)) {
    if (!(key in patch)) continue;
    sets.push(`${column} = ?`);
    params.push(column === 'enabled' ? fromBool(patch[key]) : patch[key]);
  }
  if (!sets.length) return { ok: true, data: existing };

  try {
    db.prepare(`UPDATE vocacolle_keywords SET ${sets.join(', ')} WHERE guild_id = ? AND id = ?`).run(...params, guildId, id);
    return { ok: true, data: await getVocacolleKeyword(guildId, id) };
  } catch (error) {
    // (page_id, target, keyword) のUNIQUE制約。既存の別登録とぶつかった場合
    if (isUniqueConstraintError(error)) return { ok: false, reason: 'duplicate' };
    console.error("Error updating vocacolle keyword:", error);
    return { ok: false, reason: 'error' };
  }
}

/**
 * 監視キーワードを削除する
 */
async function removeVocacolleKeyword(guildId, id) {
  try {
    const info = db.prepare('DELETE FROM vocacolle_keywords WHERE guild_id = ? AND id = ?').run(guildId, id);
    return info.changes > 0;
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

// ボカコレ監視のON/OFFは専用テーブル（1行固定）をやめ、鯖ごとの値を持てる
// app_settings に移した（設定の置き場所が2種類あると取り違えるため）。
const WATCH_ENABLED_KEY = 'vocacolle_watch_enabled';

/**
 * その鯖のボカコレ監視の有効/無効フラグ（未設定ならデフォルトで有効扱い）
 */
async function getVocacolleWatchEnabled(guildId) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE guild_id = ? AND key = ?')
      .get(guildId, WATCH_ENABLED_KEY);
    return row ? row.value === '1' : true;
  } catch (error) {
    console.error("Error getting vocacolle settings:", error);
    return true;
  }
}

/**
 * その鯖のボカコレ監視の有効/無効を切り替える（/vc_toggle 用）
 */
async function setVocacolleWatchEnabled(guildId, enabled) {
  try {
    db.prepare(`
      INSERT INTO app_settings (guild_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(guildId, WATCH_ENABLED_KEY, fromBool(enabled) ? '1' : '0', new Date().toISOString());
    return true;
  } catch (error) {
    console.error("Error setting vocacolle watch enabled:", error);
    return false;
  }
}

/**
 * キャッシュ済みの Next.js buildId を取得する
 */
async function getVocacolleRankingSource(pageId) {
  try {
    const row = db.prepare(`
      SELECT build_id, resolved_at FROM vocacolle_ranking_sources WHERE page_id = ?
    `).get(pageId);
    if (!row) return null;
    return { buildId: row.build_id, resolvedAt: row.resolved_at };
  } catch (error) {
    console.error("Error getting vocacolle ranking source:", error);
    return null;
  }
}

/**
 * 解決した Next.js buildId を保存する
 */
async function upsertVocacolleRankingSource(pageId, source) {
  try {
    db.prepare(`
      INSERT INTO vocacolle_ranking_sources (page_id, build_id, resolved_at) VALUES (?, ?, ?)
      ON CONFLICT(page_id) DO UPDATE SET build_id = excluded.build_id, resolved_at = excluded.resolved_at
    `).run(pageId, source.buildId, source.resolvedAt);
  } catch (error) {
    console.error("Error saving vocacolle ranking source:", error);
  }
}

module.exports = {
  getVocacolleKeywords,
  getVocacolleKeyword,
  addVocacolleKeyword,
  updateVocacolleKeyword,
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
