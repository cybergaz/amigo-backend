import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';

const db_connect = () => {
  if (!process.env.DB_URL) {
    throw new Error("DATABASE_URL is not defined in environment variables");
  }

  return drizzle(process.env.DB_URL);
};

const db = db_connect();

// Verify the connection actually works
db.execute(sql`SELECT 1`)
  .then(() => console.log(`🛢️  DB -> Connected`))
  .catch((err) => {
    console.error(`🛢️  DB -> Connection failed:`, err.message);
    process.exit(1);
  });

export default db;
