// システム全体のタイムゾーンを日本時間(JST)に設定
process.env.TZ = 'Asia/Tokyo';

const express = require('express');
const axios = require('axios');
const config = require('./config');
const { startDiscordBot } = require('./services/discord');
const { startScheduler } = require('./services/scheduler');

console.log("🔍 Checking Environment Variables on Startup:");
console.log(`- DISCORD_TOKEN: ${config.DISCORD.TOKEN ? "✅ PRESENT" : "❌ MISSING"}`);
console.log(`- DISCORD_CHANNEL_ID: ${config.DISCORD.CHANNEL_ID ? "✅ PRESENT" : "❌ MISSING"}`);
console.log(`- SUPABASE_URL: ${config.SUPABASE.URL ? "✅ PRESENT" : "❌ MISSING"}`);
console.log(`- SUPABASE_KEY: ${config.SUPABASE.KEY ? "✅ PRESENT" : "❌ MISSING"}`);

const app = express();
const PORT = config.PORT;

// Renderのスリープ回避用のエンドポイント
app.get('/', (req, res) => {
  res.send('XENOGRAM Analytics Bot is running.');
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
  
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
const { sendErrorEmbed } = require('./services/discord');

process.on('uncaughtException', async (error) => {
  console.error('Uncaught Exception:', error);
  await sendErrorEmbed(error, "🚨 Uncaught Exception");
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  await sendErrorEmbed(reason, "🚨 Unhandled Rejection");
});
