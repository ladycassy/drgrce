import puppeteer, { Browser, Page, ElementHandle } from "puppeteer";
import { ScrapeConfig, ScrapedImage } from "../shared/schema";
import { storage } from "./storage";
import { normalizeDate } from "./utils/date-normalization";
import { transformToCleanMetadata } from "./utils/metadata-normalizer";
import { generateCaption } from "./utils/caption-generator";
import { failedScrapesLogger, FailedScrape } from "./utils/failed-scrapes-logger";
import { VPNManager, VPNConfig } from "./utils/vpn-manager";
import { WaitTimeHelper } from "./utils/wait-time-helper";
import { SmartFrameExtensionManager, SmartFrameCanvasExtractor } from "./utils/smartframe-extension";
import { CanvasTimeoutError, CanvasExtensionError } from "./utils/smartframe-extension/canvas-extractor";
import { loadScraperConfig } from "./utils/config-loader";
import type { SmartframeMetadata, ScraperConfig } from "./types";
import fs from 'fs';
import path from 'path';

type ScrapeProgress = {
  percentage: number;
  current: number;
  total: number;
  status: string;
};

type ScrapeCallbacks = {
  onProgress?: (scrapedCount: number, totalCount: number) => void;
  onComplete?: (images: ScrapedImage[]) => void;
  onError?: (error: Error) => void;
};

// Metadata cache for network-intercepted data
const metadataCache = new Map<string, SmartframeMetadata>();

// Job queue item type
type QueuedJob = {
  jobId: string;
  url: string;
  config: ScrapeConfig;
  callbacks: ScrapeCallbacks;
  resolve: (value: ScrapedImage[]) => void;
  reject: (error: Error) => void;
};

class SmartFrameScraper {
  private browser: Browser | null = null;
  private vpnManager: VPNManager | null = null;
  private waitTimeHelper: WaitTimeHelper | null = null;
  private config: ScraperConfig | null = null;
  private jobQueue: QueuedJob[] = [];
  private runningJobs: number = 0;
  private maxConcurrentJobs: number = 3;
  private extensionManager: SmartFrameExtensionManager | null = null;
  private canvasExtractor: SmartFrameCanvasExtractor | null = null;
  private extensionDir: string | null = null;

  async initialize() {
    // Load configuration from scraper.config.json first
    if (!this.config) {
      this.config = loadScraperConfig();
    }

    // Launch browser with appropriate configuration
    // Note: Extension will be initialized dynamically per job if needed
    if (!this.browser) {
      const launchOptions: any = {
        headless: true, // Default to headless, will restart if canvas extraction is needed
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
        ],
      };

      this.browser = await puppeteer.launch(launchOptions);
    }

    // Set max concurrent jobs from config
    this.maxConcurrentJobs = this.config.navigation?.maxConcurrentJobs || 3;

    // Initialize VPN manager
    if (!this.vpnManager && this.config.vpn) {
      // Merge user config with defaults to ensure all required VPN fields are present
      const vpnConfig = {
        ...VPNManager.createDefaultConfig(),
        ...this.config.vpn
      };
      this.vpnManager = new VPNManager(vpnConfig);
      if (this.config.vpn.enabled) {
        console.log('✓ VPN rotation enabled - will rotate after', this.config.vpn.changeAfterFailures, 'consecutive failures');
      }
    }

