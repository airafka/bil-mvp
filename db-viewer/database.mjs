import pg from 'pg';
import { attributeNote } from './attribute-notes.mjs';

// PostgreSQL numeric values and timestamps remain lossless strings in the browser.
for (const oid of [20, 1114, 1184, 1082, 1700]) pg.types.setTypeParser(oid, value => value);
export const CHANNEL = 'billing_db_viewer';
export const connection = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5433),
  database: process.env.DB_NAME || 'billing_next',
  user: process.env.DB_USER || 'billing',
  password: process.env.DB_PASSWORD,
  application_name: 'billing-db-viewer',
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
};
export const quote = name => '"' + name.replaceAll('"', '""') + '"';
export class InputError extends Error {}
export const pool = new pg.Pool({ ...connection, max: 4, options: '-c default_transaction_read_only=on' });
pool.on('error', () => console.error('Database pool connection lost'));

export async function read(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function tables(client) {
  return (await client.query(`SELECT c.relname AS name,
    obj_description(c.oid) AS comment,
    EXISTS (SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid=c.oid
      AND tr.tgname='billing_db_viewer_changes' AND tr.tgenabled IN ('O','A')) AS observed
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows;
}

export async function overview() {
  return read(async client => {
    const list = await tables(client);
    const counts = list.length ? (await client.query(list.map(t =>
      `SELECT '${t.name.replaceAll("'", "''")}'::text AS name, count(*)::text AS count FROM public.${quote(t.name)}`
    ).join(' UNION ALL '))).rows : [];
    const countMap = new Map(counts.map(t => [t.name, t.count]));
    return { database: connection.database, schema: 'public', at: new Date().toISOString(),
      tables: list.map(t => ({ ...t, count: countMap.get(t.name) })) };
  });
}

export async function tablePage(params) {
  const name = params.get('name');
  const search = (params.get('search') || '').trim();
  const offset = Number(params.get('offset') || 0);
  const limit = Number(params.get('limit') || 50);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 ||
      ![25, 50, 100].includes(limit) || search.length > 200) throw new InputError('Некорректные параметры страницы');
  return read(async client => {
    if (!(await tables(client)).some(t => t.name === name)) throw new InputError('Таблица не найдена');
    const columns = (await client.query(`SELECT a.attname AS name,
      format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable,
      col_description(a.attrelid,a.attnum) AS comment,
      EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary
        AND a.attnum=ANY(i.indkey)) AS primary
      FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [`public.${quote(name)}`])).rows;
    const foreignKeys = (await client.query(`SELECT c.confrelid::regclass::text AS target,
      array_agg(a.attname::text ORDER BY k.position) AS columns,
      array_agg(af.attname::text ORDER BY k.position) AS target_columns,
      array_agg(EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.confrelid
        AND i.indisunique AND i.indnkeyatts=1 AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indkey[0]=af.attnum) ORDER BY k.position) AS unique_targets
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(source, target, position)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.source
      JOIN pg_attribute af ON af.attrelid=c.confrelid AND af.attnum=k.target
      WHERE c.conrelid=$1::regclass AND c.contype='f'
      GROUP BY c.oid, c.confrelid
      ORDER BY cardinality(c.conkey), c.oid`, [`public.${quote(name)}`])).rows;
    // Prefer the referenced record's own unique key over a shared context field.
    const relations = foreignKeys.flatMap(key => key.columns.map((column, index) => ({
      target: key.target, columns: key.columns, target_columns: key.target_columns,
      column, target_column: key.target_columns[index], target_unique: key.unique_targets[index],
    }))).sort((a, b) => Number(b.target_unique) - Number(a.target_unique) || a.columns.length - b.columns.length);
    const sort = params.get('sort') || '';
    const filterColumns = params.getAll('column'), filterValues = params.getAll('value');
    if (filterColumns.length !== filterValues.length || filterColumns.length > 32) throw new InputError('Некорректный фильтр связи');
    if ((sort && !columns.some(c => c.name === sort)) ||
        filterColumns.some(v => !columns.some(c => c.name === v))) throw new InputError('Неизвестная колонка');
    const values = [];
    const filters = [];
    if (search) {
      values.push('%' + search.replace(/[\\%_]/g, '\\$&') + '%');
      filters.push(`to_jsonb(t)::text ILIKE $${values.length}`);
    }
    for (const [index, filterColumn] of filterColumns.entries()) {
      const filterValue = filterValues[index];
      if (filterValue.length > 200) throw new InputError('Слишком длинное значение');
      values.push(filterValue);
      filters.push(`t.${quote(filterColumn)}::text = $${values.length}`);
    }
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const total = (await client.query(`SELECT count(*)::text AS count FROM public.${quote(name)} t${where}`, values)).rows[0].count;
    const pk = columns.filter(c => c.primary).map(c => `t.${quote(c.name)}`).join(', ');
    const order = sort ? `t.${quote(sort)} ${params.get('direction') === 'asc' ? 'ASC' : 'DESC'} NULLS LAST` : 't.xmin::text::bigint DESC';
    // Text conversion avoids precision loss for BIGINT, numeric, timestamps and JSON numbers.
    const projection = columns.map(c => `t.${quote(c.name)}::text AS ${quote(c.name)}`).join(', ');
    const rows = (await client.query(`SELECT ${projection} FROM public.${quote(name)} t${where}
      ORDER BY ${order}, ${pk || 't.ctid'} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset])).rows;
    return { name, columns: columns.map(column => ({ ...column, note: attributeNote(name, column, relations) })),
      relations, rows, total, offset, limit, at: new Date().toISOString() };
  });
}

export async function installObserver(client) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('CREATE SCHEMA IF NOT EXISTS billing_observer');
    await client.query(`CREATE OR REPLACE FUNCTION billing_observer.notify_change() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        PERFORM pg_notify('${CHANNEL}', json_build_object('table', TG_TABLE_NAME,
          'operation', TG_OP, 'transaction', txid_current()::text)::text);
        RETURN NULL;
      END $$`);
    const list = await tables(client);
    for (const { name } of list) {
      await client.query(`CREATE OR REPLACE TRIGGER billing_db_viewer_changes
        AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.${quote(name)}
        FOR EACH STATEMENT EXECUTE FUNCTION billing_observer.notify_change()`);
    }
    await client.query('COMMIT');
    return list.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
