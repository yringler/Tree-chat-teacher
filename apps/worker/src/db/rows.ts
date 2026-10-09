// The rows raw SQL reads, typed from schema.ts: keyed by SQL column name
// (`account_id`), the way D1 returns them, so renaming or retyping a column
// breaks every query that reads it at compile time.
import type { Column, Table } from 'drizzle-orm';

/** A column's value as D1 returns it: booleans and timestamps are stored as integers. */
type SqlValue<C extends Column> = C['_']['dataType'] extends 'boolean' | 'date'
  ? number
  : C['_']['data'];

type Columns<T extends Table> = T['_']['columns'];

/**
 * A `SELECT *` row of `T`: every column under its SQL name. Raw queries read
 * a `Pick` of it, plus an inline type for what SQL computes (`COUNT(*) AS n`).
 */
export type SqlRow<T extends Table> = {
  [K in keyof Columns<T> as Columns<T>[K]['_']['name']]: Columns<T>[K]['_']['notNull'] extends true
    ? SqlValue<Columns<T>[K]>
    : SqlValue<Columns<T>[K]> | null;
};
