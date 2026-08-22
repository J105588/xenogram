/**
 * スクリーンショット単体テスト（Discord/DBには触れない）
 *
 *   node test/vocacolle_screenshot_test.js            … ランキング1位を撮影
 *   node test/vocacolle_screenshot_test.js sm45966776 … 指定した動画のカードを撮影
 *
 * 実際に Chromium を起動するので、実行前に環境の許可を得ること。
 * 出力先: test/output/vocacolle_<watchId>.png
 */
process.env.TZ = 'Asia/Tokyo';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const vocacolle = require('../services/vocacolle');
const screenshot = require('../services/screenshot');

async function main() {
  let watchId = process.argv[2];

  if (!watchId) {
    const ranking = await vocacolle.fetchRanking(config.VOCACOLLE.RANKING_URL);
    if (!ranking.items.length) throw new Error('ランキングが空でした');
    watchId = ranking.items[0].watchId;
    console.log(`対象: ${ranking.items[0].rank}位 ${ranking.items[0].title} (${watchId})`);
  }

  const startedAt = Date.now();
  const shots = await screenshot.captureRankingEntries({
    url: config.VOCACOLLE.RANKING_URL,
    watchIds: [watchId],
  });

  const shot = shots.get(watchId);
  if (!shot) {
    console.error('スクリーンショットの取得に失敗しました');
    process.exit(1);
  }

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `vocacolle_${watchId}.png`);
  fs.writeFileSync(outPath, shot.buffer);

  console.log(`mode=${shot.mode} size=${(shot.buffer.length / 1024).toFixed(1)}KB time=${Date.now() - startedAt}ms`);
  console.log(`保存先: ${outPath}`);
}

main().catch((error) => {
  console.error('テストに失敗しました:', error);
  process.exit(1);
});
