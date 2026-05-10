const express = require('express');
const axios = require('axios');
const config = require('./config');
const { startDiscordBot } = require('./services/discord');
const { startScheduler } = require('./services/scheduler');

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

  // 13分に1回、自分自身にアクセスしてRenderのスリープを回避
  setInterval(() => {
    if (config.RENDER_EXTERNAL_URL) {
      axios.get(config.RENDER_EXTERNAL_URL)
        .then(() => console.log('Self-ping successful.'))
        .catch(err => console.error('Self-ping failed:', err.message));
    }
  }, 13 * 60 * 1000); // 13分
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
