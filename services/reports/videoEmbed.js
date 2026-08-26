const { EmbedBuilder } = require('discord.js');
const config = require('../../config');
const utils = require('../../utils');

/**
 * 動画1本ぶんの統計Embedを組み立てる。
 *
 * デイリーレポート・週次レポート・/stats の3か所がそれぞれ似て非なるEmbedを
 * 自前で組み立てており、「現在値と前日比の±」しか出ていなかった。
 * 表示内容の再設計にあたって、3か所が同じ見た目・同じ指標になるようここへ集約している。
 *
 * 出す情報は4段構成:
 *   1. 現在値・増減・増加率の表（実数だけだと規模の違いで多寡が判断できないため率を併記）
 *   2. 期間全体の勢い（合計・1日平均・直近1日・加速/減速）
 *   3. 次のキリ番と到達予測日
 *   4. 増加量（棒）と累計（線）の複合グラフ
 *
 * @param {Object}   params
 * @param {string}   params.videoId
 * @param {string}   params.title           動画タイトル
 * @param {string}   [params.thumbnail]
 * @param {string}   [params.tags]
 * @param {Object}   params.current         { view, like, mylist, comment }
 * @param {Object}   [params.previous]      比較元の video_stats 行 { views, likes, ... }
 * @param {Array}    [params.history]       日次履歴（古い順）
 * @param {string}   [params.diffHeader]    差分列の見出し（'vs 1d' / 'vs 7d'）
 * @param {string}   [params.titlePrefix]   タイトル接頭辞（'Analytics' / '週報'）
 * @param {number}   [params.milestoneStep] キリ番の刻み
 */
function buildVideoStatsEmbed({
  videoId,
  title,
  thumbnail,
  tags,
  current,
  previous = null,
  history = [],
  diffHeader = 'vs 1d',
  titlePrefix = 'Analytics',
  milestoneStep = config.MILESTONE_STEP,
}) {
  const trend = utils.analyzeHistory(history, 'views');
  // 比較元の記録がまだ無いときは差分を出さない（0埋めすると「伸びていない」と誤読される）
  const diff = previous ? utils.calculateDiff(current, previous) : null;

  const table = utils.buildStatsTable(current, diff, diffHeader);
  let description = diff
    ? table
    : `${table}\n※ 比較できる過去の記録がまだありません（次回のレポートから差分が出ます）`;
  if (current.likeStale) {
    description += '\n※ いいねは最新値を取得できなかったため、前回の記録値を表示しています';
  }

  const embed = new EmbedBuilder()
    .setTitle(utils.truncate(`${titlePrefix}: ${title}`, 256))
    .setURL(`https://www.nicovideo.jp/watch/${videoId}`)
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setDescription(description)
    .setFooter({ text: config.FOOTER_TEXT })
    .setTimestamp();

  if (thumbnail) embed.setThumbnail(thumbnail);

  // 勢い: 増加量が2日ぶん揃わないと「合計・平均・直近」が全部同じ数字になり、
  // 上の表以上の情報にならない。3日目以降から出す。
  if (trend.deltas.length >= 2) {
    const spanDays = trend.deltas.length;
    embed.addFields({
      name: `勢い（直近${spanDays}日）`,
      value:
        `合計 ${utils.formatDiff(trend.total)}再生 ・ 1日平均 ${utils.formatDiff(Math.round(trend.avgPerDay))}\n` +
        `直近1日 ${utils.formatDiff(trend.latest)} → ${utils.describeMomentum(trend.momentum)}`,
      inline: false,
    });
  }

  // 次のキリ番: 「あと何回か」だけでなく、今の伸びなら何日で届くかまで出す
  const upcoming = utils.getUpcomingMilestone(current.view, milestoneStep);
  const etaDays = utils.estimateDaysToMilestone(upcoming.remaining, trend.avgPerDay);
  embed.addFields({
    name: '次のマイルストーン',
    value:
      `**${upcoming.nextMilestone.toLocaleString()}** 再生まであと **${upcoming.remaining.toLocaleString()}**` +
      (etaDays ? `（今の勢いなら約${etaDays}日後）` : '（伸びが止まっているため予測不可）'),
    inline: false,
  });

  if (tags) {
    embed.addFields({ name: 'タグ', value: utils.truncate(`\`${tags}\``, 1024), inline: false });
  }

  const chartUrl = utils.generateChartUrl(history, { column: 'views', label: '再生' });
  if (chartUrl) embed.setImage(chartUrl);

  return embed;
}

