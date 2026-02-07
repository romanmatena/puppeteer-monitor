/**
 * Open Mode - launch new Chrome and monitor.
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import { C, log } from '../utils/colors.mjs';
import {
  getWindowsHostForWSL,
  getLastCmdStderrAndClear,
  getWindowsLocalAppData,
  detectWindowsChromeCanaryPath,
  printCanaryInstallInstructions,
  killPuppeteerMonitorChromes,
  checkChromeRunning,
  runWslDiagnostics,
} from '../os/wsl/index.mjs';
import { LogBuffer, getTimestamp, getFullTimestamp } from '../logging/index.mjs';
import { createHttpServer } from '../http-server.mjs';
import { setupPageMonitoring as setupPageMonitoringShared } from './page-monitoring.mjs';
import { askUserToSelectPage } from './tab-selection.mjs';
import { askYesNo } from '../utils/ask.mjs';
import { printReadyHelp, printStatusBlock, KEYS_OPEN } from '../templates/ready-help.mjs';
import { printApiHelpTable } from '../templates/api-help.mjs';
import { printModeHeading, printBulletBox } from '../templates/section-heading.mjs';
import { createTable, printTable } from '../templates/table-helper.mjs';
import { writeStatusLine, clearStatusLine } from '../utils/status-line.mjs';
import { getProfileIdFromProjectDir } from '../utils/profile-id.mjs';

// Browser and page in module scope for cleanup
let browser = null;
let page = null;
let cleanupDone = false;
let launchedOnWindows = false;
let windowsDebugPort = 0;


/**
 * Run in Open Mode - launch new Chrome and monitor
 * @param {string} url - URL to monitor
 * @param {Object} options - Monitor options
 * @param {boolean} options.realtime - Enable realtime mode (default: false = lazy mode)
 * @param {boolean} options.headless - Run in headless mode (default: false = GUI mode)
 * @param {string} options.outputDir - Output directory (default: process.cwd())
 * @param {string[]} options.ignorePatterns - Additional patterns to ignore in console
 * @param {number} options.hardTimeout - Hard timeout in ms (default: 0 = disabled)
 * @param {number} options.defaultTimeout - Default page timeout in ms (default: 30000)
 * @param {number} options.navigationTimeout - Navigation timeout in ms (default: 60000)
 * @param {number} options.httpPort - HTTP server port for dump endpoint (default: 60001, 0 = disabled)
 */
