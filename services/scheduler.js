// 各ジョブの実体は services/jobs/ 配下にドメインごと分割されている。
// このファイルは cron への登録と、後方互換のための re-export だけを担う。
const cron = require('node-cron');
const config = require('../config');
const discordService = require('./discord');

const { updateVideoList } = require('./jobs/updateVideoList');
const { reportEachVideoStats } = require('./jobs/dailyReport');
const { runVocacolleWatch } = require('./jobs/vocacolleWatch');
const { sendWeeklyReport } = require('./jobs/weeklyReport');
const { getSchedulerStatus } = require('./jobs/status');

function startScheduler() {
  // 1時間に1回 (毎時0分)
  cron.schedule('0 * * * *', () => {
    updateVideoList().catch(async err => {
      console.error(err);
      await discordService.sendErrorEmbed(err, "🚨 Scheduler: Hourly Update Failed");
    });
  }, { timezone: "Asia/Tokyo" });

  // 毎朝7時0分（日本時間）
  cron.schedule('0 7 * * *', () => {
    reportEachVideoStats().catch(async err => {
      console.error(err);
      await discordService.sendErrorEmbed(err, "🚨 Scheduler: Daily Report Failed");
    });
  }, { timezone: "Asia/Tokyo" });

  // ボカコレ ランキング監視 (既定: 毎時5分)
  if (config.VOCACOLLE.ENABLED) {
    cron.schedule(config.VOCACOLLE.CRON, () => {
      runVocacolleWatch({ notifySummary: true }).catch(async err => {
        console.error(err);
        await discordService.sendErrorEmbed(err, "🚨 Scheduler: Vocacolle Watch Failed");
      });
    }, { timezone: "Asia/Tokyo" });
    console.log(`Vocacolle watcher scheduled: "${config.VOCACOLLE.CRON}" (Asia/Tokyo)`);
  } else {
    console.log("Vocacolle watcher is disabled (VOCACOLLE_ENABLED=false).");
  }

  // 週次まとめレポート (既定: 毎週日曜21時)
  if (config.WEEKLY_REPORT.ENABLED) {
    cron.schedule(config.WEEKLY_REPORT.CRON, () => {
      sendWeeklyReport().catch(async err => {
        console.error(err);
        await discordService.sendErrorEmbed(err, "🚨 Scheduler: Weekly Report Failed");
      });
    }, { timezone: "Asia/Tokyo" });
    console.log(`Weekly report scheduled: "${config.WEEKLY_REPORT.CRON}" (Asia/Tokyo)`);
  } else {
    console.log("Weekly report is disabled (WEEKLY_REPORT_ENABLED=false).");
  }

  console.log("Schedulers started.");
}

module.exports = {
  startScheduler,
  updateVideoList,
  reportEachVideoStats,
  runVocacolleWatch,
  sendWeeklyReport,
  getSchedulerStatus
};
