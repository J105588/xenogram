const { sendErrorEmbed } = require('./client');

const handlers = {
  ...require('./commands/misc'),
  ...require('./commands/videos'),
  ...require('./commands/vocacolle'),
};

/**
 * client の interactionCreate を、コマンド名に対応するハンドラへ振り分ける。
 * 各ハンドラは (interaction, { client }) => Promise<void> の形。
 */
function attachInteractionHandler(client) {
  client.on('interactionCreate', async (interaction) => {
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
