/**
 * "2026-08-21 19:00" のような入力を JST として ISO 文字列に変換する。
 * ISO 形式で渡された場合はそのまま解釈する。
 * @returns {string|null} 変換できなければ null
 */
function parseJstDateTime(input) {
  if (!input) return null;

  const trimmed = input.trim();
  // 既にタイムゾーン付きならそのまま解釈する
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const m = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;

  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  // JST(+09:00) 固定で組み立てる
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(sec)}+09:00`;
  const parsed = new Date(iso);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * ISO 文字列を日本時間の見やすい表記にする
 */
function formatJst(iso) {
  if (!iso) return '制限なし';
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

module.exports = { parseJstDateTime, formatJst };
