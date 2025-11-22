/**
 * SmartFrame Canvas Extractor Chrome Extension
 * Ported from Python smartframe_extractor.py
 * 
 * This module contains the Chrome extension files (manifest.json, background.js, content_script.js)
 * and injected JavaScript needed to extract canvas images from SmartFrame embeds.
 */

export const MANIFEST_JSON = {
  manifest_version: 3,
  name: "Canvas Data Extractor",
  version: "2.0",
  description: "Extracts data from a canvas, bypassing taint restrictions (Manifest V3).",
  permissions: ["scripting"],
  host_permissions: ["<all_urls>"],
  background: {
    service_worker: "background.js"
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["content_script.js"],
      run_at: "document_start"
    }
  ],
  web_accessible_resources: [
    {
      resources: ["*"],
      matches: ["<all_urls>"]
    }
  ]
};

export const BACKGROUND_JS = `
console.log("Canvas Extractor V3: Service Worker loaded.");

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Canvas Extractor V3: Message received in service worker.", request);
  
  if (request.action === "getCanvasDataURL") {
    console.log(\`Canvas Extractor V3: Executing script in tab \${sender.tab.id} to get canvas data.\`);
    
    // Manifest V3: Use chrome.scripting.executeScript instead of chrome.tabs.executeScript
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN', // CRITICAL: Run in MAIN world to access window.__smartFrameShadowRoot
      func: (selector) => {
        console.log('Canvas Extractor [Privileged]: Script started in page context.');
          const selectorsToTry = [];
          if (selector) {
            selectorsToTry.push(selector);
          }
          if (window.__SMARTFRAME_TARGET_IMAGE_ID) {
            selectorsToTry.push(\`smartframe-embed[image-id="\${window.__SMARTFRAME_TARGET_IMAGE_ID}"]\`);
          }
          selectorsToTry.push('smartframe-embed:not([thumbnail-mode])');
          selectorsToTry.push('smartframe-embed');

          let smartframeEmbed = null;
          for (const candidateSelector of selectorsToTry) {
            try {
              const candidate = document.querySelector(candidateSelector);
              if (candidate) {
                smartframeEmbed = candidate;
                console.log(\`Canvas Extractor [Privileged]: smartframe-embed resolved via selector '\${candidateSelector}'.\`);
                break;
              }
            } catch (err) {
              console.warn(\`Canvas Extractor [Privileged]: Selector '\${candidateSelector}' threw an error:\`, err);
            }
          }

          if (!smartframeEmbed) {
            console.error('Canvas Extractor [Privileged]: smartframe-embed not found.');
            return { error: 'smartframe-embed element not found' };
          }
        console.log('Canvas Extractor [Privileged]: smartframe-embed found.');
        
        // Function to search for canvas with retry logic
        // Increased from 10 to 15 attempts and delay from 500ms to 1000ms for large canvas dimensions (9999x9999)
        function findCanvas(maxAttempts = 15, delay = 1000) {
          return new Promise((resolve) => {
            let attempts = 0;
            
            function tryFind() {
              attempts++;
              console.log(\`Canvas Extractor [Privileged]: Search attempt \${attempts}/\${maxAttempts}\`);
              
              let canvas = null;
              
              // First, try to use the captured shadow root from window object
              if (window.__smartFrameShadowRoot) {
                console.log('Canvas Extractor [Privileged]: Checking captured shadow root...');
                const allCanvases = window.__smartFrameShadowRoot.querySelectorAll('canvas');
                console.log(\`Canvas Extractor [Privileged]: Found \${allCanvases.length} canvas element(s) in captured shadowRoot\`);
                
                canvas = window.__smartFrameShadowRoot.querySelector('canvas.stage');
                if (!canvas) {
                  canvas = window.__smartFrameShadowRoot.querySelector('canvas');
                }
                if (canvas) {
                  console.log('Canvas Extractor [Privileged]: Canvas found in captured shadowRoot');
                }
              } else {
                console.log('Canvas Extractor [Privileged]: window.__smartFrameShadowRoot is null/undefined');
              }
              
              // If not found via captured reference, try direct shadowRoot access
              if (!canvas) {
                const shadowRoot = smartframeEmbed.shadowRoot;
                if (shadowRoot) {
                  console.log('Canvas Extractor [Privileged]: Checking direct shadowRoot access...');
                  const allCanvases = shadowRoot.querySelectorAll('canvas');
                  console.log(\`Canvas Extractor [Privileged]: Found \${allCanvases.length} canvas element(s) in direct shadowRoot\`);
                  
                  canvas = shadowRoot.querySelector('canvas.stage');
                  if (!canvas) {
                    canvas = shadowRoot.querySelector('canvas');
                  }
                  if (canvas) {
                    console.log('Canvas Extractor [Privileged]: Canvas found in shadowRoot via direct access');
                  }
                } else {
                  console.log('Canvas Extractor [Privileged]: smartframeEmbed.shadowRoot is null');
                }
              }
              
              // Fallback to searching the entire document if not found in shadow DOM
              if (!canvas) {
                console.log('Canvas Extractor [Privileged]: Searching in document...');
                const allCanvases = document.querySelectorAll('canvas');
                console.log(\`Canvas Extractor [Privileged]: Found \${allCanvases.length} canvas element(s) in document\`);
                
                canvas = document.querySelector('canvas.stage');
                if (!canvas) {
                  canvas = document.querySelector('canvas[width][height]');
                  if (!canvas) {
                    canvas = document.querySelector('canvas');
                  }
                }
                if (canvas) {
                  console.log('Canvas Extractor [Privileged]: Canvas found in document');
                }
              }
              
              if (canvas) {
                const canvasWidth = canvas.width || 0;
                const canvasHeight = canvas.height || 0;
                console.log(\`Canvas Extractor [Privileged]: Canvas found on attempt \${attempts}. Width: \${canvasWidth}, Height: \${canvasHeight}\`);
                
                // CRITICAL: Verify canvas has non-zero dimensions before accepting it
                if (canvasWidth === 0 || canvasHeight === 0) {
                  console.warn(\`Canvas Extractor [Privileged]: Canvas has zero dimensions (\${canvasWidth}x\${canvasHeight}), treating as not found\`);
                  canvas = null;
                }
                
                if (canvas) {
                  resolve(canvas);
                  return;
                }
              }
              
              if (attempts < maxAttempts) {
                console.log(\`Canvas Extractor [Privileged]: Canvas not found, retrying in \${delay}ms...\`);
                setTimeout(tryFind, delay);
              } else {
                console.error('Canvas Extractor [Privileged]: Canvas element not found after all attempts.');
                resolve(null);
              }
            }
            
            tryFind();
          });
        }
        
        // Return a promise that resolves with the result
        return findCanvas().then(canvas => {
          if (!canvas) {
            return { error: 'Canvas element not found after all retry attempts' };
          }

          // CRITICAL: Final verification of canvas dimensions before extraction
          const finalWidth = canvas.width || 0;
          const finalHeight = canvas.height || 0;
          console.log(\`Canvas Extractor [Privileged]: Final canvas dimensions: \${finalWidth}x\${finalHeight}\`);
          
          if (finalWidth === 0 || finalHeight === 0) {
            console.error(\`Canvas Extractor [Privileged]: ❌ ABORT: Canvas has zero dimensions (\${finalWidth}x\${finalHeight}). SmartFrame failed to render.\`);
            return { error: \`Canvas has zero dimensions (\${finalWidth}x\${finalHeight}) - SmartFrame rendering failed\` };
          }
          
          console.log('Canvas Extractor [Privileged]: ✅ Canvas dimensions verified. Attempting to get data URL.');
          try {
            // CRITICAL FIX: Use original toDataURL and apply to current canvas
            const tempCanvas = document.createElement("canvas");
            tempCanvas.width = canvas.width || 1920; 
            tempCanvas.height = canvas.height || 1080;

            const dataUrl = tempCanvas.toDataURL.call(canvas, 'image/png');
            const dataUrlLength = dataUrl ? dataUrl.length : 0;
            console.log(\`Canvas Extractor [Privileged]: Successfully generated data URL length: \${dataUrlLength} chars\`);
            
            if (!dataUrl || dataUrlLength < 100) {
              console.error('Canvas Extractor [Privileged]: ❌ Data URL is empty or too short, canvas may be blank');
              return { error: 'Generated data URL is empty or invalid' };
            }
            
            return { dataUrl: dataUrl };
          } catch (e) {
            console.error('Canvas Extractor [Privileged]: Error calling toDataURL:', e);
            return { error: 'Error calling toDataURL: ' + e.message };
          }
        });
      },
      args: [request.selector]
    }).then(results => {
      console.log("Canvas Extractor V3: Script execution finished.");
      const result = results && results[0] && results[0].result;
      console.log("Canvas Extractor V3: Sending response:", result);
      sendResponse(result || { error: 'No result from script execution' });
    }).catch(error => {
      console.error("Canvas Extractor V3: Error executing script in tab:", error);
      sendResponse({ error: error.toString() });
    });
    
    // Return true to indicate asynchronous response
    return true;
  }
});
`;

