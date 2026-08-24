const cron = require('node-cron');

// cron式を直接書かなくても、日本語の自然な表現からスケジュールを組み立てられるようにする。
// 「5分」「7時30分」「日 21時」のような入力を、ジョブの形（毎時/毎日/毎週）に応じて
// 対応するcron式へ変換する。既にcron式そのものが渡された場合はそのまま使う
// （従来通りの上級者向け直接入力も引き続きサポート）。

const WEEKDAY_MAP = {
  '日曜日': 0, '日曜': 0, 'sunday': 0, 'sun': 0,
  '月曜日': 1, '月曜': 1, 'monday': 1, 'mon': 1,
  '火曜日': 2, '火曜': 2, 'tuesday': 2, 'tue': 2,
  '水曜日': 3, '水曜': 3, 'wednesday': 3, 'wed': 3,
  '木曜日': 4, '木曜': 4, 'thursday': 4, 'thu': 4,
  '金曜日': 5, '金曜': 5, 'friday': 5, 'fri': 5,
  '土曜日': 6, '土曜': 6, 'saturday': 6, 'sat': 6,
  '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6,
};
// 長い表記（月曜日）から先に判定しないと「月」だけが早期にマッチしてしまうため長さ順に並べる
const WEEKDAY_KEYS = Object.keys(WEEKDAY_MAP).sort((a, b) => b.length - a.length);

function extractWeekday(text) {
  for (const key of WEEKDAY_KEYS) {
    const isEnglish = /^[a-z]+$/.test(key);
    const haystack = isEnglish ? text.toLowerCase() : text;
    const idx = haystack.indexOf(key);
    if (idx !== -1) {
      return { value: WEEKDAY_MAP[key], remainder: text.slice(0, idx) + text.slice(idx + key.length) };
    }
  }
  return null;
}

/**
 * 「午前」「午後」（12時間制）を24時間制の時に正規化する。
 * 午前12時＝0時（深夜）、午後12時＝12時（正午）という一般的な慣用に合わせる。
 */
function applyMeridiem(hour, meridiem) {
  if (!meridiem) return hour;
  if (meridiem === 'am') return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12; // pm
}

function extractTime(text) {
  const meridiemMatch = text.match(/午前|午後|am|pm/i);
  const meridiem = meridiemMatch
    ? (meridiemMatch[0] === '午前' || meridiemMatch[0].toLowerCase() === 'am' ? 'am' : 'pm')
    : null;

  let m = text.match(/(\d{1,2})\s*時\s*(\d{1,2})?\s*分?/);
  if (m) return { hour: applyMeridiem(Number(m[1]), meridiem), minute: m[2] !== undefined ? Number(m[2]) : 0 };
  m = text.match(/(\d{1,2}):(\d{2})/);
  if (m) return { hour: applyMeridiem(Number(m[1]), meridiem), minute: Number(m[2]) };
  return null;
}

function extractMinuteOnly(text) {
  let m = text.match(/(\d{1,2})\s*分/);
  if (m) return Number(m[1]);
  m = text.match(/^\s*(\d{1,2})\s*$/);
  if (m) return Number(m[1]);
  return null;
}

const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// /set_schedule のエラーメッセージ・オートコンプリートの説明文で使う入力例
const SHAPE_EXAMPLES = {
  hourly: '`5` または `5分`（毎時5分に実行）',
  daily: '`7時` `7時30分` `7:30` `午後9時`（その時刻に毎日実行）',
  weekly: '`日 21時` `月曜9時30分` `日曜午後9時`（毎週その曜日・時刻に実行）',
};

/**
 * @param {string} rawInput ユーザー入力（自然な表現 or cron式）
 * @param {'hourly'|'daily'|'weekly'} shape ジョブが受け付けるスケジュールの形
 * @returns {{ok: true, cronExpr: string} | {ok: false}}
 */
function toCronExpression(rawInput, shape) {
  const input = (rawInput || '').trim();
  if (!input) return { ok: false };

  // 5フィールドの正しいcron式ならそのまま採用する
  if (cron.validate(input)) return { ok: true, cronExpr: input };

  const cleaned = input.replace(/毎時|毎日|毎週/g, '').trim();

  if (shape === 'hourly') {
    const minute = extractMinuteOnly(cleaned);
    if (!inRange(minute, 0, 59)) return { ok: false };
    return { ok: true, cronExpr: `${minute} * * * *` };
  }

  if (shape === 'daily') {
    const time = extractTime(cleaned);
    if (!time || !inRange(time.hour, 0, 23) || !inRange(time.minute, 0, 59)) return { ok: false };
    return { ok: true, cronExpr: `${time.minute} ${time.hour} * * *` };
  }

  if (shape === 'weekly') {
    const weekday = extractWeekday(cleaned);
    if (!weekday) return { ok: false };
    const time = extractTime(weekday.remainder);
    if (!time || !inRange(time.hour, 0, 23) || !inRange(time.minute, 0, 59)) return { ok: false };
    return { ok: true, cronExpr: `${time.minute} ${time.hour} * * ${weekday.value}` };
  }

  return { ok: false };
}

module.exports = { toCronExpression, SHAPE_EXAMPLES };
