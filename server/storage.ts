import { ScrapeJob, ScrapedImage, ScrapeConfig } from "@shared/schema";
import { randomUUID } from "crypto";
import { eq, desc } from "drizzle-orm";
import { db, schema, dbType } from "./db/index";
import type { ScrapeJobRow, ScrapedImageRow } from "./types";

/**
 * Helper function to map database image row to DTO
 */
function mapImageRowToDto(img: ScrapedImageRow): ScrapedImage {
  return {
    imageId: img.imageId,
    hash: img.hash,
    url: img.url,
    copyLink: img.copyLink,
    smartframeId: img.smartframeId,
    thumbnailUrl: img.thumbnailUrl,
    titleField: img.titleField,
    subjectField: img.subjectField,
    tags: img.tags,
    comments: img.comments,
    authors: img.authors,
    dateTaken: img.dateTaken,
    copyright: img.copyright,
  };
}

export interface IStorage {
  createScrapeJob(url: string, config: ScrapeConfig): Promise<ScrapeJob>;
  getScrapeJob(id: string): Promise<ScrapeJob | undefined>;
  updateScrapeJob(id: string, updates: Partial<ScrapeJob>): Promise<ScrapeJob | undefined>;
  getAllScrapeJobs(): Promise<ScrapeJob[]>;
}

export class PostgresStorage implements IStorage {
  async createScrapeJob(url: string, config: ScrapeConfig): Promise<ScrapeJob> {
    const id = randomUUID();
    const now = new Date();
    
    // Type assertion needed due to union type of db (PostgreSQL vs SQLite)
    await (db as any).insert(schema.scrapeJobs).values({
      id,
      url,
      status: "pending",
      progress: 0,
      totalImages: 0,
      scrapedImages: 0,
      error: null,
      startedAt: now,
      config,
    });

    return {
      id,
      url,
      status: "pending",
      progress: 0,
      totalImages: 0,
      scrapedImages: 0,
      images: [],
      error: null,
      startedAt: now.toISOString(),
      completedAt: null,
      config,
    };
  }

  async getScrapeJob(id: string): Promise<ScrapeJob | undefined> {
    // Type assertion needed due to union type of db (PostgreSQL vs SQLite)
    const [job] = await (db as any)
      .select()
      .from(schema.scrapeJobs)
      .where(eq(schema.scrapeJobs.id, id));

    if (!job) return undefined;

    const images = await (db as any)
      .select()
      .from(schema.scrapedImages)
      .where(eq(schema.scrapedImages.jobId, id));

    const jobRow = job as ScrapeJobRow;
    const imageRows = (images || []) as ScrapedImageRow[];

    return {
      id: jobRow.id,
      url: jobRow.url,
      status: jobRow.status as "pending" | "scraping" | "completed" | "error",
      progress: jobRow.progress,
      totalImages: jobRow.totalImages,
      scrapedImages: jobRow.scrapedImages,
      images: (imageRows || []).map(mapImageRowToDto),
      error: jobRow.error,
      startedAt: jobRow.startedAt.toISOString(),
      completedAt: jobRow.completedAt?.toISOString() || null,
      config: jobRow.config,
    };
  }

  async updateScrapeJob(id: string, updates: Partial<ScrapeJob>): Promise<ScrapeJob | undefined> {
    const dbUpdates: Partial<{
      status: string;
      progress: number;
      totalImages: number;
      scrapedImages: number;
      error: string | null;
      completedAt: Date | null;
    }> = {};
    
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.progress !== undefined) dbUpdates.progress = updates.progress;
    if (updates.totalImages !== undefined) dbUpdates.totalImages = updates.totalImages;
    if (updates.scrapedImages !== undefined) dbUpdates.scrapedImages = updates.scrapedImages;
    if (updates.error !== undefined) dbUpdates.error = updates.error;
    if (updates.completedAt !== undefined) {
      dbUpdates.completedAt = updates.completedAt ? new Date(updates.completedAt) : null;
    }

    if (Object.keys(dbUpdates).length > 0) {
      // Type assertion needed due to union type of db (PostgreSQL vs SQLite)
      await (db as any)
        .update(schema.scrapeJobs)
        .set(dbUpdates)
        .where(eq(schema.scrapeJobs.id, id));
    }

    if (updates.images && updates.images.length > 0) {
      const imagesToInsert = updates.images.map(img => ({
        id: randomUUID(),
        jobId: id,
        imageId: img.imageId,
        hash: img.hash,
        url: img.url,
        copyLink: img.copyLink,
        smartframeId: img.smartframeId,
        thumbnailUrl: img.thumbnailUrl,
        titleField: img.titleField,
        subjectField: img.subjectField,
        tags: img.tags,
        comments: img.comments,
        authors: img.authors,
        dateTaken: img.dateTaken,
        copyright: img.copyright,
        createdAt: new Date(),
      }));

      // Type assertion needed due to union type of db (PostgreSQL vs SQLite)
      await (db as any).insert(schema.scrapedImages)
        .values(imagesToInsert)
        .onConflictDoNothing({ target: [schema.scrapedImages.jobId, schema.scrapedImages.imageId] });
      
      console.log(`✓ Inserted up to ${updates.images.length} images (duplicates automatically skipped by database)`);
    }

    return this.getScrapeJob(id);
  }

  async getAllScrapeJobs(): Promise<ScrapeJob[]> {
    try {
      // Use LEFT JOIN to fetch all jobs and their images in a single query
      // This eliminates the N+1 query problem
      const result = await (db as any)
        .select()
        .from(schema.scrapeJobs)
        .leftJoin(
          schema.scrapedImages,
          eq(schema.scrapedImages.jobId, schema.scrapeJobs.id)
        )
        .orderBy(desc(schema.scrapeJobs.startedAt));

      if (!result || result.length === 0) {
        return [];
      }

      // Group images by job ID to construct the final result
      const jobsMap = new Map<string, ScrapeJob>();

      for (const row of result) {
        const jobRow = row.scrape_jobs as ScrapeJobRow;
        const imageRow = row.scraped_images as ScrapedImageRow | null;

        // Create job entry if it doesn't exist yet
        if (!jobsMap.has(jobRow.id)) {
          jobsMap.set(jobRow.id, {
            id: jobRow.id,
            url: jobRow.url,
            status: jobRow.status as "pending" | "scraping" | "completed" | "error",
            progress: jobRow.progress,
            totalImages: jobRow.totalImages,
            scrapedImages: jobRow.scrapedImages,
            images: [],
            error: jobRow.error,
            startedAt: jobRow.startedAt.toISOString(),
            completedAt: jobRow.completedAt?.toISOString() || null,
            config: jobRow.config,
          });
        }

        // Add image to job if it exists (LEFT JOIN may return null for jobs without images)
        if (imageRow) {
          jobsMap.get(jobRow.id)!.images.push(mapImageRowToDto(imageRow));
        }
      }

      // Convert map to array, maintaining the order from the query
      return Array.from(jobsMap.values());
    } catch (error) {
      console.error("Error in getAllScrapeJobs (returning empty array):", error);
      return [];
    }
  }
}

export const storage = new PostgresStorage();
