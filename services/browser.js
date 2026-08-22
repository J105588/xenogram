const config = require('../config');

// puppeteer は読み込みが重いので、実際に起動が必要になるまで require しない
let puppeteer = null;
function getPuppeteer() {
  if (!puppeteer) puppeteer = require('puppeteer');
  return puppeteer;
}

// コンテナ/低メモリ環境（Render, Fly.io, Docker 等）で安定させるための起動オプション。
// Render無料/最小プラン(512MB)でメモリ超過による自動再起動が発生したため、
// レンダラーのメモリ上限を明示的に絞っている。
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-software-rasterizer',
  '--disable-breakpad', // クラッシュレポート収集を無効化（若干のメモリ節約）
  '--no-first-run',
  '--no-zygote',
  '--hide-scrollbars',
  '--mute-audio',
  '--lang=ja-JP',
  '--js-flags=--max-old-space-size=192', // V8ヒープを192MBに制限
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

module.exports = { launchBrowser, closeBrowserSafely };
