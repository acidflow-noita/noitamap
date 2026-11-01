import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Execute the real D1 migration/SQL with SQLite; all OAuth HTTP stays mocked. */
export function accountDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('workers/noitamap-auth/migrations/0001_linked_accounts.sql', 'utf8'));
  const prepare = (sql: string) => {
    let values: SQLInputValue[] = [];
    return {
      bind(...args: SQLInputValue[]) { values = args; return this; },
      async first(column?: string) {
        const row = sqlite.prepare(sql).get(...values);
        return column ? row?.[column] ?? null : row ?? null;
      },
      async all() { return { results: sqlite.prepare(sql).all(...values), success: true }; },
      async run() { return { success: true, meta: sqlite.prepare(sql).run(...values) }; },
    };
  };
  return {
    sqlite,
    binding: {
      prepare,
      async batch(statements: ReturnType<typeof prepare>[]) {
        sqlite.exec('BEGIN');
        try { const values = []; for (const statement of statements) values.push(await statement.run()); sqlite.exec('COMMIT'); return values; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      },
    },
  };
}
