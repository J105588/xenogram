const { db } = require('./db');
const config = require('../../config');

// キー: app_settings.key ⇔ config.js のデフォルト値の対応表。
// DBに行が無ければ config 側の値（＝.envのデフォルト）を使う。
const DEFAULTS = {
  milestone_step: () => config.MILESTONE_STEP,
  spike_view_threshold_per_hour: () => config.SPIKE_DETECTION.VIEW_THRESHOLD_PER_HOUR,
  spike_cooldown_hours: () => config.SPIKE_DETECTION.COOLDOWN_HOURS,
  vocacolle_rank_change_threshold: () => config.VOCACOLLE.RANK_CHANGE_THRESHOLD,
  cron_update_video_list: () => '0 * * * *',
  cron_daily_report: () => '0 7 * * *',
  cron_vocacolle_watch: () => config.VOCACOLLE.CRON,
  cron_weekly_report: () => config.WEEKLY_REPORT.CRON,
  cron_twitter_watch: () => config.TWITTER_MONITOR.CRON,
};

const NUMERIC_KEYS = new Set([
  'milestone_step',
  'spike_view_threshold_per_hour',
  'spike_cooldown_hours',
  'vocacolle_rank_change_threshold',
]);

function getRaw(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (row) return row.value;
  const fallback = DEFAULTS[key];
  return fallback ? String(fallback()) : null;
}

/**
 * 設定値を取得する。DBに保存されていなければ config.js のデフォルトを返す。
 * 数値設定キーは自動でNumberに変換する。
 */
function getSetting(key) {
  const raw = getRaw(key);
  if (raw === null) return null;
  return NUMERIC_KEYS.has(key) ? Number(raw) : raw;
}

/**
 * 設定値を保存する（/set_* コマンド用）
 */
function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), new Date().toISOString());
}

/**
 * 現在有効な設定を一覧取得する（/settings コマンド用）。
 * DB上書きの有無も分かるようにする。
 */
function getAllSettingsWithSource() {
  return Object.keys(DEFAULTS).map((key) => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return {
      key,
      value: row ? row.value : String(DEFAULTS[key]()),
      overridden: !!row,
    };
  });
}

module.exports = { getSetting, setSetting, getAllSettingsWithSource };
