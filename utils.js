const config = require('./config');

// 統計の各指標について「APIレスポンス上のキー」と「video_stats列 / 表示名」の対応。
// 従来はこの対応が calculateDiff・各レポート・CSV出力にべつべつに散らばっており、
// 指標を1つ増やすだけで数か所直す必要があったため1か所に集約した。
// en は等幅テーブル用。Discordのコードブロックは日本語（全角）が
// 半角のちょうど2倍幅で描画されない環境があり、日本語ラベルのままだと列がずれるため、
// 桁を揃える表の中だけASCIIを使う。
const METRICS = [
  { key: 'view', column: 'views', label: '再生', en: 'Views' },
  { key: 'like', column: 'likes', label: 'いいね', en: 'Likes' },
  { key: 'mylist', column: 'mylists', label: 'マイリスト', en: 'Mylists' },
  { key: 'comment', column: 'comments', label: 'コメント', en: 'Comments' },
];

/**
 * JST基準の MM/DD 文字列。パースできない値は "--/--" にフォールバックする。
 *
 * ja-JP ロケールで month/day を個別に取ると "08月" "17日" が返り、
 * 連結すると "08月/17日" になってグラフの軸ラベルが崩れる。
 * ISO形式（YYYY-MM-DD）で出す en-CA から切り出すことで純粋な数字だけを得る。
 */