/**
 * レポート冒頭に送る全体サマリー。
 *
 * 従来は動画ごとのEmbedがただ並ぶだけで、「今日どれが伸びたのか」を
 * 人間が全部スクロールして見比べる必要があった。先頭に総量とTOPを置く。
 *
 * @param {Array}  rows [{ video, current, diff, trend }]
 * @param {Object} [options] { title, periodLabel, topN }
 */
function buildSummaryEmbed(rows, options = {}) {
  const { title = 'デイリーレポート', periodLabel = '本日', topN = 5 } = options;

  const totalViewGrowth = rows.reduce((sum, r) => sum + (r.diff.view || 0), 0);
  const totalLikeGrowth = rows.reduce((sum, r) => sum + (r.diff.like || 0), 0);
  const ranked = [...rows].sort((a, b) => (b.diff.view || 0) - (a.diff.view || 0));

  const staleCount = rows.filter((r) => r.current.likeStale).length;
  const staleNote = staleCount
    ? `\n※ うち${staleCount}本はいいねの最新値を取得できず、前回の記録値のままです`
    : '';

  const embed = new EmbedBuilder()
    .setTitle(`${title}（${new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}）`)
    .setColor(parseInt(config.CHART_COLOR, 16))
    .setDescription(
      `監視中 **${rows.length}本**\n` +
      `${periodLabel}の合計: 再生 **${utils.formatDiff(totalViewGrowth)}** ・ いいね **${utils.formatDiff(totalLikeGrowth)}**` +
      staleNote
    )
    .setFooter({ text: config.FOOTER_TEXT })
    .setTimestamp();

  const top = ranked.slice(0, topN).filter((r) => (r.diff.view || 0) > 0);
  if (top.length) {
    embed.addFields({
      name: `${periodLabel}の伸び TOP${top.length}`,
      value: top
        .map((r, i) => {
          const rate = utils.formatDiffRate(r.diff.view, r.current.view);
          return `**${i + 1}.** [${utils.truncate(r.video.title, 60)}](https://www.nicovideo.jp/watch/${r.video.id})\n` +
            `　再生 ${utils.formatDiff(r.diff.view)}${rate ? ` (${rate})` : ''} ・ いいね ${utils.formatDiff(r.diff.like)}`;
        })
        .join('\n'),
      inline: false,
    });
  }

  // 平常時より明確に速い／遅い動画だけを拾う（横ばいは列挙しても判断材料にならない）
  const accelerating = rows.filter((r) => r.trend.momentum !== null && r.trend.momentum >= 20);
  const decelerating = rows.filter((r) => r.trend.momentum !== null && r.trend.momentum <= -20);

  if (accelerating.length) {
    embed.addFields({
      name: '勢いが上がっている動画',
      value: accelerating
        .sort((a, b) => b.trend.momentum - a.trend.momentum)
        .slice(0, 5)
        .map((r) => `・${utils.truncate(r.video.title, 50)} — ${utils.describeMomentum(r.trend.momentum)}`)
        .join('\n'),
      inline: false,
    });
  }
  if (decelerating.length) {
    embed.addFields({
      name: '勢いが落ちている動画',
      value: decelerating
        .sort((a, b) => a.trend.momentum - b.trend.momentum)
        .slice(0, 5)
        .map((r) => `・${utils.truncate(r.video.title, 50)} — ${utils.describeMomentum(r.trend.momentum)}`)
        .join('\n'),
      inline: false,
    });
  }

  return embed;
}

module.exports = { buildVideoStatsEmbed, buildSummaryEmbed };
