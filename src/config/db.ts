import { drizzle } from 'drizzle-orm/postgres-js';

const db_connect = () => {
  try {

    if (!process.env.DB_URL) {
      throw new Error("DATABASE_URL is not defined in environment variables");
    }

    const db = drizzle(process.env.DB_URL);

    console.log(
      `[DATABASE] -> Connected ${new Date().toLocaleString()}`
    );
    return db;

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};
const db = db_connect();

export default db;
