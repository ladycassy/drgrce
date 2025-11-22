# SmartFrame Scraper

## Overview
This project is a professional image metadata extraction tool designed to scrape image metadata from SmartFrame.com search results. It enables users to extract detailed information from images and export the results in JSON or CSV format. The application aims to provide a robust and efficient solution for gathering image data, including advanced features like VPN IP rotation to ensure reliable and undetected scraping operations.

## Recent Changes (November 22, 2025)
- **SmartFrame Canvas Scraping Performance Optimization**: Implemented parallel processing architecture for 3x throughput improvement:
  - **Concurrent Tab Processing**: Created PageActivationScheduler for round-robin tab activation (3 concurrent tabs with 500ms rotation)
  - **Anti-Throttling Browser Flags**: Added Chrome flags to prevent background tab throttling (--disable-background-timer-throttling, --disable-renderer-backgrounding, etc.)
  - **Event-Driven Waits**: Replaced fixed 29s delays (19s + 10s) with smart exponential backoff polling (100ms → 2s max), reducing average wait time by 3-5x
  - **Configurable Concurrency**: Canvas extraction now supports 3 concurrent pages (configurable via canvasConcurrency setting)
  - **Performance Gains**: Expected 3x throughput for canvas extraction while maintaining GPU rendering quality
  - **Configuration Updates**: Updated scraper.config.json with tabActivationIntervalMs (500ms), maxRenderWaitMs (30s), reduced initialRenderWaitMs (2s), and pageRecreationInterval (5 images)

- **GitHub Import Setup**: Successfully imported and configured project from GitHub to run in Replit environment:
  - Installed all npm dependencies (539 packages)
  - Configured Dev Server workflow on port 5000 with webview output
  - Set up deployment configuration for VM target (required for Puppeteer)
  - Created .gitignore file for Node.js project
  - Verified application is working correctly with PostgreSQL database
  - Frontend properly configured with allowedHosts for Replit proxy support
  
## Previous Changes (November 21, 2025)
- **Enhanced Metadata Extraction**: Comprehensive improvements to SmartFrame scraper reliability:
  - **Structured Caption Parsing**: Enhanced DOM extraction to parse structured metadata from caption paragraphs (Featuring/Where/When/Credit fields) with support for multiple separator types (colon, em-dash, en-dash, hyphen)
  - **Network Cache Fallback**: Integrated network metadata cache as intelligent fallback layer, preventing data loss during retries or incomplete DOM extraction
  - **Safe Merge Strategy**: Fixed critical regression bug where undefined values would overwrite existing data during retries - now only overwrites when new values are truthy and non-empty
  - **Validation & Auto-Fallback**: Added metadata completeness validation with automatic fallback to network cache when 3+ fields are missing, significantly improving Comments field quality
  - **Enhanced Regex Patterns**: Upgraded caption text parsing to handle variant punctuation, case-insensitive matching, and multiple date formats (DD MMM YYYY, DD.MM.YY)
- **Metadata-Rich Comments Field**: Enhanced Comments field to ALWAYS generate structured, metadata-rich descriptions combining title with formatted metadata fields. Format: "{title}\nFeaturing: {featuring}\nWhere: {city, country}\nWhen: {date}\nCredit: {credit}". Example output: "Lee Latchford-Evans outside ITV Studios\nFeaturing: Lee Latchford-Evans\nWhere: London, United Kingdom\nWhen: 18 Jul 2016\nCredit: Rocky/WENN.com"
- **API Export URLs in Console**: Added console logging to display direct API export URLs (CSV and JSON) when scrape jobs complete for easy copy-paste access
- **React Query Refetch Fix**: Fixed export button visibility issue by adding `refetchOnWindowFocus: true` and `staleTime: 0` to ensure UI refreshes job data after scraping completes
- **CRITICAL BUG FIX - High Resolution Canvas Export**: Fixed critical bug where images were never persisted to database when using High Resolution (9999x9999) canvas extraction mode. The scraper's `onProgress` callback was only updating progress counters but not passing the `images` array to `storage.updateScrapeJob`, preventing CSV export button from appearing. Now images are incrementally persisted during scraping regardless of canvas extraction mode, enabling CSV export for all scraping scenarios.
- **Replit Environment Setup**: Successfully configured project for Replit environment with workflow for dev server on port 5000, deployment configuration for VM target, flexible database support (PostgreSQL in Replit, SQLite for local), and proper .gitignore for Node.js
- **CSV Export UX Improvements**: Enhanced CSV export discoverability with automatic completion notifications, prominent export button with image count badge, and CSV as default export format
- **EXIF Metadata Compatibility**: Verified and documented CSV column mapping to EXIF metadata standards (Title Field → EXIF Title, Subject Field → EXIF Subject, Authors → EXIF Artist, Date Taken → EXIF DateTimeOriginal, Copyright → EXIF Copyright)
- **Canvas Extraction + CSV**: Confirmed that canvas extraction saves metadata to database for CSV export while also embedding EXIF data into extracted images using exiftool
- **Agency Prefix Retention**: Disabled automatic stripping of Agency prefixes (WENN, Getty Images, Reuters, etc.) from Subject field - prefixes are now retained in extracted metadata

