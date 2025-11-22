import { Page } from 'puppeteer';

interface PageState {
  page: Page;
  busy: boolean;
  lastActivated: number;
}

interface AcquiredPage {
  page: Page;
  index: number;
  release: () => void;
}

/**
 * PageActivationScheduler - Manages concurrent page pool with round-robin activation
 * 
 * This scheduler ensures that multiple Puppeteer pages get periodic GPU rendering time
 * by rotating which tab is "active" (brought to front). This is critical for SmartFrame
 * canvas extraction which requires tabs to be visible for GPU-accelerated rendering.
 */
export class PageActivationScheduler {
  private pages: PageState[] = [];
  private activationIntervalMs: number = 500;
  private rotationTimerId: NodeJS.Timeout | null = null;
  private currentActiveIndex: number = 0;
  private activeTasks: Set<Promise<void>> = new Set();
  private shuttingDown: boolean = false;
  private cleanupStarted: Promise<void> | null = null;
  private cleanupResolver: (() => void) | null = null;

  constructor(pages: Page[], activationIntervalMs: number = 500) {
    this.pages = pages.map(page => ({
      page,
      busy: false,
      lastActivated: 0
    }));
    this.activationIntervalMs = activationIntervalMs;
    console.log(`[PageScheduler] Created pool with ${pages.length} pages, rotation interval: ${activationIntervalMs}ms`);
  }

  /**
   * Start background rotation of tab focus
   * This keeps all tabs "hot" for GPU rendering
   */
  startRotation(): void {
    if (this.rotationTimerId) {
      console.log('[PageScheduler] Rotation already running');
      return;
    }

    this.rotationTimerId = setInterval(async () => {
      await this.rotateActivePage();
    }, this.activationIntervalMs);
    
    console.log('[PageScheduler] Background tab rotation started');
  }

  /**
   * Stop background rotation
   */
  stopRotation(): void {
    if (this.rotationTimerId) {
      clearInterval(this.rotationTimerId);
      this.rotationTimerId = null;
      console.log('[PageScheduler] Background tab rotation stopped');
    }
  }

  /**
   * Rotate to next page (for tracking purposes only - does NOT bring to front)
   * CRITICAL FIX: Check shuttingDown flag before mouse movement
   * Pages are only brought to front when explicitly acquired via acquirePage()
   */
  private async rotateActivePage(): Promise<void> {
    // Check if shutting down - stop interacting with pages
    if (this.shuttingDown) {
      return;
    }

    try {
      this.currentActiveIndex = (this.currentActiveIndex + 1) % this.pages.length;
      const pageState = this.pages[this.currentActiveIndex];
      
      // DO NOT call bringToFront() here - it causes focus thrashing
      // Only track timestamp for rotation monitoring
      pageState.lastActivated = Date.now();
      
      // Optional: Simulate subtle mouse movement to keep canvas "hot"
      // This helps prevent GPU throttling on some systems
      // Skip if shutting down
      if (!this.shuttingDown) {
        try {
          const x = 400 + Math.random() * 200;
          const y = 400 + Math.random() * 200;
          await pageState.page.mouse.move(x, y);
        } catch (error) {
          // Mouse movement is optional, ignore errors
        }
      }
    } catch (error) {
      console.error('[PageScheduler] Error during rotation:', error instanceof Error ? error.message : error);
    }
  }