function formatDayLabel(recordedAt) {
  const d = new Date(recordedAt);
  if (isNaN(d.getTime())) return '--/--';
  const iso = d.toLocaleDateString('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [, month, day] = iso.split('-');
  return month && day ? `${month}/${day}` : '--/--';
}

/**
 * 日次履歴から「伸びの傾向」を計算する。
 *
 * レポートに出していた情報が「前日比の±」だけだったのは、履歴を持っているのに
 * 隣り合う2点しか見ていなかったため。ここで期間合計・1日平均・直近1日、そして
 * 「直近1日が それ以前の平均と比べて速いのか遅いのか（＝勢い）」までまとめて出す。
 *
 * @param {Array} history 日次履歴（古い順）[{ views, likes, ..., recorded_at }]
 * @param {string} column video_stats の列名（'views' など）
 */
function analyzeHistory(history, column = 'views') {
  const points = (history || []).filter((r) => r && r[column] != null);
  const empty = { days: points.length, deltas: [], total: 0, avgPerDay: 0, latest: 0, baselineAvg: 0, momentum: null };
  if (points.length < 2) return empty;

  // 再生数などは単調増加のはずだが、ニコニコ側の集計補正でまれに減ることがある。
  // グラフ・平均が壊れるので0で下げ止める。
  const deltas = [];
  for (let i = 1; i < points.length; i++) {
    deltas.push(Math.max(0, (points[i][column] || 0) - (points[i - 1][column] || 0)));
  }

  const total = deltas.reduce((a, b) => a + b, 0);
  const latest = deltas[deltas.length - 1];
  const past = deltas.slice(0, -1);
  const baselineAvg = past.length ? past.reduce((a, b) => a + b, 0) / past.length : 0;

  return {
    days: points.length,
    deltas,
    total,
    avgPerDay: total / deltas.length,
    latest,
    baselineAvg,
    // 比較対象（直近1日を除いた平均）が0だと割合が無限大になるため null にして「判定不可」扱いにする
    momentum: past.length && baselineAvg > 0 ? ((latest - baselineAvg) / baselineAvg) * 100 : null,
  };
}

/**
 * analyzeHistory の momentum を日本語のひとことに変える。
 * ±20%以内は誤差の範囲とみなして「横ばい」とする。
 */
function describeMomentum(momentum) {
  if (momentum === null || !isFinite(momentum)) return '判定不可（履歴が不足しています）';
  const signed = `${momentum >= 0 ? '+' : ''}${momentum.toFixed(0)}%`;
  if (momentum >= 20) return `加速中 (${signed})`;
  if (momentum <= -20) return `減速中 (${signed})`;
  return `横ばい (${signed})`;
}

/**
 * グラフURLの生成（QuickChart）。
 *
 * 旧実装は「1日の増加」だけの折れ線で、しかも差分をとる都合で先頭の1日が
 * グラフから消えていた。増加量（棒・左軸）と累計（線・右軸）の複合グラフにして、
 * 「勢い」と「規模」を1枚で同時に読めるようにする。
 * 背景を白にしているのは、Discordのダークテーマだと既定の透過背景では
 * 軸ラベルの黒文字がほぼ見えないため。
 *
 * @param {Array} statsHistory - [{ views: 100, recorded_at: '...' }, ...] 古い順
 * @param {Object} [options] - { column, label, title }
 */
function generateChartUrl(statsHistory, options = {}) {
  const { column = 'views', label = '再生', title } = options;
  const points = (statsHistory || []).filter((r) => r && r[column] != null);
  if (points.length < 2) return null;

  const labels = points.map((p) => formatDayLabel(p.recorded_at));
  const totals = points.map((p) => p[column] || 0);
  // 先頭の日は「前日」が無く増加量を出せないので null（＝棒を描かない）にして、
  // 累計の線だけはその日から始まるようにする
  const deltas = [null, ...analyzeHistory(points, column).deltas];

  const chartConfig = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `1日の${label}増加`,
          data: deltas,
          backgroundColor: `#${config.CHART_COLOR}`,
          yAxisID: 'growth',
          order: 2,
        },
        {
          type: 'line',
          label: `累計${label}`,
          data: totals,
          borderColor: '#e67e22',
          backgroundColor: 'transparent',
          fill: false,
          pointRadius: 2,
          borderWidth: 2,
          yAxisID: 'total',
          order: 1,
        },
      ],
    },
    options: {
      title: { display: true, text: title || `${label}の推移（直近${points.length}日）` },
      legend: { display: true, position: 'bottom' },
      scales: {
        yAxes: [
          { id: 'growth', position: 'left', ticks: { beginAtZero: true } },
          { id: 'total', position: 'right', gridLines: { display: false } },
        ],
      },
    },
  };

  return `https://quickchart.io/chart?w=600&h=300&bkg=%23ffffff&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
}

/**
 * video_stats の行（views/likes/...）を、ニコニコAPIレスポンスと同じ
 * { view, like, mylist, comment } の形に揃える。
 * レポート系がDB由来の値でもAPI由来の値でも同じ処理を通せるようにするため。
 */
function fromStatsRow(row) {
  const current = {};
  for (const { key, column } of METRICS) {
    current[key] = row ? row[column] || 0 : 0;
  }
  return current;
}

/**
 * 最新データ（APIレスポンス形式）と過去データ（video_stats行）の差分を計算
 */
function calculateDiff(currentStats, previousStats) {
  const diff = {};
  for (const { key, column } of METRICS) {
    diff[key] = previousStats
      ? (currentStats[key] || 0) - (previousStats[column] || 0)
      : 0;
  }
  return diff;
}

/**
 * 差分に + をつけるフォーマット関数
 */
function formatDiff(num) {
  if (num > 0) return `+${num.toLocaleString()}`;
  if (num < 0) return `${num.toLocaleString()}`;
  return `±0`;
}

/**
 * 差分を「増加率」に直す。母数（＝比較元の値）が0以下なら率に意味がないので null。
 * 実数だけだと動画の規模によって多いのか少ないのか判断できないため併記する。
 */
function formatDiffRate(diff, currentValue) {
  const base = (currentValue || 0) - (diff || 0);
  // 増減が無いときの「+0.0%」は情報量が無く、表がうるさくなるだけなので出さない
  if (!diff || base <= 0) return null;
  return `${diff >= 0 ? '+' : ''}${((diff / base) * 100).toFixed(1)}%`;
}

/**
 * 文字列の表示幅（全角=2, 半角=1）。Discordのコードブロックは等幅表示なので、
 * この幅で桁を揃えると日本語ラベル混じりの表でも列がずれない。
 */
function displayWidth(str) {
  let width = 0;
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += isWide ? 2 : 1;
  }
  return width;
}

/** 表示幅ベースの右詰め／左詰め（displayWidth を使う） */
function padStartWide(str, width) {
  const s = String(str);
  return ' '.repeat(Math.max(0, width - displayWidth(s))) + s;
}
function padEndWide(str, width) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/**
 * 「現在値」「増減」「増加率」を等幅の表にまとめる。
 * Embedのinlineフィールドを4つ並べる旧レイアウトは3個目で折り返して不揃いになり、
 * 増加率を足す余白も無かったため、1つのコードブロックに集約した。
 * 列見出し・指標名をASCIIに寄せているのは METRICS のコメントの通り。
 *
 * @param {Object} current { view, like, mylist, comment }
 * @param {Object|null} diff calculateDiff の戻り値。比較元の記録がまだ無い場合は null を渡すこと
 *   （0を渡すと「増減なし」と区別がつかず、監視を始めた直後が伸びていないように見えてしまう）
 * @param {string} diffHeader 差分列の見出し（'vs 1d' / 'vs 7d' など）
 */
function buildStatsTable(current, diff, diffHeader = 'vs 1d') {
  const rows = METRICS.map(({ key, en }) => {
    const value = current[key] || 0;
    if (!diff) return [en, value.toLocaleString(), '--', ''];
    const d = diff[key] || 0;
    const rate = formatDiffRate(d, value);
    return [en, value.toLocaleString(), formatDiff(d), rate ? `(${rate})` : ''];
  });

  const headers = ['Metric', 'Current', diffHeader, ''];
  const all = [headers, ...rows];
  const widths = headers.map((_, col) => Math.max(...all.map((r) => displayWidth(r[col]))));

  const line = (r) =>
    `${padEndWide(r[0], widths[0])}  ${padStartWide(r[1], widths[1])}  ${padStartWide(r[2], widths[2])} ${padEndWide(r[3], widths[3])}`.trimEnd();

  const header = line(headers);
  const body = rows.map(line);
  // 区切り線は見出し行ではなく最長行に合わせる（増加率の列は見出しが空のため）
  const ruleWidth = Math.max(displayWidth(header), ...body.map(displayWidth));
  return ['```', header, '-'.repeat(ruleWidth), ...body, '```'].join('\n');
}

/**
 * マイルストーン（キリ番）を跨いだか判定する
 * @param {number} oldValue 前回の値
 * @param {number} newValue 現在の値
 * @param {number} step 判定単位 (例: 100)
 * @returns {number|null} 跨いだ場合は一番高いキリ番の数値、跨いでいない場合は null
 */
function checkMilestone(oldValue, newValue, step = 100) {
  const oldFloor = Math.floor((oldValue || 0) / step);
  const newFloor = Math.floor((newValue || 0) / step);
  if (oldFloor < newFloor) {
    return newFloor * step;
  }
  return null;
}

/**
 * 次のキリ番まであといくつかを計算する
 * @param {number} currentValue 現在の値
 * @param {number} step 判定単位 (例: 100)
 * @returns {Object} { nextMilestone: 200, remaining: 15 }
 */
function getUpcomingMilestone(currentValue, step = 100) {
  const val = currentValue || 0;
  const nextMilestone = (Math.floor(val / step) + 1) * step;
  return {
    nextMilestone,
    remaining: nextMilestone - val
  };
}

/**
 * 直近の伸び（1日あたり）から、次のキリ番到達までおよそ何日かを見積もる。
 * 伸びが止まっている（0以下）場合は予測不能として null を返す。
 */
function estimateDaysToMilestone(remaining, perDay) {
  if (!perDay || perDay <= 0 || remaining <= 0) return null;
  return Math.max(1, Math.ceil(remaining / perDay));
}

/**
 * 外部API由来の文字列（動画タイトル等）をDiscord Embedの文字数上限内に収める。
 * 上限を超えたまま .setTitle() 等に渡すと例外で処理全体が落ちるため、
 * 表示直前に必ずこれを通す。
 * @param {string} str
 * @param {number} maxLen
 */
function truncate(str, maxLen) {
  const s = str == null ? '' : String(str);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

module.exports = {
  METRICS,
  generateChartUrl,
  formatDayLabel,
  analyzeHistory,
  describeMomentum,
  fromStatsRow,
  calculateDiff,
  formatDiff,
  formatDiffRate,
  buildStatsTable,
  displayWidth,
  checkMilestone,
  getUpcomingMilestone,
  estimateDaysToMilestone,
  truncate
};
