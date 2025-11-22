import fs from 'fs';
import path from 'path';
import os from 'os';
import { MANIFEST_JSON, BACKGROUND_JS, CONTENT_SCRIPT_JS } from './extension-files';

/**
 * SmartFrame Extension Manager
 * Manages the Chrome extension used for canvas extraction
 */
export class SmartFrameExtensionManager {
  private extensionDir: string | null = null;

  /**
   * Set up the Chrome extension files in a temporary directory
   * @returns Path to the extension directory
   */
  async setupExtension(): Promise<string> {
    // Create a temporary directory for the extension
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartframe-extension-'));
    this.extensionDir = tempDir;

    console.log(`Creating SmartFrame extension in: ${tempDir}`);

    // Write manifest.json
    const manifestPath = path.join(tempDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST_JSON, null, 2));

    // Write background.js
    const backgroundPath = path.join(tempDir, 'background.js');
    fs.writeFileSync(backgroundPath, BACKGROUND_JS);

    // Write content_script.js
    const contentScriptPath = path.join(tempDir, 'content_script.js');
    fs.writeFileSync(contentScriptPath, CONTENT_SCRIPT_JS);

    console.log('✓ Chrome extension files created successfully');

    return tempDir;
  }

  /**
   * Clean up the extension directory
   */
  cleanup(): void {
    if (this.extensionDir && fs.existsSync(this.extensionDir)) {
      try {
        fs.rmSync(this.extensionDir, { recursive: true, force: true });
        console.log(`✓ Cleaned up extension directory: ${this.extensionDir}`);
        this.extensionDir = null;
      } catch (error) {
        console.error(`Failed to clean up extension directory:`, error);
      }
    }
  }

  /**
   * Get the extension directory path
   */
  getExtensionDir(): string | null {
    return this.extensionDir;
  }
}
