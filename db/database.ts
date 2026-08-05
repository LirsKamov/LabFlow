/**
 * 数据库单例模块。
 *
 * 背景：expo-sqlite 中 PRAGMA foreign_keys 是【每连接作用域】的设置，
 * 项目原有 40+ 处 openDatabaseAsync 每次都打开新连接，导致外键约束每次
 * 新建连接时都被重置为关闭状态，外键关联无法生效。
 *
 * 解决方案：本模块持有唯一的数据库连接 Promise（getDb 幂等），并在打开时
 * 显式开启 PRAGMA foreign_keys = ON 与 WAL 日志模式。
 *
 * 后续基建 Worker 将把项目内 40+ 处 openDatabaseAsync("labflow.db") 统一
 * 替换为 getDb()，所有调用方一律通过本模块访问数据库。
 *
 * 注意：expo-sqlite 的 withTransactionAsync 回调不返回值，必须使用闭包
 * 变量传递事务结果（见 withTransaction 实现）。
 */
import * as SQLite from "expo-sqlite";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("labflow.db");
      await db.execAsync("PRAGMA foreign_keys = ON;");
      await db.execAsync("PRAGMA journal_mode = WAL;");
      return db;
    })();
  }
  return dbPromise;
}

export async function withTransaction<T>(
  fn: (db: SQLite.SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  let result!: T;
  await db.withTransactionAsync(async () => {
    result = await fn(db);
  });
  return result;
}
