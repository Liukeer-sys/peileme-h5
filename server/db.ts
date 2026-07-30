import pg from "pg";
import { getConfig } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export const getPool = () => {
  if (!pool) {
    pool = new Pool({
      connectionString: getConfig().DATABASE_URL,
      max: getConfig().NODE_ENV === "test" ? 4 : 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000
    });
  }
  return pool;
};

export const query = <T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
) => getPool().query<T>(text, values);

export const withTransaction = async <T>(callback: (client: pg.PoolClient) => Promise<T>) => {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const closePool = async () => {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
};
