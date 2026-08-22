// 各ジョブの実体は services/jobs/ 配下にドメインごと分割されている。
// このファイルは cron への登録・実行時の再スケジュールと、後方互換のための
// re-export だけを担う。
const cron = require('node-cron');
const config = require('../config');
const discordService = require('./discord');
const dbService = require('./database');

const { updateVideoList } = require('./jobs/updateVideoList');
const { reportEachVideoStats } = require('./jobs/dailyReport');
const { runVocacolleWatch } = require('./jobs/vocacolleWatch');
const { sendWeeklyReport } = require('./jobs/weeklyReport');
const { getSchedulerStatus } = require('./jobs/status');

// ジョブ定義: /set_schedule コマンドで cron 式を実行時に変更できるよう、
// 設定キー・実行本体・現在動いている cron タスクをひとまとめに管理する。
const JOB_DEFS = {
  update_video_list: {
    settingKey: 'cron_update_video_list',
    label: '毎時 新着/キリ番/急上昇チェック',
    run: () => updateVideoList(),
    errorTitle: '🚨 Scheduler: Hourly Update Failed',
  },
  daily_report: {
    settingKey: 'cron_daily_report',
    label: 'デイリーレポート',
    run: () => reportEachVideoStats(),
    errorTitle: '🚨 Scheduler: Daily Report Failed',
  },
  vocacolle_watch: {
    settingKey: 'cron_vocacolle_watch',
    label: 'ボカコレ/ランキング監視',
    run: () => runVocacolleWatch({ notifySummary: true }),
    errorTitle: '🚨 Scheduler: Vocacolle Watch Failed',
    enabledCheck: () => config.VOCACOLLE.ENABLED,
  },
  weekly_report: {
    settingKey: 'cron_weekly_report',
    label: '週次まとめレポート',
    run: () => sendWeeklyReport(),
    errorTitle: '🚨 Scheduler: Weekly Report Failed',
    enabledCheck: () => config.WEEKLY_REPORT.ENABLED,
  },
};

// 現在稼働中の cron タスク（stop()して差し替えられるよう保持する）
const activeTasks = new Map();

function scheduleJob(jobKey) {
  const def = JOB_DEFS[jobKey];
  if (!def) throw new Error(`Unknown job: ${jobKey}`);

  if (def.enabledCheck && !def.enabledCheck()) {
    console.log(`${def.label} is disabled by config, skipping schedule.`);
    return;
  }

  const cronExpr = dbService.getSetting(def.settingKey);
  const task = cron.schedule(cronExpr, () => {
    def.run().catch(async (err) => {
      console.error(err);
      await discordService.sendErrorEmbed(err, def.errorTitle);
    });
  }, { timezone: 'Asia/Tokyo' });

  activeTasks.set(jobKey, task);
  console.log(`${def.label} scheduled: "${cronExpr}" (Asia/Tokyo)`);
}

/**
 * 稼働中のジョブのcron式を実行時に変更する（/set_schedule 用）。
 * 再起動不要で、古いタスクを止めて新しい式で即座に登録し直す。
 */
function rescheduleJob(jobKey, newCronExpr) {
  const def = JOB_DEFS[jobKey];
  if (!def) return { ok: false, reason: 'unknown_job' };
  if (!cron.validate(newCronExpr)) return { ok: false, reason: 'invalid_cron' };

  const existing = activeTasks.get(jobKey);
  if (existing) existing.stop();

  dbService.setSetting(def.settingKey, newCronExpr);
  scheduleJob(jobKey);
  return { ok: true };
}

function listJobs() {
  return Object.entries(JOB_DEFS).map(([key, def]) => ({
    key,
    label: def.label,
    cron: dbService.getSetting(def.settingKey),
  }));
}

function startScheduler() {
  for (const jobKey of Object.keys(JOB_DEFS)) {
    scheduleJob(jobKey);
  }
  console.log("Schedulers started.");
}

module.exports = {
  startScheduler,
  rescheduleJob,
  listJobs,
  updateVideoList,
  reportEachVideoStats,
  runVocacolleWatch,
  sendWeeklyReport,
  getSchedulerStatus
};
