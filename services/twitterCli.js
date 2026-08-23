// X（旧Twitter）を読み取り専用で扱うための twitter-cli ラッパー。
// https://github.com/public-clis/twitter-cli
//
// 重要: このモジュールはツイートの「取得」だけを行い、投稿・返信・いいね等の
// 書き込み系コマンドは一切呼び出さない（呼び出す関数自体を用意していない）。
//
// twitter-cli はAPIキーではなくブラウザCookie/セッショントークンで動く非公式ツールのため、
// 未インストール・未ログインの環境では動かない。その状態でも他機能に影響が出ないよう、
// 呼び出し側は必ず isCliAvailable() で事前確認するか、エラーを個別にハンドリングすること。
const { execFile } = require('child_process');
const config = require('../config');

function runCli(args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      config.TWITTER_MONITOR.CLI_BIN,
      args,
      {
        timeout: timeoutMs || config.TWITTER_MONITOR.FETCH_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          // twitter-cli はAPIエラー時に非0の終了コードを返すが、stdoutには
          // {"ok": false, "error": {"message": "..."}} という構造化された理由が
          // 書かれていることが多い。拾えるならそちらを使い、ログを分かりやすくする
          // （実際に「Xの新しいbot対策(x-client-transaction-id)にツールが未対応」
          //  というケースをこの形で確認している）。
          let apiMessage = null;
          try {
            const parsed = JSON.parse(stdout);
            if (parsed && parsed.ok === false && parsed.error && parsed.error.message) {
              apiMessage = parsed.error.message;
            }
          } catch (_) {
            // stdoutがJSONでなければ元のexecFileエラーをそのまま使う
          }
          const wrapped = new Error(apiMessage || error.message);
          wrapped.stderrOutput = stderr;
          wrapped.originalError = error;
          return reject(wrapped);
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * twitter-cli が実行可能な状態か（インストール済み・PATHが通っているか）を確認する。
 * ログイン（Cookie）が有効かまでは保証しない（それは実際の検索が失敗するかで分かる）。
 */
async function isCliAvailable() {
  try {
    await runCli(['--version'], { timeoutMs: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 実機（twitter-cli 0.8.5）で確認した実際の形は { ok, schema_version, data: [...] }。
 * 将来のバージョンで多少変わっても拾えるよう、他の代表的なキー名もフォールバックとして試す。
 */
function extractTweetArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of ['data', 'tweets', 'results', 'items']) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [];
}

function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

/**
 * 1件ぶんのツイートを、出力フォーマットの揺れを吸収した共通の形に正規化する。
 * 実機確認済みの形（{id, text, author: {screenName, name, ...}, createdAtISO, ...}）を
 * 優先しつつ、他バージョンでのフィールド名揺れにも best-effort で対応する。
 * id が取れない行は捨てる（DBの重複防止キーとして必須のため）。
 */
function normalizeTweet(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const id = pick(raw, ['id', 'tweet_id', 'id_str']);
  if (!id) return null;

  const user = (raw.author && typeof raw.author === 'object') ? raw.author : (raw.user || {});
  // screenName が実際の @ハンドル（表示名の name とは別物）。ハンドルが取れなければ表示名で妥協する
  const author = pick(user, ['screenName', 'screen_name', 'username', 'handle'])
    || pick(user, ['name'])
    || pick(raw, ['author', 'username']);
  const text = pick(raw, ['text', 'full_text', 'content']) || '';
  const createdAt = pick(raw, ['createdAtISO', 'created_at', 'createdAt', 'date']);
  const url = pick(raw, ['url', 'link']) || (author ? `https://x.com/${author}/status/${id}` : `https://x.com/i/status/${id}`);

  return { id: String(id), author: author ? String(author) : null, text: String(text), createdAt, url };
}

/**
 * キーワード（検索クエリ）でツイートを検索する（読み取りのみ）。
 * @param {string} query
 * @param {number} maxResults
 * @returns {Promise<Array<{id: string, author: string|null, text: string, createdAt: string|null, url: string}>>}
 */
async function searchTweets(query, maxResults = 20) {
  const stdout = await runCli(['search', query, '--json', '--max', String(maxResults)]);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    const err = new Error(`twitter-cli の出力をJSONとして解釈できませんでした: ${e.message}`);
    err.rawOutput = stdout.slice(0, 500);
    throw err;
  }

  return extractTweetArray(parsed).map(normalizeTweet).filter(Boolean);
}

module.exports = { isCliAvailable, searchTweets };
