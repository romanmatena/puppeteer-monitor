/**
 * Join Mode - attach to existing Chrome (connect to running browser).
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import { C, log } from '../utils/colors.mjs';
import { getChromeProfileLocation } from '../utils/chrome-profile-path.mjs';
import {
  getWindowsHostForWSL,
  detectWindowsChromePath,
  scanChromeInstances,
  findProjectChrome,
  findFreeDebugPort,
  startChromeOnWindows,
  killPuppeteerMonitorChromes,
  removePortProxyIfExists,
  isPortBlocked,
  runWslDiagnostics,
} from '../os/wsl/index.mjs';
import { LogBuffer } from '../logging/index.mjs';
import { createHttpServer } from '../http-server.mjs';
import { setupPageMonitoring as setupPageMonitoringShared } from './page-monitoring.mjs';
import { askUserToSelectPage } from './tab-selection.mjs';
import { askYesNo } from '../utils/ask.mjs';
import { printReadyHelp, printStatusBlock, KEYS_JOIN } from '../templates/ready-help.mjs';
import { printJoinConnectedBlock, printModeHeading } from '../templates/section-heading.mjs';
import { printApiHelpTable } from '../templates/api-help.mjs';
import { createTable, printTable } from '../templates/table-helper.mjs';
import { buildWaitForChromeContent } from '../templates/wait-for-chrome.mjs';
import { writeStatusLine, clearStatusLine } from '../utils/status-line.mjs';

/**
 * Run in Join Mode - attach to an existing Chrome browser
 * @param {number} port - Chrome debugging port (default: 9222)
 * @param {Object} options - Monitor options
 */
