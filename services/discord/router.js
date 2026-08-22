const { sendErrorEmbed } = require('./client');

const miscCmds = require('./commands/misc');
const videoCmds = require('./commands/videos');
const vocacolleCmds = require('./commands/vocacolle');
const settingsCmds = require('./commands/settings');
const systemCmds = require('./commands/system');

const handlers = {
  ...miscCmds,
  ...videoCmds,
  ...vocacolleCmds,
  ...settingsCmds,
  ...systemCmds,
};

// video_id/id/user_id等、手打ちしにくいIDを入力補完するオートコンプリート。
// コマンドごとに使うオプションは1つだけなので、コマンド名単位の対応でよい。
const AUTOCOMPLETE = {
  stats: videoCmds.autocompleteVideoId,
  remove: videoCmds.autocompleteVideoId,
  compare: videoCmds.autocompleteVideoId,
  vc_remove: vocacolleCmds.autocompleteKeywordId,
  user_remove: settingsCmds.autocompleteUserId,
  set_schedule: settingsCmds.autocompleteScheduleInput,
};

/**
 * client の interactionCreate を、コマンド名に対応するハンドラへ振り分ける。
 * 各ハンドラは (interaction, { client }) => Promise<void> の形。
 */
function attachInteractionHandler(client) {
  client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
      const autocompleteHandler = AUTOCOMPLETE[interaction.commandName];
      try {
        if (autocompleteHandler) {
          await autocompleteHandler(interaction);
        } else {
          await interaction.respond([]);
        }
      } catch (err) {
        console.error('Autocomplete Error:', err);
        try { await interaction.respond([]); } catch { /* 応答不可なら諦める */ }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;
    const handler = handlers[commandName];

    try {
      await interaction.deferReply();

      if (!handler) {
        await interaction.editReply(`未対応のコマンドです: /${commandName}`);
        return;
      }
      await handler(interaction, { client });
    } catch (err) {
      console.error("Command Error:", err);

      // エラー通知チャンネルにも詳細を送信する
      await sendErrorEmbed(err, `🚨 Command Execution Error (/${commandName})`);

      try {
        const errorMessage = "❌ コマンドの実行中にエラーが発生しました。詳細なログを確認してください。";
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(errorMessage);
        } else {
          await interaction.reply({ content: errorMessage, ephemeral: true });
        }
      } catch (followUpError) {
        console.error("Failed to send error message to user:", followUpError);
      }
    }
  });
}

module.exports = { attachInteractionHandler };
