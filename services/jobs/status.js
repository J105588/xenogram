// 各定期ジョブが最後に成功した時刻（/status コマンド用）。
// プロセス内メモリのみで保持するため、再起動すると null に戻る
// （＝「再起動後まだ1回も実行されていない」ことがそのまま可視化される）
const lastRunAt = {
  updateVideoList: null,
  reportEachVideoStats: null,
  vocacolleWatch: null,
  weeklyReport: null,
};

function markRun(jobName) {
  lastRunAt[jobName] = new Date().toISOString();
}

function getSchedulerStatus() {
  return { ...lastRunAt };
}

module.exports = { markRun, getSchedulerStatus };