export const CONTENT_SCRIPT_JS = `
console.log("Canvas Extractor V3: Content script loaded.");

// Listen for messages from the page context via window.postMessage
window.addEventListener('message', function(event) {
  // Verify origin matches current page (security check)
  if (event.origin !== window.location.origin) {
    return;
  }
  
  // Only accept messages from the same window (not from iframes)
  if (event.source !== window) {
    return;
  }
  
  // Check if this is our custom message
  if (event.data && event.data.type === 'GET_CANVAS_DATA') {
    console.log("Canvas Extractor V3 [Content]: 'GET_CANVAS_DATA' message received by content script.");
    const selector = event.data.selector;

    console.log(\`Canvas Extractor V3 [Content]: Sending message to service worker for selector: \${selector}\`);
    
    // Send a message to the service worker, requesting the data URL
    chrome.runtime.sendMessage({
      action: "getCanvasDataURL",
      selector: selector
    }).then(response => {
      console.log("Canvas Extractor V3 [Content]: Received response from service worker.", response);
      
      // Create a temporary element in the DOM to hold the response data
      const responseDiv = document.createElement('div');
      responseDiv.id = 'extension-response-data';
      responseDiv.style.display = 'none';
      
      if (response && response.dataUrl) {
        console.log("Canvas Extractor V3 [Content]: Data URL received, creating response div with data-url.");
        responseDiv.setAttribute('data-url', response.dataUrl);
      } else {
        const errorMsg = (response && response.error) || "Unknown error: No data URL returned.";
        console.error(\`Canvas Extractor V3 [Content]: Error received from service worker: \${errorMsg}\`);
        responseDiv.setAttribute('data-error', errorMsg);
      }
      document.body.appendChild(responseDiv);
      console.log("Canvas Extractor V3 [Content]: Appended responseDiv to body.");
    }).catch(error => {
      console.error("Canvas Extractor V3 [Content]: Error sending message or receiving response from service worker:", error);
      
      // Still try to append a div to indicate failure
      const responseDiv = document.createElement('div');
      responseDiv.id = 'extension-response-data';
      responseDiv.style.display = 'none';
      responseDiv.setAttribute('data-error', 'Communication error: ' + error.toString());
      document.body.appendChild(responseDiv);
      console.log("Canvas Extractor V3 [Content]: Appended error responseDiv to body after communication error.");
    });
  }
});
`;

