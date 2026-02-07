/**
 * Interactive mode: no Chrome started; user chooses open (o) or join (j).
 * Exports runInteractiveMode(options, deps) where deps = { runOpenMode, runJoinMode }
 * to avoid circular dependency with monitor.mjs.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { C, log } from '../utils/colors.mjs';
import { getChromeProfileLocation } from '../utils/chrome-profile-path.mjs';
import { getLastCmdStderrAndClear, isWsl, scanChromeInstances } from '../os/wsl/index.mjs';
import { printBulletBox, printInteractiveMenuBlock, printModeHeading } from '../templates/section-heading.mjs';
import { createTable, printTable } from '../templates/table-helper.mjs';
import { buildWaitForChromeContent } from '../templates/wait-for-chrome.mjs';
import { writeStatusLine, clearStatusLine } from '../utils/status-line.mjs';
import { getPaths, ensureDirectories } from '../settings.mjs';

/**
 * Collect Chrome instances with remote debugging (for interactive "join").
 * @returns {Promise<Array<{ port: number, label: string }>>}
 */
export async function getChromeInstances() {
  writeStatusLine(`${C.dim}Scanning for Chrome...${C.reset}`);
  try {
    if (isWsl()) {
      const { instances } = scanChromeInstances();
      return instances.map((i) => ({ port: i.port, label: `${i.port} – ${i.profile}` }));
    }
    const list = [];
    const host = '127.0.0.1';
    for (let port = 9222; port <= 9229; port++) {
      try {
        const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(800) });
        if (res.ok) {
          const info = await res.json();
          const label = info.Browser ? `${port} – ${info.Browser}` : String(port);
          list.push({ port, label });
        }
      } catch {
        // Port not reachable
      }
    }
    return list;
  } finally {
    clearStatusLine();
  }
}

/**
 * Ask user which directory to use as project root when opening Chrome (key 'o').
 * Reads one line via stdin.once('data') so that stdin is NOT closed (readline.close()
 * would destroy stdin and the process would exit before the menu keypress listener runs).
 * @param {string} currentCwd
 * @returns {Promise<string>} Resolved absolute path to use as outputDir
 */
export function askProjectDirForOpen(currentCwd) {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isTTY && process.stdin.isRaw;
    if (wasRaw) process.stdin.setRawMode(false);

    console.log('');
    process.stdout.write(`  ${C.cyan}Project root${C.reset}: ${C.brightCyan}${currentCwd}${C.reset} (${C.green}Enter${C.reset} = use, or type path): `);

    const onData = (chunk) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      if (wasRaw && process.stdin.isTTY) process.stdin.setRawMode(true);

      const trimmed = (chunk.toString().trim().split('\n')[0] || '').trim();
      if (trimmed === '') {
        resolve(currentCwd);
        return;
      }
      const resolved = path.resolve(currentCwd, trimmed);
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) {
          log.warn(`Not a directory: ${resolved}, using current dir.`);
          resolve(currentCwd);
          return;
        }
      } catch {
        log.warn(`Path not found: ${resolved}, using current dir.`);
        resolve(currentCwd);
        return;
      }
      resolve(resolved);
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', onData);
  });
}

/**
 * Let user pick one Chrome instance from list.
 * @param {Array<{ port: number, label: string }>} items
 * @returns {Promise<number|null>}
 */
export function askUserToSelectChromeInstance(items) {
  if (items.length === 0) return Promise.resolve(null);
  if (items.length === 1) {
    return Promise.resolve(items[0].port);
  }
  console.log('');
  items.forEach((item, index) => {
    console.log(`  ${C.brightGreen}${index + 1}${C.reset}. ${C.cyan}${item.label}${C.reset}`);
  });
  console.log('');
  console.log(`  ${C.red}q${C.reset}. Cancel`);
  console.log('');
  return new Promise((resolve) => {
    process.stdout.write(`${C.cyan}Select Chrome instance${C.reset} (${C.green}1-${items.length}${C.reset}, ${C.red}q${C.reset}=cancel): `);
    const handleKey = (str, key) => {
      if (!key) return;
      process.stdin.removeListener('keypress', handleKey);
      const char = (key.name || str).toLowerCase();
      process.stdout.write(char + '\n');
      if (char === 'q') {
        resolve(null);
      } else {
        const num = parseInt(char, 10);
        if (num >= 1 && num <= items.length) {
          resolve(items[num - 1].port);
        } else {
          log.warn('Invalid selection');
          resolve(null);
        }
      }
    };
    process.stdin.once('keypress', handleKey);
  });
}