export async function runJoinMode(port, options = {}) {
  const {
    realtime = false,
    outputDir = process.cwd(),
    paths = null,
    ignorePatterns = [],
    hardTimeout = 0,
    httpPort = 60001,
    defaultUrl = '',
    host = null, // Allow explicit host override
    sharedHttpState = null,
    sharedHttpServer = null,
    skipModeHeading = false,
  } = options;

  if (!skipModeHeading) printModeHeading('Join mode');
  const lazyMode = !realtime;
  const connectHost = host || getWindowsHostForWSL({ quiet: true });
  const browserURL = `http://${connectHost}:${port}`;
  // Mutable URL that will be updated if auto-port-selection changes the port
  let currentBrowserURL = browserURL;

  // Create LogBuffer instance for centralized buffer management
  const logBuffer = new LogBuffer({
    outputDir,
    paths,
    lazyMode,
    ignorePatterns,
  });

  let browser = null;
  let monitoredPages = [];
  let cleanupDone = false;
  let httpServer = null;
  let isSelectingTab = false; // Flag to pause main keypress handler during tab selection
  let activePageCleanup = null;
  let collectingPaused = false; // When true, console/network events are not recorded

  // Output counter for periodic help reminder (same block as initial Ready, every HELP_INTERVAL)
  let outputCounter = 0;
  const HELP_INTERVAL = 5;
  function maybeShowHelp() {
    outputCounter++;
    if (outputCounter % HELP_INTERVAL === 0) {
      printReadyHelp(httpPort, KEYS_JOIN);
    }
  }

  // In-session help (h key) – full table with session context for Claude Code
  function printHelp() {
    const currentUrl = monitoredPages[0]?.url?.() || defaultUrl || '';
    const profileLoc = getChromeProfileLocation(outputDir);
    console.log(`${C.cyan}Join mode${C.reset}  Browser: ${C.brightGreen}${currentBrowserURL}${C.reset}  │  Dir: ${outputDir}`);
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
        currentUrl: currentUrl || undefined,
        profilePath: profileLoc?.path,
      },
    });
  }

  // Use shared HTTP server (started in CLI) or create our own
  if (sharedHttpState && sharedHttpServer) {
    httpServer = sharedHttpServer;
    sharedHttpState.mode = 'join';
    sharedHttpState.logBuffer = logBuffer;
    sharedHttpState.getPages = () => monitoredPages;
    sharedHttpState.getCollectingPaused = () => collectingPaused;
    sharedHttpState.setCollectingPaused = (v) => { collectingPaused = !!v; };
    sharedHttpState.getAllTabs = async () => {
      if (!browser) return [];
      const allPages = await browser.pages();
      const isUserPage = (pg) => {
        const u = pg.url();
        return !u.startsWith('chrome://') && !u.startsWith('devtools://') && !u.startsWith('chrome-extension://');
      };
      let pages = allPages.filter(isUserPage);
      const nonBlank = pages.filter(pg => pg.url() !== 'about:blank');
      if (nonBlank.length > 0) pages = nonBlank;
      return pages.map((pg, i) => ({ index: i + 1, url: pg.url() }));
    };
    sharedHttpState.switchToTab = async (index) => {
      if (!browser) return { success: false, error: 'Browser not connected' };
      try {
        const allPages = await browser.pages();
        const isUserPage = (pg) => {
          const u = pg.url();
          return !u.startsWith('chrome://') && !u.startsWith('devtools://') && !u.startsWith('chrome-extension://');
        };
        let pages = allPages.filter(isUserPage);
        const nonBlank = pages.filter(pg => pg.url() !== 'about:blank');
        if (nonBlank.length > 0) pages = nonBlank;
        if (index < 1 || index > pages.length) return { success: false, error: `Invalid index. Use 1-${pages.length}.` };
        const selectedPage = pages[index - 1];
        monitoredPages = [selectedPage];
        setupPageMonitoring(selectedPage, 'Page');
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
      mode: 'join',
      logBuffer,
      getPages: () => monitoredPages,
      getCollectingPaused: () => collectingPaused,
      setCollectingPaused: (v) => { collectingPaused = !!v; },
    });
  }

  async function cleanup(code = 0, closeBrowser = false) {
    if (cleanupDone) return;
    cleanupDone = true;

    console.log('');
    log.info(closeBrowser ? 'Disconnecting and closing Chrome...' : 'Disconnecting...');

    try {
      if (httpServer) {
        await new Promise((resolve) => httpServer.close(resolve));
        log.dim('HTTP server closed');
      }
    } catch (e) {}

    try {
      if (browser) {
        if (closeBrowser) {
          await browser.close();
          log.success('Browser closed');
        } else {
          browser.disconnect();
          log.success('Disconnected from browser (Chrome still running)');
        }
      }
    } catch (e) {}

    process.exit(code);
  }

  process.on('SIGINT', () => cleanup(0, false));
  process.on('SIGTERM', () => cleanup(0, false));
  process.on('uncaughtException', (e) => {
    const msg = (e && e.message) || String(e);
    if (/Execution context was destroyed|Target closed|Protocol error/.test(msg)) {
      log.dim(`Navigation/context closed: ${msg.slice(0, 60)}… (continuing)`);
      return;
    }
    log.error(`Uncaught exception: ${e.message}`);
    cleanup(1);
  });

  if (hardTimeout > 0) {
    setTimeout(() => {
      log.error(`HARD TIMEOUT (${hardTimeout}ms) - forcing exit`);
      cleanup(1);
    }, hardTimeout);
  }

  function setupKeyboardInput() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdin.on('keypress', async (str, key) => {
      // Ctrl+C always works
      if (key.ctrl && key.name === 'c') {
        cleanup(0);
        return;
      }

      // Ignore other keys during tab selection (the selection handler will process them)
      if (isSelectingTab) {
        return;
      }

      // Shortcuts only without modifiers (no Ctrl, Shift, Win)
      if (key.ctrl || key.shift || key.meta) {
        return;
      }

      if (key.name === 'd') {
        const page = monitoredPages.length > 0 ? monitoredPages[0] : null;
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
      } else if (key.name === 'k') {
        log.warn('Closing Chrome and exiting...');
        cleanup(0, true);
      } else if (key.name === 's') {
        const stats = logBuffer.getStats();
        const urls = monitoredPages.map(p => p.url()).join(', ');
        printStatusBlock(stats, urls, monitoredPages.length, collectingPaused);
        maybeShowHelp();
      } else if (key.name === 'p') {
        collectingPaused = !collectingPaused;
        log.info(collectingPaused ? 'Collecting stopped (paused). Press p or curl .../start to resume.' : 'Collecting started (resumed).');
        maybeShowHelp();
      } else if (key.name === 't') {
        // Switch tabs
        await switchTabs();
        maybeShowHelp();
      } else if (key.name === 'h') {
        // Show full help
        printHelp();
      }
    });
  }

  function setupPageMonitoring(page, pageLabel) {
    setupPageMonitoringShared(page, {
      logBuffer,
      getCollectingPaused: () => collectingPaused,
      setActivePageCleanup: (fn) => { activePageCleanup = fn; },
      pageLabel: pageLabel || '',
    });
  }

  async function switchTabs() {
    if (!browser) {
      log.error('Browser not connected');
      return;
    }

    try {
      const allPages = await browser.pages();

      // Filter out internal Chrome pages
      const isUserPage = (pg) => {
        const pgUrl = pg.url();
        return !pgUrl.startsWith('chrome://') &&
               !pgUrl.startsWith('devtools://') &&
               !pgUrl.startsWith('chrome-extension://');
      };
      let pages = allPages.filter(isUserPage);

      // If we have pages other than about:blank, filter out about:blank
      const nonBlankPages = pages.filter(pg => pg.url() !== 'about:blank');
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

      // Clear old monitoring and setup new
      monitoredPages = [selectedPage];
      setupPageMonitoring(selectedPage, 'Page');
      log.success(`Now monitoring: ${C.brightCyan}${selectedPage.url()}${C.reset}`);

      logBuffer.printConsoleSeparator('TAB SWITCHED');
      logBuffer.printNetworkSeparator('TAB SWITCHED');

    } catch (e) {
      log.error(`Error switching tabs: ${e.message}`);
      isSelectingTab = false;
    }
  }

  // ===== MAIN =====
  // Detect WSL and show setup instructions proactively
  const isWSL = (() => {
    try {
      const release = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      return release.includes('microsoft') || release.includes('wsl');
    } catch { return false; }
  })();

  // Track actual port to use (may change if auto-selecting free port)
  let actualPort = port;

  if (isWSL) {
    writeStatusLine(`${C.dim}Detecting Chrome...${C.reset}`);
    // Detect Chrome path
    const detectedChromePath = detectWindowsChromePath();
    const chromePath = detectedChromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const chromeFound = !!detectedChromePath;

    // Profile path (same logic as open-mode: WSL → Windows LOCALAPPDATA, native → project dir)
    const profileLoc = getChromeProfileLocation(outputDir);
    const projectName = path.basename(outputDir);

    const { instances, chromeRunning } = scanChromeInstances();
    const projectMatch = findProjectChrome(instances, outputDir);

    // Show block only when Chrome not found / not reachable (errors)
    const showSetupBlock = !projectMatch.found || !chromeFound;
    if (showSetupBlock) {
      clearStatusLine();
      console.log('');
      log.section('Join (WSL)');
      console.log(`  ${C.cyan}Project${C.reset} ${C.brightCyan}${projectName}${C.reset}  ${C.cyan}Profile${C.reset} ${C.dim}${profileLoc.path}${C.reset}`);
      if (instances.length > 0) {
        const line = instances.map((inst) => {
          const isOurs = projectMatch.found && projectMatch.instance === inst;
          const mark = isOurs ? `${C.green}*${C.reset}` : '';
          return `port ${inst.port}${mark}`;
        }).join(', ');
        console.log(`  ${C.cyan}Instances${C.reset} ${line}`);
      } else if (chromeRunning) {
        console.log(`  ${C.yellow}Chrome running without debug port${C.reset}`);
      } else {
        console.log(`  ${C.dim}Chrome not running${C.reset}`);
      }
      console.log('');
    }

    // Decide what to do based on status
    let shouldWaitForUser = false;
    let shouldLaunchChrome = false;
    let waitMessageContent = '';

    if (projectMatch.found && projectMatch.instance) {
      // Found Chrome with our project's profile - test if actually reachable
      actualPort = projectMatch.instance.port;
      writeStatusLine(`${C.dim}Checking connection to port ${actualPort}...${C.reset}`);

      // Actually test connectivity (don't trust bindAddress from command line)
      let isReachable = false;
      try {
        const testUrl = `http://${connectHost}:${actualPort}/json/version`;
        const response = await fetch(testUrl, { signal: AbortSignal.timeout(2000) });
        isReachable = response.ok;
      } catch {
        isReachable = false;
      }

      if (isReachable) {
        clearStatusLine();
        // Silent – compact block shown after connect
      } else {
        clearStatusLine();
        // Chrome exists but not reachable from WSL - port proxy needed
        shouldWaitForUser = true;
        waitMessageContent = [
          `${C.yellow}⚠ Chrome found but not accessible from WSL${C.reset}`,
          `${C.dim}Port proxy required (Chrome M113+ binds to 127.0.0.1 only)${C.reset}`,
          '',
          `${C.yellow}Close Chrome and re-run to retry.${C.reset}`,
        ].join('\n');
      }
    } else if (chromeFound) {
      actualPort = findFreeDebugPort(instances, port);
      clearStatusLine();
      console.log(`  ${C.yellow}No Chrome for this project.${C.reset} Port ${actualPort}, profile ${C.dim}${profileLoc.path}${C.reset}`);
      shouldLaunchChrome = await askYesNo(`  Launch Chrome for this project?`);
    } else {
      actualPort = findFreeDebugPort(instances, port);
      shouldWaitForUser = true;
      clearStatusLine();
      waitMessageContent = [
        `${C.yellow}Chrome path not found.${C.reset} In PowerShell (Admin):`,
        `${C.dim}1) Start Chrome: --remote-debugging-port=${actualPort} --user-data-dir="${profileLoc.path}"${C.reset}`,
        `${C.dim}2) netsh interface portproxy add v4tov4 listenport=${actualPort} listenaddress=0.0.0.0 connectport=${actualPort} connectaddress=127.0.0.1${C.reset}`,
      ].join('\n');
    }

    // Launch Chrome if needed
    if (shouldLaunchChrome && chromeFound) {
      // Check if port proxy is blocking our port and remove it
      if (isPortBlocked(actualPort)) {
        clearStatusLine();
        log.info(`Port ${actualPort} is in use, checking for port proxy...`);
        const removed = removePortProxyIfExists(actualPort);
        if (!removed && isPortBlocked(actualPort)) {
          // Port is still blocked - try next free port
          clearStatusLine();
          log.warn(`Port ${actualPort} is blocked, trying next available...`);
          actualPort = findFreeDebugPort(instances, actualPort + 1);
          // Check the new port too
          if (isPortBlocked(actualPort)) {
            removePortProxyIfExists(actualPort);
          }
        }
      }

      // Kill any existing Chrome with puppeteer-monitor profile to prevent singleton hijacking
      killPuppeteerMonitorChromes();

      clearStatusLine();
      log.info(`Launching Chrome on port ${actualPort}...`);
      const launched = startChromeOnWindows(chromePath, actualPort, profileLoc.path);
      if (launched) {
        writeStatusLine(`${C.dim}Waiting for Chrome to start...${C.reset}`);
        await new Promise(r => setTimeout(r, 2500));
        clearStatusLine();
      } else {
        log.error('Failed to launch Chrome automatically');
        shouldWaitForUser = true;
        waitMessageContent = `${C.yellow}Failed to launch Chrome automatically.${C.reset}`;
      }
    }

    // Wait for user if needed
    if (shouldWaitForUser) {
      clearStatusLine();
      const content = buildWaitForChromeContent(waitMessageContent);
      const table = createTable({ colWidths: [72], tableOpts: { wordWrap: true } });
      table.push([content]);
      printTable(table);
      await new Promise((resolve) => {
        process.stdin.setRawMode(false);
        process.stdin.resume();
        process.stdin.once('data', () => {
          resolve();
        });
      });
      console.log('');
    }

  }

  // Use actual port for connection (may have been changed by auto-detection)
  const finalBrowserURL = `http://${connectHost}:${actualPort}`;
  currentBrowserURL = finalBrowserURL;

  if (realtime) {
    fs.writeFileSync(logBuffer.CONSOLE_LOG, '');
    logBuffer.clearNetworkDir();
  }

  // HTTP server is already started via createHttpServer above

  try {
    writeStatusLine(`${C.dim}Connecting to browser...${C.reset}`);
    // Connect to existing Chrome instance via Chrome DevTools Protocol (CDP).
    // defaultViewport: null preserves the browser's actual viewport size.
    // Without this, Puppeteer would resize the page to its default (800x600),
    // causing the page content to shrink unexpectedly.
    browser = await puppeteer.connect({ browserURL: finalBrowserURL, defaultViewport: null });

    writeStatusLine(`${C.dim}Loading pages...${C.reset}`);
    const allPages = await browser.pages();

    // Filter out internal/dev pages that are not useful for monitoring
    const isUserPage = (page) => {
      const url = page.url();
      const title = page.title ? page.title() : '';

      // Skip Chrome internal pages
      if (url.startsWith('chrome://')) return false;
      if (url.startsWith('chrome-extension://')) return false;
      if (url.startsWith('devtools://')) return false;
      if (url === 'about:blank') return false;

      // Skip React/Redux DevTools and similar extensions
      if (url.includes('react-devtools') || url.includes('redux-devtools')) return false;
      if (url.includes('__react_devtools__')) return false;

      // Skip extension pages by pattern
      if (/^moz-extension:\/\//.test(url)) return false;  // Firefox extensions
      if (/^extension:\/\//.test(url)) return false;

      return true;
    };

    const userPages = allPages.filter(isUserPage);
    const pages = userPages.length > 0 ? userPages : allPages; // Fallback to all if no user pages

    if (pages.length === 0) {
      clearStatusLine();
      log.error('No tabs found in browser');
      cleanup(1);
      return;
    }

    let selectedPage;
    if (pages.length === 1) {
      selectedPage = pages[0];
      clearStatusLine();
    } else {
      clearStatusLine();
      log.section('Tab Selection');
      console.log(`  ${C.cyan}Tabs${C.reset} ${pages.length} – select which to monitor:`);
      selectedPage = await askUserToSelectPage(pages);
      if (!selectedPage) {
        log.dim('Using first tab.');
        selectedPage = pages[0];
      }
    }

    monitoredPages = [selectedPage];
    setupPageMonitoring(selectedPage, 'Page');

    if (isWSL) {
      printJoinConnectedBlock(connectHost, selectedPage.url());
    }

    // Watch for new tabs
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        const newPage = await target.page();
        if (newPage) log.dim(`New tab: ${newPage.url()}`);
      }
    });

    logBuffer.printConsoleSeparator('CONNECTED - Listening for console output');
    logBuffer.printNetworkSeparator('CONNECTED - Listening for network requests');

    clearStatusLine(true);
    // Ready block from template (same as periodic reminder)
    printReadyHelp(httpPort, KEYS_JOIN);
    setupKeyboardInput();

    await new Promise(() => {});
  } catch (e) {
    clearStatusLine(true);
    if (e.message.includes('ECONNREFUSED') || e.message.includes('fetch failed') || e.message.includes('ETIMEDOUT') || e.message.includes('timeout')) {
      console.log('');
      log.error(`Cannot connect to Chrome at ${C.brightRed}${currentBrowserURL}${C.reset}`);
      console.log('');

      // Check if we're in WSL - if so, run diagnostics
      const isWSL = (() => {
        try {
          const release = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
          return release.includes('microsoft') || release.includes('wsl');
        } catch { return false; }
      })();

      if (isWSL) {
        // Run comprehensive WSL diagnostics
        const diagResult = await runWslDiagnostics(port, connectHost);

        // Handle port proxy conflict automatically
        if (diagResult.hasPortProxyConflict) {
          console.log('');
          console.log(`${C.bold}${C.green}═══════════════════════════════════════════════════════════════════════════════${C.reset}`);
          console.log(`${C.bold}${C.green}  AUTOMATIC FIX${C.reset}`);
          console.log(`${C.bold}${C.green}═══════════════════════════════════════════════════════════════════════════════${C.reset}`);
          console.log('');

          const shouldFix = await askYesNo('Do you want me to fix this automatically? (remove port proxy, restart Chrome)');

          if (shouldFix) {
            const fixPort = diagResult.actualPort || port;

            console.log(`${C.cyan}[1/2]${C.reset} Removing port proxy for port ${fixPort}...`);
            try {
              execSync(`netsh.exe interface portproxy delete v4tov4 listenport=${fixPort} listenaddress=0.0.0.0`, { encoding: 'utf8', timeout: 5000 });
              console.log(`  ${C.green}✓${C.reset} Port proxy removed`);
            } catch (err) {
              console.log(`  ${C.yellow}!${C.reset} Could not remove port proxy (may need admin): ${err.message}`);
            }

            console.log(`${C.cyan}[2/2]${C.reset} Stopping Chrome...`);
            try {
              killPuppeteerMonitorChromes(true); // Only kill puppeteer-monitor Chrome, not user's browser!
              console.log(`  ${C.green}✓${C.reset} Chrome stopped`);
            } catch (err) {
              console.log(`  ${C.yellow}!${C.reset} Could not stop Chrome: ${err.message}`);
            }

            console.log('');
            console.log(`${C.green}Fix applied!${C.reset} Please run puppeteer-monitor again.`);
            console.log(`${C.dim}Chrome will now bind to 0.0.0.0 correctly (no port proxy needed).${C.reset}`);
            console.log('');
            process.exit(0);
          }
        }
      } else {
        // Non-WSL: show basic help
        console.log(`  ${C.yellow}Make sure Chrome is running with remote debugging enabled:${C.reset}`);
        console.log(`    ${C.dim}Windows:${C.reset} ${C.cyan}chrome.exe --remote-debugging-port=${port}${C.reset}`);
        console.log(`    ${C.dim}Linux:${C.reset}   ${C.cyan}google-chrome --remote-debugging-port=${port}${C.reset}`);
        console.log(`    ${C.dim}Mac:${C.reset}     ${C.cyan}/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}${C.reset}`);
        console.log('');
        console.log(`  ${C.yellow}If connecting from remote server, create SSH reverse tunnel first:${C.reset}`);
        console.log(`    ${C.cyan}ssh -R ${port}:localhost:${port} user@this-server${C.reset}`);
        console.log('');
      }
    } else {
      log.error(e.message);
    }
    process.exit(1);
  }
}