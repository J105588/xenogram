const axios = require('axios');
const config = require('../config');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 以前はページが裏で叩く nvapi.nicovideo.jp の「nicotop」ランキングAPIを
// ブラウザのネットワーク監視で盗み見て使っていたが、2026-08時点でサイト側の
// 実装が変わり、クライアント側から nvapi へは一切リクエストしなくなった
// （ランキングデータは vocaloid-collection.jp 自身の Next.js データAPIから
// サーバー側で埋め込まれる構成に変更された）。そのため今はブラウザ不要で、
// 下記の Next.js データAPI（/_next/data/{buildId}/ranking/{pageId}.json）を
// 直接叩くだけで取得できる。
//
// buildId はサイトを再デプロイするたびに変わり、HTMLの __NEXT_DATA__ 内に
// 埋め込まれている。これを1回だけ軽量に（ブラウザなしのHTML取得で）解決し、
// 呼び出し側（scheduler.js）にキャッシュしてもらう。
const BUILD_ID_RE = /"buildId":"([^"]+)"/;

// この期間を過ぎたキャッシュ済みbuildIdは、呼び出し側から渡されても信用せず再解決する
// （サイトの再デプロイでbuildIdが変わり、古いIDでは404になるため）
const SOURCE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12時間

function extractPageId(url) {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'unknown';
}

function isSourceFresh(source) {
  if (!source || !source.buildId || !source.resolvedAt) return false;
  const age = Date.now() - new Date(source.resolvedAt).getTime();
  return age >= 0 && age < SOURCE_MAX_AGE_MS;
}

/**
 * ランキングページのHTMLから、Next.jsのbuildIdを取得する。
 * ブラウザは使わない（軽量なHTML取得のみ）。
 *
 * @param {string} url 監視対象ランキングURL
 * @returns {Promise<{buildId: string, resolvedAt: string}>}
 */
async function resolveRankingSource(url, { timeoutMs = 20000 } = {}) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ja-JP,ja;q=0.9',
    },
    timeout: timeoutMs,
  });

  const match = BUILD_ID_RE.exec(response.data);
  if (!match) {
    throw new Error('buildIdの解決に失敗しました（ページ構成が変わった可能性があります）');
  }

  return { buildId: match[1], resolvedAt: new Date().toISOString() };
}

/**
 * vocaloid-collection.jp 自身の Next.js データAPIを直接叩き、最新の順位表を取得する。
 *
 * @param {object} source { buildId }
 * @param {string} pageId ランキングURLの末尾セグメント（例: 'rookie'）
 * @returns {Promise<{title: string, items: Array}>}
 */
async function fetchLiveRanking(source, pageId) {
  const response = await axios.get(
    `https://vocaloid-collection.jp/_next/data/${source.buildId}/ranking/${pageId}.json`,
    {
      params: { id: pageId },
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'ja-JP,ja;q=0.9',
      },
      timeout: config.VOCACOLLE.FETCH_TIMEOUT_MS,
      validateStatus: () => true,
    }
  );

  const rankingData = response.data && response.data.pageProps && response.data.pageProps.localRankingData;
  const rawItems = rankingData && rankingData.data && rankingData.data.items;
  if (response.status !== 200 || !Array.isArray(rawItems)) {
    const err = new Error(`ランキング取得に失敗しました (status=${response.status}, buildId=${source.buildId}, pageId=${pageId})`);
    err.invalidSource = true;
    throw err;
  }

  const items = rawItems.map((entry, index) => {
    const video = entry.video || {};
    const count = video.count || {};
    const owner = video.owner || {};
    const thumbnail = video.thumbnail || {};
    return {
      rank: index + 1,
      watchId: entry.watchId || video.id || null,
      title: video.title || '',
      artist: owner.name || '',
      artistId: owner.id || null,
      view: count.view || 0,
      comment: count.comment || 0,
      mylist: count.mylist || 0,
      like: count.like || 0,
      registeredAt: video.registeredAt || null,
      thumbnail: thumbnail.largeUrl || thumbnail.middleUrl || thumbnail.url || null,
    };
  });

  const title = (rankingData.meta && rankingData.meta.title) || '';
  return { title, items };
}

