const config = require('../config');

// puppeteer は読み込みが重いので、実際に起動が必要になるまで require しない
let puppeteer = null;
function getPuppeteer() {
  if (!puppeteer) puppeteer = require('puppeteer');
  return puppeteer;
}

// コンテナ/低メモリ環境（Render, Fly.io, Docker 等）で安定させるための起動オプション
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  '--no-zygote',
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

module.exports = { launchBrowser };
