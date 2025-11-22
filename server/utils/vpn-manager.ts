import { spawn } from 'child_process';

export type VPNClientType = 'nordvpn' | 'windscribe' | 'manual';
export type RotationStrategy = 'manual' | 'time' | 'count' | 'adaptive';

export interface VPNConfig {
  enabled: boolean;
  clientType: VPNClientType;
  command: string;
  connectionVerifyUrl: string;
  ipTrackingEndpoint: string;
  connectionVerifyTimeout: number;
  maxRetries: number;
  retryDelay: number;
  changeAfterFailures: number;
  rotationStrategy: RotationStrategy;
  rotationCount: number;
  rotationIntervalMs: number;
  serverList: string[];
}

interface VPNMetrics {
  lastRotationTime: number;
  scrapesSinceRotation: number;
  currentIP: string | null;
  consecutiveFailures: number;
}

export class VPNManager {
  private config: VPNConfig;
  private isConnected: boolean = false;
  private metrics: VPNMetrics = {
    lastRotationTime: Date.now(),
    scrapesSinceRotation: 0,
    currentIP: null,
    consecutiveFailures: 0,
  };
  private currentServerIndex: number = 0;

  constructor(config: VPNConfig) {
    this.config = config;
    this.logConfiguration();
  }

  private logConfiguration(): void {
    if (this.config.enabled) {
      console.log('\n' + '='.repeat(70));
      console.log('🔐 VPN MANAGER INITIALIZED');
      console.log('='.repeat(70));
      console.log(`Client Type: ${this.config.clientType}`);
      console.log(`Rotation Strategy: ${this.config.rotationStrategy}`);
      
      if (this.config.rotationStrategy === 'count') {
        console.log(`Rotation Trigger: Every ${this.config.rotationCount} scrapes`);
      } else if (this.config.rotationStrategy === 'time') {
        const minutes = Math.floor(this.config.rotationIntervalMs / 60000);
        console.log(`Rotation Trigger: Every ${minutes} minutes`);
      } else if (this.config.rotationStrategy === 'adaptive') {
        console.log(`Rotation Trigger: After ${this.config.changeAfterFailures} failures OR ${this.config.rotationCount} scrapes`);
      }
      
      if (this.config.serverList.length > 0) {
        console.log(`Server Pool: ${this.config.serverList.length} locations`);
      }
      console.log('='.repeat(70) + '\n');
    }
  }

