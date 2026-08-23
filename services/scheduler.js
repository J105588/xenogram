// 各ジョブの実体は services/jobs/ 配下にドメインごと分割されている。
// このファイルは cron への登録・実行時の再スケジュールと、後方互換のための
// re-export だけを担う。
//
// マルチテナント化にあたり、cronタスクは「ジョブごと1本」から
// 「サーバー × ジョブごと1本」に変わった。鯖ごとに実行時刻を変えられるようにするため。
const cron = require('node-cron');
const config = require('../config');
const discordService = require('./discord');
const dbService = require('./database');
const { toCronExpression } = require('./cronFriendly');

const { updateVideoList } = require('./jobs/updateVideoList');
const { reportEachVideoStats } = require('./jobs/dailyReport');
const { runVocacolleWatch } = require('./jobs/vocacolleWatch');
const { sendWeeklyReport } = require('./jobs/weeklyReport');
const { runTwitterWatch } = require('./jobs/twitterWatch');
const { getSchedulerStatus } = require('./jobs/status');

// ジョブ定義: /set_schedule コマンドで実行時刻を変更できるよう、
// 設定キー・実行本体・現在動いている cron タスクをひとまとめに管理する。
// scheduleShape は /set_schedule での自然言語入力（例:「5分」「7時30分」「日 21時」）を
// cron式へ変換する際に、どんな形の時刻を受け付けるかを示す（cronFriendly.js 参照）。
const JOB_DEFS = {
  update_video_list: {
    settingKey: 'cron_update_video_list',
    label: '毎時 新着/キリ番/急上昇チェック',
    scheduleShape: 'hourly',
    run: (guildId) => updateVideoList(guildId),
    errorTitle: '🚨 Scheduler: Hourly Update Failed',
  },
  daily_report: {
    settingKey: 'cron_daily_report',
    label: 'デイリーレポート',
    scheduleShape: 'daily',
    run: (guildId) => reportEachVideoStats(guildId),
    errorTitle: '🚨 Scheduler: Daily Report Failed',
  },
  vocacolle_watch: {
    settingKey: 'cron_vocacolle_watch',
    label: 'ボカコレ/ランキング監視',
    scheduleShape: 'hourly',
    run: (guildId) => runVocacolleWatch(guildId, { notifySummary: true }),
    errorTitle: '🚨 Scheduler: Vocacolle Watch Failed',
    enabledCheck: () => config.VOCACOLLE.ENABLED,
  },
  weekly_report: {
    settingKey: 'cron_weekly_report',
    label: '週次まとめレポート',
    scheduleShape: 'weekly',
    run: (guildId) => sendWeeklyReport(guildId),
    errorTitle: '🚨 Scheduler: Weekly Report Failed',
    enabledCheck: () => config.WEEKLY_REPORT.ENABLED,
  },
  twitter_watch: {
    settingKey: 'cron_twitter_watch',
    label: 'X(Twitter) キーワード監視（読み取り専用）',
    scheduleShape: 'hourly',
    run: (guildId) => runTwitterWatch(guildId),
    errorTitle: '🚨 Scheduler: Twitter Watch Failed',
    // 未セットアップの環境では無効のままにし、cronにも登録しない（TWITTER_MONITOR_ENABLED=true が必要）
    enabledCheck: () => config.TWITTER_MONITOR.ENABLED,
  },
};

// 現在稼働中の cron タスク。キーは "guildId:jobKey"
// （鯖ごとに実行時刻が違うので、差し替えも鯖単位で行う必要がある）
const activeTasks = new Map();

const taskKey = (guildId, jobKey) => `${guildId}:${jobKey}`;

function scheduleJob(guildId, jobKey) {
  const def = JOB_DEFS[jobKey];
  if (!def) throw new Error(`Unknown job: ${jobKey}`);

  if (def.enabledCheck && !def.enabledCheck()) return;

  const cronExpr = dbService.getSetting(guildId, def.settingKey);
  if (!cron.validate(cronExpr)) {
    console.error(`[SCHED] 不正なcron式のため登録をスキップします (guild: ${guildId}, ${jobKey}): "${cronExpr}"`);
    return;
  }

  const task = cron.schedule(cronExpr, () => {
    def.run(guildId).catch(async (err) => {
      console.error(err);
      // エラーはその鯖にだけ通知する（他の鯖には関係のない話のため）
      await discordService.sendErrorEmbed(err, def.errorTitle, guildId);
    });
  }, { timezone: 'Asia/Tokyo' });

  activeTasks.set(taskKey(guildId, jobKey), task);
}

/**
 * 1サーバーぶんの全ジョブを登録する（既存のタスクがあれば止めてから張り直す）。
 */
function scheduleGuild(guildId) {
  unscheduleGuild(guildId);
  for (const jobKey of Object.keys(JOB_DEFS)) {
    scheduleJob(guildId, jobKey);
  }
  console.log(`[SCHED] サーバー ${guildId} のジョブを登録しました。`);
}

/**
 * 1サーバーぶんの全ジョブを止める（Botがサーバーから外された時など）。
 */
