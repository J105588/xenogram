const axios = require('axios');
const config = require('../config');
const { launchBrowser, closeBrowserSafely } = require('./browser');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ボカコレのランキングページ自体は Next.js の SSG で、
// HTML に埋め込まれた __NEXT_DATA__ は数時間単位で古いキャッシュを返す
// （ページの Last-Modified を見ると分かる）。実際の最新順位はページが裏で
// 叩いている nvapi.nicovideo.jp の「nicotop」ランキングAPIから取れるため、
// 毎時の監視にはこちらを使う。
//
// ただし nvapi の呼び出しにはボカコレ側の内部ランキングID（例: 329893）が
// 必要で、これはページのHTMLには含まれず、ブラウザがページを描画する際に
// クライアント側のJSが解決してから叩いている。そのIDをネットワーク監視で
// 一度だけ取得し、呼び出し側（scheduler.js）にキャッシュしてもらうことで、
// 通常運転時はブラウザなし・軽量な直接APIコールだけで毎時チェックできる。
const NVAPI_RANKING_RE = /nvapi\.nicovideo\.jp\/v1\/ranking\/nicotop\/(\d+)\?([^"'\s]*)/;
const DEFAULT_FRONTEND_ID = '146';

// この期間を過ぎたキャッシュ済みIDは、呼び出し側から渡されても信用せず再解決する
const SOURCE_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12時間

function extractPageId(url) {
  const segments = new URL(url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'unknown';
}

function isSourceFresh(source) {
  if (!source || !source.rankingId || !source.resolvedAt) return false;
  const age = Date.now() - new Date(source.resolvedAt).getTime();
  return age >= 0 && age < SOURCE_MAX_AGE_MS;
}

/**
 * ランキングページを実際にブラウザで開き、ページ自身が発行する nvapi へのリクエストを
 * 監視して「本物の」ランキングIDを取得する。データ取得そのものはしない
 * （スクリーンショットも撮らない）ので、通常のページ表示より軽い。
 *
 * @param {string} url 監視対象ランキングURL
 * @returns {Promise<{rankingId: string, frontendId: string, resolvedAt: string}>}
 */
async function resolveRankingSource(url, { timeoutMs = 20000 } = {}) {
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    const found = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('ランキングIDの解決がタイムアウトしました（ページ構成が変わった可能性があります）'));
      }, timeoutMs);

      page.on('response', (response) => {
        const match = NVAPI_RANKING_RE.exec(response.url());
        if (!match) return;
        clearTimeout(timer);
        const params = new URLSearchParams(match[2]);
        resolve({
          rankingId: match[1],
          frontendId: params.get('_frontendId') || DEFAULT_FRONTEND_ID,
          resolvedAt: new Date().toISOString(),
        });
      });
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs }).catch(() => {});
    return await found;
  } finally {
    await closeBrowserSafely(browser);
  }
}

/**
 * nvapi の nicotop ランキングAPIを直接叩き、ブラウザなしで最新の順位表を取得する。
 *
 * @param {object} source { rankingId, frontendId }
 * @returns {Promise<{title: string, items: Array}>}
 */
async function fetchLiveRanking(source) {
  const response = await axios.get(`https://nvapi.nicovideo.jp/v1/ranking/nicotop/${source.rankingId}`, {
    params: { _frontendId: source.frontendId || DEFAULT_FRONTEND_ID },
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ja-JP,ja;q=0.9',
    },
    timeout: config.VOCACOLLE.FETCH_TIMEOUT_MS,
    validateStatus: () => true,
  });

  const meta = response.data && response.data.meta;
  if (!meta || meta.status !== 200) {
    const err = new Error(`nvapi ランキング取得に失敗しました (status=${meta && meta.status}, id=${source.rankingId})`);
    err.invalidSource = true;
    throw err;
  }

  const ranking = response.data.data.ranking;
  const items = (ranking.videos || []).map((video, index) => {
    const count = video.count || {};
    const owner = video.owner || {};
    const thumbnail = video.thumbnail || {};
    return {
      rank: index + 1,
      watchId: video.id || null,
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

  return { title: (ranking.setting && ranking.setting.title) || '', items };
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
    live = await fetchLiveRanking(source);
  } catch (error) {
    if (!error.invalidSource) throw error;
    // キャッシュ済みIDが失効している（イベント切り替わり等）ので、一度だけ再解決して再試行する
    console.warn(`[VOCACOLLE] ランキングID ${source.rankingId} が無効でした。再解決します。`);
    source = await resolveRankingSource(url);
    if (setCachedSource) await setCachedSource(pageId, source);
    live = await fetchLiveRanking(source);
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
