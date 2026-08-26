const config = require('../config');
const { launchBrowser, closeBrowserSafely } = require('./browser');

const HIGHLIGHT_COLOR = '#3498db';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// vocacolleWatchのロックは鯖ごとに分かれているため、複数の鯖のチェックが
// 同時にヒットするとここへ同時に呼び出しが来うる。Chromiumは重いので、
// プロセス全体としては常に1本ずつ順番に起動する（キューイング）。
let browserQueueTail = Promise.resolve();
function runExclusive(fn) {
  const run = browserQueueTail.then(fn);
  browserQueueTail = run.catch(() => {});
  return run;
}

/**
 * 同意ダイアログ等が出ていれば閉じる（出ていなければ何もしない）
 */
async function dismissOverlays(page) {
  try {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const labels = ['同意', '閉じる', 'OK', '許可しない', 'close'];
      document.querySelectorAll('button, [role="button"]').forEach((el) => {
        const text = (el.textContent || '').trim();
        if (labels.includes(text)) el.click();
      });
    });
  } catch (_) {
    // ダイアログ処理は best-effort。失敗しても撮影は続行する
  }
}

/**
 * ページ内で対象動画のカードを探し、強調表示したうえで切り出す範囲を返す。
 * 見つからなければ null（＝ビューポート全体を撮る）。
 */
function locateAndHighlight(page, watchId, highlightColor) {
  return page.evaluate(
    (targetId, color) => {
      // 前回の強調表示を消す
      document.querySelectorAll('[data-xenogram-highlight]').forEach((el) => {
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.removeAttribute('data-xenogram-highlight');
      });

      // includes()による部分一致だと、一方のIDがもう一方の前方一致になる場合
      // （例: sm123456 と sm1234567）に誤ったカードを強調してしまうため、
      // /watch/ 直後のIDセグメントを取り出して完全一致で比較する。
      const anchor = [...document.querySelectorAll('a[href]')].find((a) => {
        const match = a.href.match(/\/watch\/([^/?#]+)/);
        return !!match && match[1] === targetId;
      });
      if (!anchor) return null;

      // リンクから親をたどり、「このカード1枚だけ」を包む要素を探す。
      // カード内には（サムネ用・タイトル用など）複数のリンクが同居することがあるため
      // リンク数では判定できない。代わりに面積の伸び方を見る: 親に上がっても
      // 面積がほぼ変わらない間はまだ同じカードの内側（ラッパーdiv等）とみなして登り続け、
      // 面積が急に何倍にも増えたら、そこは複数カードを束ねた行/グリッドなので
      // 一段手前（増える直前の要素）で止める。
      let card = anchor;
      for (let i = 0; i < 8; i += 1) {
        const parent = card.parentElement;
        if (!parent) break;
        const curBox = card.getBoundingClientRect();
        const parentBox = parent.getBoundingClientRect();
        const curArea = Math.max(curBox.width * curBox.height, 1);
        const parentArea = Math.max(parentBox.width * parentBox.height, 1);
        if (parentArea > curArea * 4) break;
        card = parent;
      }

      card.scrollIntoView({ block: 'center' });
      card.style.outline = `4px solid ${color}`;
      card.style.outlineOffset = '2px';
      card.setAttribute('data-xenogram-highlight', '1');

      const box = card.getBoundingClientRect();
      const pad = 16;
      // page.screenshot の clip はビューポートではなくページ全体（ドキュメント）基準の
      // 座標を取るため、getBoundingClientRect（ビューポート基準）に現在のスクロール量を足す
      return {
        x: Math.max(0, Math.floor(box.left + window.scrollX - pad)),
        y: Math.max(0, Math.floor(box.top + window.scrollY - pad)),
        width: Math.ceil(box.width + pad * 2),
        height: Math.ceil(box.height + pad * 2),
      };
    },
    watchId,
    highlightColor
  );
}

/**
 * ランキングページを開き、指定した動画のカードを強調してスクリーンショットを撮る。
 * 複数指定してもブラウザの起動は1回で済ませる（低メモリ環境への配慮）。
 *
 * @param {object} params
 * @param {string} params.url ランキングページURL
 * @param {string[]} params.watchIds 強調したい動画ID（sm...）の配列
 * @returns {Promise<Map<string, {buffer: Buffer, mode: 'entry'|'page'}>>}
 */
async function captureRankingEntries({ url, watchIds = [] }) {
  const results = new Map();

  if (!config.SCREENSHOT.ENABLED) {
    console.warn('[VOCACOLLE] SCREENSHOT_ENABLED=false のためスクリーンショットをスキップします');
    return results;
  }
  if (!watchIds.length) return results;

  await runExclusive(() => captureWithBrowser({ url, watchIds, results }));

  return results;
}

async function captureWithBrowser({ url, watchIds, results }) {
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({
      width: config.SCREENSHOT.VIEWPORT_WIDTH,
      height: config.SCREENSHOT.VIEWPORT_HEIGHT,
      deviceScaleFactor: config.SCREENSHOT.DEVICE_SCALE_FACTOR,
    });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });

    // 'networkidle2' は広告やアクセス解析タグ等の継続的な通信で成立しないことがあり、
    // 低スペック環境（Render等）ではしばしばタイムアウトしてバッチ全体が失敗する。
    // 実際に必要な要素の出現はこの後 waitForSelector で個別に待っているため、
    // ここでは軽い 'domcontentloaded' に留め、失敗しても握りつぶして先へ進める。
    await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: config.SCREENSHOT.TIMEOUT_MS })
      .catch((e) => console.warn('[VOCACOLLE] ページ遷移が完全には終わりませんでした（続行します）:', e.message));
    await dismissOverlays(page);

    // ランキング一覧はクライアント側で描画されるため、動画リンクが出るまで待つ
    // （Render等の低スペック環境では描画自体に時間がかかるため、撮影全体のタイムアウトと揃える）
    await page
      .waitForSelector('a[href*="/watch/"]', { timeout: config.SCREENSHOT.TIMEOUT_MS })
      .catch(() => console.warn('[VOCACOLLE] ランキング一覧のリンクを検出できませんでした'));
    await wait(1500); // 遅延読み込みのサムネイルが表示されるまで少し待つ

    for (const watchId of watchIds) {
      try {
        const clip = await locateAndHighlight(page, watchId, HIGHLIGHT_COLOR);
        const usable = clip && clip.width > 0 && clip.height > 0;
        if (!usable) {
          console.warn(`[VOCACOLLE] ${watchId} のカードが見つからず、表示範囲全体を撮影します`);
        }
        await wait(400); // スクロール位置の確定を待つ

        const buffer = await page.screenshot({ type: 'png', ...(usable ? { clip } : {}) });
        results.set(watchId, { buffer: Buffer.from(buffer), mode: usable ? 'entry' : 'page' });
        console.log(`[VOCACOLLE] スクリーンショット取得 watchId=${watchId} mode=${usable ? 'entry' : 'page'}`);
      } catch (itemError) {
        // 1件失敗しても他の撮影は続ける
        console.error(`[VOCACOLLE] ${watchId} のスクリーンショットに失敗しました:`, itemError.message);
      }
    }
  } catch (error) {
    console.error('[VOCACOLLE] スクリーンショット処理でエラーが発生しました:', error.message);
  } finally {
    await closeBrowserSafely(browser);
  }
}

module.exports = { captureRankingEntries };
