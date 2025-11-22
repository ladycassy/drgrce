import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { ScrapeConfig } from "../shared/schema";
import * as pgSchema from "./db/schema";
import * as sqliteSchema from "./db/sqlite-schema";

/**
 * Database row type for scrape jobs (PostgreSQL)
 */
export type ScrapeJobRowPg = {
  id: string;
  url: string;
  status: string;
  progress: number;
  totalImages: number;
  scrapedImages: number;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  config: ScrapeConfig;
};

/**
 * Database row type for scrape jobs (SQLite)
 */
export type ScrapeJobRowSqlite = {
  id: string;
  url: string;
  status: string;
  progress: number;
  totalImages: number;
  scrapedImages: number;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  config: ScrapeConfig;
};

/**
 * Unified scrape job row type (works for both databases)
 */
export type ScrapeJobRow = ScrapeJobRowPg | ScrapeJobRowSqlite;

/**
 * Database row type for scraped images (PostgreSQL)
 */
export type ScrapedImageRowPg = {
  id: string;
  jobId: string;
  imageId: string;
  hash: string;
  url: string;
  copyLink: string;
  smartframeId: string;
  thumbnailUrl: string | null;
  titleField: string | null;
  subjectField: string | null;
  tags: string | null;
  comments: string | null;
  authors: string | null;
  dateTaken: string | null;
  copyright: string | null;
  createdAt: Date;
};

/**
 * Database row type for scraped images (SQLite)
 */
export type ScrapedImageRowSqlite = {
  id: string;
  jobId: string;
  imageId: string;
  hash: string;
  url: string;
  copyLink: string;
  smartframeId: string;
  thumbnailUrl: string | null;
  titleField: string | null;
  subjectField: string | null;
  tags: string | null;
  comments: string | null;
  authors: string | null;
  dateTaken: string | null;
  copyright: string | null;
  createdAt: Date;
};

/**
 * Unified scraped image row type (works for both databases)
 */
export type ScrapedImageRow = ScrapedImageRowPg | ScrapedImageRowSqlite;

/**
 * Typed Drizzle database client for PostgreSQL
 */
export type PostgresDatabaseClient = NodePgDatabase<typeof pgSchema>;

/**
 * Typed Drizzle database client for SQLite
 */
export type SqliteDatabaseClient = BetterSQLite3Database<typeof sqliteSchema>;

/**
 * Union type for database client (supports both PostgreSQL and SQLite)
 */
export type DatabaseClient = PostgresDatabaseClient | SqliteDatabaseClient;

/**
 * SmartFrame metadata interface with known fields and index signature for unmapped fields
 */
export interface SmartframeMetadata {
  title?: string | null;
  caption?: string | null;
  keywords?: string[];
  labelValues?: Array<{
    label: string;
    value: string;
  }>;
  contentPartner?: string | null;
  nextData?: any;
  imageId?: string;
  image_id?: string;
  id?: string;
  [key: string]: unknown; // Index signature for unmapped fields
}

/**
 * Database context discriminated union for type-safe database operations
 */
export type DatabaseContext =
  | {
      type: "postgres";
      db: PostgresDatabaseClient;
      schema: typeof pgSchema;
    }
  | {
      type: "sqlite";
      db: SqliteDatabaseClient;
      schema: typeof sqliteSchema;
    };

/**
 * Scraper configuration loaded from scraper.config.json
 */
export interface ScraperConfig {
  vpn?: {
    enabled: boolean;
    changeAfterFailures: number;
  };
  waitTimes?: {
    scrollDelay: number;
    minVariance: number;
    maxVariance: number;
  };
  scraping?: {
    concurrency: number;
    maxRetryRounds: number;
    retryDelay: number;
    detectEmptyResults: boolean;
    maxConcurrency?: number;
    canvasConcurrency?: number;
    interTabDelayMin?: number;
    interTabDelayMax?: number;
    ensureTabActive?: boolean;
    pageRecreationInterval?: number;
  };
  navigation?: {
    timeout: number;
    waitUntil: string;
    maxConcurrentJobs: number;
  };
  smartframe?: {
    extractFullImages: boolean;
    viewportMode: string;
    headless: boolean;
    enableParallelCanvasExtraction?: boolean;
    renderTimeout: number;
    initialRenderWaitMs?: number;
    postResizeWaitMs?: number;
    maxRenderWaitMs?: number;
    tabActivationIntervalMs?: number;
    jpgQuality?: {
      thumbnail: number;
      full: number;
    };
    minValidFileSize?: number;
    minValidDimensions?: number;
    viewportSizes?: {
      full?: { width: number; height: number };
      thumbnail?: { width: number; height: number };
      large?: { width: number; height: number };
    };
    resizeSteps?: {
      enabled: boolean;
      steps: string[];
      delayBetweenSteps: number;
    };
  };
  metadata?: {
    metadataTimeout?: number;
  };
}
