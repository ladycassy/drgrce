import { pgTable, text, integer, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";

export const scrapeJobs = pgTable("scrape_jobs", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  status: text("status").notNull(),
  progress: integer("progress").notNull().default(0),
  totalImages: integer("total_images").notNull().default(0),
  scrapedImages: integer("scraped_images").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at").notNull(),
  completedAt: timestamp("completed_at"),
  config: jsonb("config").notNull(),
}, (table) => ({
  statusIdx: index("scrape_jobs_status_idx").on(table.status),
  startedAtIdx: index("scrape_jobs_started_at_idx").on(table.startedAt),
}));

export const scrapedImages = pgTable("scraped_images", {
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
  
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  jobIdIdx: index("scraped_images_job_id_idx").on(table.jobId),
  imageIdIdx: index("scraped_images_image_id_idx").on(table.imageId),
  imageIdJobIdIdx: index("scraped_images_image_id_job_id_idx").on(table.imageId, table.jobId),
  uniqueJobImage: unique("scraped_images_job_id_image_id_unique").on(table.jobId, table.imageId),
}));
