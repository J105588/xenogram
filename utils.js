const config = require('./config');

/**
 * グラフURLの生成（QuickChart）
 * @param {Array} statsHistory - [{ views: 100, recorded_at: '...' }, ...]
 */
function generateChartUrl(statsHistory) {
  if (!statsHistory || statsHistory.length < 2) return null;

  const labels = [];
  const growths = [];

  // 前回の値との差分（伸びた数）を計算する
  for (let i = 1; i < statsHistory.length; i++) {
    const prev = statsHistory[i - 1];
    const curr = statsHistory[i];

    const d = new Date(curr.recorded_at);
    if (isNaN(d.getTime())) {
      labels.push("--/--");
    } else {
      // 日本時間（Asia/Tokyo）基準で MM/DD 形式を取得
      const m = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit' });
      const day = d.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', day: '2-digit' });
      labels.push(`${m}/${day}`);
    }

    const growth = curr.views - prev.views;
    growths.push(growth >= 0 ? growth : 0); // マイナスになる場合は0とする
  }

  const chartConfig = {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Daily Growth',
        data: growths,
        borderColor: `#${config.CHART_COLOR}`,
        backgroundColor: `rgba(52, 152, 219, 0.1)`,
        fill: true,
        pointRadius: 4,
        borderWidth: 2
      }]
    },
    options: {
      legend: { display: false },
      title: { display: true, text: 'Daily Views Growth' }
    }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
}

/**
 * 最新データと過去データの差分を計算
 */
function calculateDiff(currentStats, previousStats) {
  if (!previousStats) {
    return { view: 0, comment: 0, mylist: 0, like: 0 };
  }
  
  return {
    view: currentStats.view - (previousStats.views || 0),
    comment: currentStats.comment - (previousStats.comments || 0),
    mylist: currentStats.mylist - (previousStats.mylists || 0),
    like: currentStats.like - (previousStats.likes || 0)
  };
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
  generateChartUrl,
  calculateDiff,
  formatDiff,
  checkMilestone,
  getUpcomingMilestone,
  truncate
};
