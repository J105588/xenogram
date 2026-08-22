// システム全体のタイムゾーンを日本時間(JST)に設定
process.env.TZ = 'Asia/Tokyo';

const express = require('express');
const axios = require('axios');
const config = require('./config');
const { startDiscordBot } = require('./services/discord');
const { startScheduler } = require('./services/scheduler');
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

  // Discord Botとスケジューラーの起動
  startDiscordBot();
  startScheduler();

  // Renderの無料プランは一定時間アクセスが無いとスリープするため、
  // 自分自身に定期アクセスして起きたままにする（Render以外では不要）。
  // 自前サーバー/PM2運用ではスリープしないので、URL未設定なら何もしない。
  const selfPingUrl = process.env.RENDER_EXTERNAL_URL;
  const selfPingEnabled = !!selfPingUrl && !selfPingUrl.includes('localhost');

  if (selfPingEnabled) {
    console.log(`✅ Self-ping protection enabled for URL: ${selfPingUrl}`);
    setInterval(() => {
      axios.get(selfPingUrl)
        .then(() => console.log('Self-ping successful.'))
        .catch(err => console.error('Self-ping failed:', err.message));
    }, 13 * 60 * 1000); // 13分
  } else {
    console.log('ℹ️ Self-ping is disabled (not needed outside Render).');
  }
});

// グローバルな例外処理
const { sendErrorEmbed, sendNotification } = require('./services/discord');

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
    await sendNotification(`🔴 Bot停止します（${signal}）`);
  } catch (e) {
    console.error('停止通知の送信に失敗しました:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
