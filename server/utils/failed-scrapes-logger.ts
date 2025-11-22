import fs from 'fs';
import path from 'path';

export interface FailedScrape {
  jobId: string;
  imageId: string;
  url: string;
  reason: string;
  attempts: number;
  timestamp: string;
  httpStatus?: number;
  retryAttempt?: number;
}

class FailedScrapesLogger {
  private logFilePath: string;
  private currentJobId: string | null = null;
  private failedScrapes: FailedScrape[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    const logDir = path.join(process.cwd(), 'failed-scrapes');
    this.ensureLogDirectory(logDir);
    this.logFilePath = path.join(logDir, 'failed-scrapes.txt');
  }

  private ensureLogDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  startJob(jobId: string): void {
    this.currentJobId = jobId;
    this.failedScrapes = [];
  }

  addFailure(failure: Omit<FailedScrape, 'jobId'>): void {
    if (!this.currentJobId) {
      console.warn('⚠️  Cannot add failure: no active job');
      return;
    }
    
    this.failedScrapes.push({
      ...failure,
      jobId: this.currentJobId
    });
  }

  async writeLogFile(): Promise<string | null> {
    if (this.failedScrapes.length === 0) {
      return null;
    }

    // Queue the write to prevent concurrent writes
    this.writeQueue = this.writeQueue.then(() => this.appendToLogFile());
    await this.writeQueue;

    return this.logFilePath;
  }

  private async appendToLogFile(): Promise<void> {
    if (this.failedScrapes.length === 0) {
      return;
    }

    const fileExists = fs.existsSync(this.logFilePath);
    
    let content = '';

    // Add separator if file already exists
    if (fileExists) {
      content += '\n\n';
    }

    // Add job header
    content += [
      '═'.repeat(80),
      `JOB: ${this.currentJobId}`,
      `Failed Images: ${this.failedScrapes.length}`,
      `Generated: ${new Date().toLocaleString()}`,
      '═'.repeat(80),
      '',
    ].join('\n');

    // Add entries
    content += this.failedScrapes.map((failure, index) => {
      const lines = [
        `[${index + 1}/${this.failedScrapes.length}] Image ID: ${failure.imageId}`,
        `Job ID: ${failure.jobId}`,
        `URL: ${failure.url}`,
        `Reason: ${failure.reason}`,
        `Attempts: ${failure.attempts}`,
      ];

      if (failure.retryAttempt !== undefined) {
        lines.push(`Retry Attempt: ${failure.retryAttempt}`);
      }

      if (failure.httpStatus) {
        lines.push(`HTTP Status: ${failure.httpStatus}`);
      }

      lines.push(`Timestamp: ${failure.timestamp}`);
      lines.push('─'.repeat(80));
      
      return lines.join('\n');
    }).join('\n');

    // Append to file
    await fs.promises.appendFile(this.logFilePath, content, 'utf-8');
    console.log(`\n📝 Failed scrapes appended to: ${this.logFilePath}\n`);
    
    // Clear buffer after successful write to prevent duplicates
    this.failedScrapes = [];
  }

  removeSuccess(imageId: string): void {
    const initialLength = this.failedScrapes.length;
    this.failedScrapes = this.failedScrapes.filter(f => f.imageId !== imageId);
    
    if (this.failedScrapes.length < initialLength) {
      console.log(`✅ Removed ${imageId} from failed list (retry successful)`);
    }
  }

  getFailureCount(): number {
    return this.failedScrapes.length;
  }

  getFailures(): FailedScrape[] {
    return [...this.failedScrapes];
  }

  reset(): void {
    this.currentJobId = null;
    this.failedScrapes = [];
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  async readFailuresFromFile(): Promise<FailedScrape[]> {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return [];
      }

      const content = await fs.promises.readFile(this.logFilePath, 'utf-8');
      const failures: FailedScrape[] = [];
      
      const lines = content.split('\n');
      let currentFailure: Partial<FailedScrape> = {};
      
      for (const line of lines) {
        if (line.includes('Image ID:')) {
          const imageId = line.split('Image ID:')[1]?.trim();
          if (imageId) currentFailure.imageId = imageId;
        } else if (line.includes('Job ID:')) {
          const jobId = line.split('Job ID:')[1]?.trim();
          if (jobId) currentFailure.jobId = jobId;
        } else if (line.includes('URL:')) {
          const url = line.split('URL:')[1]?.trim();
          if (url) currentFailure.url = url;
        } else if (line.includes('Reason:')) {
          const reason = line.split('Reason:')[1]?.trim();
          if (reason) currentFailure.reason = reason;
        } else if (line.includes('Attempts:')) {
          const attempts = parseInt(line.split('Attempts:')[1]?.trim() || '0');
          if (!isNaN(attempts)) currentFailure.attempts = attempts;
        } else if (line.includes('HTTP Status:')) {
          const status = parseInt(line.split('HTTP Status:')[1]?.trim() || '0');
          if (!isNaN(status)) currentFailure.httpStatus = status;
        } else if (line.includes('Timestamp:')) {
          const timestamp = line.split('Timestamp:')[1]?.trim();
          if (timestamp) currentFailure.timestamp = timestamp;
          
          if (currentFailure.imageId && currentFailure.jobId && currentFailure.url && 
              currentFailure.reason && currentFailure.attempts && currentFailure.timestamp) {
            failures.push(currentFailure as FailedScrape);
          }
          currentFailure = {};
        }
      }
      
      console.log(`📖 Read ${failures.length} failed scrapes from log file`);
      return failures;
    } catch (error) {
      console.error('Error reading failed scrapes file:', error);
      return [];
    }
  }

  async removeFromFile(successfulImageIds: string[]): Promise<void> {
    try {
      if (!fs.existsSync(this.logFilePath) || successfulImageIds.length === 0) {
        return;
      }

      const content = await fs.promises.readFile(this.logFilePath, 'utf-8');
      const lines = content.split('\n');
      const filteredLines: string[] = [];
      let skipBlock = false;
      let currentImageId = '';
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.includes('Image ID:')) {
          const imageId = line.split('Image ID:')[1]?.trim();
          currentImageId = imageId || '';
          skipBlock = successfulImageIds.includes(currentImageId);
        }
        
        if (line.match(/^─{80}$/)) {
          skipBlock = false;
          currentImageId = '';
        }
        
        if (!skipBlock) {
          filteredLines.push(line);
        }
      }
      
      await fs.promises.writeFile(this.logFilePath, filteredLines.join('\n'), 'utf-8');
      console.log(`✅ Removed ${successfulImageIds.length} successful retries from failed-scrapes.txt`);
    } catch (error) {
      console.error('Error removing from failed scrapes file:', error);
    }
  }
}

export const failedScrapesLogger = new FailedScrapesLogger();
