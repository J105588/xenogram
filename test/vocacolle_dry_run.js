/**
 * ボカコレ監視のドライラン
 *
 *   node test/vocacolle_dry_run.js                 … ランキング上位を表示するだけ
 *   node test/vocacolle_dry_run.js "曲名"          … 曲名の完全一致を判定
 *   node test/vocacolle_dry_run.js artist "投稿者" … アーティスト名の完全一致を判定
 *
 * Discord にもDBにも触れず、スクリーンショットも撮らない。
 * buildIdをキャッシュせず毎回HTMLから解決するため
 * （本番の scheduler.js はDBにキャッシュして再利用する）、少しだけ余計にHTTPを叩く。
 * ブラウザは使わない。
 */
process.env.TZ = 'Asia/Tokyo';

const config = require('../config');
const vocacolle = require('../services/vocacolle');

async function main() {
  const args = process.argv.slice(2);
  const target = args[0] === 'artist' || args[0] === 'title' ? args.shift() : 'title';
  const keyword = args.join(' ');

  const ranking = await vocacolle.fetchRanking(config.VOCACOLLE.RANKING_URL);
  console.log(`取得元: ${config.VOCACOLLE.RANKING_URL}`);
  console.log(`ランキング: ${ranking.title} (pageId=${ranking.pageId}) / ${ranking.items.length}件\n`);

  console.log('--- 上位10件 ---');
  ranking.items.slice(0, 10).forEach((item) => {
    console.log(
      `${String(item.rank).padStart(3)}位  ${item.title}  /  ${item.artist}  (再生 ${item.view.toLocaleString()})`
    );
  });

  if (!keyword) {
    console.log('\nキーワードを引数に渡すと完全一致の判定結果を表示します。');
    return;
  }

  const fakeKeyword = { id: 0, keyword, target, page_id: ranking.pageId, enabled: true };
  const matches = vocacolle.findMatches(ranking, [fakeKeyword]);

  console.log(`\n--- 判定: [${target}] "${keyword}" ---`);
  if (!matches.length) {
    console.log('一致なし');
    return;
  }
  matches.forEach(({ item }) => {
    console.log(`一致: ${item.rank}位  ${item.title}  /  ${item.artist}  (${item.watchId})`);
  });
}

main().catch((error) => {
  console.error('ドライランに失敗しました:', error.message);
  process.exit(1);
});