    // Initialize wait time helper
    if (!this.waitTimeHelper && this.config.waitTimes) {
      const waitConfig = {
        baseDelay: this.config.waitTimes.scrollDelay,
        minVariance: this.config.waitTimes.minVariance,
        maxVariance: this.config.waitTimes.maxVariance
      };
      this.waitTimeHelper = new WaitTimeHelper(waitConfig);
      console.log('✓ Random wait times enabled - base:', this.config.waitTimes.scrollDelay + 'ms, variance:', this.config.waitTimes.minVariance + '-' + this.config.waitTimes.maxVariance + 'ms');
    }
  }

  /**
   * Initialize SmartFrame extension if needed for canvas extraction
   */
  private async ensureExtensionInitialized(): Promise<void> {
    if (!this.extensionManager) {
      console.log('🎨 Initializing SmartFrame canvas extraction extension...');
      this.extensionManager = new SmartFrameExtensionManager();
      this.extensionDir = await this.extensionManager.setupExtension();
      this.canvasExtractor = new SmartFrameCanvasExtractor();
      
      // Restart browser with extension loaded and non-headless mode
      if (this.browser) {
        await this.browser.close();
      }
      
      const launchOptions: any = {
        headless: false, // Must be non-headless for canvas rendering
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-blink-features=AutomationControlled',
          // Anti-throttling flags to prevent Chrome from throttling background tabs
          // NOTE: Do NOT disable GPU - it's required for canvas rendering
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          '--disable-hang-monitor',
          `--disable-extensions-except=${this.extensionDir}`,
          `--load-extension=${this.extensionDir}`,
        ],
      };
      
      this.browser = await puppeteer.launch(launchOptions);
      console.log('✓ Browser restarted with SmartFrame extension and non-headless mode');
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    
    // Clean up extension
    if (this.extensionManager) {
      this.extensionManager.cleanup();
      this.extensionManager = null;
      this.extensionDir = null;
    }
  }

  /**
   * Process the next job in the queue
   */
  private async processNextJob(): Promise<void> {
    if (this.jobQueue.length === 0 || this.runningJobs >= this.maxConcurrentJobs) {
      return;
    }

    const job = this.jobQueue.shift();
    if (!job) return;

    this.runningJobs++;
    console.log(`\n📊 Queue Status: ${this.runningJobs} running, ${this.jobQueue.length} queued`);

    try {
      const result = await this.scrapeInternal(job.jobId, job.url, job.config, job.callbacks);
      job.resolve(result);
    } catch (error) {
      job.reject(error as Error);
    } finally {
      this.runningJobs--;
      // Process next job in queue
      this.processNextJob();
    }
  }

  /**
   * Add a scrape job to the queue
   */
  async scrape(
    jobId: string,
    url: string,
    config: ScrapeConfig,
    callbacks: ScrapeCallbacks = {}
  ): Promise<ScrapedImage[]> {
    return new Promise((resolve, reject) => {
      this.jobQueue.push({ jobId, url, config, callbacks, resolve, reject });
      console.log(`\n📥 Job ${jobId} added to queue (position: ${this.jobQueue.length})`);
      this.processNextJob();
    });
  }

  /**
   * Internal scrape implementation (actual scraping logic)
   */
  private async scrapeInternal(
    jobId: string,
    url: string,
    config: ScrapeConfig,
    callbacks: ScrapeCallbacks = {}
  ): Promise<ScrapedImage[]> {
    await this.initialize();
    
    // Initialize extension if canvas extraction is needed for this job
    const canvasExtraction = config.canvasExtraction || "none";
    if (canvasExtraction !== "none") {
      await this.ensureExtensionInitialized();
    }
    
    const page = await this.browser!.newPage();

    // Initialize failed scrapes logger for this job
    failedScrapesLogger.startJob(jobId);

    try {
      await storage.updateScrapeJob(jobId, { status: "scraping" });
      
      console.log('\n' + '='.repeat(60));
      console.log('STARTING SCRAPE JOB');
      console.log('='.repeat(60));
      console.log(`Job ID: ${jobId}`);
      console.log(`Target URL: ${url}`);
      console.log(`Max Images: ${config.maxImages === 0 ? 'Unlimited' : config.maxImages}`);
      console.log(`Extract Details: ${config.extractDetails ? 'Yes' : 'No'}`);
      console.log(`Auto-scroll: ${config.autoScroll ? 'Yes' : 'No'}`);
      console.log(`Canvas Extraction: ${canvasExtraction}`);
      console.log('='.repeat(60) + '\n');
      
      // Anti-detection setup
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );
      
      // Add benign headers that are safe to apply globally
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      });
      
      // Enhanced stealth mode - hide webdriver and spoof browser properties
      await page.evaluateOnNewDocument(() => {
        // Hide webdriver property
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        
        // Add plugins to appear more like a real browser
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });
        
        // Add languages array
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
        
        // Add chrome runtime object (present in real Chrome browsers)
        (window as any).chrome = {
          runtime: {}
        };
      });

      // Setup network interception for API metadata (Strategy A)
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        request.continue();
      });

      page.on('response', async (response) => {
        const url = response.url();
        // Intercept SmartFrame API metadata calls
        if (url.includes('smartframe.') && (url.includes('/api/') || url.includes('/metadata') || url.includes('/image/'))) {
          try {
            const contentType = response.headers()['content-type'];
            if (contentType && contentType.includes('application/json')) {
              const data = await response.json();
              if (data && (data.imageId || data.image_id || data.id)) {
                const imageId = data.imageId || data.image_id || data.id;
                metadataCache.set(imageId, data);
                console.log(`Cached metadata for image: ${imageId}`);
              }
            }
          } catch (error) {
            // Silently skip non-JSON responses
          }
        }
      });

      console.log(`Navigating to ${url}...`);
      
      // Get navigation configuration from config
      const navigationTimeout = this.config?.navigation?.timeout || 60000;
      const waitUntil = this.config?.navigation?.waitUntil || 'domcontentloaded';
      
      // Retry navigation with exponential backoff
      let attempts = 0;
      const maxAttempts = 3;
      let navigationSuccess = false;

      while (attempts < maxAttempts && !navigationSuccess) {
        attempts++;
        console.log(`Navigation attempt ${attempts}/${maxAttempts} to ${url}`);
        
        try {
          await page.goto(url, {
            waitUntil: waitUntil as any,
            timeout: navigationTimeout
          });
          navigationSuccess = true;
        } catch (error) {
          console.error(`Navigation attempt ${attempts} failed:`, error);
          if (attempts === maxAttempts) throw error;
          await this.waitTimeHelper!.wait(2000 * attempts);
        }
      }

      // Wait for SmartFrame embeds to load
      try {
        await page.waitForSelector('smartframe-embed, .sf-thumbnail, [data-testid="image-card"]', { timeout: 15000 });
      } catch (error) {
        console.log("SmartFrame elements not found with standard selectors, trying fallback...");
        await this.waitTimeHelper!.wait(3000);
      }

      // Extract thumbnails from search page
      const thumbnails = await this.extractThumbnailsFromSearch(page);
      console.log(`Extracted ${thumbnails.size} thumbnails from search page`);

      // Create accumulator for incrementally discovered image links
      const discoveredLinks = new Map<string, { url: string; imageId: string; hash: string }>();

      // NEW: Collect initial page before autoScroll starts
      console.log('Collecting images from initial page...');
      const initialPageLinks = await this.collectPageImageLinks(page);
      for (const link of initialPageLinks) {
        discoveredLinks.set(link.imageId, link);
      }
      console.log(`Initial page: collected ${discoveredLinks.size} images`);

      // Auto-scroll to load all images with incremental collection
      if (config.autoScroll) {
        await this.autoScroll(
          page, 
          config.maxImages, 
          config.scrollDelay || 1000, 
          async (progress: ScrapeProgress) => {
            await storage.updateScrapeJob(jobId, {
              progress: Math.round(progress.percentage),
              scrapedImages: progress.current,
              totalImages: progress.total,
            });
          },
          async () => {
            // Collect images from current page after each pagination
            const pageLinks = await this.collectPageImageLinks(page);
            for (const link of pageLinks) {
              discoveredLinks.set(link.imageId, link);
            }
            console.log(`Collected ${discoveredLinks.size} unique images so far`);
          }
        );
      }
      
      // Convert discovered links Map to array
      const imageLinks = Array.from(discoveredLinks.values());
      console.log(`Total unique images collected: ${imageLinks.length}`);

      // Apply max images limit if specified
      const limitedLinks = config.maxImages === 0 ? imageLinks : imageLinks.slice(0, config.maxImages);

      console.log(`Processing ${limitedLinks.length} image links`);

      const images: ScrapedImage[] = [];
      const concurrency = config.concurrency || this.config?.scraping?.concurrency || 2;
      
      console.log(`\n🚀 Parallel Processing Enabled: ${concurrency} concurrent tabs`);
      console.log(`Processing ${limitedLinks.length} images...\n`);

      // Process images in parallel using worker pool
      const processedImages = await this.processImagesInParallel(
        limitedLinks,
        thumbnails,
        config.extractDetails || false,
        concurrency,
        jobId,
        config,
        async (currentImages: ScrapedImage[], attemptedCount: number) => {
          // Update job progress in database AND persist images incrementally
          console.log(`💾 [Canvas Mode] Persisting ${currentImages.length} images to database for CSV export...`);
          await storage.updateScrapeJob(jobId, {
            scrapedImages: currentImages.length,
            progress: Math.round((attemptedCount / limitedLinks.length) * 100),
            images: currentImages, // CRITICAL FIX: Persist images to database for CSV export
          });
          
          // Call user's onProgress callback if provided
          callbacks.onProgress?.(currentImages.length, limitedLinks.length);
        }
      );
      
      images.push(...processedImages);

      // Enhanced multi-round retry mechanism with smart error filtering
      if (config.extractDetails) {
        const maxRetryRounds = this.config?.scraping?.maxRetryRounds || 2;
        console.log(`\n🔄 Starting retry mechanism (max ${maxRetryRounds} rounds)...`);
        
        for (let round = 1; round <= maxRetryRounds; round++) {
          // Get all current failures
          const failures = failedScrapesLogger.getFailures();
          
          if (failures.length === 0) {
            console.log(`✅ No failed images to retry after round ${round - 1}`);
            break;
          }

          // Filter out non-retryable errors to avoid wasting resources
          const retryableFailures = failures.filter(failure => {
            // Don't retry 404s (image doesn't exist)
            if (failure.httpStatus === 404) {
              console.log(`⏭️  Skipping retry for ${failure.imageId}: 404 Not Found`);
              return false;
            }
            // Don't retry 403s (access forbidden)
            if (failure.httpStatus === 403) {
              console.log(`⏭️  Skipping retry for ${failure.imageId}: 403 Forbidden`);
              return false;
            }
            // Don't retry 401s (unauthorized)
            if (failure.httpStatus === 401) {
              console.log(`⏭️  Skipping retry for ${failure.imageId}: 401 Unauthorized`);
              return false;
            }
            return true;
          });

          if (retryableFailures.length === 0) {
            console.log(`⏭️  All ${failures.length} failures are non-retryable errors (404, 403, 401)`);
            break;
          }

          console.log(`\n🔄 Retry Round ${round}/${maxRetryRounds}: ${retryableFailures.length} retryable failures (${failures.length - retryableFailures.length} skipped as non-retryable)`);
          
          // Progressive delay before each retry round
          if (round > 1) {
            const delayBeforeRetry = 5000 * round;
            console.log(`⏱️  Waiting ${delayBeforeRetry}ms before retry round ${round}...`);
            await new Promise(resolve => setTimeout(resolve, delayBeforeRetry));
          }
          
          const retriedImages = await this.retryFailedImages(
            retryableFailures, 
            thumbnails, 
            1, // Use concurrency of 1 for retries to minimize rate limiting
            jobId, 
            round,
            config
          );
          
          images.push(...retriedImages);
          console.log(`✓ Retry round ${round} complete: ${retriedImages.length} images recovered`);
        }
        
        // Final summary
        const finalFailures = failedScrapesLogger.getFailures();
        if (finalFailures.length > 0) {
          console.log(`\n⚠️  Final status: ${finalFailures.length} images could not be scraped after ${maxRetryRounds} retry rounds`);
        } else {
          console.log(`\n✅ All images successfully scraped!`);
        }
      }

      await storage.updateScrapeJob(jobId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        images,
        scrapedImages: images.length,
      });

      console.log(`\n✅ Job ${jobId} completed. Scraped ${images.length} images.`);
      
      // Print direct API export URLs for easy access
      const baseUrl = process.env.REPLIT_DEPLOYMENT === "true" 
        ? `https://${process.env.REPLIT_SLUG}.${process.env.REPLIT_OWNER}.repl.co`
        : `http://localhost:${process.env.PORT || 5000}`;
      
      console.log(`\n📥 Direct API Export URLs:`);
      console.log(`GET ${baseUrl}/api/export/${jobId}?format=json`);
      console.log(`GET ${baseUrl}/api/export/${jobId}?format=csv`);
      console.log(`============================================================\n`);
      
      if (this.vpnManager) {
        this.vpnManager.recordScrapeSuccess();
        const rotationCheck = this.vpnManager.shouldRotate();
        
        if (rotationCheck.rotate) {
          console.log(`\n🔄 VPN Rotation Triggered: ${rotationCheck.reason}`);
          try {
            await this.vpnManager.changeVPN();
          } catch (error) {
            console.error('⚠️  VPN rotation failed, continuing anyway:', error instanceof Error ? error.message : error);
          }
        } else {
          console.log(`📊 VPN Status: ${rotationCheck.reason}`);
        }
      }
      
      callbacks.onComplete?.(images);
      
      return images;
    } catch (error) {
      console.error(`Job ${jobId} failed:`, error);
      
      if (this.vpnManager) {
        this.vpnManager.recordScrapeFailure();
        const rotationCheck = this.vpnManager.shouldRotate();
        
        if (rotationCheck.rotate) {
          console.log(`\n🔄 VPN Rotation Triggered (due to failure): ${rotationCheck.reason}`);
          try {
            await this.vpnManager.changeVPN();
          } catch (vpnError) {
            console.error('⚠️  VPN rotation failed:', vpnError instanceof Error ? vpnError.message : vpnError);
          }
        }
      }
      
      await storage.updateScrapeJob(jobId, {
        status: "error",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      });
      callbacks.onError?.(error as Error);

      throw error;
    } finally {
      await page.close();
    }
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    try {
      const cookieSelector = '.cky-btn.cky-btn-accept';
      const cookieBanner = await page.$(cookieSelector);
      
      if (cookieBanner) {
        console.log('Cookie banner detected - dismissing...');
        await cookieBanner.click();
        // Wait for banner to dissolve
        await page.waitForSelector(cookieSelector, { hidden: true, timeout: 5000 }).catch(() => {});
        console.log('Cookie banner dismissed successfully');
      }
    } catch (error) {
      // Silently continue if no cookie banner found
    }
  }

  /**
   * Content-aware wait: waits until a selector exists AND contains non-empty text
   * This ensures dynamic JavaScript has fully loaded metadata before extraction
   */
  private async waitForContentLoaded(
    page: Page,
    selector: string,
    timeoutMs: number = 15000,
    description?: string
  ): Promise<boolean> {
    try {
      await page.waitForFunction(
        (sel) => {
          const element = document.querySelector(sel);
          return element && element.textContent && element.textContent.trim().length > 0;
        },
        { timeout: timeoutMs },
        selector
      );
      console.log(`✓ ${description || selector} loaded with content`);
      return true;
    } catch (error) {
      console.log(`⚠️  ${description || selector} loading timed out after ${timeoutMs}ms`);
      return false;
    }
  }

  /**
   * Extracts text content by piercing the Shadow DOM
   * Required for SmartFrame custom web components that encapsulate metadata
   */
  private async extractFromShadowDOM(
    page: Page,
    hostSelector: string,
    dataSelector: string
  ): Promise<string | null> {
    return page.evaluate((hostSel, dataSel) => {
      const hostElement = document.querySelector(hostSel);
      if (hostElement && (hostElement as any).shadowRoot) {
        const shadowRoot = (hostElement as any).shadowRoot;
        const dataElement = shadowRoot.querySelector(dataSel);
        return dataElement ? dataElement.textContent : null;
      }
      return null;
    }, hostSelector, dataSelector);
  }

  /**
   * Waits for multiple metadata fields to be populated in Shadow DOM
   * Uses robust 15-second timeout to ensure dynamic content is fully loaded
   */
  private async waitForMetadataFields(page: Page, imageId: string): Promise<void> {
    const METADATA_TIMEOUT = this.config?.metadata?.metadataTimeout || 15000;
    console.log(`[${imageId}] Waiting up to ${METADATA_TIMEOUT}ms for metadata to fully load...`);
    
    try {
      // Wait for smartframe-embed Shadow DOM to contain populated metadata
      await page.waitForFunction(() => {
        const embed = document.querySelector('smartframe-embed');
        if (!embed || !(embed as any).shadowRoot) return false;
        
        const shadowRoot = (embed as any).shadowRoot;
        const listItems = shadowRoot.querySelectorAll('li');
        
        // Check if we have at least some metadata fields with actual content
        let fieldsWithContent = 0;
        listItems.forEach((li: Element) => {
          const strong = li.querySelector('strong');
          if (strong) {
            const label = strong.textContent?.trim() || '';
            const value = strong.nextSibling?.textContent?.trim() || 
                         li.querySelector('button')?.textContent?.trim() || '';
            if (label && value && value.length > 0) {
              fieldsWithContent++;
            }
          }
        });
        
        // Consider loaded if we have at least 3 metadata fields populated
        return fieldsWithContent >= 3;
      }, { timeout: METADATA_TIMEOUT });
      
      console.log(`✓ [${imageId}] Metadata fields loaded successfully`);
    } catch (error) {
      console.log(`⚠️  [${imageId}] Metadata loading timed out - proceeding with available data`);
    }
  }


  private async createConfiguredPage(viewport: { width: number; height: number }): Promise<Page> {
    const page = await this.browser!.newPage();
    await page.setViewport(viewport);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br'
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      (window as any).chrome = { runtime: {} };
    });
    return page;
  }

  private async processImagesInParallel(
    linkData: Array<{ url: string; imageId: string; hash: string }>,
    thumbnails: Map<string, string>,
    extractDetails: boolean,
    initialConcurrency: number,
    jobId: string,
    config: ScrapeConfig,
    onProgress: (currentImages: ScrapedImage[], attemptedCount: number) => Promise<void>
  ): Promise<ScrapedImage[]> {
    const results: ScrapedImage[] = [];
    let attemptedCount = 0;
    
    // Get SmartFrame viewport configuration from job config
    const canvasExtraction = config.canvasExtraction || "none";
    const orderedSequential = config.orderedSequential || false;
    const maxConcurrency = this.config?.scraping?.maxConcurrency || 20;
    
    // Apply concurrency limit (use let instead of const since we may modify it)
    let concurrency = initialConcurrency;
    if (concurrency > maxConcurrency) {
      console.log(`⚠️  Requested concurrency ${concurrency} exceeds max ${maxConcurrency}, limiting to ${maxConcurrency}`);
      concurrency = maxConcurrency;
    }
    
    // CONCURRENT PROCESSING: When canvas extraction is enabled AND parallel mode is enabled, use parallel processing with rotation
    // Use round-robin tab activation to ensure each tab gets GPU rendering time
    // CRITICAL FIX: Parallel canvas extraction is now OPT-IN via config flag
    const enableParallelCanvas = this.config?.smartframe?.enableParallelCanvasExtraction === true;
    if (canvasExtraction !== "none" && !orderedSequential && enableParallelCanvas) {
      // Use configurable concurrency for canvas extraction (default: 3)
      const canvasConcurrency = this.config?.scraping?.canvasConcurrency || 3;
      concurrency = Math.min(canvasConcurrency, maxConcurrency);
      console.log(`🎨 Canvas extraction enabled with PARALLEL mode - using ${concurrency} concurrent tabs with rotation scheduler`);
    } else if (orderedSequential) {
      // Fall back to sequential for ordered mode
      concurrency = 1;
      console.log(`📋 Ordered sequential mode enabled - tabs will open in order with active focus and delays`);
    } else if (canvasExtraction !== "none" && !enableParallelCanvas) {
      // Fall back to sequential for canvas extraction when parallel is disabled
      concurrency = 1;
      console.log(`🎨 Canvas extraction enabled with SEQUENTIAL mode (parallel disabled in config) - using 1 tab at a time`);
    }
    
    // Create a pool of worker pages
    const workerPages: Page[] = [];
    
    let viewport = { width: 1920, height: 1080 }; // Default viewport
    
    if (canvasExtraction === "full") {
      viewport = { width: 9999, height: 9999 };
      console.log(`📐 Using full resolution viewport: ${viewport.width}x${viewport.height}`);
    } else if (canvasExtraction === "thumbnail") {
      viewport = { width: 600, height: 600 };
      console.log(`📐 Using thumbnail viewport: ${viewport.width}x${viewport.height}`);
    }
    
    for (let i = 0; i < concurrency; i++) {
      const workerPage = await this.createConfiguredPage(viewport);
      workerPages.push(workerPage);
    }

    try {
      // CONCURRENT CANVAS PROCESSING: Use PageActivationScheduler for parallel processing
      // CRITICAL FIX: Only use scheduler if parallel mode is explicitly enabled
      if (canvasExtraction !== "none" && !orderedSequential && enableParallelCanvas) {
        // Import PageActivationScheduler
        const { PageActivationScheduler } = await import('./utils/page-activation-scheduler');
        
        // Create scheduler with configured activation interval
        const activationInterval = this.config?.smartframe?.tabActivationIntervalMs || 500;
        const scheduler = new PageActivationScheduler(workerPages, activationInterval);
        
        // Start background tab rotation
        scheduler.startRotation();
        
        try {
          // Process in concurrent batches
          const batchSize = concurrency;
          const PAGE_RECREATION_INTERVAL = this.config?.scraping?.pageRecreationInterval || 5;
          
          console.log(`🔄 Page recreation enabled every ${PAGE_RECREATION_INTERVAL} images per tab`);
          
          for (let i = 0; i < linkData.length; i += batchSize) {
            const batch = linkData.slice(i, i + batchSize);
            
            // Process batch in parallel using scheduler
            const batchPromises = batch.map(async (link, batchIndex) => {
              const acquired = await scheduler.acquirePage();
              if (!acquired) {
                console.error(`Failed to acquire page for ${link.imageId}`);
                return null;
              }
              
              const { page: workerPage, release } = acquired;
              
              try {
                const image = await this.extractImageData(
                  workerPage,
                  link.url,
                  link.imageId,
                  link.hash,
                  extractDetails,
                  thumbnails.get(link.imageId),
                  config
                );
                
                if (image) {
                  console.log(`✓ [${i + batchIndex + 1}/${linkData.length}] ${link.imageId}`);
                  return image;
                }
              } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                console.error(`✗ Error scraping ${link.url}:`, errorMsg);
                
                failedScrapesLogger.addFailure({
                  imageId: link.imageId,
                  url: link.url,
                  reason: `Uncaught exception: ${errorMsg}`,
                  attempts: 1,
                  timestamp: new Date().toISOString()
                });
              } finally {
                release();
              }
              
              return null;
            });
            
            const batchResults = await Promise.all(batchPromises);
            const validImages = batchResults.filter((img): img is ScrapedImage => img !== null);
            results.push(...validImages);
            attemptedCount += batch.length;
            
            // Update progress after each batch
            await onProgress([...results], attemptedCount);
          }
        } finally {
          // Clean up scheduler (pages will be closed by outer finally block)
          await scheduler.cleanup(30000, false);
        }
      } else if (orderedSequential) {
        // SEQUENTIAL PROCESSING: For ordered sequential mode only
        let workerPage = workerPages[0];
        
        const interTabDelayMin = config.interTabDelayMin || this.config?.scraping?.interTabDelayMin || 3000;
        const interTabDelayMax = config.interTabDelayMax || this.config?.scraping?.interTabDelayMax || 5000;
        const PAGE_RECREATION_INTERVAL = 15;
        
        console.log(`⏱️  Inter-tab delay: ${interTabDelayMin}-${interTabDelayMax}ms`);
        console.log(`🔄 Page recreation enabled every ${PAGE_RECREATION_INTERVAL} images`);
        
        for (let i = 0; i < linkData.length; i++) {
          const link = linkData[i];
          
          if (i > 0 && i % PAGE_RECREATION_INTERVAL === 0) {
            try {
              console.log(`🔄 [Memory Cleanup] Closing page after ${i} images...`);
              await workerPage.close().catch(() => {});
              workerPage = await this.createConfiguredPage(viewport);
              workerPages[0] = workerPage;
              console.log(`✅ [Memory Cleanup] Fresh page created`);
            } catch (cleanupError) {
              console.error(`⚠️  Error recreating page:`, cleanupError instanceof Error ? cleanupError.message : cleanupError);
            }
          }
          
          try {
            await workerPage.bringToFront();
            console.log(`[${i + 1}/${linkData.length}] Tab activated for ${link.imageId}`);
            
            const image = await this.extractImageData(
              workerPage,
              link.url,
              link.imageId,
              link.hash,
              extractDetails,
              thumbnails.get(link.imageId),
              config
            );
            
            if (image) {
              console.log(`✓ [${i + 1}/${linkData.length}] ${link.imageId}`);
              results.push(image);
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.error(`✗ Error scraping ${link.url}:`, errorMsg);
            
            failedScrapesLogger.addFailure({
              imageId: link.imageId,
              url: link.url,
              reason: `Uncaught exception: ${errorMsg}`,
              attempts: 1,
              timestamp: new Date().toISOString()
            });
          }
          
          attemptedCount++;
          await onProgress([...results], attemptedCount);
          
          if (i < linkData.length - 1) {
            const delay = Math.floor(Math.random() * (interTabDelayMax - interTabDelayMin + 1)) + interTabDelayMin;
            console.log(`⏳ Waiting ${delay}ms before loading next tab...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      } else {
        // Parallel batch processing for metadata-only scraping (original logic)
        const batchSize = concurrency;
        for (let i = 0; i < linkData.length; i += batchSize) {
          const batch = linkData.slice(i, i + batchSize);
          
          // Process batch in parallel
          const batchPromises = batch.map(async (link, index) => {
            const workerPage = workerPages[index % concurrency];
            
            try {
              const image = await this.extractImageData(
                workerPage,
                link.url,
                link.imageId,
                link.hash,
                extractDetails,
                thumbnails.get(link.imageId),
                config
              );
              
              if (image) {
                console.log(`✓ [${attemptedCount + 1}/${linkData.length}] ${link.imageId}`);
                return image;
              }
            } catch (error) {
              console.error(`✗ Error scraping ${link.url}:`, error instanceof Error ? error.message : error);
              // Log the failure from uncaught exception
              failedScrapesLogger.addFailure({
                imageId: link.imageId,
                url: link.url,
                reason: `Uncaught exception: ${error instanceof Error ? error.message : String(error)}`,
                attempts: 1,
                timestamp: new Date().toISOString()
              });
            }
            
            return null;
          });

          const batchResults = await Promise.all(batchPromises);
          const validImages = batchResults.filter((img): img is ScrapedImage => img !== null);
          results.push(...validImages);
          attemptedCount += batch.length;
          
          // Update progress with immutable snapshot of accumulated results after each batch
          // Progress is based on attempted count, not successful count
          await onProgress([...results], attemptedCount);
          
          // Small delay between batches to avoid overwhelming the server
          if (i + batchSize < linkData.length) {
            await this.waitTimeHelper!.wait(500);
          }
        }
      }
    } finally {
      // Clean up worker pages
      await Promise.all(workerPages.map(page => page.close().catch(() => {})));
    }

    console.log(`\n✅ Parallel processing complete: ${results.length} images extracted\n`);
    return results;
  }

  private async extractThumbnailsFromSearch(page: Page): Promise<Map<string, string>> {
    const thumbnailMap = new Map<string, string>();

    try {
      const thumbnails = await page.evaluate(() => {
        const results: Array<{ imageId: string; thumbnailUrl: string }> = [];

        // Extract from smartframe-embed elements
        const embeds = document.querySelectorAll('smartframe-embed');
        embeds.forEach((embed) => {
          const imageId = embed.getAttribute('image-id');
          if (imageId) {
            // Try to get thumbnail from computed style or child img
            const img = embed.querySelector('img');
            const thumbnailUrl = img?.src || '';
            if (thumbnailUrl) {
              results.push({ imageId, thumbnailUrl });
            }
          }
        });

        return results;
      });

      thumbnails.forEach(({ imageId, thumbnailUrl }) => {
        thumbnailMap.set(imageId, thumbnailUrl);
      });
    } catch (error) {
      console.error('Error extracting thumbnails:', error);
    }

    return thumbnailMap;
  }

  private async collectPageImageLinks(page: Page): Promise<Array<{ url: string; imageId: string; hash: string }>> {
    return await page.evaluate(() => {
      const links: Array<{ url: string; imageId: string; hash: string }> = [];
      
      // Method 1: smartframe-embed elements
      const embeds = document.querySelectorAll('smartframe-embed');
      embeds.forEach((embed) => {
        const imageId = embed.getAttribute('image-id');
        const customerId = embed.getAttribute('customer-id');
        if (imageId && customerId) {
          links.push({
            url: `https://smartframe.com/search/image/${customerId}/${imageId}`,
            imageId: imageId,
            hash: customerId
          });
        }
      });

      // Method 2: Direct links to /search/image/
      const thumbnailLinks = document.querySelectorAll('a[href*="/search/image/"]');
      thumbnailLinks.forEach((link) => {
        const href = (link as HTMLAnchorElement).href;
        const match = href.match(/\/search\/image\/([^\/]+)\/([^\/\?]+)/);
        if (match && !links.some(l => l.imageId === match[2])) {
          links.push({
            url: href,
            imageId: match[2],
            hash: match[1]
          });
        }
      });

      // Method 3: Data attributes on containers
      const containers = document.querySelectorAll('[data-image-id], .sf-thumbnail');
      containers.forEach((container) => {
        const imageId = container.getAttribute('data-image-id');
        const hash = container.getAttribute('data-customer-id') || container.getAttribute('data-hash');
        
        if (imageId && hash && !links.some(l => l.imageId === imageId)) {
          links.push({
            url: `https://smartframe.com/search/image/${hash}/${imageId}`,
            imageId: imageId,
            hash: hash
          });
        }
      });

      return links;
    });
  }

  private async autoScroll(
    page: Page, 
    maxImages: number, 
    scrollDelay: number, 
    onProgress: (progress: ScrapeProgress) => void,
    onPageChange?: () => Promise<void>
  ): Promise<void> {
    let previousHeight;
    let imageCount = 0;
    const loadedImageUrls = new Set<string>();
    const visitedPages = new Set<string>(); // Track visited pages to prevent loops
    let lastPageUrl = ''; // Track last page URL to detect pagination changes
    let justClickedPagination = false; // Track if we just clicked pagination to skip visited check

    // CSS selectors that can be used with page.$$()
    const loadMoreSelectors = [
      '[data-testid="load-more"]',
      'button.load-more',
      '#load-more-button',
      'button[class*="load-more"]',
      'button[class*="rounded-r-md"]', // Next button in pagination (right-rounded button)
      '[aria-label*="Load"]',
      '[aria-label*="Next"]',
      '[aria-label*="next"]',
      '.pagination button',
      '.pagination a',
      'nav button',
      'nav a',
      'button', // Fallback: check all buttons
      'a[href*="page"]', // Links with "page" in href
    ];

    const isUnlimited = maxImages === 0;
    const patienceRounds = 5; // Number of retry rounds when scroll height stops increasing
    const patienceDelay = scrollDelay * 2; // Delay between patience rounds
    console.log(`Starting auto-scroll (target: ${isUnlimited ? 'unlimited' : maxImages} images, delay: ${scrollDelay}ms, patience: ${patienceRounds} rounds)`);

    while (isUnlimited || imageCount < maxImages) {
      // Get current page state for comparison
      const currentUrl = page.url();
      const currentPageKey = currentUrl + '-' + imageCount; // Unique key for this page state
      
      // Check if we've already processed this exact page state (skip if we just clicked pagination)
      if (!justClickedPagination && visitedPages.has(currentPageKey)) {
        console.log(`Already visited page state: ${currentPageKey}. Breaking pagination loop.`);
        break;
      }
      
      // Reset the flag at the start of each iteration
      justClickedPagination = false;
      
      visitedPages.add(currentPageKey);
      
      const thumbnails = await page.$$('img');
      imageCount = thumbnails.length;
      console.log(`Scrolled to ${await page.evaluate(() => document.body.scrollHeight)}px, found ${imageCount} images`);

      onProgress({
        percentage: isUnlimited ? 0 : (imageCount / maxImages) * 100,
        current: imageCount,
        total: isUnlimited ? imageCount : maxImages,
        status: 'Scrolling and discovering images...',
      });

      // Attempt to click "Load More" or "Next" button if it exists and is visible
      let loadMoreButton: ElementHandle<Element> | null = null;
      let matchedSelector = '';
      let buttonText = '';
      
      // First, try to find pagination buttons by evaluating all buttons and getting the element
      try {
        const buttonInfo = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, a'));
          
          // Priority 1: Look for "Next" buttons specifically
          for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            const text = btn.textContent?.toLowerCase().trim() || '';
            const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
            
            // Check if this is specifically a "Next" button
            if (text === 'next' || ariaLabel === 'next' || text.startsWith('next')) {
              // Check if button is enabled and visible
              const isDisabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true';
              if (isDisabled) continue;
              
              const rect = btn.getBoundingClientRect();
              const isVisible = rect.top >= 0 && 
                               rect.left >= 0 && 
                               rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) * 2 &&
                               rect.right <= (window.innerWidth || document.documentElement.clientWidth) &&
                               rect.width > 0 && rect.height > 0;
              
              if (isVisible && btn instanceof HTMLElement) {
                const style = window.getComputedStyle(btn);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  return {
                    found: true,
                    index: i,
                    text: btn.textContent?.trim() || '',
                    tagName: btn.tagName.toLowerCase()
                  };
                }
              }
            }
          }
          
          // Priority 2: Look for other pagination buttons
          for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            const text = btn.textContent?.toLowerCase() || '';
            const classList = Array.from(btn.classList || []);
            const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
            
            // Check if this is a pagination button
            const isPaginationText = text.includes('load more') || 
                                     text.includes('show more') ||
                                     text.includes('load all');
            
            const isPaginationClass = classList.some(cls => 
              cls.includes('load') || 
              cls.includes('pagination') ||
              cls.includes('rounded-r-md') // Specific to Next button in the provided HTML
            );
            
            const isPaginationAria = ariaLabel.includes('load') ||
                                     ariaLabel.includes('more');
            
            if (isPaginationText || isPaginationClass || isPaginationAria) {
              // Check if button is enabled and visible
              const isDisabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true';
              if (isDisabled) continue;
              
              const rect = btn.getBoundingClientRect();
              const isVisible = rect.top >= 0 && 
                               rect.left >= 0 && 
                               rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) * 2 &&
                               rect.right <= (window.innerWidth || document.documentElement.clientWidth) &&
                               rect.width > 0 && rect.height > 0;
              
              if (isVisible && btn instanceof HTMLElement) {
                const style = window.getComputedStyle(btn);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                  return {
                    found: true,
                    index: i,
                    text: btn.textContent?.trim() || '',
                    tagName: btn.tagName.toLowerCase()
                  };
                }
              }
            }
          }
          return { found: false };
        });
        
        if (buttonInfo.found) {
          // Get the actual element handle
          const allButtons = await page.$$('button, a');
          if (buttonInfo.index !== undefined && allButtons[buttonInfo.index]) {
            loadMoreButton = allButtons[buttonInfo.index];
            matchedSelector = 'evaluated pagination button';
            buttonText = buttonInfo.text || '';
            console.log(`Found pagination button with text: "${buttonText}"`);
          }
        }
      } catch (error) {
        console.log('Error finding pagination button via evaluation:', error);
      }
      
      // Fallback: try CSS selectors
      if (!loadMoreButton) {
        for (const selector of loadMoreSelectors) {
          try {
            const elements = await page.$$(selector);
            for (const element of elements) {
              const isVisible = await element.isIntersectingViewport();
              if (isVisible) {
                // Check if element is disabled
                const isDisabled = await element.evaluate(el => {
                  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
                });
                if (isDisabled) continue;
                
                // Check if element text suggests it's a pagination control
                const text = await element.evaluate(el => el.textContent?.toLowerCase().trim() || '');
                const isPagination = text === 'next' ||
                                     text.includes('load') || 
                                     text.includes('more') || 
                                     text.includes('next') || 
                                     text.includes('show');
                
                if (isPagination) {
                  loadMoreButton = element;
                  matchedSelector = selector;
                  buttonText = text;
                  console.log(`Found pagination button with selector: ${selector}, text: "${text}"`);
                  break;
                }
              }
            }
            if (loadMoreButton) break;
          } catch (error) {
            // This selector is not supported or failed, try the next one
          }
        }
      }

      if (loadMoreButton) {
        try {
          // Capture state before clicking
          const beforeClickImageCount = imageCount;
          const beforeClickUrl = page.url();
          
          // Scroll button into view before clicking
          await loadMoreButton.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          await new Promise(resolve => setTimeout(resolve, 500));
          
          await loadMoreButton.click();
          console.log(`Clicked pagination button (${matchedSelector}).`);
          
          // Wait longer for page to fully load and new content to appear
          await new Promise(resolve => setTimeout(resolve, scrollDelay + 2000)); // Increased wait time
          
          // Verify that clicking resulted in a change
          const afterClickUrl = page.url();
          const afterClickThumbnails = await page.$$('img');
          const afterClickImageCount = afterClickThumbnails.length;
          
          if (afterClickUrl !== beforeClickUrl) {
            console.log(`Page URL changed from ${beforeClickUrl} to ${afterClickUrl} - pagination successful`);
            lastPageUrl = afterClickUrl; // Update last page URL to detect next pagination
            justClickedPagination = true; // Mark that we just clicked pagination successfully
            if (onPageChange) await onPageChange();
            continue; // Continue to next iteration with new page
          } else if (afterClickImageCount > beforeClickImageCount) {
            console.log(`Image count increased from ${beforeClickImageCount} to ${afterClickImageCount} - pagination successful`);
            justClickedPagination = true; // Mark that we just clicked pagination successfully
            if (onPageChange) await onPageChange();
            continue; // Continue to next iteration with new content
          } else {
            console.log(`Click did not result in page change or new content. Proceeding with scroll.`);
            loadMoreButton = null;
          }
        } catch (error) {
          console.log('Pagination button no longer clickable or disappeared. Proceeding with scroll.');
          loadMoreButton = null;
        }
      }

      previousHeight = await page.evaluate(() => document.body.scrollHeight);
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await new Promise(resolve => setTimeout(resolve, scrollDelay));

      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      if (newHeight === previousHeight) {
        // Height unchanged - check for pagination button that may now be visible at bottom
        console.log('Scroll height unchanged. Checking for pagination button before patience mechanism...');
        
        let paginationButton: ElementHandle<Element> | null = null;
        let paginationSelector = '';
        let paginationButtonText = '';
        
        // Try to find pagination button now that we're at the bottom
        try {
          const buttonInfo = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            
            // Priority 1: Look for "Next" buttons specifically
            for (let i = 0; i < buttons.length; i++) {
              const btn = buttons[i];
              const text = btn.textContent?.toLowerCase().trim() || '';
              const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
              
              // Check if this is specifically a "Next" button
              if (text === 'next' || ariaLabel === 'next' || text.startsWith('next')) {
                // Check if button is enabled and visible
                const isDisabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true';
                if (isDisabled) continue;
                
                const rect = btn.getBoundingClientRect();
                const isVisible = rect.top >= 0 && 
                                 rect.left >= 0 && 
                                 rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) * 2 &&
                                 rect.right <= (window.innerWidth || document.documentElement.clientWidth) &&
                                 rect.width > 0 && rect.height > 0;
                
                if (isVisible && btn instanceof HTMLElement) {
                  const style = window.getComputedStyle(btn);
                  if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    return {
                      found: true,
                      index: i,
                      text: btn.textContent?.trim() || '',
                      tagName: btn.tagName.toLowerCase()
                    };
                  }
                }
              }
            }
            
            // Priority 2: Look for other pagination buttons
            for (let i = 0; i < buttons.length; i++) {
              const btn = buttons[i];
              const text = btn.textContent?.toLowerCase() || '';
              const classList = Array.from(btn.classList || []);
              const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
              
              // Check if this is a pagination button
              const isPaginationText = text.includes('load more') || 
                                       text.includes('show more') ||
                                       text.includes('load all');
              
              const isPaginationClass = classList.some(cls => 
                cls.includes('load') || 
                cls.includes('pagination') ||
                cls.includes('rounded-r-md')
              );
              
              const isPaginationAria = ariaLabel.includes('load') ||
                                       ariaLabel.includes('more');
              
              if (isPaginationText || isPaginationClass || isPaginationAria) {
                // Check if button is enabled and visible
                const isDisabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true';
                if (isDisabled) continue;
                
                const rect = btn.getBoundingClientRect();
                const isVisible = rect.top >= 0 && 
                                 rect.left >= 0 && 
                                 rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) * 2 &&
                                 rect.right <= (window.innerWidth || document.documentElement.clientWidth) &&
                                 rect.width > 0 && rect.height > 0;
                
                if (isVisible && btn instanceof HTMLElement) {
                  const style = window.getComputedStyle(btn);
                  if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                    return {
                      found: true,
                      index: i,
                      text: btn.textContent?.trim() || '',
                      tagName: btn.tagName.toLowerCase()
                    };
                  }
                }
              }
            }
            return { found: false };
          });
          
          if (buttonInfo.found) {
            const allButtons = await page.$$('button, a');
            if (buttonInfo.index !== undefined && allButtons[buttonInfo.index]) {
              paginationButton = allButtons[buttonInfo.index];
              paginationSelector = 'evaluated pagination button';
              paginationButtonText = buttonInfo.text || '';
              console.log(`Found pagination button at bottom with text: "${paginationButtonText}"`);
            }
          }
        } catch (error) {
          console.log('Error finding pagination button at bottom:', error);
        }
        
        // Try CSS selectors as fallback
        if (!paginationButton) {
          for (const selector of loadMoreSelectors) {
            try {
              const elements = await page.$$(selector);
              for (const element of elements) {
                const isVisible = await element.isIntersectingViewport();
                if (isVisible) {
                  // Check if element is disabled
                  const isDisabled = await element.evaluate(el => {
                    return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
                  });
                  if (isDisabled) continue;
                  
                  const text = await element.evaluate(el => el.textContent?.toLowerCase().trim() || '');
                  const isPagination = text === 'next' ||
                                       text.includes('load') || 
                                       text.includes('more') || 
                                       text.includes('next') || 
                                       text.includes('show');
                  
                  if (isPagination) {
                    paginationButton = element;
                    paginationSelector = selector;
                    paginationButtonText = text;
                    console.log(`Found pagination button at bottom with selector: ${selector}, text: "${text}"`);
                    break;
                  }
                }
              }
              if (paginationButton) break;
            } catch (error) {
              // This selector failed, try the next one
            }
          }
        }
        
        // If we found a pagination button, click it
        if (paginationButton) {
          try {
            // Capture state before clicking
            const beforeClickImageCount = imageCount;
            const beforeClickUrl = page.url();
            
            await paginationButton.evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            await this.waitTimeHelper!.wait(500);
            
            await paginationButton.click();
            console.log(`Clicked pagination button at bottom (${paginationSelector}).`);
            
            // Wait longer for page to fully load
            await this.waitTimeHelper!.wait(scrollDelay + 2000);
            
            // Verify that clicking resulted in a change
            const afterClickUrl = page.url();
            const afterClickThumbnails = await page.$$('img');
            const afterClickImageCount = afterClickThumbnails.length;
            
            if (afterClickUrl !== beforeClickUrl) {
              console.log(`Page URL changed after click at bottom - pagination successful`);
              lastPageUrl = afterClickUrl;
              justClickedPagination = true; // Mark that we just clicked pagination successfully
              if (onPageChange) await onPageChange();
              continue; // Continue to next iteration with new page
            } else if (afterClickImageCount > beforeClickImageCount) {
              console.log(`Image count increased after click at bottom - pagination successful`);
              justClickedPagination = true; // Mark that we just clicked pagination successfully
              if (onPageChange) await onPageChange();
              continue; // Continue to next iteration with new content
            } else {
              console.log(`Click at bottom did not result in page change. Proceeding with patience mechanism.`);
            }
          } catch (error) {
            console.log('Failed to click pagination button at bottom. Proceeding with patience mechanism.');
          }
        }
        
        // No pagination button found, try patience mechanism
        console.log('No pagination button found. Starting patience mechanism...');
        let moreImagesLoaded = false;
        
        for (let round = 1; round <= patienceRounds; round++) {
          console.log(`Patience round ${round}/${patienceRounds}: Waiting ${patienceDelay}ms for more images to load...`);
          await this.waitTimeHelper!.wait(patienceDelay);
          
          const currentHeight = await page.evaluate(() => document.body.scrollHeight);
          if (currentHeight > newHeight) {
            console.log(`Patience round ${round}/${patienceRounds}: New content detected! Scroll height increased from ${newHeight}px to ${currentHeight}px.`);
            moreImagesLoaded = true;
            break;
          }
          
          console.log(`Patience round ${round}/${patienceRounds}: No new content yet (height still ${currentHeight}px).`);
        }
        
        if (!moreImagesLoaded) {
          console.log(`Patience mechanism exhausted after ${patienceRounds} rounds. Reached end of page.`);
          break; // End of page
        }
      }
    }
  }

  // Helper function to clean and validate extracted text (plain JS for serialization)
  private cleanTextHelper(text: string | null): string | null {
    if (!text) return null;
    
    // Early rejection: Check for suspicious patterns in raw text before cleaning
    const lowerText = text.toLowerCase();
    if (lowerText.includes('script') || 
        lowerText.includes('iframe') ||
        lowerText.includes('onclick') ||
        lowerText.includes('onerror') ||
        lowerText.includes('onload')) return null;
    
    // Reject common UI text that's not metadata
    if (lowerText.includes('add to board') ||
        lowerText.includes('copy link') ||
        lowerText.includes('copy embed') ||
        lowerText.includes('google tag manager') ||
        lowerText.includes('smartframe content partner')) return null;
    
    // Multi-step sanitization to remove HTML tags and prevent injection
    let cleaned = text;
    // Step 1: Remove complete tags
    cleaned = cleaned.replace(/<[^>]*>/g, '');
    // Step 2: Remove incomplete tags at start/end
    cleaned = cleaned.replace(/^<[^>]*/, '').replace(/[^<]*>$/, '');
    // Step 3: Remove any remaining angle brackets (prevents any HTML parsing)
    cleaned = cleaned.replace(/[<>]/g, '');
    cleaned = cleaned.trim();
    
    // Reject if text is too long (likely grabbed too much content)
    if (cleaned.length > 200) return null;
    // Reject if text contains multiple newlines (likely multiple elements)
    if (cleaned.split('\n').length > 3) return null;
    
    return cleaned || null;
  }

  private isEmptyResult(image: ScrapedImage): boolean {
    // Check if all meaningful metadata fields are null
    // imageId, hash, and url are always populated, so we ignore those
    const meaningfulFields = [
      image.titleField,
      image.subjectField,
      image.tags,
      image.comments,
      image.copyright,
      image.dateTaken,
      image.authors
    ];

    // Return true if ALL fields are null/empty
    return meaningfulFields.every(field => field === null || field === undefined || field === '');
  }

  private async retryFailedImages(
    failures: FailedScrape[],
    thumbnails: Map<string, string>,
    concurrency: number,
    jobId: string,
    retryRound: number = 1,
    config: ScrapeConfig
  ): Promise<ScrapedImage[]> {
    const results: ScrapedImage[] = [];
    let successCount = 0;
    let failCount = 0;
    
    console.log(`Starting retry round ${retryRound} with concurrency: ${concurrency}`);
    
    // Filter out non-retryable errors (404s, permanent client errors)
    const retryableFailures = failures.filter(failure => {
      // Don't retry 404s - image doesn't exist
      if (failure.httpStatus === 404) {
        console.log(`⏭️  Skipping ${failure.imageId} - HTTP 404 (not retryable)`);
        return false;
      }
      // Don't retry 403 Forbidden - access denied
      if (failure.httpStatus === 403) {
        console.log(`⏭️  Skipping ${failure.imageId} - HTTP 403 Forbidden (not retryable)`);
        return false;
      }
      // Don't retry 401 Unauthorized
      if (failure.httpStatus === 401) {
        console.log(`⏭️  Skipping ${failure.imageId} - HTTP 401 Unauthorized (not retryable)`);
        return false;
      }
      return true;
    });
    
    if (retryableFailures.length < failures.length) {
      console.log(`📊 Filtered out ${failures.length - retryableFailures.length} non-retryable errors`);
    }
    
    if (retryableFailures.length === 0) {
      console.log('No retryable failures found');
      return results;
    }
    
    // Create a pool of worker pages for retries
    const workerPages: Page[] = [];
    
    // Get SmartFrame viewport configuration from job config
    const canvasExtraction = config.canvasExtraction || "none";
    let viewport = { width: 1920, height: 1080 }; // Default viewport
    
    if (canvasExtraction === "full") {
      viewport = { width: 9999, height: 9999 };
    } else if (canvasExtraction === "thumbnail") {
      viewport = { width: 600, height: 600 };
    }
    
    for (let i = 0; i < concurrency; i++) {
      const workerPage = await this.browser!.newPage();
      
      // Apply viewport based on job configuration
      await workerPage.setViewport(viewport);
      await workerPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );
      await workerPage.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      });
      await workerPage.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        (window as any).chrome = { runtime: {} };
      });
      
      workerPages.push(workerPage);
    }

    try {
      // Process in batches
      const batchSize = concurrency;
      for (let i = 0; i < retryableFailures.length; i += batchSize) {
        const batch = retryableFailures.slice(i, i + batchSize);
        
        // Process batch in parallel
        const batchPromises = batch.map(async (failure, index) => {
          const workerPage = workerPages[index % concurrency];
          const retryAttempt = (failure.retryAttempt || 0) + 1;
          
          console.log(`🔄 [Round ${retryRound}, Retry ${retryAttempt}] Attempting ${failure.imageId} (${i + index + 1}/${retryableFailures.length})`);
          
          try {
            // Extract hash from URL (format: /search/image/{hash}/{imageId})
            const urlMatch = failure.url.match(/\/search\/image\/([^\/]+)\/([^\/\?]+)/);
            const hash = urlMatch ? urlMatch[1] : '';
            
            const image = await this.extractImageData(
              workerPage,
              failure.url,
              failure.imageId,
              hash,
              true, // extractDetails is always true for retries
              thumbnails.get(failure.imageId),
              config
            );
            
            // Check if we got meaningful data (not just partial/empty image)
            // Consider it successful if we have at least title, authors, or comments
            if (image && (image.titleField || image.authors || image.comments)) {
              console.log(`✅ [Round ${retryRound}, Retry ${retryAttempt}] Success: ${failure.imageId}`);
              // Remove from failed list since retry was successful
              failedScrapesLogger.removeSuccess(failure.imageId);
              successCount++;
              return image;
            } else {
              console.log(`❌ [Round ${retryRound}, Retry ${retryAttempt}] Still no data: ${failure.imageId}`);
              // Update failure with incremented retry attempt
              failedScrapesLogger.addFailure({
                imageId: failure.imageId,
                url: failure.url,
                reason: `${failure.reason} (retry round ${retryRound}, attempt ${retryAttempt} failed)`,
                attempts: failure.attempts + 1,
                timestamp: new Date().toISOString(),
                httpStatus: failure.httpStatus,
                retryAttempt
              });
              failCount++;
            }
          } catch (error) {
            console.error(`❌ [Round ${retryRound}, Retry ${retryAttempt}] Exception for ${failure.imageId}:`, error instanceof Error ? error.message : error);
            // Update failure with exception info
            failedScrapesLogger.addFailure({
              imageId: failure.imageId,
              url: failure.url,
              reason: `Retry round ${retryRound}, attempt ${retryAttempt} exception: ${error instanceof Error ? error.message : String(error)}`,
              attempts: failure.attempts + 1,
              timestamp: new Date().toISOString(),
              httpStatus: failure.httpStatus,
              retryAttempt
            });
            failCount++;
          }
          
          return null;
        });

        const batchResults = await Promise.all(batchPromises);
        const validImages = batchResults.filter((img): img is ScrapedImage => img !== null);
        results.push(...validImages);
        
        // Increased delay between batches to avoid rate limiting
        // Use exponential backoff based on retry round
        if (i + batchSize < retryableFailures.length) {
          const delayBetweenBatches = 3000 * retryRound; // 3s, 6s, etc. based on round
          console.log(`⏳ Waiting ${delayBetweenBatches / 1000}s before next batch...`);
          await this.waitTimeHelper!.wait(delayBetweenBatches);
        }
      }
    } finally {
      // Clean up worker pages
      await Promise.all(workerPages.map(page => page.close().catch(() => {})));
    }

    console.log(`\n📊 Retry Round ${retryRound} Summary:`);
    console.log(`   ✅ Successful: ${successCount}`);
    console.log(`   ❌ Failed: ${failCount}`);
    console.log(`   📈 Recovery rate: ${retryableFailures.length > 0 ? ((successCount / retryableFailures.length) * 100).toFixed(1) : 0}%\n`);
    
    return results;
  }

  private parseMetadata(rawData: SmartframeMetadata): Partial<ScrapedImage> {
    const result: Partial<ScrapedImage> = {
      titleField: null,
      subjectField: null,
      tags: null,
      comments: null,
      authors: null,
      dateTaken: null,
      copyright: null,
    };

    const title = this.cleanTextHelper(rawData.title || null);
    const captionText = rawData.caption ? rawData.caption.trim() : null;
    
    result.titleField = title;
    result.comments = captionText;

    // Extract keywords if available
    if (rawData.keywords && Array.isArray(rawData.keywords)) {
      const tagsList = rawData.keywords.map((k: string) => this.cleanTextHelper(k)).filter(Boolean);
      result.tags = tagsList.length > 0 ? tagsList.join(', ') : null;
    }

    // Reduced logging for performance
    // console.log(`[DEBUG parseMetadata] Processing ${rawData.labelValues?.length || 0} label-value pairs`);
    
    for (const item of rawData.labelValues || []) {
      const label = item.label?.toLowerCase() || '';
      const value = this.cleanTextHelper(item.value);

      if (!value) continue;

      switch (label) {
        case 'photographer':
        case 'credit':
        case 'photo credit':
        case 'by':
        case 'author':
        case 'shot by':
        case 'photo by':
          result.authors = result.authors || value;
          if (value.includes('©') || value.includes('Copyright')) {
            result.copyright = result.copyright || value;
          }
          break;
        case 'date':
        case 'date taken':
        case 'when':
        case 'date created':
        case 'created':
          if (!result.dateTaken) {
            result.dateTaken = normalizeDate(value) || value;
          }
          break;
        case 'event':
        case 'title':
        case 'headline':
        case 'event title':
          result.titleField = result.titleField || value;
          break;
        case 'caption':
        case 'description':
        case 'desc':
          result.comments = result.comments || value;
          break;
        case 'featuring':
        case 'people':
        case 'subject':
        case 'subjects':
        case 'person':
        case 'who':
          result.subjectField = result.subjectField || value;
          break;
        case 'where':
        case 'location':
        case 'place':
          // Parse location as "City, Country" or just "Country"
          const locationParts = value.split(',').map((part: string) => part.trim());
          if (locationParts.length === 2) {
            (result as any).city = locationParts[0];
            (result as any).country = locationParts[1];
          } else if (locationParts.length === 1) {
            (result as any).country = locationParts[0];
          }
          break;
        case 'city':
          (result as any).city = value;
          break;
        case 'country':
          (result as any).country = value;
          break;
        case 'tags':
        case 'keywords':
        case 'keyword':
          if (value && !result.tags) {
            result.tags = value;
          }
          break;
        case 'copyright':
        case '©':
        case 'rights':
          result.copyright = result.copyright || value;
          break;
      }
    }

    result.titleField = result.titleField || title;

    if (captionText) {
      // Strategy 1: Look for credit/photographer markers (supports multiple formats)
      // Handles: "Credit:", "Photographer:", "©", "Copyright:", etc.
      const creditMatch = captionText.match(/(?:Credit|Photographer|Photo(?:\s+Credit)?|©|Copyright)(?:\s*\([^)]+\))?:\s*([^\n]+)/i);
      if (creditMatch) {
        const credit = this.cleanTextHelper(creditMatch[1]);
        if (credit) {
          let cleanedCredit = credit;
          
          // Remove "(Mandatory):" prefix and similar artifacts
          cleanedCredit = cleanedCredit.replace(/^\s*\([^)]+\)\s*:\s*/, '').trim();
          cleanedCredit = cleanedCredit.replace(/^:\s*/, '').trim();
          
          // Validate cleaned credit is not empty before assigning
          if (cleanedCredit && cleanedCredit.length > 0) {
            result.authors = result.authors || cleanedCredit;
            result.copyright = result.copyright || cleanedCredit;
          }
        }
      }

      // Strategy 2: Look for date patterns in caption
      const dateMatch = captionText.match(/(?:When|Date):\s*([^\n]+)/i);
      if (dateMatch && !result.dateTaken) {
        const dateValue = this.cleanTextHelper(dateMatch[1]);
        result.dateTaken = normalizeDate(dateValue) || dateValue;
      }
      
      // Also check for date format: "City, Country - DD.MM.YY"
      const datePattern = captionText.match(/[-–]\s+(\d{2}\.\d{2}\.\d{2,4})/);
      if (datePattern && !result.dateTaken) {
        const datePart = datePattern[1].trim();
        result.dateTaken = normalizeDate(datePart) || datePart;
      }

      // Strategy 3: Look for "Featuring:" marker with enhanced pattern matching
      // Supports: "Featuring:", "Featuring :", "Featuring-", "Featuring –"
      const featuringMatch = captionText.match(/Featuring\s*[:–—-]\s*([^\n]+)/i);
      if (featuringMatch) {
        result.subjectField = result.subjectField || this.cleanTextHelper(featuringMatch[1]);
      }
      
      // Strategy 4: Look for "Where:" marker to extract location (city, country)
      // Supports multiple separators and handles HTML entities
      const whereMatch = captionText.match(/Where\s*[:–—-]\s*([^\n]+)/i);
      if (whereMatch) {
        const locationText = this.cleanTextHelper(whereMatch[1]);
        if (locationText) {
          // Parse location as "City, Country" or just "Country"
          const locationParts = locationText.split(',').map(part => part.trim());
          if (locationParts.length === 2) {
            // Format: "City, Country"
            (result as any).city = locationParts[0];
            (result as any).country = locationParts[1];
          } else if (locationParts.length === 1) {
            // Format: just "Country" or "City"
            (result as any).country = locationParts[0];
          }
        }
      }
      
      // Strategy 5: Enhanced credit extraction with multiple pattern support
      // Handles: "Credit:", "Photo Credit:", "Photographer:", with various separators
      const enhancedCreditMatch = captionText.match(/(?:Photo\s*Credit|Credit|Photographer)\s*[:–—-]\s*([^\n]+)/i);
      if (enhancedCreditMatch && !result.authors) {
        const credit = this.cleanTextHelper(enhancedCreditMatch[1]);
        if (credit && credit.length > 0) {
          result.authors = credit;
          result.copyright = result.copyright || credit;
        }
      }
    }

    // Extract additional metadata from nextData if available
    if (rawData.nextData) {
      const nextData = rawData.nextData as any;
      result.authors = result.authors || this.cleanTextHelper(nextData.photographer || nextData.author || nextData.credit);
      result.titleField = result.titleField || this.cleanTextHelper(nextData.title || nextData.eventTitle || nextData.headline);
      result.subjectField = result.subjectField || this.cleanTextHelper(nextData.featuring || nextData.people || nextData.subject);
      result.copyright = result.copyright || this.cleanTextHelper(nextData.copyright);
      
      if (!result.dateTaken) {
        const dateValue = this.cleanTextHelper(nextData.date || nextData.dateCreated || nextData.dateTaken);
        result.dateTaken = normalizeDate(dateValue) || dateValue;
      }
      
      if (nextData.tags && Array.isArray(nextData.tags)) {
        const existingTags = result.tags ? result.tags.split(',').map(t => t.trim()) : [];
        const newTags = nextData.tags.map((t: any) => String(t).trim()).filter(Boolean);
        const allTags = [...new Set([...existingTags, ...newTags])];
        result.tags = allTags.length > 0 ? allTags.join(', ') : null;
      }
    }

    return result;
  }

  private async extractImageData(
    page: Page,
    url: string,
    imageId: string,
    hash: string,
    extractDetails: boolean,
    thumbnailUrl: string | undefined,
    config: ScrapeConfig
  ): Promise<ScrapedImage | null> {
    const image: ScrapedImage = {
      imageId,
      hash,
      url,
      copyLink: url,
      smartframeId: imageId,
      thumbnailUrl: thumbnailUrl || null,
      titleField: null,
      subjectField: null,
      tags: null,
      comments: null,
      authors: null,
      dateTaken: null,
      copyright: null,
    };

    // Check if we have cached metadata from network interception (Strategy A)
    if (metadataCache.has(imageId)) {
      const cachedData = metadataCache.get(imageId) as any;
      console.log(`Using cached network metadata for ${imageId}`);
      
      // Map cached data to new IPTC/EXIF fields
      image.titleField = cachedData?.title || cachedData?.headline || cachedData?.event || null;
      image.subjectField = cachedData?.featuring || cachedData?.people || cachedData?.subject || null;
      image.comments = cachedData?.description || cachedData?.caption || null;
      image.copyright = cachedData?.copyright || cachedData?.credit || null;
      image.authors = cachedData?.photographer || cachedData?.author || cachedData?.credit || null;
      
      if (cachedData?.date || cachedData?.dateCreated || cachedData?.created_at || cachedData?.dateTaken) {
        const dateValue = cachedData.date || cachedData.dateCreated || cachedData.created_at || cachedData.dateTaken;
        image.dateTaken = normalizeDate(dateValue as string) || dateValue;
      }
      
      if (cachedData?.tags && Array.isArray(cachedData.tags)) {
        const tagsList = cachedData.tags.map((t: any) => String(t).trim()).filter(Boolean);
        image.tags = tagsList.length > 0 ? tagsList.join(', ') : null;
      }
    }

    if (extractDetails) {
      try {
        // CRITICAL: Viewport size must match extraction mode
        // For FULL mode, use 9999x9999 like the working Python scripts
        // For THUMBNAIL mode, use standard desktop viewport
        const canvasExtraction = config.canvasExtraction || "none";
        const viewportWidth = canvasExtraction === "full" ? 9999 : 1280;
        const viewportHeight = canvasExtraction === "full" ? 9999 : 800;
        console.log(`[${imageId}] Setting viewport to ${viewportWidth}x${viewportHeight} for ${canvasExtraction} extraction mode`);
        await page.setViewport({ width: viewportWidth, height: viewportHeight });
        
        // CRITICAL: Setup shadow root capture hook BEFORE navigation
        // This must happen before page.goto to intercept SmartFrame's attachShadow call
        if (canvasExtraction !== "none" && this.canvasExtractor) {
          await this.canvasExtractor.setupShadowRootCapture(page, imageId, canvasExtraction as 'full' | 'thumbnail');
        }
        
        // Retry mechanism for page navigation with HTTP status code checking
        let navSuccess = false;
        let httpStatus = 0;
        let lastError: Error | null = null;
        const maxAttempts = 3;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            // Use networkidle2 to ensure all JavaScript and content has loaded
            // This is critical for SmartFrame pages that load metadata dynamically
            const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
            httpStatus = response?.status() || 0;
            
            // Check for HTTP error responses
            if (httpStatus === 429) {
              // Rate limiting - use longer exponential backoff
              console.log(`⚠️  [${imageId}] HTTP 429 - Rate limited (attempt ${attempt}/${maxAttempts})`);
              if (attempt < maxAttempts) {
                // Longer exponential backoff for rate limiting: 5s, 10s, 20s
                const delay = 5000 * Math.pow(2, attempt - 1);
                console.log(`Rate limited. Waiting ${delay}ms before retry...`);
                await this.waitTimeHelper!.wait(delay);
                continue;
              } else {
                console.log(`❌ [${imageId}] Failed after ${attempt} attempts - HTTP 429 Rate Limited. Logging failure.`);
                failedScrapesLogger.addFailure({
                  imageId,
                  url,
                  reason: `HTTP 429 Rate Limited after ${maxAttempts} attempts`,
                  attempts: maxAttempts,
                  timestamp: new Date().toISOString(),
                  httpStatus
                });
                return image; // Return partial data for CSV
              }
            } else if (httpStatus >= 500) {
              console.log(`⚠️  [${imageId}] HTTP ${httpStatus} error - Server error (attempt ${attempt}/${maxAttempts})`);
              if (attempt < maxAttempts) {
                // Exponential backoff: 2s, 4s, 8s
                const delay = 2000 * Math.pow(2, attempt - 1);
                console.log(`Retrying in ${delay}ms...`);
                await this.waitTimeHelper!.wait(delay);
                continue;
              } else {
                console.log(`❌ [${imageId}] Failed after ${attempt} attempts - HTTP ${httpStatus}. Logging failure.`);
                failedScrapesLogger.addFailure({
                  imageId,
                  url,
                  reason: `HTTP ${httpStatus} Server Error after ${maxAttempts} attempts`,
                  attempts: maxAttempts,
                  timestamp: new Date().toISOString(),
                  httpStatus
                });
                return image; // Return partial data for CSV
              }
            } else if (httpStatus === 404) {
              console.log(`❌ [${imageId}] HTTP 404 - Image not found. Logging failure.`);
              failedScrapesLogger.addFailure({
                imageId,
                url,
                reason: 'HTTP 404 - Image Not Found',
                attempts: attempt,
                timestamp: new Date().toISOString(),
                httpStatus
              });
              return image; // Return partial data for CSV
            } else if (httpStatus >= 400) {
              console.log(`⚠️  [${imageId}] HTTP ${httpStatus} error - Client error. Logging failure.`);
              failedScrapesLogger.addFailure({
                imageId,
                url,
                reason: `HTTP ${httpStatus} Client Error`,
                attempts: attempt,
                timestamp: new Date().toISOString(),
                httpStatus
              });
              return image; // Return partial data for CSV
            }
            
            navSuccess = true;
            
            // CRITICAL FIX #1: Dismiss cookie banner IMMEDIATELY after successful navigation
            // This must happen before any other waits to prevent JavaScript blocking
            await this.dismissCookieBanner(page);
            
            break;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.log(`Navigation attempt ${attempt} failed for ${url}:`, error instanceof Error ? error.message : error);
            if (attempt === maxAttempts) {
              // Log navigation timeout failure
              console.log(`❌ [${imageId}] Failed to navigate after ${maxAttempts} attempts. Logging failure.`);
              failedScrapesLogger.addFailure({
                imageId,
                url,
                reason: `Navigation timeout: ${lastError.message}`,
                attempts: maxAttempts,
                timestamp: new Date().toISOString()
              });
              return image; // Return partial data for CSV
            }
            // Exponential backoff: 2s, 4s, 8s
            const delay = 2000 * Math.pow(2, attempt - 1);
            console.log(`Retrying in ${delay}ms...`);
            await this.waitTimeHelper!.wait(delay);
          }
        }

        if (!navSuccess) return image; // Return partial data for CSV

        // CRITICAL FIX #2: Robust content-aware wait with 15-second timeout
        // Wait for dynamic JavaScript to fully populate metadata fields
        // This is THE KEY FIX that prevents premature data extraction
        console.log(`[${imageId}] Waiting for dynamic content to load...`);
        
        // Wait for smartframe-embed element (metadata container)
        try {
          await page.waitForSelector('smartframe-embed', { timeout: 15000 });
          console.log(`[${imageId}] smartframe-embed found`);
        } catch (error) {
          console.log(`[${imageId}] smartframe-embed not found within 15s - will try extraction anyway`);
        }

        // CRITICAL FIX #3: Wait for metadata fields to be fully populated
        // Uses robust 15-second timeout to ensure content is ready
        await this.waitForMetadataFields(page, imageId);

        // CRITICAL FIX: SmartFrame renders metadata INSIDE shadow DOM
        // We must access smartframe-embed.shadowRoot, not document
        const rawData = await page.evaluate(() => {
          const labelValues: Array<{ label: string; value: string }> = [];
          const keywords: string[] = [];
          
          // Find smartframe-embed element
          const embed = document.querySelector('smartframe-embed');
          let shadowRoot = null;
          
          if (embed) {
            shadowRoot = embed.shadowRoot;
            if (!shadowRoot) {
              console.log('[Extraction] smartframe-embed found but shadowRoot is null');
            } else {
              console.log('[Extraction] smartframe-embed shadowRoot accessed successfully');
            }
          } else {
            console.log('[Extraction] smartframe-embed element not found');
          }

          // Extract from BOTH shadow DOM and light DOM for maximum coverage
          let title = null;
          let caption = null;
          let contentPartner = null;

          // Try shadow DOM first (where SmartFrame metadata actually lives)
          if (shadowRoot) {
            const shadowTitle = shadowRoot.querySelector('h1, h2, [class*="title"], [data-title]');
            title = shadowTitle?.textContent || null;
            
            const shadowCaption = shadowRoot.querySelector('p, div[class*="caption"], [class*="description"]');
            caption = shadowCaption?.textContent || null;
            
            // Extract label-value pairs from shadow DOM
            shadowRoot.querySelectorAll('li').forEach(li => {
              const strong = li.querySelector('strong');
              if (!strong) return;
              
              const label = strong.textContent?.replace(':', '').trim() || '';
              let value: string | null = null;
              
              const button = li.querySelector('button');
              if (button) {
                value = button.textContent || null;
              } else if (strong.nextSibling) {
                value = strong.nextSibling.textContent || null;
              }
              
              if (label && value) {
                labelValues.push({ label, value });
                console.log(`[Extraction Shadow] Found: ${label} = ${value.substring(0, 50)}`);
              }
            });
          }

          // Fallback: try light DOM (page-level metadata)
          // IMPORTANT: Skip provider/gallery name (h2) - it's not the image title
          if (!title) {
            // Try h1 first (actual title), skip h2 (usually just the provider name like "WENN")
            const h1El = document.querySelector('h1');
            if (h1El?.textContent && !h1El.textContent.match(/^(WENN|Getty|AFP|Reuters|Shutterstock)$/i)) {
              title = h1El.textContent;
            }
          }
          
          if (!caption) {
            // Look for the main paragraph that contains the full caption with embedded metadata
            // This usually has the format:
            // [Title/description]
            // Featuring: [people]
            // Where: [location]
            // When: [date]
            // Credit: [photographer]
            const captionSelectors = [
              'section p', // Main caption paragraph in section - most common
              'div[class*="flex"][class*="col"] p', // Flexbox column paragraphs
              'p.text-iy-midnight-400',
              'div.text-iy-midnight-400',
              'p[class*="midnight"]',
              'p[class*="caption"]',
              'article p',
              'main p'
            ];
            
            for (const selector of captionSelectors) {
              const el = document.querySelector(selector);
              if (el?.textContent && el.textContent.length > 20) { // Ensure it's substantial content
                const text = el.textContent.trim();
                // Verify it contains actual metadata (use case-insensitive matching for reliability)
                const hasMetadata = /featuring|where|when|credit|photographer/i.test(text) || 
                                   text.match(/\d{2}\s*[A-Za-z]{3}\s*\d{4}/) || // "18 Jul 2016"
                                   text.match(/\d{2}\.\d{2}\.\d{2}/) || // "18.07.16"
                                   text.includes(' - ');
                
                if (hasMetadata) {
                  caption = text;
                  console.log('[Extraction Light] Found caption paragraph with embedded metadata');
                  break;
                }
              }
            }
            
            // Enhanced extraction: Parse structured caption into label-value pairs
            // This captures "Featuring: X", "Where: Y", "When: Z", "Credit: W" patterns
            if (caption) {
              const lines = caption.split('\n').map(l => l.trim()).filter(l => l.length > 0);
              for (const line of lines) {
                // Match patterns like "Featuring: John Smith" or "Where : London, UK"
                // Support variants: colon, em-dash, en-dash, with/without spaces
                const labelMatch = line.match(/^(Featuring|Where|When|Credit|Photographer|Photo\s*Credit)\s*[:–—-]\s*(.+)$/i);
                if (labelMatch) {
                  const label = labelMatch[1].trim();
                  const value = labelMatch[2].trim();
                  
                  // Add to labelValues if not already present
                  if (!labelValues.some(lv => lv.label.toLowerCase() === label.toLowerCase())) {
                    labelValues.push({ label, value });
                    console.log(`[Extraction Caption] Parsed: ${label} = ${value.substring(0, 50)}`);
                  }
                }
              }
            }
          }

          // Extract SmartFrame Content Partner
          // Look for the pattern: <h6>SmartFrame Content Partner</h6><h2>Provider Name</h2>
          const contentPartnerSection = document.querySelector('h6.headline');
          if (contentPartnerSection?.textContent?.includes('SmartFrame Content Partner')) {
            // Get the next h2 sibling or the h2 within the same parent
            const parent = contentPartnerSection.parentElement;
            const partnerName = parent?.querySelector('h2.headline');
            if (partnerName?.textContent) {
              contentPartner = partnerName.textContent.trim();
              console.log(`[Extraction] Found Content Partner: ${contentPartner}`);
            }
          }

          // Extract Keywords from button elements
          // Keywords are displayed as buttons with the keyword text
          const keywordSection = document.querySelector('h2');
          const keywordSections = Array.from(document.querySelectorAll('h2')).filter(h2 => 
            h2.textContent?.toLowerCase().includes('keywords') || h2.textContent?.toLowerCase().includes('keyword')
          );
          
          if (keywordSections.length > 0) {
            // Find the parent section and get all button elements within it
            keywordSections.forEach(section => {
              const parent = section.parentElement;
              if (parent) {
                const buttons = parent.querySelectorAll('button[type="button"]');
                buttons.forEach(button => {
                  const keyword = button.textContent?.trim();
                  if (keyword && keyword.length > 0 && !keyword.includes('SmartFrame') && !keyword.includes('View all')) {
                    keywords.push(keyword);
                  }
                });
              }
            });
            console.log(`[Extraction] Found ${keywords.length} keywords`);
          }

          // Extract label-value pairs from light DOM as fallback
          document.querySelectorAll('li').forEach(li => {
            const strong = li.querySelector('strong');
            if (!strong) return;
            
            const label = strong.textContent?.replace(':', '').trim() || '';
            
            // Skip if we already have this label from shadow DOM
            if (labelValues.some(lv => lv.label.toLowerCase() === label.toLowerCase())) {
              return;
            }
            
            let value: string | null = null;
            const button = li.querySelector('button');
            if (button) {
              value = button.textContent || null;
            } else if (strong.nextSibling) {
              value = strong.nextSibling.textContent || null;
            }
            
            if (label && value) {
              labelValues.push({ label, value });
              console.log(`[Extraction Light] Found: ${label} = ${value.substring(0, 50)}`);
            }
          });

          // COMPREHENSIVE JSON EXTRACTION
          // SmartFrame embeds metadata as JSON in various formats
          // We try multiple strategies to find and extract this data
          let nextData: any = null;
          const extractionLog: string[] = [];

          // Strategy 1: __NEXT_DATA__ script tag (Next.js standard)
          try {
            const nextDataScript = document.querySelector('script#__NEXT_DATA__');
            if (nextDataScript?.textContent) {
              extractionLog.push('Found __NEXT_DATA__ script');
              const parsed = JSON.parse(nextDataScript.textContent);
              
              // Try multiple possible paths in the JSON structure
              const possiblePaths = [
                parsed?.props?.pageProps?.image?.metadata,
                parsed?.props?.pageProps?.metadata,
                parsed?.props?.pageProps?.image,
                parsed?.props?.image?.metadata,
                parsed?.pageProps?.image?.metadata,
              ];
              
              for (const imageMetadata of possiblePaths) {
                if (imageMetadata && typeof imageMetadata === 'object') {
                  extractionLog.push(`Found metadata at path in __NEXT_DATA__`);
                  nextData = {
                    photographer: imageMetadata.photographer || imageMetadata.credit || imageMetadata.byline || imageMetadata.author,
                    dimensions: imageMetadata.dimensions || imageMetadata.imageSize || imageMetadata.size,
                    fileSize: imageMetadata.fileSize || imageMetadata.file_size,
                    country: imageMetadata.country || imageMetadata.countryCode,
                    city: imageMetadata.city || imageMetadata.location,
                    date: imageMetadata.date || imageMetadata.dateCreated || imageMetadata.dateTaken || imageMetadata.created,
                    eventTitle: imageMetadata.eventTitle || imageMetadata.event || imageMetadata.matchEvent,
                    title: imageMetadata.title || imageMetadata.headline || imageMetadata.name,
                    caption: imageMetadata.caption || imageMetadata.description,
                    featuring: imageMetadata.featuring || imageMetadata.people || imageMetadata.subject,
                    people: imageMetadata.people || imageMetadata.featuring,
                    tags: imageMetadata.tags || imageMetadata.keywords || imageMetadata.categories || [],
                    copyright: imageMetadata.copyright || imageMetadata.copyrightNotice,
                    credit: imageMetadata.credit || imageMetadata.photographer,
                    comments: imageMetadata.comments || imageMetadata.notes,
                    authors: imageMetadata.authors || imageMetadata.author || imageMetadata.photographer
                  };
                  break;
                }
              }
            }
          } catch (e) {
            extractionLog.push(`__NEXT_DATA__ parse error: ${e}`);
          }

          // Strategy 2: Search all script tags for JSON containing metadata
          if (!nextData) {
            try {
              const scripts = Array.from(document.querySelectorAll('script'));
              extractionLog.push(`Searching ${scripts.length} script tags for JSON metadata`);
              
              for (const script of scripts) {
                if (!script.textContent) continue;
                const content = script.textContent;
                
                // Skip very small scripts
                if (content.length < 100) continue;
                
                // Look for JSON-like content with metadata keywords
                if (content.includes('photographer') || 
                    content.includes('metadata') || 
                    content.includes('caption') ||
                    content.includes('copyright')) {
                  
                  // Try to parse as JSON
                  try {
                    // Handle various JSON formats
                    let jsonData = null;
                    
                    // Direct JSON
                    if (content.trim().startsWith('{')) {
                      jsonData = JSON.parse(content);
                    }
                    // JSON.parse("...") wrapped
                    else if (content.includes('JSON.parse')) {
                      const match = content.match(/JSON\.parse\(['"](.+)['"]\)/);
                      if (match) {
                        // Unescape the JSON string
                        const unescaped = match[1]
                          .replace(/\\"/g, '"')
                          .replace(/\\'/g, "'")
                          .replace(/\\\\/g, '\\')
                          .replace(/\\n/g, '\n')
                          .replace(/\\r/g, '\r')
                          .replace(/\\t/g, '\t');
                        jsonData = JSON.parse(unescaped);
                      }
                    }
                    // Embedded in object/array
                    else {
                      // Try to extract JSON object/array
                      const jsonMatch = content.match(/\{[\s\S]*"photographer"[\s\S]*\}/);
                      if (jsonMatch) {
                        jsonData = JSON.parse(jsonMatch[0]);
                      }
                    }
                    
                    if (jsonData) {
                      extractionLog.push(`Found JSON with metadata keywords`);
                      
                      // Recursively search for metadata object
                      const findMetadata = (obj: any): any => {
                        if (!obj || typeof obj !== 'object') return null;
                        
                        // Check if this object looks like metadata
                        if ((obj.photographer || obj.credit) && (obj.title || obj.caption)) {
                          return obj;
                        }
                        
                        // Check nested properties
                        for (const key of Object.keys(obj)) {
                          if (key === 'metadata' || key === 'image' || key === 'imageData') {
                            const nested = findMetadata(obj[key]);
                            if (nested) return nested;
                          }
                        }
                        
                        // Check arrays
                        if (Array.isArray(obj)) {
                          for (const item of obj) {
                            const nested = findMetadata(item);
                            if (nested) return nested;
                          }
                        }
                        
                        return null;
                      };
                      
                      const metadata = findMetadata(jsonData);
                      if (metadata) {
                        extractionLog.push(`Extracted metadata from embedded JSON`);
                        nextData = {
                          photographer: metadata.photographer || metadata.credit || metadata.byline,
                          dimensions: metadata.dimensions || metadata.imageSize || metadata.size,
                          fileSize: metadata.fileSize || metadata.file_size,
                          country: metadata.country,
                          city: metadata.city,
                          date: metadata.date || metadata.dateCreated || metadata.dateTaken,
                          eventTitle: metadata.eventTitle || metadata.event,
                          title: metadata.title || metadata.headline,
                          caption: metadata.caption || metadata.description,
                          featuring: metadata.featuring || metadata.people,
                          people: metadata.people,
                          tags: metadata.tags || metadata.keywords || [],
                          copyright: metadata.copyright,
                          credit: metadata.credit,
                          comments: metadata.comments,
                          authors: metadata.authors || metadata.author || metadata.photographer
                        };
                        break;
                      }
                    }
                  } catch (e) {
                    // Continue to next script
                  }
                }
              }
            } catch (e) {
              extractionLog.push(`Script search error: ${e}`);
            }
          }

          extractionLog.forEach(log => console.log(`[Extraction] ${log}`));
          return { title, caption, labelValues, nextData, contentPartner, keywords };
        });

        // Reduced logging for performance - uncomment for debugging
        // console.log(`[DEBUG] Extracted raw data for ${url}:`, {
        //   title: rawData.title,
        //   caption: rawData.caption?.substring(0, 100),
        //   labelCount: rawData.labelValues?.length,
        //   hasNextData: !!rawData.nextData
        // });

        // Detect error pages by checking the title and content
        const errorPageIndicators = [
          '502 bad gateway',
          '503 service unavailable',
          '500 internal server error',
          '504 gateway timeout',
          '429 too many requests',
          'error occurred',
          'page not found',
          'access denied',
          'rate limit exceeded'
        ];
        
        const titleLower = (rawData.title || '').toLowerCase().trim();
        const isErrorPage = errorPageIndicators.some(indicator => titleLower.includes(indicator));
        
        if (isErrorPage) {
          console.log(`❌ [${imageId}] Error page detected (title: "${rawData.title}"). SmartFrame may be rate-limiting or experiencing issues.`);
          console.log(`⚠️  [${imageId}] Logging failure and returning partial data for CSV.`);
          failedScrapesLogger.addFailure({
            imageId,
            url,
            reason: `Error page detected: ${rawData.title}`,
            attempts: 1,
            timestamp: new Date().toISOString()
          });
          return image; // Return partial data for CSV
        }
        
        // If we have 0 label-value pairs AND no useful title/caption, it's likely an error
        const hasNoMetadata = (!rawData.labelValues || rawData.labelValues.length === 0) && 
                             !rawData.nextData && 
                             (!rawData.title || rawData.title.length < 3) &&
                             (!rawData.caption || rawData.caption.length < 10);
        
        if (hasNoMetadata) {
          console.log(`⚠️  [${imageId}] No metadata found on page - possible error or rate limiting. Logging failure.`);
          failedScrapesLogger.addFailure({
            imageId,
            url,
            reason: 'No metadata found - possible rate limiting or error page',
            attempts: 1,
            timestamp: new Date().toISOString()
          });
          return image; // Return partial data for CSV
        }

        // Process raw data in Node context using helper functions
        const metadata = this.parseMetadata(rawData);
        
        // Reduced logging for performance - uncomment for debugging
        // console.log(`[DEBUG] Parsed metadata for ${url}:`, {
        //   photographer: metadata.photographer,
        //   title: metadata.title,
        //   featuring: metadata.featuring,
        //   date: metadata.date,
        //   dateTaken: metadata.dateTaken
        // });

        // Merge metadata with priority: DOM > Network Cache > Existing
        // CRITICAL: Only overwrite existing fields if new value is truthy (not null/undefined/empty)
        // This prevents regressing data during retries or multi-pass scraping
        const cachedMetadata = metadataCache.get(imageId);
        
        // Helper to safely merge: only overwrite if new value exists and is non-empty
        const safeString = (newVal: string | null | undefined, fallback1?: string | null, fallback2?: any): string | null => {
          if (newVal && newVal.trim()) return newVal;
          if (fallback1 && fallback1.trim()) return fallback1;
          if (typeof fallback2 === 'string' && fallback2.trim()) return fallback2;
          return null;
        };
        
        // Merge with priority: DOM > Existing > Network Cache (preserve existing data)
        image.titleField = safeString(metadata.titleField, image.titleField, cachedMetadata?.title);
        image.subjectField = safeString(metadata.subjectField, image.subjectField, cachedMetadata?.featuring) ?? 
                           safeString(null, null, cachedMetadata?.people);
        image.tags = safeString(metadata.tags, image.tags) ?? 
                     (cachedMetadata?.keywords && Array.isArray(cachedMetadata.keywords) ? cachedMetadata.keywords.join(', ') : null);
        image.copyright = safeString(metadata.copyright, image.copyright, cachedMetadata?.copyright) ?? 
                        safeString(null, null, cachedMetadata?.copyrightNotice);
        image.dateTaken = safeString(metadata.dateTaken, image.dateTaken, cachedMetadata?.date);
        image.authors = safeString(metadata.authors, image.authors, cachedMetadata?.photographer) ?? 
                       safeString(null, null, cachedMetadata?.author);

        // Extract city/country from metadata or cached data
        const city = (metadata as any).city || cachedMetadata?.city || undefined;
        const country = (metadata as any).country || cachedMetadata?.country || undefined;

        // ALWAYS generate metadata-rich caption from structured fields
        // Format: "{title}\nFeaturing: {featuring}\nWhere: {location}\nWhen: {date}\nCredit: {credit}"
        const generatedCaption = generateCaption({
          title: image.titleField || undefined,
          captionRaw: (metadata as any).caption || (metadata as any).captionRaw || cachedMetadata?.caption || undefined,
          featuring: image.subjectField || (metadata as any).featuring || cachedMetadata?.featuring || undefined,
          city: city,
          country: country,
          dateTaken: image.dateTaken || undefined,
          photographer: image.authors || (metadata as any).photographer || cachedMetadata?.photographer || undefined,
          copyright: image.copyright || undefined
        });
        
        if (generatedCaption && generatedCaption.trim().length > 0) {
          image.comments = generatedCaption;
          
          // Validate metadata completeness and log warnings for missing critical fields
          const missingFields: string[] = [];
          if (!image.titleField) missingFields.push('title');
          if (!image.subjectField) missingFields.push('featuring');
          if (!city && !country) missingFields.push('location');
          if (!image.dateTaken) missingFields.push('date');
          if (!image.authors) missingFields.push('credit');
          
          if (missingFields.length > 0) {
            console.log(`⚠️  [${imageId}] Generated caption with missing fields: ${missingFields.join(', ')}`);
            
            // Attempt to regenerate using cached metadata as fallback for missing fields
            if (cachedMetadata && missingFields.length >= 3) {
              console.log(`[${imageId}] Attempting fallback caption generation using network cache...`);
              const fallbackCaption = generateCaption({
                title: image.titleField || (typeof cachedMetadata.title === 'string' ? cachedMetadata.title : undefined),
                featuring: image.subjectField || (typeof cachedMetadata.featuring === 'string' ? cachedMetadata.featuring : undefined),
                city: city || (typeof cachedMetadata.city === 'string' ? cachedMetadata.city : undefined),
                country: country || (typeof cachedMetadata.country === 'string' ? cachedMetadata.country : undefined),
                dateTaken: image.dateTaken || (typeof cachedMetadata.date === 'string' ? cachedMetadata.date : undefined),
                photographer: image.authors || (typeof cachedMetadata.photographer === 'string' ? cachedMetadata.photographer : undefined),
                copyright: image.copyright || undefined
              });
              
              if (fallbackCaption && fallbackCaption.trim().length > generatedCaption.trim().length) {
                image.comments = fallbackCaption;
                console.log(`✓ [${imageId}] Improved caption using network cache fallback`);
              }
            }
          } else {
            console.log(`✓ [${imageId}] Generated complete metadata-rich caption`);
          }
        } else {
          // Fallback to raw caption or cached metadata
          image.comments = metadata.comments ?? image.comments ?? 
                          (typeof cachedMetadata?.caption === 'string' ? cachedMetadata.caption : null);
          console.log(`⚠️  [${imageId}] Caption generation failed, using raw caption fallback`);
        }

      } catch (error) {
        console.error(`Error extracting details for ${url}:`, error);
        // Log the failure from generic extraction error
        failedScrapesLogger.addFailure({
          imageId,
          url,
          reason: `Detail extraction error: ${error instanceof Error ? error.message : String(error)}`,
          attempts: 1,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Extract SmartFrame canvas image if enabled
    const canvasExtraction = config.canvasExtraction || "none";
    if (canvasExtraction !== "none" && this.canvasExtractor && extractDetails) {
      try {
        console.log(`[${imageId}] Extracting SmartFrame canvas image in ${canvasExtraction} mode...`);
        
        // Create output directory if it doesn't exist
        const outputDir = path.join(process.cwd(), 'downloaded_images');
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const canvasImagePath = await this.canvasExtractor.extractCanvasImage(
          page,
          imageId,
          outputDir,
          canvasExtraction as 'full' | 'thumbnail',
          {
            titleField: image.titleField,
            subjectField: image.subjectField,
            tags: image.tags,
            comments: image.comments,
            authors: image.authors,
            dateTaken: image.dateTaken,
            copyright: image.copyright
          }
        );

        if (canvasImagePath) {
          console.log(`✓ [${imageId}] Canvas image extracted: ${canvasImagePath}`);
          // Store the canvas image path in the image metadata for reference
          (image as any).canvasImagePath = canvasImagePath;
        } else {
          console.log(`⚠️  [${imageId}] Canvas extraction failed`);
        }
      } catch (error) {
        // Handle typed canvas errors for retry logic
        if (error instanceof CanvasTimeoutError) {
          console.error(`[${imageId}] Canvas timeout error:`, error.message);
          failedScrapesLogger.addFailure({
            imageId,
            url,
            reason: `Canvas timeout: ${error.message} (elapsed: ${error.elapsedMs}ms, max: ${error.maxWaitMs}ms)`,
            attempts: 1,
            timestamp: new Date().toISOString()
          });
          // Timeout errors are potentially retryable (network issues, slow rendering)
        } else if (error instanceof CanvasExtensionError) {
          console.error(`[${imageId}] Canvas extension error:`, error.message);
          failedScrapesLogger.addFailure({
            imageId,
            url,
            reason: `Canvas extension error: ${error.extensionError} (after ${error.elapsedMs}ms)`,
            attempts: 1,
            timestamp: new Date().toISOString()
          });
          // Extension errors might be retryable depending on the error
        } else {
          console.error(`[${imageId}] Error during canvas extraction:`, error);
          failedScrapesLogger.addFailure({
            imageId,
            url,
            reason: `Canvas extraction error: ${error instanceof Error ? error.message : String(error)}`,
            attempts: 1,
            timestamp: new Date().toISOString()
          });
        }
      }
    }

    // Check if the result is empty (no metadata extracted)
    if (this.config?.scraping?.detectEmptyResults !== false && extractDetails) {
      if (this.isEmptyResult(image)) {
        console.log(`⚠️  [${imageId}] No metadata extracted - all fields are null/empty`);
        failedScrapesLogger.addFailure({
          imageId,
          url,
          reason: 'No metadata extracted',
          attempts: 1,
          timestamp: new Date().toISOString()
        });
      }
    }

    return image;
  }
}

export const scraper = new SmartFrameScraper();
