export interface WaitTimeConfig {
  baseDelay: number;
  minVariance: number;
  maxVariance: number;
}

export class WaitTimeHelper {
  private config: WaitTimeConfig;

  constructor(config: WaitTimeConfig) {
    this.config = config;
  }

  getRandomDelay(): number {
    const variance = Math.random() * (this.config.maxVariance - this.config.minVariance) + this.config.minVariance;
    const totalDelay = this.config.baseDelay + variance;
    return Math.round(totalDelay);
  }

  async wait(customBase?: number): Promise<void> {
    const baseDelay = customBase !== undefined ? customBase : this.config.baseDelay;
    const variance = Math.random() * (this.config.maxVariance - this.config.minVariance) + this.config.minVariance;
    const totalDelay = baseDelay + variance;
    const delay = Math.round(totalDelay);
    
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  static createDefault(): WaitTimeHelper {
    return new WaitTimeHelper({
      baseDelay: 1000,
      minVariance: 2000,
      maxVariance: 5000
    });
  }

  static createFromConfig(scrollDelay: number, minExtra: number = 2000, maxExtra: number = 5000): WaitTimeHelper {
    return new WaitTimeHelper({
      baseDelay: scrollDelay,
      minVariance: minExtra,
      maxVariance: maxExtra
    });
  }
}