/**
 * Run in Interactive Mode. Requires runOpenMode and runJoinMode to be passed to avoid circular deps.
 * @param {Object} options
 * @param {{ runOpenMode: Function, runJoinMode: Function }} deps
 */
export async function runInteractiveMode(options, deps) {
  const {
    defaultUrl = 'https://localhost:4000/',
    realtime = false,
    headless = false,
    hardTimeout = 0,
    navigationTimeout = 60_000,
    outputDir: optionsOutputDir = process.cwd(),
    paths: optionsPaths = null,
    ignorePatterns = [],
    httpPort = 60001,
  } = options;

  const { runOpenMode, runJoinMode } = deps;

  // Ask for project root when interactive; otherwise use option/cwd
  const outputDir = process.stdin.isTTY
    ? await askProjectDirForOpen(process.cwd())
    : (optionsOutputDir || process.cwd());

  // Recompute paths if project root changed from CLI's original
  const paths = (outputDir !== optionsOutputDir && optionsPaths)
    ? getPaths(outputDir)
    : (optionsPaths || getPaths(outputDir));
  ensureDirectories(outputDir);

  const profileLoc = getChromeProfileLocation(outputDir);
  const cmdStderrLines = getLastCmdStderrAndClear();
  // Merge UNC path line with CMD.EXE message (path first in stderr, then "CMD.EXE was started...")
  let mergedStderr = [];
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
  const infoLines = [
    ...mergedStderr,
    `${C.cyan}Profile path:${C.reset} ${profileLoc.path} ${C.dim}(${profileLoc.where})${C.reset}`,
  ];
  if (infoLines.length > 0) {
    console.log('');
    printBulletBox(infoLines);
  }

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume(); // ensure stdin is readable after askProjectDirForOpen (may have paused it)

  const MENU_INDENT = '    ';
  const showMenu = () => {
    console.log('');
    printInteractiveMenuBlock('  Interactive   Chrome not started – choose action');
    console.log(`${MENU_INDENT}${C.green}o${C.reset} = open Chrome (launch new browser → ${C.cyan}${defaultUrl}${C.reset})`);
    console.log(`${MENU_INDENT}${C.green}j${C.reset} = join running Chrome (pick existing instance/tab)`);
    console.log(`${MENU_INDENT}${C.green}q${C.reset} = quit`);
  };

  showMenu();

  process.stdin.on('keypress', async (str, key) => {
    if (key?.ctrl && key?.name === 'c') {
      process.exit(0);
    }
    if (key?.ctrl || key?.shift || key?.meta) return;
    const char = (key?.name || str)?.toLowerCase();
    if (char === 'q') {
      process.exit(0);
    }
    if (char === 'o') {
      process.stdin.removeAllListeners('keypress');
      process.stdin.setRawMode?.(false);
      await runOpenMode(defaultUrl, {
        realtime,
        headless,
        outputDir,
        paths,
        ignorePatterns,
        hardTimeout,
        navigationTimeout,
        httpPort,
        sharedHttpState: options.sharedHttpState,
        sharedHttpServer: options.sharedHttpServer,
        skipProfileBlock: true,
      });
      return;
    }
    if (char === 'j') {
      printModeHeading('Join mode');
      let instances = await getChromeInstances();
      while (instances.length === 0) {
        const hint = isWsl()
          ? 'Start Chrome on Windows with: chrome.exe --remote-debugging-port=9222'
          : 'Start Chrome with: google-chrome --remote-debugging-port=9222';
        const titleContent = `${C.yellow}No Chrome with remote debugging found.${C.reset}\n${C.dim}${hint}${C.reset}`;
        const content = buildWaitForChromeContent(titleContent);
        const table = createTable({ colWidths: [72], tableOpts: { wordWrap: true } });
        table.push([content]);
        printTable(table);
        await new Promise((resolve) => {
          process.stdin.setRawMode?.(false);
          process.stdin.resume();
          process.stdin.once('data', () => {
            if (process.stdin.isTTY) process.stdin.setRawMode(true);
            resolve();
          });
        });
        console.log('');
        instances = await getChromeInstances();
      }
      const port = await askUserToSelectChromeInstance(instances);
      if (port == null) return;
      process.stdin.removeAllListeners('keypress');
      process.stdin.setRawMode?.(false);
      await runJoinMode(port, {
        realtime,
        outputDir,
        paths,
        ignorePatterns,
        hardTimeout,
        defaultUrl,
        httpPort,
        sharedHttpState: options.sharedHttpState,
        sharedHttpServer: options.sharedHttpServer,
        skipModeHeading: true,
      });
    }
  });
}
