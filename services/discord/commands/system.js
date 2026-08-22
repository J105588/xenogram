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

module.exports = { logs };