  /**
   * Get next available page for work
   * Returns a task tracking object with release function
   * This will wait if all pages are busy, but returns null immediately if shutdown is in progress
   */
  async acquirePage(timeoutMs: number = 60000): Promise<AcquiredPage | null> {
    const startTime = Date.now();
    
    // Create promise that resolves when cleanup starts
    const cleanupWatcher = this.cleanupStarted ? 
      this.cleanupStarted.then(() => null) : 
      new Promise<null>(() => {}); // Never resolves if no cleanup
    
    while (Date.now() - startTime < timeoutMs) {
      // Check shuttingDown flag - return null immediately if shutdown in progress
      if (this.shuttingDown) {
        console.log('[PageScheduler] Shutdown in progress, returning null from acquirePage');
        return null;
      }

      const availableIndex = this.pages.findIndex(p => !p.busy);
      
      if (availableIndex !== -1) {
        const pageState = this.pages[availableIndex];
        pageState.busy = true;
        
        // Bring this page to front immediately to ensure it's active
        await pageState.page.bringToFront();
        pageState.lastActivated = Date.now();
        
        // Create a task promise and release function
        let taskResolver: (() => void) | null = null;
        const taskPromise = new Promise<void>((resolve) => {
          taskResolver = resolve;
        });
        
        // Add task promise to Set
        this.activeTasks.add(taskPromise);
        
        const release = () => {
          if (this.pages[availableIndex]) {
            this.pages[availableIndex].busy = false;
          }
          // Remove task promise from Set when released
          this.activeTasks.delete(taskPromise);
          if (taskResolver) {
            taskResolver();
          }
          console.log(`[PageScheduler] Released page ${availableIndex}, ${this.getBusyCount()}/${this.pages.length} busy, ${this.activeTasks.size} active tasks`);
        };
        
        console.log(`[PageScheduler] Acquired page ${availableIndex}, ${this.getBusyCount()}/${this.pages.length} busy, ${this.activeTasks.size} active tasks`);
        return { page: pageState.page, index: availableIndex, release };
      }
      
      // Wait a bit before checking again, or until cleanup starts
      const waitPromise = new Promise(resolve => setTimeout(resolve, 100));
      await Promise.race([waitPromise, cleanupWatcher]);
      
      // If cleanupWatcher resolved, check shuttingDown flag on next iteration
    }
    
    console.error('[PageScheduler] Timeout waiting for available page');
    return null;
  }

  /**
   * Get count of busy pages
   */
  private getBusyCount(): number {
    return this.pages.filter(p => p.busy).length;
  }

  /**
   * Get pool statistics
   */
  getStats(): { total: number; busy: number; available: number; activeTasks: number } {
    const busy = this.getBusyCount();
    return {
      total: this.pages.length,
      busy,
      available: this.pages.length - busy,
      activeTasks: this.activeTasks.size
    };
  }

  /**
   * Cleanup all pages and stop rotation
   * CRITICAL FIX: Set shuttingDown flag, wait for tasks with timeout, then force-close
   * @param closePages - Whether to close the pages (default: true). Set to false if caller will close them.
   */
  async cleanup(timeoutMs: number = 30000, closePages: boolean = true): Promise<void> {
    console.log('[PageScheduler] Cleaning up page pool...');
    
    // Set shuttingDown flag at start
    this.shuttingDown = true;
    
    // Resolve cleanupStarted promise to wake waiters
    if (!this.cleanupStarted) {
      this.cleanupStarted = new Promise((resolve) => {
        this.cleanupResolver = resolve;
      });
    }
    if (this.cleanupResolver) {
      this.cleanupResolver();
    }
    
    this.stopRotation();
    
    // Wait for all active tasks to complete with timeout
    if (this.activeTasks.size > 0) {
      console.log(`[PageScheduler] Waiting for ${this.activeTasks.size} active tasks to complete...`);
      const startTime = Date.now();
      
      // Use Promise.race to wait for tasks or timeout
      const allTasksPromise = Promise.all(Array.from(this.activeTasks));
      const timeoutPromise = new Promise<void>((resolve) => 
        setTimeout(resolve, timeoutMs)
      );
      
      await Promise.race([allTasksPromise, timeoutPromise]);
      
      const elapsedMs = Date.now() - startTime;
      
      if (this.activeTasks.size > 0) {
        console.warn(`[PageScheduler] Timeout waiting for tasks - ${this.activeTasks.size} tasks still active after ${elapsedMs}ms`);
        console.warn(`[PageScheduler] Forcing cleanup despite hanging tasks`);
      } else {
        console.log(`[PageScheduler] All active tasks completed in ${elapsedMs}ms`);
      }
    }
    
    // Close all pages if requested
    if (closePages) {
      await Promise.all(
        this.pages.map(ps => ps.page.close().catch(() => {}))
      );
    }
    
    this.pages = [];
    console.log('[PageScheduler] Cleanup complete');
  }
}