function unscheduleGuild(guildId) {
  for (const jobKey of Object.keys(JOB_DEFS)) {
    const key = taskKey(guildId, jobKey);
    const task = activeTasks.get(key);
    if (task) {
      task.stop();
      activeTasks.delete(key);
    }
  }
}

/**
 * 指定ジョブのcron式を設定に保存し、稼働中のタスクを差し替える（実行時に即反映）。
 */
function applyCronAndReschedule(guildId, jobKey, cronExpr) {
  const key = taskKey(guildId, jobKey);
  const existing = activeTasks.get(key);
  if (existing) {
    existing.stop();
    activeTasks.delete(key);
  }

  dbService.setSetting(guildId, JOB_DEFS[jobKey].settingKey, cronExpr);
  scheduleJob(guildId, jobKey);
}

/**
 * 稼働中のジョブの実行時刻を実行時に変更する（/set_schedule 用）。
 * 「5分」「7時30分」「日 21時」のような自然な入力をジョブの形に応じてcron式へ変換してから
 * 適用する（cron式をそのまま渡した場合はそれを使う）。再起動不要で即座に反映する。
 */
function rescheduleJob(guildId, jobKey, rawInput) {
  const def = JOB_DEFS[jobKey];
  if (!def) return { ok: false, reason: 'unknown_job' };

  const parsed = toCronExpression(rawInput, def.scheduleShape);
  if (!parsed.ok) return { ok: false, reason: 'invalid_format', scheduleShape: def.scheduleShape };

  applyCronAndReschedule(guildId, jobKey, parsed.cronExpr);
  return { ok: true, cronExpr: parsed.cronExpr };
}

// ボカコレ監視ON中は、デイリーレポートを「毎日1回」ではなく「毎時20分」に切り替える
// （イベント期間中はより細かい頻度で各動画の伸びを追いたいという運用要望のため）。
// OFFに戻したら、ONにする直前の設定（手動で変更していた場合もそれ）に復元する。
const VOCA_LINKED_JOB_KEY = 'daily_report';
const VOCA_LINKED_CRON = '20 * * * *'; // 他のジョブ（:00 :05 :10）とぶつからない分に配置
const VOCA_LINKED_SAVED_SETTING_KEY = 'daily_report_cron_before_voca_link';

/**
 * /vc_toggle から呼ばれる。ボカコレ監視のON/OFFに合わせてデイリーレポートの
 * スケジュールを切り替える。切り替えが発生した場合はユーザー向けの案内文を返す
 * （何も変わらなかった場合は null）。鯖ごとに独立して効く。
 */
function applyVocacolleLinkedSchedule(guildId, vocaEnabled) {
  const def = JOB_DEFS[VOCA_LINKED_JOB_KEY];

  if (vocaEnabled) {
    const current = dbService.getSetting(guildId, def.settingKey);
    if (current === VOCA_LINKED_CRON) return null; // 既に連動切り替え済み（二重トグル等）

    dbService.setSetting(guildId, VOCA_LINKED_SAVED_SETTING_KEY, current);
    applyCronAndReschedule(guildId, VOCA_LINKED_JOB_KEY, VOCA_LINKED_CRON);
    return `📅 ボカコレ監視中は${def.label}を毎時20分に切り替えました（元の設定 \`${current}\` は保存済みで、OFFに戻すと自動で復元されます）。`;
  }

  const saved = dbService.getSetting(guildId, VOCA_LINKED_SAVED_SETTING_KEY);
  if (saved === null) return null; // 連動切り替えを一度もしていない状態

  applyCronAndReschedule(guildId, VOCA_LINKED_JOB_KEY, saved);
  return `📅 ${def.label}を元のスケジュール \`${saved}\` に戻しました。`;
}

function listJobs(guildId) {
  // enabledCheck が false のジョブ（機能まるごと config で無効化されているもの）は、
  // /settings 等の表示からも除外する（＝実行されないジョブの存在自体を出さない）
  return Object.entries(JOB_DEFS)
    .filter(([, def]) => !def.enabledCheck || def.enabledCheck())
    .map(([key, def]) => ({
      key,
      label: def.label,
      cron: dbService.getSetting(guildId, def.settingKey),
      scheduleShape: def.scheduleShape,
    }));
}

/**
 * 登録済みの全サーバーぶんのジョブを起動する。
 * guildsテーブルが埋まっている必要があるため、Discordログイン完了後に呼ぶこと。
 */
function startScheduler() {
  const guilds = dbService.getAllGuilds();
  for (const guild of guilds) {
    scheduleGuild(guild.guild_id);
  }
  console.log(`Schedulers started for ${guilds.length} guild(s). (${activeTasks.size} tasks)`);
}

module.exports = {
  startScheduler,
  scheduleGuild,
  unscheduleGuild,
  rescheduleJob,
  applyVocacolleLinkedSchedule,
  listJobs,
  updateVideoList,
  reportEachVideoStats,
  runVocacolleWatch,
  sendWeeklyReport,
  runTwitterWatch,
  getSchedulerStatus
};
