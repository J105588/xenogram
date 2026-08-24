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

process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await sendErrorEmbed(error, "🚨 Uncaught Exception");
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  await sendErrorEmbed(reason, "🚨 Unhandled Rejection");
});

// 停止（pm2 stop/restart、Ctrl+C等）を「予期せぬクラッシュ」と区別できるよう一報する。
// PM2側の kill_timeout(15秒) の範囲内で通知＋後片付けを終わらせる想定
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} を受信しました。シャットダウンします...`);
  try {
    await broadcastNotification(`🔴 Bot停止します（${signal}）`);
  } catch (e) {
    console.error('停止通知の送信に失敗しました:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
