const { EmbedBuilder } = require('discord.js');
const config = require('../../config');
const dbService = require('../database');
const { client, startDiscordBot, sendNotification, sendEmbedWithFiles, sendErrorEmbed } = require('./client');
const { registerCommands } = require('./definitions');
const { attachInteractionHandler } = require('./router');

/**
 * 起動（PM2によるクラッシュ後の自動復旧を含む）のたびに、
 * Botが今オンラインであることをDiscordに一報する。
 * 個人PC運用ではプロセスが落ちたまま誰も気づかないリスクがあるため。
 */
async function sendStartupNotice(videoCount) {
  const os = require('os');
  const embed = new EmbedBuilder()
    .setTitle('🟢 Bot起動しました')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'ホスト', value: os.hostname(), inline: true },
      { name: 'Node.js', value: process.version, inline: true },
      { name: '監視動画数', value: `${videoCount}本`, inline: true }
    )
    .setFooter({ text: config.FOOTER_TEXT })
    .setTimestamp();

  await sendNotification(embed);
}

// discord.js v15で 'ready' が廃止され 'clientReady' に一本化される予定のため、先行して新名称を使う
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  const videos = await dbService.getAllVideos();
  client.user.setActivity(`${videos.length}本の動画を監視中`, { type: 3 });
  await registerCommands();
  await sendStartupNotice(videos.length);
});

attachInteractionHandler(client);

module.exports = { client, startDiscordBot, sendNotification, sendEmbedWithFiles, sendErrorEmbed };
