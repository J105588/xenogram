const { db } = require('./db');
const config = require('../../config');

/**
 * 監視対象のニコニコユーザーID一覧を取得する。
 * DB（nico_users）に1件も登録が無ければ、config.js（NICO_USER_IDS環境変数）にフォールバックする
 * ＝初期状態では今まで通り .env の設定で動く。/user_add を一度でも使うとDB側が優先される。
 */
function getNicoUserIds() {
  const rows = db.prepare('SELECT user_id FROM nico_users ORDER BY added_at ASC').all();
  if (rows.length) return rows.map((r) => r.user_id);
  return config.NICO_USER_IDS;
}

function getNicoUsersDetailed() {
  const rows = db.prepare('SELECT user_id, label, added_at FROM nico_users ORDER BY added_at ASC').all();
  if (rows.length) return rows.map((r) => ({ ...r, fromEnv: false }));
  return config.NICO_USER_IDS.map((id) => ({ user_id: id, label: null, added_at: null, fromEnv: true }));
}

function addNicoUser(userId, label = null) {
  try {
    db.prepare('INSERT INTO nico_users (user_id, label, added_at) VALUES (?, ?, ?)')
      .run(userId, label, new Date().toISOString());
    return { ok: true };
  } catch (error) {
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return { ok: false, reason: 'duplicate' };
    }
    console.error('Error adding nico user:', error);
    return { ok: false, reason: 'error' };
  }
}

function removeNicoUser(userId) {
  const info = db.prepare('DELETE FROM nico_users WHERE user_id = ?').run(userId);
  return info.changes > 0;
}

module.exports = { getNicoUserIds, getNicoUsersDetailed, addNicoUser, removeNicoUser };
