import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const scrapeJobs = sqliteTable("scrape_jobs", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  status: text("status").notNull(),
  progress: integer("progress").notNull().default(0),
  totalImages: integer("total_images").notNull().default(0),
  scrapedImages: integer("scraped_images").notNull().default(0),
  error: text("error"),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  config: text("config", { mode: "json" }).notNull(),
}, (table) => ({
  statusIdx: index("scrape_jobs_status_idx").on(table.status),
  startedAtIdx: index("scrape_jobs_started_at_idx").on(table.startedAt),
}));

export const scrapedImages = sqliteTable("scraped_images", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => scrapeJobs.id, { onDelete: "cascade" }),
  imageId: text("image_id").notNull(),
  hash: text("hash").notNull(),
  url: text("url").notNull(),
  copyLink: text("copy_link").notNull(),
  smartframeId: text("smartframe_id").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  
  // The 7 clean metadata fields for CSV export
  titleField: text("title_field"),
  subjectField: text("subject_field"),
  tags: text("tags"),
  comments: text("comments"),
  authors: text("authors"),
  dateTaken: text("date_taken"),
  copyright: text("copyright"),
  
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  jobIdIdx: index("scraped_images_job_id_idx").on(table.jobId),
  imageIdIdx: index("scraped_images_image_id_idx").on(table.imageId),
  imageIdJobIdIdx: index("scraped_images_image_id_job_id_idx").on(table.imageId, table.jobId),
  uniqueJobImage: unique("scraped_images_job_id_image_id_unique").on(table.jobId, table.imageId),
}));