export const INJECTED_JAVASCRIPT = `
    (function() {
      // Store reference to smartframe-embed shadow root on window object for extension access
      // Only initialize if not already set by another script
      if (window.__smartFrameShadowRoot === undefined) {
          window.__smartFrameShadowRoot = null;
      }
      if (window.__smartFrameHostElement === undefined) {
          window.__smartFrameHostElement = null;
      }
      if (window.__SMARTFRAME_EMBED_SELECTOR === undefined) {
          window.__SMARTFRAME_EMBED_SELECTOR = null;
      }
      if (window.__SMARTFRAME_TARGET_IMAGE_ID === undefined) {
          window.__SMARTFRAME_TARGET_IMAGE_ID = null;
      }
      const nativeAttachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(init) {
          const shadowRoot = nativeAttachShadow.call(this, init);
          if (this.tagName.toLowerCase() === 'smartframe-embed') {
              const targetSelector = window.__SMARTFRAME_EMBED_SELECTOR;
              const targetImageId = window.__SMARTFRAME_TARGET_IMAGE_ID;
              const imageId = this.getAttribute('image-id');
              
              const matchesImageId = Boolean(targetImageId && imageId === targetImageId);
              const matchesSelector = Boolean(targetSelector && typeof this.matches === 'function' && this.matches(targetSelector));
              const shouldCapture = matchesImageId || matchesSelector || window.__smartFrameShadowRoot === null;
              
              if (shouldCapture) {
                  window.__smartFrameShadowRoot = shadowRoot;
                  window.__smartFrameHostElement = this;
                  console.log('Injected JavaScript (Main Page): Captured smartframe-embed shadow root reference.');
                  
                  // Log initial canvas count in shadow root
                  setTimeout(() => {
                      const canvases = shadowRoot.querySelectorAll('canvas');
                      console.log(\`Injected JavaScript (Main Page): Shadow root has \${canvases.length} canvas element(s) initially.\`);
                  }, 100);
              }
          }
          return shadowRoot;
      };

    console.log('Injected JavaScript (Main Page): Shadow root capture hook applied.');

      const smartframeEmbedSelector = window.__SMARTFRAME_EMBED_SELECTOR || 'smartframe-embed';
      const smartframeTargetImageId = window.__SMARTFRAME_TARGET_IMAGE_ID || null;
      
      function resolveSmartFrameElement() {
          const selectorsToTry = [];
          
          if (smartframeTargetImageId) {
              selectorsToTry.push(\`smartframe-embed[image-id="\${smartframeTargetImageId}"]\`);
          }
          
          if (smartframeEmbedSelector && !selectorsToTry.includes(smartframeEmbedSelector)) {
              selectorsToTry.push(smartframeEmbedSelector);
          }
          
          selectorsToTry.push('smartframe-embed:not([thumbnail-mode])');
          selectorsToTry.push('smartframe-embed');
          
          for (const selector of selectorsToTry) {
              if (!selector) {
                  continue;
              }
              
              try {
                  const candidate = document.querySelector(selector);
                  if (candidate) {
                      console.log(\`Injected JavaScript (Main Page): SmartFrame candidate found via selector '\${selector}'.\`);
                      return { element: candidate, selector };
                  }
              } catch (err) {
                  console.warn(\`Injected JavaScript (Main Page): Selector '\${selector}' threw an error:\`, err);
              }
          }
          
          return { element: null, selector: smartframeEmbedSelector };
      }
    
    // Guard to prevent multiple executions
    let extractionInitialized = false;

    // Use event-based initialization instead of polling
    function initSmartFrameExtraction() {
        // Prevent multiple executions
        if (extractionInitialized) {
            return;
        }
        
      const { element: smartFrame, selector: resolvedSelector } = resolveSmartFrameElement();
      if (smartFrame) {
            extractionInitialized = true;
            console.log('Injected JavaScript (Main Page): smartframe-embed found.');
          window.__SMARTFRAME_ACTIVE_SELECTOR = resolvedSelector;
          window.__smartFrameHostElement = smartFrame;
          
          if (!window.__smartFrameShadowRoot && smartFrame.shadowRoot) {
              window.__smartFrameShadowRoot = smartFrame.shadowRoot;
          }

            // CRITICAL FIX: Poll until SmartFrame populates CSS custom properties
            // The injected script fires too early (on attachShadow), before SmartFrame
            // has finished its layout and set --sf-original-width/height values.
            // We must WAIT for these values to be populated before resizing.
            const viewportMode = window.__SMARTFRAME_VIEWPORT_MODE || 'thumbnail';
            console.log(\`Injected JavaScript (Main Page): Viewport mode: \${viewportMode}\`);
            
            let pollAttempts = 0;
            const maxPollAttempts = 50; // 50 attempts × 100ms = 5 seconds max wait
            const pollInterval = 100; // Check every 100ms
            
            const pollForDimensions = () => {
                pollAttempts++;
                const computedStyle = window.getComputedStyle(smartFrame);
                const width = computedStyle.getPropertyValue('--sf-original-width').trim();
                const height = computedStyle.getPropertyValue('--sf-original-height').trim();
                
                // Parse to numbers to check if valid
                const widthNum = parseFloat(width);
                const heightNum = parseFloat(height);
                
                console.log(\`Injected JavaScript (Main Page): Poll attempt \${pollAttempts}/\${maxPollAttempts} - width="\${width}", height="\${height}" (parsed: \${widthNum}x\${heightNum})\`);
                
                // Check if we have valid numeric dimensions
                if (isFinite(widthNum) && isFinite(heightNum) && widthNum > 0 && heightNum > 0) {
                    console.log(\`Injected JavaScript (Main Page): ✅ CSS variables populated! Dimensions: \${widthNum}x\${heightNum}\`);
                    
                    // Remove thumbnail-mode attribute to force full rendering
                    if (smartFrame.hasAttribute('thumbnail-mode')) {
                        smartFrame.removeAttribute('thumbnail-mode');
                        console.log('Injected JavaScript (Main Page): Removed thumbnail-mode attribute');
                    }
                    
                    // CRITICAL: Branch logic based on viewport mode
                    let finalWidth, finalHeight;
                    if (viewportMode === 'full') {
                        // FULL MODE: Two-stage approach - start at 9000, then escalate to 9999
                        // Stage 1: 9000x9000 for initial render
                        finalWidth = '9000px';
                        finalHeight = '9000px';
                        console.log(\`Injected JavaScript (Main Page): FULL mode - Stage 1: Setting to 9000x9000 for initial render\`);
                        
                        // AGGRESSIVE CSS OVERRIDE: Remove ALL constraints that might limit canvas size
                        smartFrame.style.cssText = 'width: 9000px !important; height: 9000px !important; max-width: 9000px !important; max-height: 9000px !important; min-width: 9000px !important; min-height: 9000px !important; display: inline-flex !important; overflow: visible !important;';
                    } else {
                        // THUMBNAIL MODE: Use the CSS variables
                        finalWidth = width.endsWith('px') ? width : width + 'px';
                        finalHeight = height.endsWith('px') ? height : height + 'px';
                        console.log(\`Injected JavaScript (Main Page): THUMBNAIL mode - using CSS vars: \${finalWidth} x \${finalHeight}\`);
                        
                        smartFrame.style.width = finalWidth;
                        smartFrame.style.maxWidth = finalWidth;
                        smartFrame.style.minWidth = finalWidth;
                        smartFrame.style.height = finalHeight;
                        smartFrame.style.maxHeight = finalHeight;
                        smartFrame.style.minHeight = finalHeight;
                        smartFrame.style.display = 'inline-flex';
                    }
                    
                    console.log(\`Injected JavaScript (Main Page): Applied inline dimensions: \${finalWidth} x \${finalHeight}\`);
                    
                    // Use RAF to ensure styles are applied before dispatching resize
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            window.dispatchEvent(new Event('resize'));
                            smartFrame.dispatchEvent(new Event('resize'));
                            console.log('Injected JavaScript (Main Page): Dispatched resize events');
                        });
                    });
                    
                    // Stage 2: Escalate to 9999x9999 for maximum resolution
                    if (viewportMode === 'full') {
                        setTimeout(() => {
                            console.log('Injected JavaScript (Main Page): FULL mode - Stage 2: Escalating to 9999x9999 for maximum resolution');
                            smartFrame.style.cssText = 'width: 9999px !important; height: 9999px !important; max-width: 9999px !important; max-height: 9999px !important; min-width: 9999px !important; min-height: 9999px !important; display: inline-flex !important; overflow: visible !important;';
                            
                            // Trigger resize event again after escalation
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    window.dispatchEvent(new Event('resize'));
                                    smartFrame.dispatchEvent(new Event('resize'));
                                    console.log('Injected JavaScript (Main Page): Stage 2 - Dispatched resize events after escalation to 9999x9999');
                                });
                            });
                            
                            // Wait 500ms then trigger extraction
                            setTimeout(() => {
                                console.log('Injected JavaScript (Main Page): Stage 2 - Sending canvas extraction message');
                                window.postMessage({
                                    type: 'GET_CANVAS_DATA',
                                    selector: resolvedSelector || smartframeEmbedSelector
                                }, window.location.origin);
                            }, 500);
                        }, 1500);
                    } else {
                        // THUMBNAIL MODE: Extract after 1 second
                        setTimeout(() => {
                            console.log('Injected JavaScript (Main Page): Sending canvas extraction message');
                            window.postMessage({
                                type: 'GET_CANVAS_DATA',
                                selector: resolvedSelector || smartframeEmbedSelector
                            }, window.location.origin);
                        }, 1000);
                    }
                    
                } else if (pollAttempts >= maxPollAttempts) {
                    console.warn(\`Injected JavaScript (Main Page): ⚠️ Timeout waiting for CSS variables after \${maxPollAttempts} attempts\`);
                    console.warn(\`Injected JavaScript (Main Page): Last values: width="\${width}", height="\${height}"\`);
                    
                    // Fallback: Try to force dimensions anyway
                    console.log('Injected JavaScript (Main Page): Falling back to fixed 9999px dimensions');
                    if (smartFrame.hasAttribute('thumbnail-mode')) {
                        smartFrame.removeAttribute('thumbnail-mode');
                    }
                    smartFrame.style.width = '9999px';
                    smartFrame.style.maxWidth = '9999px';
                    smartFrame.style.minWidth = '9999px';
                    smartFrame.style.height = '9999px';
                    smartFrame.style.maxHeight = '9999px';
                    smartFrame.style.minHeight = '9999px';
                    smartFrame.style.display = 'inline-flex';
                    
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            window.dispatchEvent(new Event('resize'));
                            smartFrame.dispatchEvent(new Event('resize'));
                        });
                    });
                    
                    setTimeout(() => {
                        window.postMessage({
                            type: 'GET_CANVAS_DATA',
                            selector: resolvedSelector || smartframeEmbedSelector
                        }, window.location.origin);
                    }, 1000);
                } else {
                    // Keep polling
                    setTimeout(pollForDimensions, pollInterval);
                }
            };
            
            // Start polling
            pollForDimensions();
        } else {
            console.warn('Injected JavaScript (Main Page): smartframe-embed not found on page.');
        }
    }

    // Execute immediately since this script is injected AFTER page load
    // The page has already loaded when Puppeteer injects this script
    console.log('Injected JavaScript (Main Page): Document ready state:', document.readyState);
    
    // Try immediately first
    initSmartFrameExtraction();
    
    // Also add delayed retries to handle cases where SmartFrame loads asynchronously
    setTimeout(initSmartFrameExtraction, 500);
    setTimeout(initSmartFrameExtraction, 1000);
    setTimeout(initSmartFrameExtraction, 2000);
    
    // Still listen for load as fallback (in case page isn't fully loaded yet)
    if (document.readyState === 'loading') {
        window.addEventListener('load', initSmartFrameExtraction);
        document.addEventListener('DOMContentLoaded', initSmartFrameExtraction);
    }
})();
`;
