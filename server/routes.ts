import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { scraper } from "./scraper";
import { scrapeRateLimiter } from "./rate-limiter";
import { scrapeConfigSchema } from "@shared/schema";
import { stringify } from "csv-stringify/sync";

/**
 * Helper to get error message from unknown error
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/scrape/bulk", async (req, res) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || "unknown";
      
      if (!scrapeRateLimiter.isAllowed(clientIp)) {
        const remainingTime = Math.ceil(scrapeRateLimiter.getRemainingTime(clientIp) / 1000);
        return res.status(429).json({
          error: "Too many requests. Please try again later.",
          retryAfter: remainingTime,
        });
      }

      const { urls } = req.body;

      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: "URLs array is required" });
      }

      const invalidUrls = urls.filter((url: string) => !url.includes("smartframe.com"));
      if (invalidUrls.length > 0) {
        return res.status(400).json({ error: "All URLs must be from smartframe.com" });
      }

      // Deduplicate URLs to avoid scraping the same content multiple times
      const uniqueUrls = [...new Set(urls)];
      const duplicateCount = urls.length - uniqueUrls.length;
      
      if (duplicateCount > 0) {
        console.log(`Removed ${duplicateCount} duplicate URL(s) from bulk request. Processing ${uniqueUrls.length} unique URLs.`);
      }

      if (uniqueUrls.length > 50) {
        return res.status(400).json({ error: "Maximum 50 URLs allowed per bulk request" });
      }

      const jobs = [];
      
      for (const url of uniqueUrls) {
        const config = scrapeConfigSchema.parse({
          url,
          maxImages: req.body.maxImages !== undefined ? req.body.maxImages : 0,
          extractDetails: req.body.extractDetails !== false,
          sortBy: req.body.sortBy || "relevance",
          autoScroll: req.body.autoScroll !== false,
          scrollDelay: req.body.scrollDelay || 1000,
          concurrency: req.body.concurrency || 5,
          canvasExtraction: req.body.canvasExtraction || "none",
        });

        const job = await storage.createScrapeJob(url, config);
        jobs.push({ jobId: job.id, url });

        scraper.scrape(job.id, url, config).catch((error) => {
          console.error(`Scraping failed for ${url}:`, error);
        });
      }

      res.json({ 
        jobs, 
        status: "started", 
        count: jobs.length,
        ...(duplicateCount > 0 && { 
          duplicatesRemoved: duplicateCount,
          message: `Removed ${duplicateCount} duplicate URL(s). Processing ${uniqueUrls.length} unique URLs.`
        })
      });
    } catch (error: unknown) {
      console.error("Error starting bulk scrape:", error);
      res.status(500).json({
        error: getErrorMessage(error) || "Failed to start scraping",
      });
    }
  });

  app.post("/api/scrape/start", async (req, res) => {
    try {
      const clientIp = req.ip || req.socket.remoteAddress || "unknown";
      
      if (!scrapeRateLimiter.isAllowed(clientIp)) {
        const remainingTime = Math.ceil(scrapeRateLimiter.getRemainingTime(clientIp) / 1000);
        return res.status(429).json({
          error: "Too many requests. Please try again later.",
          retryAfter: remainingTime,
        });
      }

      const { url } = req.body;

      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }

      if (!url.includes("smartframe.com")) {
        return res.status(400).json({ error: "URL must be from smartframe.com" });
      }

      const config = scrapeConfigSchema.parse({
        url,
        maxImages: req.body.maxImages !== undefined ? req.body.maxImages : 0,
        extractDetails: req.body.extractDetails !== false,
        sortBy: req.body.sortBy || "relevance",
        autoScroll: req.body.autoScroll !== false,
        scrollDelay: req.body.scrollDelay || 1000,
        concurrency: req.body.concurrency || 5,
        canvasExtraction: req.body.canvasExtraction || "none",
      });

      const job = await storage.createScrapeJob(url, config);

      scraper.scrape(job.id, url, config).catch((error) => {
        console.error("Scraping failed:", error);
      });

      res.json({ jobId: job.id, status: "started" });
    } catch (error: unknown) {
      console.error("Error starting scrape:", error);
      res.status(500).json({
        error: getErrorMessage(error) || "Failed to start scraping",
      });
    }
  });

  app.get("/api/scrape/job/:jobId", async (req, res) => {
    try {
      const { jobId } = req.params;
      const job = await storage.getScrapeJob(jobId);

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      res.json(job);
    } catch (error: unknown) {
      console.error("Error fetching job:", error);
      res.status(500).json({
        error: getErrorMessage(error) || "Failed to fetch job",
      });
    }
  });

  app.get("/api/scrape/jobs", async (req, res) => {
    try {
      const jobs = await storage.getAllScrapeJobs();
      res.json(jobs);
    } catch (error: unknown) {
      console.error("Error fetching jobs:", error);
      res.status(500).json({
        error: getErrorMessage(error) || "Failed to fetch jobs",
      });
    }
  });

  app.get("/api/export/:jobId", async (req, res) => {
    try {
      const { jobId } = req.params;
      const { format = "json" } = req.query;

      const job = await storage.getScrapeJob(jobId);

      if (!job) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (!job.images || job.images.length === 0) {
        return res.status(400).json({ error: "No images to export" });
      }

      if (format === "csv") {
        // Map to include ImageID, Page URL, Copy Link, and all metadata fields
        const csvExportData = job.images.map(img => ({
          imageId: img.imageId,
          url: img.url,
          copyLink: img.copyLink,
          titleField: img.titleField,
          subjectField: img.subjectField,
          tags: img.tags,
          comments: img.comments,
          authors: img.authors,
          dateTaken: img.dateTaken,
          copyright: img.copyright,
        }));
        
        // Export with all columns including identifiers and metadata
        const csvData = stringify(csvExportData, {
          header: true,
          columns: [
            { key: "imageId", header: "ImageID" },
            { key: "url", header: "Page URL" },
            { key: "copyLink", header: "Copy Link" },
            { key: "titleField", header: "Title Field" },
            { key: "subjectField", header: "Subject Field" },
            { key: "tags", header: "Tags" },
            { key: "comments", header: "Comments" },
            { key: "authors", header: "Authors" },
            { key: "dateTaken", header: "Date Taken" },
            { key: "copyright", header: "Copyright" },
          ],
        });

        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="smartframe-export-${jobId}.csv"`
        );
        res.send(csvData);
      } else {
        const jsonData = {
          jobId: job.id,
          url: job.url,
          totalImages: job.images.length,
          scrapedAt: job.startedAt,
          completedAt: job.completedAt,
          images: job.images,
        };

        res.setHeader("Content-Type", "application/json");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="smartframe-export-${jobId}.json"`
        );
        res.json(jsonData);
      }
    } catch (error: unknown) {
      console.error("Error exporting data:", error);
      res.status(500).json({
        error: getErrorMessage(error) || "Failed to export data",
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
