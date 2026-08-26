// システム全体のタイムゾーンを日本時間(JST)に設定
process.env.TZ = 'Asia/Tokyo';

// このBotは専用サーバーではなく普段使いのデスクトップPC上でPM2常駐させている。
// Discord・VSCode・ブラウザ・ゲーム等の前面アプリと常にCPUを取り合っており、
// Windowsは非フォーカスのバックグラウンドプロセス（このNodeプロセスもその1つ）の
// スケジューリングを動的に後回しにすることがある。これが数秒〜十数秒単位で
// イベントループの処理が遅延する原因となり、Discordの応答期限（3秒）を過ぎて
// "Unknown interaction" エラーになる一因になっていた。
// 自分自身の優先度を一段階上げておくことで、後回しにされにくくする。
try {
  const os = require('os');
  os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
} catch (err) {
  console.warn('[STARTUP] プロセス優先度の変更に失敗しました（続行します）:', err.message);
}

// イベントループ遅延の監視。
// 上記の理由でイベントループが数秒〜それ以上詰まると、その間に届いた
// スラッシュコマンドは3秒の応答期限を過ぎて "Unknown interaction" になり、
// ユーザーからは「コマンドに応じなくなった」ように見える。原因がOSの
// スケジューリングなのか、コード側で重い同期処理を書いてしまったのかを
// 事後に切り分けられるよう、遅延がDiscordの応答期限に近づいたら記録しておく。
{
  const CHECK_INTERVAL_MS = 2000;
  const WARN_THRESHOLD_MS = 2000; // 応答期限(3秒)に対して余裕を持たせて警告
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - CHECK_INTERVAL_MS;
    lastTick = now;
    if (lag > WARN_THRESHOLD_MS) {
      console.warn(`[WATCHDOG] イベントループが約${lag}ms遅延しました（OSによるスケジューリング後回し、または重い同期処理の可能性）`);
    }
  }, CHECK_INTERVAL_MS).unref();
}

const express = require('express');
const config = require('./config');
const { startDiscordBot } = require('./services/discord');
const { reapOrphanedChromeProcesses } = require('./services/browser');

console.log("🔍 Checking Environment Variables on Startup:");
console.log(`- DISCORD_TOKEN: ${config.DISCORD.TOKEN ? "✅ PRESENT" : "❌ MISSING"}`);
console.log(`- DISCORD_CHANNEL_ID: ${config.DISCORD.CHANNEL_ID ? "✅ PRESENT" : "❌ MISSING"}`);
console.log(`- DB: SQLite (${require('./services/repositories/db').DB_PATH})`);

const app = express();
const PORT = config.PORT;

// Renderのスリープ回避用のエンドポイント
app.get('/', (req, res) => {
  res.send('XENOGRAM Analytics Bot is running.');
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);

  // 前回セッションの残骸（ゾンビ化したChromium）を掃除してから起動する
  reapOrphanedChromeProcesses().catch((e) => console.warn('[BROWSER] 起動時クリーンアップでエラー:', e.message));

  // Discord Botの起動。
  // スケジューラは「どのサーバーに入っているか」が分かってからでないと
  // 鯖ごとのcronを張れないため、ログイン完了後（clientReady）に起動する。
  startDiscordBot();
});

// グローバルな例外処理
const { sendErrorEmbed, broadcastNotification } = require('./services/discord');

// uncaughtException/unhandledRejection発生後のプロセスはNode公式が警告する通り
// 「何が壊れているか分からない」状態（イベントループの途中状態、破損した可能性のある
// メモリ上の状態等）にあるため、そのまま動作を継続させず、通知後に必ず終了する。
// ecosystem.config.js側でautorestart/exp_backoff_restart_delay/max_restartsを
// 設定済みなので、PM2が安全に再起動してくれる。
let exiting = false;
async function fatalExit(error, title) {
  if (exiting) return;
  exiting = true;
  try {
    // 通知先のDiscord API呼び出しがハングした場合でも終了が無期限に遅れないよう
    // 上限を設ける（この時点で既にプロセスは異常状態なので、長く待つ意味がない）
    await Promise.race([
      sendErrorEmbed(error, title),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (e) {
    console.error('エラー通知の送信に失敗しました:', e.message);
  } finally {
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  fatalExit(error, "🚨 Uncaught Exception");
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  fatalExit(reason, "🚨 Unhandled Rejection");
});

// 停止（pm2 stop/restart、Ctrl+C等）を「予期せぬクラッシュ」と区別できるよう一報する。
// PM2側の kill_timeout(15秒) の範囲内で通知＋後片付けを終わらせる想定。
//
// 【注意】Windows環境では、PM2がプロセスを止める際に送るシグナルがここに届かず
// （process.kill()のWindowsでの制約。詳細は services/shutdown.js のコメント参照）、
// 実際にはこのハンドラが一度も実行されないまま強制終了されているのを確認している。
// 動かせる保証はないが、将来Linux/Mac上で動かす場合や、コンソールが接続された
// 状態でのCtrl+C（実際にSIGINTとして機能する）のために登録は残しておく。
const { gracefulShutdown } = require('./services/shutdown');
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
