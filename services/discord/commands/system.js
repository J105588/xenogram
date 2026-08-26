const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');
const config = require('../../../config');

const LOG_DIR = path.join(__dirname, '..', '..', '..', 'logs');
// Discordメッセージ本文の上限(2000文字)に対し、コードブロックの記号分を差し引いた安全マージン
const INLINE_LIMIT = 1800;

function tailFile(filePath, maxLines) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.slice(-maxLines);
}

/**
 * /logs はPM2の生ログをそのままDiscordへ転送する。将来どこかで
 * console.error(error)のようにaxiosのエラーオブジェクト全体（リクエストヘッダ含む）
 * 等を出力してしまった場合に備え、既知の機密値（Botトークン・Xのセッションcookie）が
 * 万一ログ中に含まれていても、送信前に必ずマスクする最後の砦として入れておく。
 */
function redactSecrets(text) {
  const secrets = [config.DISCORD.TOKEN, config.TWITTER_MONITOR.CT0, config.TWITTER_MONITOR.AUTH_TOKEN]
    .filter((v) => typeof v === 'string' && v.length >= 8);
  return secrets.reduce((acc, secret) => acc.split(secret).join('[REDACTED]'), text);
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

  const combined = redactSecrets([
    errLines.length ? `--- エラーログ（直近${errLines.length}行） ---\n${errLines.join('\n')}` : null,
    outLines.length ? `--- 通常ログ（直近${outLines.length}行） ---\n${outLines.join('\n')}` : null,
  ].filter(Boolean).join('\n\n'));

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
 *
 * 以前は process.kill(process.pid, 'SIGTERM') でindex.jsのSIGTERMハンドラに
 * 処理を委ねていたが、Windows環境では process.kill() によるSIGTERM送信は
 * シグナルハンドラを経由せずプロセスを無条件に強制終了するため、そのハンドラは
 * 一度も実行されていなかった（停止通知が届かず、Chromiumの後片付けも行われないまま
 * 強制終了していたことをログで確認済み）。同じプロセス内から呼び出すだけなので
 * シグナル送信は不要と判断し、services/shutdown.js の関数を直接呼び出す。
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

  // 上のeditReplyがDiscordに届いた後で呼び出す
  const { gracefulShutdown } = require('../../shutdown');
  gracefulShutdown('/restart');
}

module.exports = { logs, restart };
