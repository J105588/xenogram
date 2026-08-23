// 同じ処理（cron実行と手動コマンドの衝突など）が同時に2つ走らないようにする共通ロック。
// 例: 毎時のボカコレ監視が実行中に /vc_check を叩かれた場合など。
// キーごとに独立してロックするため、ジョブ間で干渉しない。
const inFlight = new Set();

/**
 * @param {string} key ロックのキー（ジョブ名など）
 * @param {() => Promise<any>} fn 実行本体
 * @returns {Promise<{ok: true, result: any} | {ok: false, reason: 'already_running'}>}
 */
async function withSingleFlight(key, fn) {
  if (inFlight.has(key)) {
    return { ok: false, reason: 'already_running' };
  }
  inFlight.add(key);
  try {
    const result = await fn();
    return { ok: true, result };
  } finally {
    inFlight.delete(key);
  }
}

module.exports = { withSingleFlight };
