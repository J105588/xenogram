const { EmbedBuilder } = require('discord.js');
const config = require('../../config');
const dbService = require('../database');
const {
  client, startDiscordBot, sendNotification, broadcastNotification, sendEmbedWithFiles, sendErrorEmbed,
} = require('./client');
const { registerCommands } = require('./definitions');
const { attachInteractionHandler } = require('./router');

/**
 * 起動（PM2によるクラッシュ後の自動復旧を含む）のたびに、
 * Botが今オンラインであることをDiscordに一報する。
 * 個人PC運用ではプロセスが落ちたまま誰も気づかないリスクがあるため。
 *
 * 監視動画数は鯖ごとに違うので、その鯖の本数を入れて鯖ごとに送る。
 */
async function sendStartupNotice() {
  const os = require('os');
  for (const guild of dbService.getActiveGuilds()) {
    const videos = await dbService.getAllVideos(guild.guild_id);
    const embed = new EmbedBuilder()
      .setTitle('🟢 Bot起動しました')
      .setColor(0x2ecc71)
      .addFields(
        { name: 'ホスト', value: os.hostname(), inline: true },
        { name: 'Node.js', value: process.version, inline: true },
        { name: '監視動画数', value: `${videos.length}本`, inline: true }
      )
      .setFooter({ text: config.FOOTER_TEXT })
      .setTimestamp();

    await sendNotification(guild.guild_id, embed);
  }
}

/**
 * Botが今参加している全サーバーを guilds テーブルに登録する。
 * これをしておかないと、Botを入れただけのサーバーはコマンドを一度も
 * 実行するまでDBに存在せず、定期ジョブの対象にならない。
 */
function syncJoinedGuilds() {
  for (const [guildId, guild] of client.guilds.cache) {
    dbService.ensureGuild(guildId, guild.name);
  }
  console.log(`参加中のサーバー ${client.guilds.cache.size}件 を登録しました。`);
}

// discord.js v15で 'ready' が廃止され 'clientReady' に一本化される予定のため、先行して新名称を使う
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  syncJoinedGuilds();

  const totalVideos = dbService.getAllWatchedVideoIds ? (await dbService.getAllWatchedVideoIds()).length : 0;
  client.user.setActivity(`${totalVideos}本の動画を監視中`, { type: 3 });

  await registerCommands();
  await sendStartupNotice();

  // 起動後にスケジューラを組み直す（鯖ごとのcronを張るために、
  // guildsテーブルが埋まってから実行する必要がある）
  require('../scheduler').startScheduler();
});

// 新しくサーバーに追加されたら即座に登録する（コマンド実行を待たずに定期ジョブの対象にする）
client.on('guildCreate', (guild) => {
  dbService.ensureGuild(guild.id, guild.name);
  console.log(`新しいサーバーに参加しました: ${guild.name} (${guild.id})`);
  require('../scheduler').scheduleGuild(guild.id);
});

// サーバーから外されたら、そのサーバーのcronを止める（データは消さない＝再参加で復帰できる）
client.on('guildDelete', (guild) => {
  console.log(`サーバーから外れました: ${guild.name} (${guild.id})`);
  require('../scheduler').unscheduleGuild(guild.id);
});

attachInteractionHandler(client);

module.exports = {
  client, startDiscordBot, sendNotification, broadcastNotification, sendEmbedWithFiles, sendErrorEmbed,
};