export async function runOpenMode(url, options = {}) {
  const {
    realtime = false,
    headless = false,
    outputDir = process.cwd(),
    paths = null,
    ignorePatterns = [],
    hardTimeout = 0,
    defaultTimeout = 30_000,
    navigationTimeout = 60_000,
    httpPort = 60001,
    sharedHttpState = null,
    sharedHttpServer = null,
    skipProfileBlock = false,
  } = options;

  const lazyMode = !realtime;

  // Create LogBuffer instance for centralized buffer management
  const logBuffer = new LogBuffer({
    outputDir,
    paths,
    lazyMode,
    ignorePatterns,
  });

  // Chrome profile: stays in project dir or Windows LOCALAPPDATA (not inside .browsermonitor)
  const USER_DATA_DIR = path.join(outputDir, '.puppeteer-profile');
  // PID file goes into .browsermonitor/ when paths available
  const PID_FILE = paths ? paths.pidFile : path.join(outputDir, '.puppeteer-chrome.pid');

  // HTTP server for LLM dump endpoint
  let httpServer = null;

  // ===== CLEANUP FUNCTION =====
  // closeBrowser: true = k (close Chrome and exit), false = q / Ctrl+C (exit only, Chrome keeps running)
  async function cleanup(code = 0, closeBrowser = false) {
    if (cleanupDone) return;
    cleanupDone = true;

    console.log('');
    log.info(closeBrowser ? 'Cleaning up and closing Chrome...' : 'Cleaning up (Chrome will stay open)...');

    try {
      if (httpServer) {
        await new Promise((resolve) => {
          httpServer.close(resolve);
        });
        log.dim('HTTP server closed');
      }
    } catch (e) {
      log.error(`Error closing HTTP server: ${e.message}`);
    }

    try {
      if (browser) {
        if (closeBrowser) {
          if (launchedOnWindows) {
            browser.disconnect();
            try {
              const killed = killPuppeteerMonitorChromes(true);
              if (killed > 0) {
                log.success('Chrome closed');
              } else {
                log.dim('Chrome may have already closed');
              }
            } catch {
              log.dim('Chrome may have already closed');
            }
          } else {
            await browser.close();
            log.success('Browser closed');
          }
        } else {
          browser.disconnect();
          log.success('Disconnected (Chrome still running)');
        }
      }
    } catch (e) {
      log.error(`Error closing browser: ${e.message}`);
    }

    try {
      fs.unlinkSync(PID_FILE);
    } catch {}

    process.exit(code);
  }

  // ===== SIGNAL HANDLERS =====
  process.on('SIGINT', () => {
    console.log('');
    log.dim('Received SIGINT (Ctrl+C)');
    cleanup(0, false);
  });

  process.on('SIGTERM', () => {
    console.log('');
    log.dim('Received SIGTERM');
    cleanup(0, false);
  });

  process.on('uncaughtException', (e) => {
    const msg = (e && e.message) || String(e);
    if (/Execution context was destroyed|Target closed|Protocol error/.test(msg)) {
      log.dim(`Navigation/context closed: ${msg.slice(0, 60)}… (continuing)`);
      return;
    }
    log.error(`Uncaught exception: ${e.message}`);
    console.error(e.stack);
    cleanup(1);
  });

  process.on('unhandledRejection', (e) => {
    const msg = (e && e.message) || String(e);
    if (/Execution context was destroyed|Target closed|Protocol error/.test(msg)) {
      log.dim(`Navigation/context closed: ${msg.slice(0, 60)}… (continuing)`);
      return;
    }
    log.error(`Unhandled rejection: ${e}`);
    cleanup(1);
  });

  // ===== HARD TIMEOUT (safety net) =====
  if (hardTimeout > 0) {
    setTimeout(() => {
      log.error(`HARD TIMEOUT (${hardTimeout}ms) - forcing exit`);
      cleanup(1);
    }, hardTimeout);
  }

  // Track monitored pages for tab switching
  let monitoredPages = [];
  let isSelectingTab = false;
  let currentProfilePath = null;
  let activePageCleanup = null;
  let collectingPaused = false;

  // Output counter for periodic help reminder (same block as initial Ready, every HELP_INTERVAL)
  let outputCounter = 0;
  const HELP_INTERVAL = 5;
  function maybeShowHelp() {
    outputCounter++;
    if (outputCounter % HELP_INTERVAL === 0) {
      printReadyHelp(httpPort, KEYS_OPEN);
    }
  }

  // In-session help (h key) – full table with session context for Claude Code
  function printHelp() {
    const currentUrl = page?.url?.() || url;
    console.log(`${C.cyan}Launch mode${C.reset}  URL: ${C.brightGreen}${currentUrl}${C.reset}  │  Dir: ${outputDir}`);
    printApiHelpTable({
      port: httpPort,
      showApi: true,
      showInteractive: true,
      showOutputFiles: true,
      context: {
        consoleLog: logBuffer.CONSOLE_LOG,
        networkLog: logBuffer.NETWORK_LOG,
        networkDir: logBuffer.NETWORK_DIR,
        cookiesDir: logBuffer.COOKIES_DIR,
        domHtml: logBuffer.DOM_HTML,
        screenshot: logBuffer.SCREENSHOT,
      },
      sessionContext: {
        currentUrl,
        profilePath: currentProfilePath,
      },
    });
  }

  // Use shared HTTP server (started in CLI) or create our own
  if (sharedHttpState && sharedHttpServer) {
    httpServer = sharedHttpServer;
    sharedHttpState.mode = 'launch';
    sharedHttpState.logBuffer = logBuffer;
    sharedHttpState.getPages = () => monitoredPages;
    sharedHttpState.getCollectingPaused = () => collectingPaused;
    sharedHttpState.setCollectingPaused = (v) => { collectingPaused = !!v; };
    sharedHttpState.getAllTabs = async () => {
      if (!browser) return [];
      const allPages = await browser.pages();
      const isUserPage = (p) => {
        const u = p.url();
        return !u.startsWith('chrome://') && !u.startsWith('devtools://') && !u.startsWith('chrome-extension://');
      };
      let pages = allPages.filter(isUserPage);
      const nonBlank = pages.filter(p => p.url() !== 'about:blank');
      if (nonBlank.length > 0) pages = nonBlank;
      return pages.map((p, i) => ({ index: i + 1, url: p.url() }));
    };
    sharedHttpState.switchToTab = async (index) => {
      if (!browser) return { success: false, error: 'Browser not ready' };
      try {
        const allPages = await browser.pages();
        const isUserPage = (p) => {
          const u = p.url();
          return !u.startsWith('chrome://') && !u.startsWith('devtools://') && !u.startsWith('chrome-extension://');
        };
        let pages = allPages.filter(isUserPage);
        const nonBlank = pages.filter(p => p.url() !== 'about:blank');
        if (nonBlank.length > 0) pages = nonBlank;
        if (index < 1 || index > pages.length) return { success: false, error: `Invalid index. Use 1-${pages.length}.` };
        const selectedPage = pages[index - 1];
        page = selectedPage;
        monitoredPages = [selectedPage];
        setupPageMonitoring(selectedPage);
        logBuffer.printConsoleSeparator('TAB SWITCHED');
        logBuffer.printNetworkSeparator('TAB SWITCHED');
        return { success: true, url: selectedPage.url() };
      } catch (e) {
        return { success: false, error: e.message };
      }
    };
  } else {
    httpServer = createHttpServer({
      port: httpPort,
      mode: 'launch',
      logBuffer,
      getPages: () => monitoredPages,
      getCollectingPaused: () => collectingPaused,
      setCollectingPaused: (v) => { collectingPaused = !!v; },
    });
  }

  // Setup page monitoring (console, request, response events) – shared implementation
  function setupPageMonitoring(targetPage) {
    setupPageMonitoringShared(targetPage, {
      logBuffer,
      getCollectingPaused: () => collectingPaused,
      setActivePageCleanup: (fn) => { activePageCleanup = fn; },
      pageLabel: '',
    });
  }

  // Switch tabs in Launch mode
  async function switchTabs() {
    if (!browser) {
      log.error('Browser not ready');
      return;
    }

    try {
      const allPages = await browser.pages();

      // Filter out internal Chrome pages (but keep about:blank if it's the only one with content)
      const isUserPage = (p) => {
        const pageUrl = p.url();
        return !pageUrl.startsWith('chrome://') &&
               !pageUrl.startsWith('devtools://') &&
               !pageUrl.startsWith('chrome-extension://');
      };
      let pages = allPages.filter(isUserPage);

      // If we have pages other than about:blank, filter out about:blank
      const nonBlankPages = pages.filter(p => p.url() !== 'about:blank');
      if (nonBlankPages.length > 0) {
        pages = nonBlankPages;
      }

      if (pages.length === 0) {
        log.warn('No user tabs found');
        return;
      }

      if (pages.length === 1) {
        log.info('Only one user tab available');
        return;
      }

      isSelectingTab = true;
      const selectedPage = await askUserToSelectPage(pages);
      isSelectingTab = false;

      if (selectedPage === null) {
        log.dim('Tab switch cancelled');
        return;
      }

      // Switch to new page and setup monitoring
      page = selectedPage;
      monitoredPages = [selectedPage];
      setupPageMonitoring(selectedPage);
      log.success(`Now monitoring: ${C.brightCyan}${selectedPage.url()}${C.reset}`);

      // Add separators to indicate tab switch in logs
      logBuffer.printConsoleSeparator('TAB SWITCHED');
      logBuffer.printNetworkSeparator('TAB SWITCHED');

    } catch (e) {
      log.error(`Error switching tabs: ${e.message}`);
      isSelectingTab = false;
    }
  }

  // Setup keyboard input for lazy mode
  function setupKeyboardInput() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', async (str, key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup(0);
        return;
      }

      // Ignore keys during tab selection
      if (isSelectingTab) {
        return;
      }

      // Shortcuts only without modifiers (no Ctrl, Shift, Win)
      if (key.ctrl || key.shift || key.meta) {
        return;
      }

      if (key.name === 'd') {
        await logBuffer.dumpBuffersToFiles({
          dumpCookies: page ? () => logBuffer.dumpCookiesFromPage(page) : null,
          dumpDom: page ? () => logBuffer.dumpDomFromPage(page) : null,
          dumpScreenshot: page ? () => logBuffer.dumpScreenshotFromPage(page) : null,
        });
        maybeShowHelp();
      } else if (key.name === 'c') {
        logBuffer.clearAllBuffers();
        maybeShowHelp();
      } else if (key.name === 'q') {
        cleanup(0, false);
      } else if (key.name === 's') {
        const stats = logBuffer.getStats();
        const currentUrl = page ? page.url() : 'N/A';
        const tabCount = browser ? (await browser.pages()).length : 0;
        printStatusBlock(stats, currentUrl, tabCount, collectingPaused);
        maybeShowHelp();
      } else if (key.name === 'p') {
        collectingPaused = !collectingPaused;
        log.info(collectingPaused ? 'Collecting stopped (paused). Press p or curl .../start to resume.' : 'Collecting started (resumed).');
        maybeShowHelp();
      } else if (key.name === 'k') {
        log.warn('Closing Chrome and exiting...');
        cleanup(0, true);
      } else if (key.name === 't') {
        await switchTabs();
        maybeShowHelp();
      } else if (key.name === 'h') {
        // Show full help
        printHelp();
      }
    });
  }

  // Initialize
  printModeHeading('Open mode');
  if (realtime) {
    fs.writeFileSync(logBuffer.CONSOLE_LOG, '');
    logBuffer.clearNetworkDir();
  }

  writeStatusLine(`${C.dim}Launching browser for ${url}...${C.reset}`);
  const configLines = [
    `${C.cyan}Configuration${C.reset}`,
    `  Mode: ${lazyMode ? `${C.green}LAZY${C.reset} (buffered)` : `${C.yellow}REALTIME${C.reset} (immediate write)`}`,
    `  Browser: ${headless ? `${C.dim}HEADLESS${C.reset}` : `${C.green}GUI${C.reset}`}`,
  ].join('\n');
  clearStatusLine(true);
  const configTable = createTable({ colWidths: [95], tableOpts: { wordWrap: true } });
  configTable.push([configLines]);
  printTable(configTable);

  if (realtime) {
    logBuffer.printNetworkSeparator('PUPPETEER MONITOR STARTED');
    logBuffer.logNetwork(`URL: ${url}`);
    logBuffer.logNetwork('');
  }

  // HTTP server is already started via createHttpServer above

  // ===== DETECT WSL =====
  const isWSL = (() => {
    try {
      const release = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      return release.includes('microsoft') || release.includes('wsl');
    } catch { return false; }
  })();

  // ===== CONFIGURE CHROME PROFILE (only when Chrome will use USER_DATA_DIR) =====
  // On WSL with project on WSL fs (/srv/...), Chrome uses Windows LOCALAPPDATA - skip creating Linux path
  const chromeUsesUserDataDir = !isWSL || outputDir.startsWith('/mnt/');
  if (chromeUsesUserDataDir) {
    const prefsDir = path.join(USER_DATA_DIR, 'Default');
    const prefsFile = path.join(prefsDir, 'Preferences');
    try {
      fs.mkdirSync(prefsDir, { recursive: true });
      let prefs = {};
      if (fs.existsSync(prefsFile)) {
        try {
          prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
        } catch { /* ignore parse errors, start fresh */ }
      }
      prefs.session = prefs.session || {};
      prefs.session.restore_on_startup = 5;
      prefs.profile = prefs.profile || {};
      prefs.profile.exit_type = 'Normal';
      fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
    } catch (e) {
      log.dim(`Could not configure profile preferences: ${e.message}`);
    }
  }

  // ===== MAIN TRY/FINALLY BLOCK =====
  try {
    if (isWSL) {
      // === WSL MODE: Launch Chrome on Windows via PowerShell ===
      writeStatusLine(`${C.dim}Detecting Chrome...${C.reset}`);

      // For launch mode we use only Chrome Canary (isolated from user's regular Chrome)
      const chromePath = detectWindowsChromeCanaryPath();
      if (!chromePath) {
        clearStatusLine();
        printCanaryInstallInstructions();
        log.info('Install Chrome Canary and try again.');
        process.exit(1);
      }

      // In launch mode, kill any existing puppeteer-monitor Chrome processes
      clearStatusLine(true);
      const killed = killPuppeteerMonitorChromes();
      if (killed > 0) {
        await new Promise(r => setTimeout(r, 1000));
      }

      // Check if Chrome is running - with or without debug port
      const chromeStatus = checkChromeRunning();
      let chromeAlreadyRunning = false;
      let useExistingChrome = false;
      let existingDebugPort = null;

      if (chromeStatus.running) {
        if (chromeStatus.withDebugPort && chromeStatus.debugPort) {
          // Chrome is running WITH debug port - we can try to connect to it!
          existingDebugPort = chromeStatus.debugPort;

          // Check if it's accessible from WSL or needs port proxy
          const connectHost = getWindowsHostForWSL();
          try {
            const testResponse = await fetch(`http://${connectHost}:${existingDebugPort}/json/version`, {
              signal: AbortSignal.timeout(2000)
            });
            if (testResponse.ok) {
              useExistingChrome = true;
            }
          } catch {
            // Not accessible - check if port proxy would help

            // Check if port proxy is already set up
            try {
              const portProxyList = execSync('netsh.exe interface portproxy show v4tov4 2>nul', { encoding: 'utf8', timeout: 5000 });
              if (portProxyList.includes(String(existingDebugPort))) {
              } else {
                // Offer to set up port proxy
                console.log('');
                console.log(`  ${C.yellow}Port proxy needed:${C.reset} Chrome is not accessible from WSL.`);
                console.log(`  ${C.dim}Run this in PowerShell (Admin) to fix:${C.reset}`);
                console.log(`  ${C.cyan}netsh interface portproxy add v4tov4 listenport=${existingDebugPort} listenaddress=0.0.0.0 connectport=${existingDebugPort} connectaddress=127.0.0.1${C.reset}`);
                console.log('');

                const shouldSetup = await askYesNo(`  ${C.bold}Try to set up port proxy now? (requires admin)${C.reset}`);
                if (shouldSetup) {
                    try {
                      // Try to run netsh (might need elevation)
                      execSync(`netsh.exe interface portproxy add v4tov4 listenport=${existingDebugPort} listenaddress=0.0.0.0 connectport=${existingDebugPort} connectaddress=127.0.0.1`, { encoding: 'utf8', timeout: 5000 });
                      // Test again
                      await new Promise(r => setTimeout(r, 500));
                      const retryResponse = await fetch(`http://${connectHost}:${existingDebugPort}/json/version`, {
                        signal: AbortSignal.timeout(2000)
                      });
                      if (retryResponse.ok) {
                        useExistingChrome = true;
                      }
                    } catch (e) {
                      log.warn('Could not set up port proxy (run PowerShell as Admin)');
                    }
                }
              }
            } catch {
              // netsh failed
            }
          }

          if (useExistingChrome) {
            windowsDebugPort = existingDebugPort;
          }
        } else {
          // Chrome running WITHOUT debug port - singleton problem
          chromeAlreadyRunning = true;
        }
      }

      // Skip launch if using existing Chrome
      let windowsUserDataDir = 'existing';

      if (!useExistingChrome) {
        // Find available port starting from 9222
        // Check if port is already in use on Windows
        const findAvailablePort = () => {
          const START_PORT = 9222;
          const MAX_PORT = 9299;
          for (let port = START_PORT; port <= MAX_PORT; port++) {
            try {
              // Check if port is listening on Windows
              const checkCmd = `powershell.exe -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).Count"`;
              const result = execSync(checkCmd, { encoding: 'utf8', timeout: 3000 }).trim();
              const count = parseInt(result, 10) || 0;
              if (count === 0) {
                return port; // Port is free
              }
            } catch {
              // Get-NetTCPConnection failed = port is likely free
              return port;
            }
          }
          // All ports in use, fallback to random
          return START_PORT + Math.floor(Math.random() * (MAX_PORT - START_PORT));
        };
        windowsDebugPort = findAvailablePort();

        // Get Windows user data dir
        // Chrome has issues with \\wsl$\ paths for singleton lock detection
        // So we store profiles on Windows filesystem with project-specific hash
        if (USER_DATA_DIR.startsWith('/mnt/')) {
          // Path is on Windows drive, convert it directly
          windowsUserDataDir = USER_DATA_DIR.replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`).replace(/\//g, '\\');
        } else {
          // Path is on WSL filesystem - use Windows LOCALAPPDATA with project-specific profile ID
          const { profileId } = getProfileIdFromProjectDir(outputDir);
          const localAppData = getWindowsLocalAppData();
          windowsUserDataDir = `${localAppData}\\puppeteer-monitor\\${profileId}`;
        }

        // CMD.EXE stderr + Profile/Project in bullet box
        const cmdStderrLines = getLastCmdStderrAndClear();
        const mergedStderr = [];
        for (let i = 0; i < cmdStderrLines.length; i++) {
          const curr = cmdStderrLines[i];
          const next = cmdStderrLines[i + 1];
          if (next && /^'\\\\/.test(curr) && /CMD\.EXE was started/i.test(next)) {
            mergedStderr.push(`${next} ${curr}`);
            i++;
          } else {
            mergedStderr.push(curr);
          }
        }
        if (!skipProfileBlock) {
          const infoLines = [
            ...mergedStderr,
            `${C.cyan}Profile:${C.reset} ${windowsUserDataDir}`,
            `${C.cyan}Project:${C.reset} ${outputDir}`,
          ];
          if (infoLines.length > 0) {
            clearStatusLine();
            console.log('');
            printBulletBox(infoLines);
          }
        }

        writeStatusLine(`${C.dim}Launching Chrome on Windows (port ${windowsDebugPort})...${C.reset}`);

        // Launch Chrome on Windows with user data dir
        // Note: Chrome M113+ always binds to 127.0.0.1 only for security
        // See: https://issues.chromium.org/issues/40261787
        // Port proxy is required for WSL access (set up after Chrome starts)
        const psCommand = `Start-Process -FilePath '${chromePath}' -ArgumentList '--remote-debugging-port=${windowsDebugPort}','--user-data-dir=${windowsUserDataDir}','--disable-session-crashed-bubble','--start-maximized','${url}'`;
        try {
          execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, { encoding: 'utf8', timeout: 10000 });
          launchedOnWindows = true;

          // Set up port proxy AFTER Chrome starts
          clearStatusLine();
          writeStatusLine(`${C.dim}Setting up port proxy for WSL access...${C.reset}`);

          // Wait for Chrome to bind and detect address
          let chromeBindAddr = null;
          for (let i = 0; i < 10; i++) {
            try { execSync('powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 500"', { timeout: 2000 }); } catch {}
            try {
              const netstat = execSync(`netstat.exe -ano`, { encoding: 'utf8', timeout: 5000 });
              const lines = netstat.split('\n').filter(l => l.includes(':' + windowsDebugPort) && l.includes('LISTEN'));
              for (const line of lines) {
                if (line.includes('127.0.0.1:' + windowsDebugPort)) { chromeBindAddr = '127.0.0.1'; break; }
                else if (line.includes('[::1]:' + windowsDebugPort)) { chromeBindAddr = '::1'; break; }
              }
              if (chromeBindAddr) break;
            } catch {}
          }
          if (!chromeBindAddr) chromeBindAddr = '127.0.0.1';

          const proxyType = chromeBindAddr === '::1' ? 'v4tov6' : 'v4tov4';

          // Remove old proxies first
          try {
            execSync(`powershell.exe -NoProfile -Command "netsh interface portproxy delete v4tov4 listenport=${windowsDebugPort} listenaddress=0.0.0.0 2>\\$null; netsh interface portproxy delete v4tov6 listenport=${windowsDebugPort} listenaddress=0.0.0.0 2>\\$null"`, { encoding: 'utf8', timeout: 5000 });
          } catch {}

          try {
            execSync(
              `powershell.exe -NoProfile -Command "netsh interface portproxy add ${proxyType} listenport=${windowsDebugPort} listenaddress=0.0.0.0 connectport=${windowsDebugPort} connectaddress=${chromeBindAddr}"`,
              { encoding: 'utf8', timeout: 5000 }
            );
            // Port proxy configured
          } catch (proxyErr) {
            log.warn(`Could not set up port proxy (may need admin): ${proxyErr.message}`);
          }
        } catch (e) {
          log.error(`Failed to launch Chrome on Windows: ${e.message}`);
          process.exit(1);
        }
      }

      // Wait for Chrome to start and connect with retry
      clearStatusLine(true);
      const connectHost = getWindowsHostForWSL({ quiet: true });
      const browserURL = `http://${connectHost}:${windowsDebugPort}`;
      const wslSetupLines = [
        `${C.cyan}Open (WSL)${C.reset}`,
        `  ${C.yellow}WSL detected${C.reset} – Chrome on Windows (GPU/WebGL)`,
        `  Chrome Canary (isolated from regular Chrome)`,
        chromeAlreadyRunning ? `  ${C.yellow}Chrome already running${C.reset} – new window joins existing process` : '',
        `  Port: ${windowsDebugPort}  │  Connection: ${browserURL}`,
      ].filter(Boolean).join('\n');
      const wslTable = createTable({ colWidths: [95], tableOpts: { wordWrap: true } });
      wslTable.push([wslSetupLines]);
      printTable(wslTable);

      writeStatusLine(`${C.dim}Connecting to Chrome...${C.reset}`);

      // Retry connection up to 5 times (total ~7.5 seconds)
      // If it fails, diagnostics will show the exact problem
      const MAX_RETRIES = 5;
      const RETRY_DELAY = 1500;
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          writeStatusLine(`${C.dim}Connecting to Chrome (attempt ${attempt}/${MAX_RETRIES})...${C.reset}`);

          // First check if Chrome debug endpoint is reachable
          try {
            const versionUrl = `${browserURL}/json/version`;
            const response = await fetch(versionUrl, { signal: AbortSignal.timeout(3000) });
            if (response.ok) {
              const info = await response.json();
              writeStatusLine(`${C.dim}Chrome responding: ${info.Browser || 'unknown'}${C.reset}`);
            }
          } catch (fetchErr) {
            throw new Error(`Cannot reach Chrome debug endpoint: ${fetchErr.message}`);
          }

          browser = await puppeteer.connect({ browserURL, defaultViewport: null });
          clearStatusLine();
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }

      if (lastError) {
        log.error(`Failed to connect to Chrome after ${MAX_RETRIES} attempts: ${lastError.message}`);

        // Run comprehensive WSL diagnostics
        const diagResult = await runWslDiagnostics(windowsDebugPort, connectHost);

        // Handle port proxy conflict automatically
        if (diagResult.hasPortProxyConflict) {
          console.log('');
          console.log(`${C.bold}${C.green}═══════════════════════════════════════════════════════════════════════════════${C.reset}`);
          console.log(`${C.bold}${C.green}  AUTOMATIC FIX${C.reset}`);
          console.log(`${C.bold}${C.green}═══════════════════════════════════════════════════════════════════════════════${C.reset}`);
          console.log('');

          const shouldFix = await askYesNo('Do you want me to fix this automatically? (remove port proxy, restart Chrome)');

          if (shouldFix) {
            const fixPort = diagResult.actualPort || windowsDebugPort;

            console.log(`${C.cyan}[1/2]${C.reset} Removing port proxy for port ${fixPort}...`);
            try {
              execSync(`netsh.exe interface portproxy delete v4tov4 listenport=${fixPort} listenaddress=0.0.0.0`, { encoding: 'utf8', timeout: 5000 });
              console.log(`  ${C.green}✓${C.reset} Port proxy removed`);
            } catch (e) {
              console.log(`  ${C.yellow}!${C.reset} Could not remove port proxy (may need admin): ${e.message}`);
            }

            console.log(`${C.cyan}[2/2]${C.reset} Stopping Chrome...`);
            try {
              killPuppeteerMonitorChromes(true); // Only kill puppeteer-monitor Chrome, not user's browser!
              console.log(`  ${C.green}✓${C.reset} Chrome stopped`);
            } catch (e) {
              console.log(`  ${C.yellow}!${C.reset} Could not stop Chrome: ${e.message}`);
            }

            console.log('');
            console.log(`${C.green}Fix applied!${C.reset} Please run puppeteer-monitor again.`);
            console.log(`${C.dim}Chrome will now bind to 0.0.0.0 correctly (no port proxy needed).${C.reset}`);
            console.log('');
            process.exit(0);
          }
        }

        // Additional context for Chrome singleton issue
        if (chromeAlreadyRunning && !diagResult.hasPortProxyConflict) {
          console.log(`${C.yellow}Note:${C.reset} Chrome was already running when we tried to launch.`);
          console.log('      The new window joined the existing process without debug port.');
          console.log('');
          console.log(`${C.bold}Solution:${C.reset} Close ALL Chrome windows and try again.`);
          console.log('');
        }

        process.exit(1);
      }

      const connectedLines = [
        `${C.green}Connected to Chrome on Windows${C.reset}`,
        `  Chrome: Windows native (port ${windowsDebugPort})`,
        `${C.dim}Note: Separate Chrome profile – you may need to log in to websites.${C.reset}`,
      ].join('\n');
      const connectedTable = createTable({ colWidths: [95], tableOpts: { wordWrap: true } });
      connectedTable.push([connectedLines]);
      printTable(connectedTable);
      currentProfilePath = windowsUserDataDir === 'existing' ? null : windowsUserDataDir;

    } else {
      // === NATIVE MODE: Standard Puppeteer launch ===
      browser = await puppeteer.launch({
        headless: headless ? 'new' : false,
        userDataDir: USER_DATA_DIR,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--ignore-certificate-errors',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--remote-debugging-port=0',
          '--disable-session-crashed-bubble',
          ...(headless ? [] : ['--start-maximized']),
        ],
        defaultViewport: headless ? { width: 1920, height: 1080 } : null,
      });

      // Save Chrome PID to file for recovery
      const browserProcess = browser.process();
      const chromePid = browserProcess ? browserProcess.pid : null;

      if (chromePid) {
        fs.writeFileSync(PID_FILE, String(chromePid));
      }
      const nativeLines = [
        `${C.green}Connected to Chrome${C.reset}`,
        `  Browser profile: ${USER_DATA_DIR}`,
        chromePid ? `  PID: ${chromePid}  │  PID file: ${PID_FILE}` : '',
        chromePid ? `${C.dim}If stuck: kill -9 $(cat ${PID_FILE})${C.reset}` : '',
      ].filter(Boolean).join('\n');
      const nativeTable = createTable({ colWidths: [95], tableOpts: { wordWrap: true } });
      nativeTable.push([nativeLines]);
      printTable(nativeTable);
      currentProfilePath = USER_DATA_DIR;
    }

    // Use one tab for our URL: open it first, then close any others (avoids closing the only window)
    const initialPages = await browser.pages();
    page = initialPages.find((p) => p.url() === 'about:blank') || initialPages[0] || await browser.newPage();
    monitoredPages = [page];

    // ===== SET TIMEOUTS =====
    page.setDefaultTimeout(defaultTimeout);
    page.setDefaultNavigationTimeout(navigationTimeout);

    // ===== SETUP PAGE MONITORING (console, network events) =====
    setupPageMonitoring(page);

    writeStatusLine(`${C.dim}Navigating to ${url}...${C.reset}`);
    if (realtime) {
      logBuffer.logConsole(`[Monitor] Navigating to ${url}...`);
    }
    logBuffer.printNetworkSeparator('NAVIGATION STARTED');

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeout,
    });

    clearStatusLine();
    logBuffer.printConsoleSeparator('PAGE LOADED - Listening for console output');
    logBuffer.printNetworkSeparator('PAGE LOADED - Listening for network requests');

    // Close other tabs only after our page is open (so we never close the tab we need)
    const allPages = await browser.pages();
    for (const p of allPages) {
      if (p !== page && !p.isClosed()) {
        await p.close().catch(() => {});
      }
    }

    if (realtime) {
      logBuffer.logConsole(`[Monitor] URL: ${url}`);
      logBuffer.logConsole(`[Monitor] Press Ctrl+C to stop.`);
      logBuffer.logConsole(`[Monitor] Type console.clear() in browser to reset console log.`);
      logBuffer.logConsole('');
    } else {
      // Lazy mode: Ready block from template (same as periodic reminder)
      printReadyHelp(httpPort, KEYS_OPEN);
      setupKeyboardInput();
    }

    // Keep process running until signal
    await new Promise(() => {});
  } finally {
    // Ensure browser is closed even if something goes wrong
    if (browser && !cleanupDone) {
      try {
        await browser.close();
        log.dim('Browser closed in finally block');
      } catch (e) {
        log.error(`Error closing browser in finally: ${e.message}`);
      }
    }

    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
  }
}