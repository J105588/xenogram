// 意図した停止（PM2の再起動・/restart等）をDiscordへ通知してから終了するための共通処理。
//
// 【重要】Windows上のNode.jsでは process.kill(pid, 'SIGTERM') は
// シグナルハンドラを経由せずプロセスを無条件に強制終了する（Node公式ドキュメントの
// 記載通り、WindowsにはPOSIXのようなシグナル機構自体が無く、SIGTERM/SIGKILLは
// 疑似的に「即終了」として扱われる）。このため、/restart コマンドが
// process.kill(process.pid, 'SIGTERM') 経由で index.js の SIGTERM ハンドラに
// 処理を委ねようとしても、そのハンドラは一度も実行されず、停止通知の送信も
// Chromiumの後片付けも行われないまま強制終了していた
// （ログに「SIGTERM を受信しました」が一度も出力されていないことで確認済み）。
//
// 対策として、シグナル送信を経由せず、この関数をプロセス内から直接呼び出す。
// PM2自体が発行するシグナル（cron_restart等）は引き続きOS依存のため改善できないが、
// 少なくともアプリ自身が意図して再起動する経路（/restart）は確実に通知できる。
let shuttingDown = false;

async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason} によりシャットダウンします...`);
  try {
    // discordモジュールを遅延require（services/discord → commands → shutdown という
    // 循環requireを避けるため、モジュール読み込み時ではなく呼び出し時に解決する）
    const { broadcastNotification } = require('./discord');
    // Discord API呼び出しがハングしてkill_timeout(15秒)を食い潰さないよう
    // 通知自体にも上限を設ける（Chromiumのクローズ処理に猶予を残すため）
    await Promise.race([
      broadcastNotification(`🔴 Bot停止します（${reason}）`),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (e) {
    console.error('停止通知の送信に失敗しました:', e.message);
  }
  process.exit(0);
}

module.exports = { gracefulShutdown };
