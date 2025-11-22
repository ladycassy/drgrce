import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;
const isProduction = process.env.NODE_ENV === "production";
const isReplit = process.env.REPL_ID !== undefined;

const usePostgres = databaseUrl && (isProduction || isReplit);

export default usePostgres
  ? defineConfig({
      out: "./migrations",
      schema: "./server/db/schema.ts",
      dialect: "postgresql",
      dbCredentials: {
        url: databaseUrl!,
      },
    })
  : defineConfig({
      out: "./migrations",
      schema: "./server/db/sqlite-schema.ts",
      dialect: "sqlite",
      dbCredentials: {
        url: process.env.SQLITE_DB_PATH || "./data/local.db",
      },
    });
