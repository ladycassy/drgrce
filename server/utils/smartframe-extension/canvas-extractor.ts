import { Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { spawn } from 'child_process';
import { INJECTED_JAVASCRIPT } from './extension-files';
import { loadScraperConfig } from '../config-loader';
import type { ScraperConfig } from '../../types';

interface ImageMetadata {
  titleField?: string | null;
  subjectField?: string | null;
  tags?: string | null;
  comments?: string | null;
  authors?: string | null;
  dateTaken?: string | null;
  copyright?: string | null;
}

/**
 * Error thrown when canvas extraction times out
 */
export class CanvasTimeoutError extends Error {
  constructor(
    public imageId: string,
    public elapsedMs: number,
    public maxWaitMs: number,
    public lastKnownError: string | null = null
  ) {
    super(
      `Canvas extraction timeout for ${imageId}: exceeded ${maxWaitMs}ms (elapsed: ${elapsedMs}ms)` +
      (lastKnownError ? ` - Last error: ${lastKnownError}` : '')
    );
    this.name = 'CanvasTimeoutError';
  }
}

/**
 * Error thrown when canvas extension reports an error
 */
export class CanvasExtensionError extends Error {
  constructor(
    public imageId: string,
    public extensionError: string,
    public elapsedMs: number
  ) {
    super(`Canvas extension error for ${imageId} after ${elapsedMs}ms: ${extensionError}`);
    this.name = 'CanvasExtensionError';
  }
}

/**
 * SmartFrame Canvas Image Extractor
 * Handles extraction of full-resolution canvas images from SmartFrame embeds
 */
export class SmartFrameCanvasExtractor {
  private config: ScraperConfig;

  constructor() {
    // Load configuration from scraper.config.json
    this.config = loadScraperConfig();
  }

  /**
   * Helper method to wait for a specified duration
   */
  private async wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Embed EXIF metadata into a JPG file using exiftool
   * @param jpgPath - Path to the JPG file
   * @param metadata - Metadata to embed
   */
  private async embedExifMetadata(jpgPath: string, metadata: ImageMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['-overwrite_original'];

      // Map our metadata fields to EXIF/IPTC/XMP tags
      // Using distinct fields to avoid overwrites
      
      if (metadata.titleField) {
        args.push(`-IPTC:ObjectName=${metadata.titleField}`);
        args.push(`-XMP:Title=${metadata.titleField}`);
        args.push(`-IPTC:Headline=${metadata.titleField}`);
      }
      
      if (metadata.subjectField) {
        // Use dedicated subject fields - NOT keywords
        args.push(`-XMP:PersonInImage=${metadata.subjectField}`);
        args.push(`-IPTC:SubjectReference=${metadata.subjectField}`);
      }
      
      if (metadata.comments) {
        // Comments/Description - distinct from subject
        args.push(`-IPTC:Caption-Abstract=${metadata.comments}`);
        args.push(`-XMP:Description=${metadata.comments}`);
        args.push(`-EXIF:ImageDescription=${metadata.comments}`);
      }
      
      if (metadata.authors) {
        args.push(`-IPTC:By-line=${metadata.authors}`);
        args.push(`-XMP:Creator=${metadata.authors}`);
        args.push(`-EXIF:Artist=${metadata.authors}`);
      }
      
      if (metadata.copyright) {
        args.push(`-IPTC:CopyrightNotice=${metadata.copyright}`);
        args.push(`-XMP:Rights=${metadata.copyright}`);
        args.push(`-EXIF:Copyright=${metadata.copyright}`);
      }
      
      if (metadata.dateTaken) {
        // Robust date parsing and formatting without timezone conversion
        try {
          // Parse ISO date string directly to avoid timezone conversion
          // Handles formats: YYYY-MM-DD, YYYY-MM-DDTHH:MM, YYYY-MM-DDTHH:MM:SS, 
          // YYYY-MM-DDTHH:MM:SS.mmm, YYYY-MM-DDTHH:MM:SS±HH:MM, etc.
          const isoMatch = metadata.dateTaken.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:[+-]\d{2}:\d{2}|Z)?)?/);
          
          if (isoMatch) {
            const [, year, month, day, hours = '00', minutes = '00', seconds = '00'] = isoMatch;
            
            // Format as EXIF date: YYYY:MM:DD HH:MM:SS
            const exifDate = `${year}:${month}:${day} ${hours}:${minutes}:${seconds}`;
            
            args.push(`-EXIF:DateTimeOriginal=${exifDate}`);
            args.push(`-EXIF:CreateDate=${exifDate}`);
            args.push(`-XMP:DateCreated=${metadata.dateTaken}`);
          } else {
            console.warn(`[SmartFrame Canvas] Date format not recognized, skipping date embedding: ${metadata.dateTaken}`);
          }
        } catch (error) {
          console.warn(`[SmartFrame Canvas] Error parsing date, skipping date embedding: ${metadata.dateTaken}`, error);
        }
      }
      
      if (metadata.tags) {
        // Split tags by comma and add as keywords
        // Use += operator to add each keyword individually
        const tagList = metadata.tags.split(',').map(t => t.trim()).filter(t => t);
        if (tagList.length > 0) {
          // Add each keyword individually to both IPTC and XMP
          tagList.forEach(tag => {
            args.push(`-IPTC:Keywords+=${tag}`);
            args.push(`-XMP:Subject+=${tag}`);
          });
        }
      }

      args.push(jpgPath);

      // Log the complete exiftool command for debugging
      console.log(`[SmartFrame Canvas] Running exiftool command:`, 'exiftool', args.join(' '));
      console.log(`[SmartFrame Canvas] Embedding EXIF metadata...`);
      
      const exiftool = spawn('exiftool', args);
      
      let stdout = '';
      let stderr = '';
      
      exiftool.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      exiftool.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      exiftool.on('close', (code) => {
        if (code === 0) {
          console.log(`[SmartFrame Canvas] ✅ EXIF metadata embedded successfully`);
          if (stdout) console.log(`[SmartFrame Canvas] exiftool output: ${stdout.trim()}`);
          resolve();
        } else {
          console.error(`[SmartFrame Canvas] ⚠️  exiftool failed with code ${code}`);
          if (stderr) console.error(`[SmartFrame Canvas] stderr: ${stderr.trim()}`);
          if (stdout) console.error(`[SmartFrame Canvas] stdout: ${stdout.trim()}`);
          // Don't reject - we still have the image, just without EXIF
          resolve();
        }
      });
      
      exiftool.on('error', (error) => {
        console.error(`[SmartFrame Canvas] ⚠️  exiftool spawn error:`, error.message);
        // Don't reject - we still have the image, just without EXIF
        resolve();
      });
    });
  }
  /**
   * Extract canvas image from SmartFrame embed
   * @param page - Puppeteer page instance
   * @param imageId - SmartFrame image ID
   * @param outputDir - Directory to save extracted images
   * @param viewportMode - Viewport mode: "full" (9999x9999) or "thumbnail" (600x600)
   * @returns Path to extracted image file, or null if extraction failed
   */
  /**
   * Setup shadow root capture hook on a page BEFORE navigation
   * This must be called before navigating to ensure attachShadow is intercepted
   */
  async setupShadowRootCapture(page: Page, imageId: string, viewportMode: 'full' | 'thumbnail' = 'thumbnail'): Promise<void> {
    const smartframeEmbedSelector = `smartframe-embed[image-id="${imageId}"]`;
    const initScript = `
      window.__SMARTFRAME_EMBED_SELECTOR = ${JSON.stringify(smartframeEmbedSelector)};
      window.__SMARTFRAME_TARGET_IMAGE_ID = ${JSON.stringify(imageId)};
      window.__SMARTFRAME_VIEWPORT_MODE = ${JSON.stringify(viewportMode)};
    `;
    
    // CRITICAL: Use evaluateOnNewDocument to inject BEFORE page loads
    // This ensures the attachShadow hook is in place when SmartFrame initializes
    await page.evaluateOnNewDocument(initScript);
    await page.evaluateOnNewDocument(INJECTED_JAVASCRIPT);
    console.log(`[SmartFrame Canvas] Shadow root capture hook registered for ${viewportMode} mode`);
  }

  async extractCanvasImage(
    page: Page,
    imageId: string,
    outputDir: string,
    viewportMode: 'full' | 'thumbnail' = 'thumbnail',
    metadata?: ImageMetadata
  ): Promise<string | null> {
    console.log(`[SmartFrame Canvas] Extracting canvas image for ${imageId} in ${viewportMode} mode`);

    try {
      // Bring tab to front to ensure GPU rendering is active
      await page.bringToFront();
      console.log('[SmartFrame Canvas] Tab brought to front for GPU rendering');

      // DETERMINISTIC STABILIZATION WAITS BEFORE POLLING
      // After navigation and viewport resize, canvas needs time to stabilize before we start polling
      const initialStabilizationMs = this.config?.smartframe?.initialRenderWaitMs || 500;
      const postResizeStabilizationMs = this.config?.smartframe?.postResizeWaitMs || 750;
      
      // Wait for initial stabilization (navigation completed earlier in flow)
      console.log(`[SmartFrame Canvas] Waiting ${initialStabilizationMs}ms for initial navigation stabilization...`);
      await this.wait(initialStabilizationMs);
      
      // Wait for viewport resize stabilization (viewport was set earlier in flow)
      console.log(`[SmartFrame Canvas] Waiting ${postResizeStabilizationMs}ms for viewport resize stabilization...`);
      await this.wait(postResizeStabilizationMs);
      
      console.log('[SmartFrame Canvas] Stabilization complete, starting event-driven polling...');

      // EVENT-DRIVEN WAIT: Poll for extension response with exponential backoff
      // This replaces the fixed delays with smart polling after deterministic waits
      const maxWaitMs = this.config?.smartframe?.maxRenderWaitMs || 30000;
      const responseSelector = '#extension-response-data';
      const startTime = Date.now();
      
      console.log(`[SmartFrame Canvas] Polling for canvas ready (max ${maxWaitMs}ms)...`);
      
      let attempt = 0;
      let canvasReady = false;
      
      while (Date.now() - startTime < maxWaitMs && !canvasReady) {
        // Check if extension has responded (either success or error)
        const hasResponse = await page.$(
          `${responseSelector}[data-url], ${responseSelector}[data-error]`
        );
        
        if (hasResponse) {
          const elapsedMs = Date.now() - startTime;
          console.log(`[SmartFrame Canvas] Canvas ready after ${elapsedMs}ms`);
          canvasReady = true;
          break;
        }
        
        // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms, then 2s
        const delay = Math.min(100 * Math.pow(2, attempt), 2000);
        await this.wait(delay);
        attempt++;
        
        // Keep tab active with periodic mouse moves every 5 attempts (~3-5s)
        if (attempt % 5 === 0) {
          try {
            const x = 400 + Math.random() * 200;
            const y = 400 + Math.random() * 200;
            await page.mouse.move(x, y);
          } catch (error) {
            // Mouse movement is optional, ignore errors
          }
        }
      }
      
      if (!canvasReady) {
        // Check if there's an error state to surface
        const errorState = await page.$eval(
          responseSelector,
          (el) => el.getAttribute('data-error')
        ).catch(() => null);
        
        const elapsedMs = Date.now() - startTime;
        
        if (errorState) {
          console.error(`[SmartFrame Canvas] Timeout after ${maxWaitMs}ms - Extension error: ${errorState}`);
          throw new CanvasTimeoutError(imageId, elapsedMs, maxWaitMs, errorState);
        } else {
          console.error(`[SmartFrame Canvas] Timeout after ${maxWaitMs}ms - No response from extension (canvas may not have rendered)`);
          throw new CanvasTimeoutError(imageId, elapsedMs, maxWaitMs, null);
        }
      }

      // Get the data URL or error
      const imageDataUrl = await page.$eval(
        responseSelector,
        (el) => el.getAttribute('data-url')
      );
      const errorFromExtension = await page.$eval(
        responseSelector,
        (el) => el.getAttribute('data-error')
      );

      const elapsedMs = Date.now() - startTime;

      if (errorFromExtension) {
        console.error(`[SmartFrame Canvas] Extension error: ${errorFromExtension}`);
        throw new CanvasExtensionError(imageId, errorFromExtension, elapsedMs);
      }

      if (!imageDataUrl || !imageDataUrl.startsWith('data:image/png;base64,')) {
        console.error('[SmartFrame Canvas] No valid canvas data URL received');
        throw new CanvasExtensionError(imageId, 'No valid canvas data URL received', elapsedMs);
      }

      // Extract base64 data
      const base64Data = imageDataUrl.split(',')[1];
      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Save as PNG (temporary intermediate file)
      const sanitizedId = imageId.replace(/[^a-zA-Z0-9.\-_]/g, '-');
      const pngFilename = `${sanitizedId}_canvas_${viewportMode}.png`;
      const pngPath = path.join(outputDir, pngFilename);

      fs.writeFileSync(pngPath, imageBuffer);
      console.log(`[SmartFrame Canvas] Saved intermediate PNG: ${pngPath}`);

      // TASK 3: Convert PNG to JPG using sharp
      const jpgQuality = viewportMode === 'full' 
        ? (this.config?.smartframe?.jpgQuality?.full || 95)
        : (this.config?.smartframe?.jpgQuality?.thumbnail || 80);
      
      const jpgFilename = `${sanitizedId}_canvas_${viewportMode}.jpg`;
      const jpgPath = path.join(outputDir, jpgFilename);

      console.log(`[SmartFrame Canvas] Converting PNG to JPG (quality: ${jpgQuality})...`);
      await sharp(imageBuffer)
        .jpeg({ quality: jpgQuality })
        .toFile(jpgPath);

      // Delete intermediate PNG file after successful JPG creation
      fs.unlinkSync(pngPath);
      console.log(`[SmartFrame Canvas] Deleted intermediate PNG file: ${pngFilename}`);
      console.log(`[SmartFrame Canvas] Saved JPG image: ${jpgPath}`);

      // TASK 4: File Validation
      const minFileSize = this.config?.smartframe?.minValidFileSize || 51200;
      const minDimensions = this.config?.smartframe?.minValidDimensions || 500;

      // Validate file size
      const fileStats = fs.statSync(jpgPath);
      const fileSizeBytes = fileStats.size;
      console.log(`[SmartFrame Canvas] Validating file size: ${fileSizeBytes} bytes (minimum: ${minFileSize} bytes)`);

      if (fileSizeBytes < minFileSize) {
        console.error(`[SmartFrame Canvas] ❌ VALIDATION FAILED: File size ${fileSizeBytes} bytes is below minimum ${minFileSize} bytes`);
        fs.unlinkSync(jpgPath);
        console.log(`[SmartFrame Canvas] Deleted invalid file: ${jpgFilename}`);
        throw new CanvasExtensionError(
          imageId,
          `File validation failed: size ${fileSizeBytes} bytes is below minimum ${minFileSize} bytes`,
          Date.now() - startTime
        );
      }

      // Validate image dimensions
      const imageInfo = await sharp(jpgPath).metadata();
      const width = imageInfo.width || 0;
      const height = imageInfo.height || 0;
      console.log(`[SmartFrame Canvas] Validating dimensions: ${width}x${height} (minimum: ${minDimensions}px)`);

      if (width < minDimensions || height < minDimensions) {
        console.error(`[SmartFrame Canvas] ❌ VALIDATION FAILED: Dimensions ${width}x${height} are below minimum ${minDimensions}px`);
        fs.unlinkSync(jpgPath);
        console.log(`[SmartFrame Canvas] Deleted invalid file: ${jpgFilename}`);
        throw new CanvasExtensionError(
          imageId,
          `File validation failed: dimensions ${width}x${height} are below minimum ${minDimensions}px`,
          Date.now() - startTime
        );
      }

      // Validation passed
      console.log(`[SmartFrame Canvas] ✅ VALIDATION PASSED: File size ${fileSizeBytes} bytes, dimensions ${width}x${height}`);
      console.log(`[SmartFrame Canvas] Successfully extracted and validated canvas image: ${jpgFilename}`);

      // TASK 3: Embed EXIF metadata if provided
      if (metadata) {
        await this.embedExifMetadata(jpgPath, metadata);
      } else {
        console.log(`[SmartFrame Canvas] No metadata provided, skipping EXIF embedding`);
      }

      return jpgPath;
    } catch (error) {
      console.error(`[SmartFrame Canvas] Error extracting canvas:`, error);
      return null;
    }
  }

  /**
   * Convert PNG to JPG (optional, for compatibility)
   * Note: This would require an image processing library like sharp
   * For now, we'll just return the PNG path
   */
  async convertToJpg(pngPath: string): Promise<string | null> {
    // TODO: Implement PNG to JPG conversion using sharp or similar library
    // For now, return the PNG path as-is
    console.log('[SmartFrame Canvas] PNG to JPG conversion not yet implemented, returning PNG');
    return pngPath;
  }
}