  private async runCommand(command: string, args: string[]): Promise<string> {
    console.log(`🔧 Executing secure command: ${command} ${args.join(' ')}`);
    
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { 
        stdio: 'pipe',
        shell: false
      });
      
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => { 
        stdout += data.toString(); 
      });
      
      child.stderr.on('data', (data) => { 
        stderr += data.toString(); 
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Command failed with code ${code}: ${stderr.trim()}`));
        } else {
          resolve(stdout.trim());
        }
      });
      
      child.on('error', (err) => {
        reject(new Error(`Failed to start command: ${err.message}`));
      });
    });
  }

  private getNextServer(): string | null {
    if (this.config.serverList.length === 0) {
      return null;
    }

    const server = this.config.serverList[this.currentServerIndex];
    this.currentServerIndex = (this.currentServerIndex + 1) % this.config.serverList.length;
    return server;
  }

  private buildDisconnectCommand(): { command: string; args: string[] } {
    const baseCommand = this.config.command;

    switch (this.config.clientType) {
      case 'nordvpn':
        return { command: baseCommand, args: ['disconnect'] };
      case 'windscribe':
        return { command: baseCommand, args: ['disconnect'] };
      default:
        return { command: baseCommand, args: [] };
    }
  }

  private buildConnectCommand(targetServer?: string): { command: string; args: string[] } {
    const baseCommand = this.config.command;

    switch (this.config.clientType) {
      case 'nordvpn':
        if (targetServer) {
          return { command: baseCommand, args: ['connect', targetServer] };
        }
        return { command: baseCommand, args: ['connect'] };
      
      case 'windscribe':
        if (targetServer) {
          return { command: baseCommand, args: ['connect', targetServer] };
        }
        return { command: baseCommand, args: ['connect'] };
      
      default:
        return { command: baseCommand, args: [] };
    }
  }

  async getCurrentIP(): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(this.config.ipTrackingEndpoint, {
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const data = await response.json();
        return data.ip || null;
      }
    } catch (error) {
      console.warn('⚠️  Failed to fetch current IP:', error instanceof Error ? error.message : error);
    }
    return null;
  }

  async changeVPN(targetServer?: string): Promise<void> {
    if (!this.config.enabled) {
      console.log('VPN rotation is disabled');
      return;
    }

    if (this.config.clientType === 'manual') {
      console.log('\n' + '='.repeat(70));
      console.log('🔄 MANUAL VPN ROTATION REQUESTED');
      console.log('='.repeat(70));
      console.log('Please change your VPN connection manually and press Enter to continue.');
      console.log('='.repeat(70) + '\n');
      
      const oldIP = await this.getCurrentIP();
      if (oldIP) {
        console.log(`📍 Current IP before manual change: ${oldIP}`);
      }
      
      await this.waitForConnection();
      
      const newIP = await this.getCurrentIP();
      if (newIP && oldIP && newIP === oldIP) {
        console.warn('⚠️  WARNING: IP address did not change!');
        console.log(`Old IP: ${oldIP} | New IP: ${newIP}`);
      } else if (newIP) {
        console.log(`✅ IP successfully changed: ${oldIP || 'unknown'} → ${newIP}`);
        this.metrics.currentIP = newIP;
      }
      
      this.metrics.lastRotationTime = Date.now();
      this.metrics.scrapesSinceRotation = 0;
      this.metrics.consecutiveFailures = 0;
      
      console.log('='.repeat(70) + '\n');
      return;
    }

    console.log('\n' + '='.repeat(70));
    console.log('🔄 VPN ROTATION STARTED');
    console.log('='.repeat(70));

    const oldIP = await this.getCurrentIP();
    if (oldIP) {
      console.log(`📍 Current IP: ${oldIP}`);
    }

    try {
      const disconnectCmd = this.buildDisconnectCommand();
      try {
        await this.runCommand(disconnectCmd.command, disconnectCmd.args);
        console.log('✅ Stage 1/3: Disconnection command executed successfully');
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.warn('⚠️  Disconnection warning (non-critical):', error instanceof Error ? error.message : error);
      }

      const server = targetServer || this.getNextServer();
      const connectCmd = this.buildConnectCommand(server || undefined);
      
      if (server) {
        console.log(`🌍 Connecting to: ${server}`);
      } else {
        console.log('🌍 Connecting to auto-selected server');
      }

      await this.runCommand(connectCmd.command, connectCmd.args);
      console.log('✅ Stage 1/3: Connection command executed successfully');

    } catch (error) {
      console.error('❌ Stage 1/3: VPN command execution failed:', error instanceof Error ? error.message : error);
      throw new Error('VPN rotation failed');
    }

    await this.waitForConnection();

    const newIP = await this.getCurrentIP();
    if (newIP && oldIP && newIP === oldIP) {
      console.warn('⚠️  WARNING: IP address did not change!');
      console.log(`Old IP: ${oldIP} | New IP: ${newIP}`);
    } else if (newIP) {
      console.log(`✅ IP successfully changed: ${oldIP || 'unknown'} → ${newIP}`);
      this.metrics.currentIP = newIP;
    }

    this.metrics.lastRotationTime = Date.now();
    this.metrics.scrapesSinceRotation = 0;
    this.metrics.consecutiveFailures = 0;

    console.log('='.repeat(70) + '\n');
  }

  async waitForConnection(): Promise<void> {
    console.log('⏳ Verifying VPN connection (3-stage verification)...');
    
    let attempts = 0;
    const maxAttempts = this.config.maxRetries || 10;
    
    while (attempts < maxAttempts) {
      attempts++;
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.connectionVerifyTimeout);
        
        const response = await fetch(this.config.connectionVerifyUrl, {
          signal: controller.signal,
          method: 'HEAD'
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          console.log(`✅ Stage 2/3: Network connectivity verified (attempt ${attempts}/${maxAttempts})`);
          
          const ip = await this.getCurrentIP();
          if (ip) {
            console.log(`✅ Stage 3/3: IP address confirmed: ${ip}`);
            this.metrics.currentIP = ip;
          } else {
            console.log(`✅ Stage 3/3: Connection verified (IP tracking unavailable)`);
          }
          
          this.isConnected = true;
          return;
        }
      } catch (error) {
        console.log(`⚠️  Connection verification failed (attempt ${attempts}/${maxAttempts})`);
      }
      
      if (attempts < maxAttempts) {
        const delay = this.config.retryDelay || 2000;
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw new Error(`Failed to verify VPN connection after ${maxAttempts} attempts. Please check your VPN manually.`);
  }

  async ensureConnection(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const response = await fetch(this.config.connectionVerifyUrl, {
        signal: controller.signal,
        method: 'HEAD'
      });
      
      clearTimeout(timeoutId);
      this.isConnected = response.ok;
    } catch (error) {
      this.isConnected = false;
      console.warn('⚠️  Connection check failed, may need VPN rotation');
    }
  }

  shouldRotate(): { rotate: boolean; reason: string } {
    if (!this.config.enabled) {
      return { rotate: false, reason: 'VPN disabled' };
    }

    switch (this.config.rotationStrategy) {
      case 'manual':
        return { rotate: false, reason: 'Manual rotation only' };
      
      case 'count':
        if (this.config.rotationCount > 0 && this.metrics.scrapesSinceRotation >= this.config.rotationCount) {
          return { rotate: true, reason: `Scrape count threshold reached (${this.metrics.scrapesSinceRotation}/${this.config.rotationCount})` };
        }
        return { rotate: false, reason: `Scrape count: ${this.metrics.scrapesSinceRotation}/${this.config.rotationCount}` };
      
      case 'time':
        if (this.config.rotationIntervalMs > 0) {
          const timeSinceRotation = Date.now() - this.metrics.lastRotationTime;
          if (timeSinceRotation >= this.config.rotationIntervalMs) {
            const minutes = Math.floor(timeSinceRotation / 60000);
            return { rotate: true, reason: `Time interval reached (${minutes} minutes)` };
          }
          const remainingMs = this.config.rotationIntervalMs - timeSinceRotation;
          const remainingMinutes = Math.floor(remainingMs / 60000);
          return { rotate: false, reason: `${remainingMinutes} minutes until next rotation` };
        }
        return { rotate: false, reason: 'No time interval set' };
      
      case 'adaptive':
        if (this.metrics.consecutiveFailures >= this.config.changeAfterFailures) {
          return { rotate: true, reason: `Failure threshold reached (${this.metrics.consecutiveFailures}/${this.config.changeAfterFailures})` };
        }
        if (this.config.rotationCount > 0 && this.metrics.scrapesSinceRotation >= this.config.rotationCount) {
          return { rotate: true, reason: `Scrape count threshold reached (${this.metrics.scrapesSinceRotation}/${this.config.rotationCount})` };
        }
        if (this.config.rotationIntervalMs > 0) {
          const timeSinceRotation = Date.now() - this.metrics.lastRotationTime;
          if (timeSinceRotation >= this.config.rotationIntervalMs) {
            const minutes = Math.floor(timeSinceRotation / 60000);
            return { rotate: true, reason: `Time interval reached (${minutes} minutes)` };
          }
        }
        const remainingMs = this.config.rotationIntervalMs > 0 ? this.config.rotationIntervalMs - (Date.now() - this.metrics.lastRotationTime) : 0;
        const remainingMinutes = Math.floor(remainingMs / 60000);
        return { 
          rotate: false, 
          reason: `Failures: ${this.metrics.consecutiveFailures}/${this.config.changeAfterFailures}, Scrapes: ${this.metrics.scrapesSinceRotation}/${this.config.rotationCount}, Time: ${remainingMinutes}min remaining` 
        };
      
      default:
        return { rotate: false, reason: 'Unknown strategy' };
    }
  }

  recordScrapeSuccess(): void {
    if (this.config.rotationStrategy !== 'manual') {
      this.metrics.scrapesSinceRotation++;
    }
    this.metrics.consecutiveFailures = 0;
  }

  recordScrapeFailure(): void {
    if (this.config.rotationStrategy !== 'manual') {
      this.metrics.consecutiveFailures++;
    }
  }

  getMetrics(): VPNMetrics {
    return { ...this.metrics };
  }

  isVPNConnected(): boolean {
    return this.isConnected;
  }

  static createDefaultConfig(): VPNConfig {
    return {
      enabled: false,
      clientType: 'manual',
      command: '',
      connectionVerifyUrl: 'https://www.google.com',
      ipTrackingEndpoint: 'https://api.ipify.org?format=json',
      connectionVerifyTimeout: 5000,
      maxRetries: 10,
      retryDelay: 2000,
      changeAfterFailures: 5,
      rotationStrategy: 'manual',
      rotationCount: 500,
      rotationIntervalMs: 3600000,
      serverList: [],
    };
  }
}