## User Preferences
- Prefer CSV export format for scraped metadata
- Expect automatic notification when scraping completes with direct CSV export option

## Replit Setup
This project is configured to run in the Replit environment with the following setup:

### Workflow Configuration
- **Dev Server**: `npm run dev` runs on port 5000 (frontend + backend)
- **Host**: Configured to bind to `0.0.0.0:5000` with `allowedHosts: true` for Replit proxy support
- **WebSocket**: HMR configured with `clientPort: 443` for Replit environment

### Deployment
- **Target**: VM deployment (required for Puppeteer and stateful operations)
- **Build**: `npm run build` (compiles Vite frontend and bundles Express backend)
- **Run**: `npm run start` (serves production build)

### Database
- **Production/Replit**: PostgreSQL (via DATABASE_URL environment variable)
- **Local Development**: SQLite (stored in `./data/local.db`)
- **Auto-switching**: Database selection is automatic based on environment

### Environment Variables
- `DATABASE_URL`: PostgreSQL connection string (provided by Replit)
- `REPL_ID`: Replit environment identifier (auto-set)
- `NODE_ENV`: Set to "development" or "production"
- `PORT`: Server port (defaults to 5000)

## System Architecture
The application uses a React, Vite, and Tailwind CSS frontend with Radix UI components, an Express.js backend with TypeScript, and PostgreSQL (with SQLite for development) for the database. A Puppeteer-based web scraper handles the core scraping logic.

Key Architectural Decisions and Features:
- **Bulk URL Scraping**: Supports scraping up to 50 URLs per request with real-time progress tracking via WebSockets.
- **Configurable Scraping**: Options for maximum images, auto-scroll behavior, and concurrency levels.
- **Canvas Extraction**: Advanced mechanism for high-quality image extraction, including a critical fix for viewport-aware full-resolution rendering by setting the viewport and element dimensions to 9999x9999 for full-mode extraction and implementing a polling loop to wait for SmartFrame's CSS variables to populate before proceeding with canvas resizing and extraction.
- **Metadata Normalization**: Standardizes extracted metadata fields (title, subject, tags, comments, authors, date taken, copyright).
- **VPN IP Rotation System**: Integrates with NordVPN and Windscribe CLIs, offering multiple rotation strategies (manual, time-based, count-based, adaptive) with secure command execution and IP tracking.
- **Performance Optimizations**: Significant bundle size reduction (removed 72 unused npm packages, 23% CSS bundle reduction), code splitting with `React.lazy()` and `Suspense`, optimized React component rendering using `useMemo` and `useCallback`, and build optimizations (Terser minification, production console.log removal).
- **Sequential Processing**: Enhanced scraping reliability with ordered sequential mode, configurable inter-tab delays, and automatic tab activation.
- **Database**: Uses Drizzle ORM for schema management, with PostgreSQL for production and SQLite for local development.
- **Deployment**: Configured for VM deployment on Replit, running frontend and backend on port 5000.
- **UI/UX**: Utilizes Radix UI for components, with a focus on user-friendly configuration panels for features like VPN settings.

## External Dependencies
- **Frontend**: React, Vite, Tailwind CSS, Wouter (routing), TanStack Query (data fetching), Radix UI.
- **Backend**: Express.js, TypeScript, Drizzle ORM, Puppeteer, WebSocket.
- **Database**: PostgreSQL (@neondatabase/serverless), SQLite (better-sqlite3).
- **VPN Services**: NordVPN CLI, Windscribe CLI.