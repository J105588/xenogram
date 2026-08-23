const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

/**
 * SQL文字列リテラルに変換する。null/undefined/空文字は NULL にする。
 * 置換で埋め込む値は .env 由来のID（数字列）だけの想定だが、
 * 万一おかしな値が来てもSQLが壊れないようクォートをエスケープする。
 */
function sqlLiteral(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 未適用のマイグレーションを version 昇順で適用する。
 *
 * これまで supabase/migrations/ にSQLはあったが、実行する仕組みが無く
 * （db.js が CREATE TABLE IF NOT EXISTS を直接叩いていた）、実質死んだ資産だった。
 * スキーマを作り変える変更が必要になったので、適用済みバージョンを記録して
 * 二度流さない、ごく小さなランナーを用意する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Object} substitutions プレースホルダ名 → 値（SQLリテラルとして埋め込む）
 */
function runMigrations(db, substitutions = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const executed = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;

    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const [placeholder, value] of Object.entries(substitutions)) {
      sql = sql.split(placeholder).join(sqlLiteral(value));
    }

    // 未置換のプレースホルダが残ったまま流すと、意味不明なSQLエラーになって
    // 原因が分からなくなる。流す前に弾く。
    const leftover = sql.match(/__[A-Z0-9_]+__/g);
    if (leftover) {
      throw new Error(`マイグレーション ${file} に未置換のプレースホルダが残っています: ${[...new Set(leftover)].join(', ')}`);
    }

    console.log(`[MIGRATE] ${version} を適用します...`);

    // 表を作り直す間は外部キーの検査を止める（PRAGMAはトランザクション内では効かないので外側で行う）
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec('BEGIN;');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
      db.exec('COMMIT;');
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* 既にロールバック済みなら無視 */ }
      throw new Error(`マイグレーション ${file} の適用に失敗しました: ${error.message}`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }

    // 作り直しで参照が壊れていないかを確認する（壊れていても静かに進むのが一番まずい）
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      console.error(`[MIGRATE] ${version} 適用後に外部キー違反が見つかりました:`, violations.slice(0, 10));
    }

    executed.push(version);
    console.log(`[MIGRATE] ${version} を適用しました。`);
  }

  return executed;
}

module.exports = { runMigrations, MIGRATIONS_DIR };
