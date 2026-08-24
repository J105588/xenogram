// X（旧Twitter）を読み取り専用で扱うための twitter-openapi-typescript ラッパー。
// https://github.com/fa0311/twitter-openapi-typescript
//
// 重要: このモジュールはツイートの「検索」だけを行い、投稿・返信・いいね等の
// 書き込み系APIは一切呼び出さない（呼び出す関数自体を用意していない）。
//
// 以前は外部CLI（twitter-cli）を子プロセスとして呼んでいたが、Xの新しいbot対策
// （x-client-transaction-idヘッダ）に未対応で検索が失敗するようになったため、
// このヘッダを自動生成できる本ライブラリに移行した（2026-08）。
// 公式APIキーではなくブラウザCookie（ct0 / auth_token）で動く非公式ライブラリのため、
// 未設定の環境では動かない。呼び出し側は必ず isConfigured() で事前確認するか、
// エラーを個別にハンドリングすること。
const config = require('../config');

// クライアントの生成は軽くない（ヘッダ定義・transaction ID生成用データを
// 外部から取得する）ため、プロセス内で使い回す。生成に失敗した場合は
// 次回呼び出し時にやり直せるよう、失敗したPromiseはキャッシュしない。
let clientPromise = null;

function fetchWithTimeout(input, init) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(config.TWITTER_MONITOR.FETCH_TIMEOUT_MS) });
}

async function createClient() {
  const { TwitterOpenApi } = require('twitter-openapi-typescript');
  TwitterOpenApi.fetchApi = fetchWithTimeout;

  const api = new TwitterOpenApi();
  return api.getClientFromCookies({
    ct0: config.TWITTER_MONITOR.CT0,
    auth_token: config.TWITTER_MONITOR.AUTH_TOKEN,
  });
}

function getClient() {
  if (!clientPromise) {
    clientPromise = createClient().catch((err) => {
      clientPromise = null; // 失敗はキャッシュしない（次回呼び出しで再試行させる）
      throw err;
    });
  }
  return clientPromise;
}

/**
 * 検索に必要な認証情報（Cookie）が設定されているか。
 * ログインが実際に有効かまでは保証しない（それは実際の検索が失敗するかで分かる）。
 */
function isConfigured() {
  return !!(config.TWITTER_MONITOR.CT0 && config.TWITTER_MONITOR.AUTH_TOKEN);
}

/**
 * 検索結果1件ぶんを、DB保存・Discord通知で使う共通の形に正規化する。
 * id が取れない行は捨てる（DBの重複防止キーとして必須のため）。
 */
function normalizeTweet(entry) {
  const tweet = entry && entry.tweet;
  if (!tweet || !tweet.restId || !tweet.legacy) return null;

  const user = entry.user;
  // screenNameの置き場所はXのGraphQLスキーマ移行途中で core/legacy に分かれている
  // （実機確認: 現在は user.core.screenName。将来また変わる可能性があるので両方見る）
  const author = (user && ((user.core && user.core.screenName) || (user.legacy && user.legacy.screenName))) || null;
  const createdAt = tweet.legacy.createdAt ? new Date(tweet.legacy.createdAt).toISOString() : null;
  const url = author
    ? `https://x.com/${author}/status/${tweet.restId}`
    : `https://x.com/i/status/${tweet.restId}`;

  return {
    id: String(tweet.restId),
    author,
    text: String(tweet.legacy.fullText || ''),
    createdAt,
    url,
  };
}

/**
 * キーワード（検索クエリ）でツイートを検索する（読み取りのみ）。
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<Array<{id: string, author: string|null, text: string, createdAt: string|null, url: string}>>}
 */
async function searchTweets(query, maxResults = 20) {
  const client = await getClient();
  const response = await client.getTweetApi().getSearchTimeline({
    rawQuery: query,
    product: 'Latest',
    count: maxResults,
  });

  return (response.data.data || [])
    .slice(0, maxResults)
    .map(normalizeTweet)
    .filter(Boolean);
}

module.exports = { isConfigured, searchTweets };
