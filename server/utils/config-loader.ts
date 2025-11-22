import fs from 'fs';
import path from 'path';
import type { ScraperConfig } from '../types';

/**
 * Default configuration values for the scraper
 * Used as fallback when scraper.config.json cannot be loaded
 */
const DEFAULT_CONFIG: ScraperConfig = {
  vpn: { 
    enabled: false, 
    changeAfterFailures: 5 
  },
  waitTimes: { 
    scrollDelay: 1000, 
    minVariance: 2000, 
    maxVariance: 5000 
  },
  scraping: { 
    concurrency: 5, 
    maxRetryRounds: 2, 
    retryDelay: 5000, 
    detectEmptyResults: true 
  },
  navigation: { 
    timeout: 60000, 
    waitUntil: 'domcontentloaded', 
    maxConcurrentJobs: 3 
  },
  smartframe: { 
    extractFullImages: false, 
    viewportMode: 'thumbnail', 
    headless: false, 
    renderTimeout: 5000 
  }
};

/**
 * Load scraper configuration from scraper.config.json
 * Falls back to default configuration if file cannot be loaded
 * 
 * @returns ScraperConfig object with all configuration settings
 */
export function loadScraperConfig(): ScraperConfig {
  try {
    const configPath = path.join(process.cwd(), 'scraper.config.json');
    const configData = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configData) as ScraperConfig;
    console.log('✓ Loaded scraper configuration from scraper.config.json');
    return config;
  } catch (error) {
    console.warn('⚠️  Could not load scraper.config.json, using defaults:', error instanceof Error ? error.message : error);
    return DEFAULT_CONFIG;
  }
}
