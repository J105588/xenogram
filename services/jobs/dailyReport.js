const niconico = require('../niconico');
const dbService = require('../database');
const discordService = require('../discord');
const utils = require('../../utils');
const config = require('../../config');
const { buildVideoStatsEmbed, buildSummaryEmbed } = require('../reports/videoEmbed');
const { markRun } = require('./status');
const { withSingleFlight } = require('../singleFlight');

// ニコニコAPIへの同時リクエスト数。直列だと動画本数ぶん待たされるが、
// 一気に投げると相手にもこちらのタイムアウト(5s)にも優しくないので控えめに並べる。
const FETCH_CONCURRENCY = 4;

/**
 * 【毎朝7時に実行】各動画の前日比・伸びの傾向・グラフを含むレポート送信。
 * /daily_report による手動実行と自動実行が重なっても二重送信されないよう、
 * 常に1本だけ走らせる。
 */
async function reportEachVideoStats(guildId) {
  const outcome = await withSingleFlight(`reportEachVideoStats:${guildId}`, () => reportEachVideoStatsInner(guildId));
  if (!outcome.ok) {
    console.warn(`[DAILY] 前回のデイリーレポートがまだ完了していないため、今回はスキップします (guild: ${guildId})`);
    return { skipped: 'already_running' };
  }
  return outcome.result;
}

/**
 * 動画1本ぶんの「収集フェーズ」。
 * 前日比は必ず「記録する前」の値と比べる必要があるため、
 *   前日分の取得 → 差分計算 → 今回値の記録 → 記録後の履歴取得
 * の順序を崩さないこと（記録を先にすると前日比が常に0になる）。
 */
async function collectVideoStats(guildId, video) {
  const apiData = await niconico.fetchNicoData(video.id);
  if (!apiData) {
    console.warn(`⚠️ Skipping report for ${video.id}: Failed to fetch Niconico data.`);
    return null;
  }

  const previous = await dbService.getYesterdayStats(video.id);
  const diff = utils.calculateDiff(apiData, previous);

  await dbService.recordStats(video.id, apiData.view, apiData.comment, apiData.mylist, apiData.like);

  // 記録後に読むことで、今日の点までグラフに載る
  const history = await dbService.getStatsHistory(video.id, 7);

  return {
    video: { ...video, title: apiData.title || video.title },
    current: apiData,
    previous,
    diff,
    history,
    trend: utils.analyzeHistory(history, 'views'),
  };
}

/**
 * 同時実行数を絞って map する。
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        console.error(`❌ Failed to collect stats for ${items[index] && items[index].id}:`, error);
        results[index] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

async function reportEachVideoStatsInner(guildId) {
  console.log(`Running daily reportEachVideoStats... (guild: ${guildId})`);

  if (!dbService.resolveChannelId(guildId, 'video')) {
    console.warn(`デイリーレポート: 通知先チャンネルが未設定のためスキップします (guild: ${guildId})`);
    return { skipped: 'no_channel' };
  }

  const videos = await dbService.getAllVideos(guildId);
  if (!videos.length) {
    console.log(`デイリーレポート: 監視中の動画がないためスキップします (guild: ${guildId})`);
    markRun('reportEachVideoStats');
    return;
  }

  // 収集と送信を分ける。全動画ぶんのデータが揃っていないと、
  // 冒頭の全体サマリー（合計・TOP・勢いの増減）が組み立てられないため。
  const collected = await mapWithConcurrency(videos, FETCH_CONCURRENCY, (v) => collectVideoStats(guildId, v));
  const rows = collected.filter(Boolean);

  if (!rows.length) {
    console.log(`デイリーレポート: 有効な統計データが取得できなかったためスキップします (guild: ${guildId})`);
    markRun('reportEachVideoStats');
    return;
  }

  try {
    await discordService.sendNotification(guildId, buildSummaryEmbed(rows, { title: 'デイリーレポート', periodLabel: '本日' }), 'video');
  } catch (summaryError) {
    // サマリーが落ちても動画ごとの詳細は届けたいので、ここでは止めない
    console.error('❌ Failed to send daily summary embed:', summaryError);
  }

  const milestoneStep = dbService.getSetting(guildId, 'milestone_step');

  for (const row of rows) {
    try {
      const embed = buildVideoStatsEmbed({
        videoId: row.video.id,
        title: row.current.title,
        thumbnail: row.current.thumbnail,
        tags: row.current.tags,
        current: row.current,
        previous: row.previous,
        history: row.history,
        diffHeader: 'vs 1d',
        titlePrefix: 'Analytics',
        milestoneStep,
      });
      await discordService.sendNotification(guildId, embed, 'video');
    } catch (itemError) {
      console.error(`❌ Failed to generate/send report for video ${row.video.id}:`, itemError);
      // 1本の動画で失敗しても、他の動画のレポート処理を止めずに次へ進む
    }
  }

  markRun('reportEachVideoStats');
}

module.exports = { reportEachVideoStats };