/**
 * ボカコレのランキングを取得する（毎時の監視で呼ぶメイン関数）。
 *
 * ランキングIDのキャッシュを外部（Supabase）に持たせたい場合は
 * getCachedSource / setCachedSource を渡す。渡さなければ呼び出しのたびに
 * ブラウザでIDを解決する（テスト・単発確認向け）。
 *
 * @param {string} [url] 監視対象ランキングURL
 * @param {object} [options]
 * @param {(pageId: string) => Promise<object|null>} [options.getCachedSource]
 * @param {(pageId: string, source: object) => Promise<void>} [options.setCachedSource]
 * @returns {Promise<{pageId: string, title: string, url: string, items: Array}>}
 */
async function fetchRanking(url = config.VOCACOLLE.RANKING_URL, options = {}) {
  const { getCachedSource, setCachedSource } = options;
  const pageId = extractPageId(url);

  let source = getCachedSource ? await getCachedSource(pageId) : null;
  if (!isSourceFresh(source)) {
    source = await resolveRankingSource(url);
    if (setCachedSource) await setCachedSource(pageId, source);
  }

  let live;
  try {
    live = await fetchLiveRanking(source, pageId);
  } catch (error) {
    if (!error.invalidSource) throw error;
    // キャッシュ済みbuildIdが失効している（サイトの再デプロイ等）ので、一度だけ再解決して再試行する
    console.warn(`[VOCACOLLE] buildId ${source.buildId} が無効でした。再解決します。`);
    source = await resolveRankingSource(url);
    if (setCachedSource) await setCachedSource(pageId, source);
    live = await fetchLiveRanking(source, pageId);
  }

  return { pageId, title: live.title || pageId, url, items: live.items };
}

/**
 * 比較用の正規化。
 * 全角/半角・大文字小文字・空白の揺れだけを吸収し、それ以外は変えない
 * （＝「絶対一致」の判定は保ったまま、入力ミスに強くする）。
 */
function normalize(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFKC')
    .replace(/[\s　]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * ボカロの曲名は「曲名 / 歌い手」「曲名 - 歌い手」のような複合表記が多いため、
 * 区切り文字で分割した各セグメントも完全一致の判定対象にする。
 * （部分一致はしない。あくまで区切られた要素そのものとの一致のみ）
 */
function titleCandidates(title) {
  const normalized = normalize(title);
  if (!normalized) return [];

  const candidates = new Set([normalized]);
  normalized
    .split(/[\/|｜／\-‐‑–—―ー~〜|,、,]|feat\.|ft\./g)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => candidates.add(part));

  // 【】[]（）() で囲まれた装飾を外した形も候補にする
  const stripped = normalized.replace(/[【\[(（][^】\])）]*[】\])）]/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped) candidates.add(stripped);

  return [...candidates];
}

/**
 * キーワードが現在有効期間内かどうか
 */
function isActive(keyword, now = new Date()) {
  if (!keyword.enabled) return false;
  if (keyword.active_from && now < new Date(keyword.active_from)) return false;
  if (keyword.active_until && now > new Date(keyword.active_until)) return false;
  return true;
}

/**
 * ランキング項目 1 件が 1 キーワードにマッチするか（完全一致）
 */
function matchesItem(item, keyword) {
  const target = normalize(keyword.keyword);
  if (!target) return false;

  if (keyword.target === 'artist') {
    return normalize(item.artist) === target;
  }
  return titleCandidates(item.title).includes(target);
}

/**
 * ランキングと有効キーワードを突き合わせ、ヒットした組み合わせを返す
 *
 * @returns {Array<{keyword: object, item: object}>}
 */
function findMatches(ranking, keywords, now = new Date()) {
  const activeKeywords = keywords.filter((k) => isActive(k, now));
  const hits = [];

  for (const keyword of activeKeywords) {
    // page_id が指定されていて、取得したランキングと違う場合はスキップ
    if (keyword.page_id && ranking.pageId !== 'unknown' && keyword.page_id !== ranking.pageId) continue;

    for (const item of ranking.items) {
      if (matchesItem(item, keyword)) {
        hits.push({ keyword, item });
      }
    }
  }
  return hits;
}

module.exports = {
  fetchRanking,
  fetchLiveRanking,
  resolveRankingSource,
  findMatches,
  isActive,
  matchesItem,
  normalize,
  titleCandidates,
};
