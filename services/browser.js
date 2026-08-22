const config = require('../config');

// puppeteer は読み込みが重いので、実際に起動が必要になるまで require しない
let puppeteer = null;
function getPuppeteer() {
  if (!puppeteer) puppeteer = require('puppeteer');
  return puppeteer;
}

// Chromium の起動オプション。
// 以前はRender(512MB)のメモリ超過対策でV8ヒープを192MBに絞る等の制限をかけていたが、
// 自前サーバー運用に移行しメモリ制約が無くなったため、描画品質を優先して外している。
// （--disable-dev-shm-usage 等、環境を問わず安定性に寄与するものは残す）
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--hide-scrollbars',
  '--mute-audio',
  '--lang=ja-JP',
];

async function launchBrowser(options = {}) {
  const opts = {
    headless: true,
    args: LAUNCH_ARGS,
    protocolTimeout: config.SCREENSHOT.TIMEOUT_MS,
    ...options,
  };
  if (config.SCREENSHOT.EXECUTABLE_PATH) {
    opts.executablePath = config.SCREENSHOT.EXECUTABLE_PATH;
  }
  return getPuppeteer().launch(opts);
}

/**
 * ブラウザを確実に終了する。
 * browser.close() が（Renderの遅いCPU等で）ハングすると、
 * 次の呼び出し時に前のChromiumプロセスが残ったまま新しいものが起動し、
 * メモリが積み上がって上限超過（自動再起動）につながる。
 * 一定時間で応答が無ければプロセスを強制終了して確実に解放する。
 */
async function closeBrowserSafely(browser, timeoutMs = 8000) {
  if (!browser) return;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('browser.close() timed out')), timeoutMs)),
    ]);
  } catch (error) {
    console.warn('[BROWSER] close()が完了しなかったため強制終了します:', error.message);
    try {
      const proc = browser.process();
      if (proc && !proc.killed) proc.kill('SIGKILL');
    } catch (killError) {
      console.error('[BROWSER] 強制終了にも失敗しました:', killError.message);
    }
  }
}

/**
 * 起動時に、前回セッションの残骸として残っているChromiumプロセスを掃除する。
 *
 * closeBrowserSafely() は「自分が起動したプロセス」しか閉じられない。
 * PM2の強制終了（kill_timeout超過）やテスト実行の異常終了等でNode本体だけが
 * 落ちた場合、子のChromiumはWindowsでは自動終了せずゾンビとして残り続ける。
 * Bot起動直後（＝まだ自分では何も起動していないタイミング）に一度だけ、
 * Puppeteerのキャッシュから起動されたchrome.exeを（他人のブラウザは巻き込まずに）掃除する。
 */
async function reapOrphanedChromeProcesses() {
  if (process.platform !== 'win32') return 0;

  const { execFile } = require('child_process');
  const marker = require('path').join('.cache', 'puppeteer').toLowerCase();

  const listProcesses = () => new Promise((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) {
        console.warn('[BROWSER] 残留プロセスの調査に失敗しました（スキップします）:', err.message);
        return resolve([]);
      }
      try {
        const parsed = JSON.parse(stdout || '[]');
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        resolve([]);
      }
    });
  });

  const processes = await listProcesses();
  // Puppeteerのキャッシュ配下から起動されたものだけを対象にする
  // （ユーザーが普段使っているChromeブラウザのプロファイルは絶対に触らない）
  const targets = processes.filter((p) => p && p.CommandLine && p.CommandLine.toLowerCase().includes(marker));
  if (!targets.length) return 0;

  await Promise.all(targets.map((p) => new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { windowsHide: true }, () => resolve());
  })));

  console.log(`[BROWSER] 起動時クリーンアップ: 残留Chromiumプロセスを${targets.length}件終了しました`);
  return targets.length;
}

module.exports = { launchBrowser, closeBrowserSafely, reapOrphanedChromeProcesses };
