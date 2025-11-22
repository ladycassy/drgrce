import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { neonConfig, Pool } from "@neondatabase/serverless";
import Database from "better-sqlite3";
import ws from "ws";
import * as pgSchema from "./schema";
import * as sqliteSchema from "./sqlite-schema";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import { fileURLToPath } from "url";
import type { DatabaseClient, PostgresDatabaseClient, SqliteDatabaseClient } from "../types";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isProduction = process.env.NODE_ENV === "production";
const isReplit = process.env.REPL_ID !== undefined;
const databaseUrl = process.env.DATABASE_URL;

// Use PostgreSQL in Replit or production, SQLite for local development
const usePostgres = databaseUrl && (isProduction || isReplit);

let db: DatabaseClient;
let schema: typeof pgSchema | typeof sqliteSchema;

if (usePostgres) {
  console.log("📊 Using PostgreSQL database");
  neonConfig.webSocketConstructor = ws;
  const pool = new Pool({ connectionString: databaseUrl! });
  db = drizzleNeon(pool, { schema: pgSchema }) as unknown as PostgresDatabaseClient;
  schema = pgSchema;
} else {
  console.log("📊 Using SQLite database (local development)");
  
  // Create data directory if it doesn't exist
  const dbPath = process.env.SQLITE_DB_PATH || "./data/local.db";
  const dbDir = dirname(dbPath);
  
  try {
    await mkdir(dbDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, that's fine
  }
  
  const sqlite = new Database(dbPath);
  db = drizzleSqlite(sqlite, { schema: sqliteSchema });
  schema = sqliteSchema;
  
  // Auto-create tables for SQLite
  console.log("🔨 Initializing SQLite database tables...");
  
  // Create tables if they don't exist
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS scrape_jobs (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        total_images INTEGER NOT NULL DEFAULT 0,
        scraped_images INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        config TEXT NOT NULL
      );
      
      CREATE INDEX IF NOT EXISTS scrape_jobs_status_idx ON scrape_jobs(status);
      CREATE INDEX IF NOT EXISTS scrape_jobs_started_at_idx ON scrape_jobs(started_at);
      
      CREATE TABLE IF NOT EXISTS scraped_images (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        image_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        url TEXT NOT NULL,
        copy_link TEXT NOT NULL,
        smartframe_id TEXT NOT NULL,
        thumbnail_url TEXT,
        title_field TEXT,
        subject_field TEXT,
        tags TEXT,
        comments TEXT,
        authors TEXT,
        date_taken TEXT,
        copyright TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (job_id) REFERENCES scrape_jobs(id) ON DELETE CASCADE,
        UNIQUE(job_id, image_id)
      );
      
      CREATE INDEX IF NOT EXISTS scraped_images_job_id_idx ON scraped_images(job_id);
      CREATE INDEX IF NOT EXISTS scraped_images_image_id_idx ON scraped_images(image_id);
      CREATE INDEX IF NOT EXISTS scraped_images_image_id_job_id_idx ON scraped_images(image_id, job_id);
    `);
  } catch (error) {
    console.error("❌ Failed to create SQLite database tables");
    console.error("Error details:", error);
    
    if (error instanceof Error) {
      if (error.message.includes("SQLITE_CANTOPEN") || error.message.includes("unable to open")) {
        console.error("💡 Possible causes:");
        console.error("   - Insufficient permissions to create/access the database file");
        console.error("   - Database path directory does not exist or is not writable");
        console.error("   - Database path:", dbPath);
      } else if (error.message.includes("SQLITE_FULL") || error.message.includes("disk")) {
        console.error("💡 Possible cause: Insufficient disk space");
      } else if (error.message.includes("SQLITE_CORRUPT") || error.message.includes("malformed")) {
        console.error("💡 Possible cause: Database file is corrupted");
        console.error("   - Try deleting the database file and restarting:", dbPath);
      } else {
        console.error("💡 Database initialization failed with an unexpected error");
      }
    }
    
    console.error("🛑 Application cannot start without a valid database. Exiting...");
    process.exit(1);
  }
  
  // Migration: Update schema if needed (for existing databases with old schema)
  try {
    const checkQuery = sqlite.prepare(`
      SELECT sql FROM sqlite_master 
      WHERE type='table' AND name='scraped_images'
    `);
    const tableInfo = checkQuery.get() as { sql: string } | undefined;
    
    // If table exists with old schema (has 'photographer' or 'caption' columns), migrate it
    if (tableInfo && (tableInfo.sql.includes('photographer') || tableInfo.sql.includes('caption'))) {
      console.log("🔄 Migrating existing database to new clean metadata schema...");
      
      // Drop old table and recreate with new schema
      sqlite.exec(`
        DROP TABLE IF EXISTS scraped_images;
        
        CREATE TABLE scraped_images (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          image_id TEXT NOT NULL,
          hash TEXT NOT NULL,
          url TEXT NOT NULL,
          copy_link TEXT NOT NULL,
          smartframe_id TEXT NOT NULL,
          thumbnail_url TEXT,
          title_field TEXT,
          subject_field TEXT,
          tags TEXT,
          comments TEXT,
          authors TEXT,
          date_taken TEXT,
          copyright TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (job_id) REFERENCES scrape_jobs(id) ON DELETE CASCADE,
          UNIQUE(job_id, image_id)
        );
        
        CREATE INDEX scraped_images_job_id_idx ON scraped_images(job_id);
        CREATE INDEX scraped_images_image_id_idx ON scraped_images(image_id);
        CREATE INDEX scraped_images_image_id_job_id_idx ON scraped_images(image_id, job_id);
      `);
      
      console.log("✅ Migration complete - updated to clean metadata schema");
    }
  } catch (error) {
    console.error("Migration warning:", error);
    // Continue anyway - table might be new
  }
  
  console.log("✅ SQLite database ready");
}

export { db, schema };
export const dbType = usePostgres ? "postgres" : "sqlite";
