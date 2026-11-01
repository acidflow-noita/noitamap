import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type {
  Database,
  Statement,
} from "../../workers/noitamap-guessr/src/index";

/** Actual SQLite schema/triggers, with the small D1 statement interface. */
export function gameDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync("workers/noitamap-guessr/migrations/0001_game.sql", "utf8"),
  );
  sqlite.exec(readFileSync("workers/noitamap-guessr/migrations/0003_daily_image_sets.sql", "utf8"));
  sqlite.exec(readFileSync("workers/noitamap-guessr/migrations/0004_ten_rounds.sql", "utf8"));
  let calls = 0;
  function prepare(sql: string, args: unknown[] = []): Statement {
    return {
      bind(...values) {
        return prepare(sql, values);
      },
      async first<T>() {
        calls++;
        return (sqlite.prepare(sql).get(...(args as any[])) ??
          null) as T | null;
      },
      async all<T>() {
        calls++;
        return { results: sqlite.prepare(sql).all(...(args as any[])) as T[] };
      },
      async run() {
        calls++;
        return sqlite.prepare(sql).run(...(args as any[]));
      },
    };
  }
  const db: Database = {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, sqlite, calls: () => calls, close: () => sqlite.close() };
}
