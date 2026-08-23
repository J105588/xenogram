const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');

const LOG_DIR = path.join(__dirname, '..', '..', '..', 'logs');
// Discordメッセージ本文の上限(2000文字)に対し、コードブロックの記号分を差し引いた安全マージン
const INLINE_LIMIT = 1800;

function tailFile(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(-maxLines);
}

async function logs(interaction) {
  const requested = interaction.options.getInteger('lines') || 40;
  const capped = Math.min(Math.max(requested, 5), 300);
  const type = interaction.options.getString('type') || 'all';

  const errLines = tailFile(path.join(LOG_DIR, 'pm2-error.log'), capped);
  const outLines = type === 'error' ? [] : tailFile(path.join(LOG_DIR, 'pm2-out.log'), capped);

  if (!errLines.length && !outLines.length) {
    return await interaction.editReply('ログファイルが見つからないか、まだ何も出力されていません（PM2運用時のみ利用できます）。');
  }

  const combined = [
    errLines.length ? `--- エラーログ（直近${errLines.length}行） ---\n${errLines.join('\n')}` : null,
    outLines.length ? `--- 通常ログ（直近${outLines.length}行） ---\n${outLines.join('\n')}` : null,
  ].filter(Boolean).join('\n\n');

  if (combined.length <= INLINE_LIMIT) {
    await interaction.editReply(`\`\`\`\n${combined}\n\`\`\``);
    return;
  }

  const buffer = Buffer.from(combined, 'utf8');
  const file = new AttachmentBuilder(buffer, { name: `xenogram-logs-${Date.now()}.txt` });
  await interaction.editReply({ content: `ログが長いためファイルで送信します（直近${capped}行）。`, files: [file] });
}

/**
 * Botプロセスを再起動する。
 * 自前でprocess.exit()するのではなく、index.jsに既に登録されているSIGTERMハンドラ
 * （gracefulShutdown）にそのまま処理を委ねる（停止通知の送信→終了、という流れを再利用する）。
 * PM2のautorestart（ecosystem.config.js）が終了を検知して自動的に再起動し、
 * 起動完了時には別途「🟢 Bot起動しました」通知が届く。
 *
 * PM2管理下でない場合（`node index.js` を直接起動している等）は、終了後に誰も
 * 再起動してくれず、そのままBotがオフラインになってしまうため安全のため拒否する。
 */
async function restart(interaction) {
  const runningUnderPm2 = process.env.pm_id !== undefined;

  if (!runningUnderPm2) {
    return await interaction.editReply(
      '⚠️ PM2管理下で起動していないようです（`pm_id` が見つかりません）。\n' +
      'この状態で再起動すると、プロセス終了後に誰かが手動で起動し直すまでBotはオフラインのままになります。\n' +
      '安全のため今回は再起動を中止しました。`pm2 start ecosystem.config.js` で起動してから改めてお試しください。'
    );
  }

  await interaction.editReply('🔄 再起動します。数秒後にBotが再度オンラインになります（起動完了時にも通知が届きます）。');
  console.log(`[SYSTEM] /restart によりBotを再起動します（実行者: ${interaction.user.tag}）`);

  // 上のeditReplyがDiscordに届いた後でシグナルを送る
  process.kill(process.pid, 'SIGTERM');
}

module.exports = { logs, restart };
