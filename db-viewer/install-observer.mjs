import pg from 'pg';
import { connection, installObserver } from './database.mjs';
if (process.env.OBSERVER_INSTALL !== 'yes') throw new Error('Требуется OBSERVER_INSTALL=yes после резервного копирования');
const client = new pg.Client(connection);
try {
  await client.connect();
  console.log(`Observer installed: ${await installObserver(client)} tables in ${connection.database}`);
} finally { await client.end(); }
