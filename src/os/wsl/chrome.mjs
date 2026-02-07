/**
 * Chrome detection and launch utilities for WSL→Windows.
 *
 * Chrome singleton pattern: when Chrome is already running, new Chrome instances
 * send their arguments to the existing process via IPC and exit immediately.
 * This means --remote-debugging-port flags on new launches are IGNORED.
 *
 * Chrome Canary is preferred for browsermonitor because it runs as a separate
 * process from regular Chrome, avoiding singleton conflicts.
 */

import fs from 'fs';
import path from 'path';
import { getProfileIdFromProjectDir } from '../../utils/profile-id.mjs';
import { execFileSync, execSync, spawnSync } from 'child_process';
import { C, log } from '../../utils/colors.mjs';

/** Last stderr lines from cmd.exe (UNC/CMD warnings). Cleared when read. */
let _lastCmdStderrLines = [];

/** Run cmd.exe and capture stderr; store lines for caller to format (do not print). */
function execCmdAndFormatStderr(cmdAfterSlashC) {
  const result = spawnSync('cmd.exe', ['/c', cmdAfterSlashC], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = (result.stderr || '').trim();
  if (stderr) {
    _lastCmdStderrLines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } else {
    _lastCmdStderrLines = [];
  }
  if (result.status !== 0) throw new Error(stderr || 'cmd failed');
  return (result.stdout || '').trim().replace(/\r?\n/g, '');
}

/** Get and clear stored cmd stderr lines (for formatting by caller). */
export function getLastCmdStderrAndClear() {
  const lines = _lastCmdStderrLines;
  _lastCmdStderrLines = [];
  return lines;
}
import { getWslDistroName } from './detect.mjs';

// Cache for LOCALAPPDATA path
let _cachedLocalAppData = null;

/**
 * Get Windows LOCALAPPDATA path (cached).
 * @returns {string} Expanded LOCALAPPDATA path (e.g., C:\Users\info\AppData\Local)
 */
export function getWindowsLocalAppData() {
  if (_cachedLocalAppData) return _cachedLocalAppData;

  try {
    // Get LOCALAPPDATA from Windows - use cmd.exe to expand the variable
    _cachedLocalAppData = execCmdAndFormatStderr('echo %LOCALAPPDATA%');
  } catch {
    // Fallback: try to get username and build path
    try {
      const winUser = execCmdAndFormatStderr('echo %USERNAME%');
      _cachedLocalAppData = `C:\\Users\\${winUser}\\AppData\\Local`;
    } catch {
      // Last resort fallback
      _cachedLocalAppData = 'C:\\Users\\Public\\AppData\\Local';
    }
  }

  return _cachedLocalAppData;
}

/**
 * Generate a unique Windows profile path for a project.
 * Uses local Windows directory instead of UNC path for better Chrome compatibility.
 * Delegates to getProfileIdFromProjectDir for consistent projectName + hash.
 *
 * @param {string} projectDir - WSL project directory path
 * @returns {string} Windows-style profile path (in LOCALAPPDATA\browsermonitor\)
 */
export function getWindowsProfilePath(projectDir) {
  const { profileId } = getProfileIdFromProjectDir(projectDir);
  const localAppData = getWindowsLocalAppData();
  return `${localAppData}\\browsermonitor\\${profileId}`;
}

/**
 * Detect Chrome Canary installation path from WSL.
 * Chrome Canary is preferred for browsermonitor because it runs as a separate
 * process from regular Chrome, avoiding singleton conflicts.
 *
 * @returns {string|null} Windows-style path to Chrome Canary or null if not found
 */
export function detectWindowsChromeCanaryPath() {
  try {
    const usersDir = '/mnt/c/Users';
    if (fs.existsSync(usersDir)) {
      const users = fs.readdirSync(usersDir).filter(u =>
        !['Default', 'Default User', 'Public', 'All Users'].includes(u) &&
        fs.statSync(path.join(usersDir, u)).isDirectory()
      );
      for (const user of users) {
        const canaryPath = `/mnt/c/Users/${user}/AppData/Local/Google/Chrome SxS/Application/chrome.exe`;
        const winPath = `C:\\Users\\${user}\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe`;
        try {
          if (fs.existsSync(canaryPath)) {
            return winPath;
          }
        } catch {
          // Ignore access errors
        }
      }
    }
  } catch {
    // Ignore errors reading user directories
  }
  return null;
}

/**
 * Detect Chrome installation path from WSL.
 * For LAUNCH mode, prefers Chrome Canary (isolated from user's regular Chrome).
 * For CONNECT mode, this function is not used (connects to any running Chrome).
 *
 * @param {boolean} canaryOnly - If true, only return Canary path (for launch mode)
 * @returns {string|null} Windows-style path to Chrome or null if not found
 */
export function detectWindowsChromePath(canaryOnly = false) {
  const canaryPath = detectWindowsChromeCanaryPath();
  if (canaryPath) {
    return canaryPath;
  }

  if (canaryOnly) {
    return null;
  }

  const chromePaths = [
    { wsl: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', win: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { wsl: '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe', win: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  ];

  // Check user-specific installation (LOCALAPPDATA)
  try {
    const usersDir = '/mnt/c/Users';
    if (fs.existsSync(usersDir)) {
      const users = fs.readdirSync(usersDir).filter(u =>
        !['Default', 'Default User', 'Public', 'All Users'].includes(u) &&
        fs.statSync(path.join(usersDir, u)).isDirectory()
      );
      for (const user of users) {
        const localAppDataPath = `/mnt/c/Users/${user}/AppData/Local/Google/Chrome/Application/chrome.exe`;
        const winPath = `C:\\Users\\${user}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`;
        chromePaths.push({ wsl: localAppDataPath, win: winPath });
      }
    }
  } catch {
    // Ignore errors reading user directories
  }

  for (const p of chromePaths) {
    try {
      if (fs.existsSync(p.wsl)) {
        return p.win;
      }
    } catch {
      // Ignore access errors
    }
  }

  return null;
}

/**
 * Print Chrome Canary installation instructions.
 * Called when Canary is not found and launch mode is requested.
 */
export function printCanaryInstallInstructions() {
  console.log('');
  console.log(`${C.yellow}═══════════════════════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.yellow}  CHROME CANARY REQUIRED${C.reset}`);
  console.log(`${C.yellow}═══════════════════════════════════════════════════════════════════════════════${C.reset}`);
  console.log('');
  console.log(`  For ${C.cyan}launch mode${C.reset}, browsermonitor requires ${C.brightGreen}Chrome Canary${C.reset}.`);
  console.log('');
  console.log(`  ${C.bold}Why Chrome Canary?${C.reset}`);
  console.log(`  • Runs as a ${C.green}separate process${C.reset} from your regular Chrome`);
  console.log(`  • No singleton conflicts - your regular Chrome stays untouched`);
  console.log(`  • Debug port is guaranteed to work without port proxy`);
  console.log('');
  console.log(`  ${C.bold}Installation:${C.reset}`);
  console.log(`  1. Download from: ${C.brightCyan}https://www.google.com/chrome/canary/${C.reset}`);
  console.log(`  2. Install normally (will NOT replace your regular Chrome)`);
  console.log(`  3. Run browsermonitor again`);
  console.log('');
  console.log(`  ${C.dim}Alternative: Use ${C.cyan}--join=9222${C.reset}${C.dim} to attach to any running Chrome with debug port.${C.reset}`);
  console.log('');
  console.log(`${C.yellow}═══════════════════════════════════════════════════════════════════════════════${C.reset}`);
  console.log('');
}

/**
 * Scan all Chrome instances on Windows for debug ports and profiles.
 *
 * @returns {{instances: Array<{port: number, profile: string, bindAddress: string}>, chromeRunning: boolean}}
 */
export function scanChromeInstances() {
  try {
    // Check if Chrome is running at all
    const chromePid = execSync(
      'powershell.exe -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { \\$_.Id }"',
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (!chromePid) {
      return { instances: [], chromeRunning: false };
    }

    // Get all Chrome command lines with WMI
    const wmicOutput = execSync(
      'wmic.exe process where "name=\'chrome.exe\'" get commandline /format:list 2>nul',
      { encoding: 'utf8', timeout: 10000 }
    ).trim();

    const instances = [];
    const seenPorts = new Set();

    if (wmicOutput) {
      const lines = wmicOutput.split('\n').filter(l => l.includes('--remote-debugging-port'));
      for (const line of lines) {
        const portMatch = line.match(/--remote-debugging-port=(\d+)/);
        const addressMatch = line.match(/--remote-debugging-address=([^\s'"]+)/);
        const profileMatch = line.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);

        if (portMatch) {
          const portNum = parseInt(portMatch[1], 10);
          // Deduplicate - Chrome has many subprocesses with same args
          if (!seenPorts.has(portNum)) {
            seenPorts.add(portNum);
            const profilePath = profileMatch ? (profileMatch[1] || profileMatch[2] || profileMatch[3]) : 'default';
            instances.push({
              port: portNum,
              profile: profilePath,
              bindAddress: addressMatch ? addressMatch[1] : '127.0.0.1',
            });
          }
        }
      }
    }

    return { instances, chromeRunning: true };
  } catch (e) {
    return { instances: [], chromeRunning: false };
  }
}

/**
 * Find Chrome instance matching the current project's profile.
 *
 * @param {Array} instances - Chrome instances from scanChromeInstances()
 * @param {string} projectDir - Current project directory (cwd)
 * @returns {{found: boolean, instance: Object|null, matchType: string}}
 */
export function findProjectChrome(instances, projectDir) {
  if (!instances || instances.length === 0) {
    return { found: false, instance: null, matchType: 'none' };
  }

  const { projectName, profileId: expectedProfileId } = getProfileIdFromProjectDir(projectDir);

  for (const inst of instances) {
    const instProfile = inst.profile.toLowerCase();

    // Match new format: browsermonitor\{projectName}_{hash}
    if (instProfile.includes('browsermonitor') && instProfile.includes(expectedProfileId)) {
      return { found: true, instance: inst, matchType: 'exact' };
    }

    // Legacy match: old puppeteer-monitor format
    if (instProfile.includes('puppeteer-monitor') && instProfile.includes(expectedProfileId)) {
      return { found: true, instance: inst, matchType: 'exact' };
    }

    // Legacy match: just project name
    if (instProfile.includes(projectName.toLowerCase()) &&
        (instProfile.includes('.puppeteer-profile') || instProfile.includes('browsermonitor') || instProfile.includes('puppeteer-monitor'))) {
      return { found: true, instance: inst, matchType: 'legacy' };
    }
  }

  // No exact match - return first accessible instance as fallback candidate
  const accessibleInst = instances.find(i => i.bindAddress === '0.0.0.0');
  if (accessibleInst) {
    return { found: false, instance: accessibleInst, matchType: 'accessible' };
  }

  return { found: false, instance: instances[0], matchType: 'first' };
}

/**
 * Find next available debug port starting from 9222.
 *
 * @param {Array} instances - Chrome instances from scanChromeInstances()
 * @param {number} startPort - Starting port (default: 9222)
 * @returns {number} Next available port
 */
export function findFreeDebugPort(instances, startPort = 9222) {
  const usedPorts = new Set(instances.map(i => i.port));
  for (let port = startPort; port < startPort + 100; port++) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  return startPort;
}

/**
 * Start Chrome on Windows and set up port proxy for WSL access.
 *
 * Note: Chrome M113+ ignores --remote-debugging-address=0.0.0.0 for security.
 * Chrome always binds to 127.0.0.1 or ::1, so we MUST use port proxy for WSL access.
 *
 * @param {string} chromePath - Windows path to Chrome
 * @param {number} port - Debug port
 * @param {string} profileDir - Windows-style profile directory path
 * @returns {boolean} true if launched successfully
 */
export function startChromeOnWindows(chromePath, port, profileDir) {
  try {
    // First, remove any existing port proxy on this port
    try {
      execSync(
        `powershell.exe -NoProfile -Command "netsh interface portproxy delete v4tov4 listenport=${port} listenaddress=0.0.0.0 2>\\$null"`,
        { encoding: 'utf8', timeout: 5000 }
      );
    } catch { /* ignore */ }

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir="${profileDir}"`,
    ].join("','");

    const psCommand = `Start-Process -FilePath '${chromePath}' -ArgumentList '${args}'`;
    execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, { encoding: 'utf8', timeout: 10000 });

    log.dim('Waiting for Chrome to start...');

    // Detect Chrome's bind address (IPv4 or IPv6)
    let chromeBindAddress = null;
    for (let i = 0; i < 10; i++) {
      try {
        execSync('powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 500"', { timeout: 2000 });
      } catch { /* ignore */ }

      try {
        const netstatOutput = execSync(`netstat.exe -ano`, { encoding: 'utf8', timeout: 5000 });
        const lines = netstatOutput.split('\n').filter(l => l.includes(':' + port) && l.includes('LISTEN'));
        for (const line of lines) {
          if (line.includes('127.0.0.1:' + port)) {
            chromeBindAddress = '127.0.0.1';
            break;
          } else if (line.includes('[::1]:' + port)) {
            chromeBindAddress = '::1';
            break;
          }
        }
        if (chromeBindAddress) break;
      } catch { /* ignore */ }
    }

    if (!chromeBindAddress) {
      chromeBindAddress = '127.0.0.1';
      log.dim('Could not detect Chrome bind address, assuming 127.0.0.1');
    }

    // Set up port proxy - use v4tov6 for IPv6, v4tov4 for IPv4
    const isIPv6 = chromeBindAddress === '::1';
    const proxyType = isIPv6 ? 'v4tov6' : 'v4tov4';
    const connectAddress = isIPv6 ? '::1' : '127.0.0.1';

    try {
      execSync(
        `powershell.exe -NoProfile -Command "netsh interface portproxy delete v4tov4 listenport=${port} listenaddress=0.0.0.0 2>\\$null; netsh interface portproxy delete v4tov6 listenport=${port} listenaddress=0.0.0.0 2>\\$null"`,
        { encoding: 'utf8', timeout: 5000 }
      );
    } catch { /* ignore */ }

    try {
      execSync(
        `powershell.exe -NoProfile -Command "netsh interface portproxy add ${proxyType} listenport=${port} listenaddress=0.0.0.0 connectport=${port} connectaddress=${connectAddress}"`,
        { encoding: 'utf8', timeout: 5000 }
      );
      log.success(`Port proxy configured: 0.0.0.0:${port} → ${connectAddress}:${port} (${proxyType})`);
    } catch (e) {
      log.warn(`Could not set up port proxy (need admin). Run manually:`);
      console.log(`  ${C.cyan}netsh interface portproxy add ${proxyType} listenport=${port} listenaddress=0.0.0.0 connectport=${port} connectaddress=${connectAddress}${C.reset}`);
    }

    return true;
  } catch (e) {
    log.error(`Failed to start Chrome: ${e.message}`);
    return false;
  }
}

/**
 * Kill only Chrome processes that have "browsermonitor" in their profile path.
 * This is safe to call - it will NEVER kill the user's regular Chrome browser.
 *
 * @param {boolean} usePowerShell - Use PowerShell instead of wmic (for calling from WSL)
 * @returns {number} Number of Chrome processes killed
 */
export function killPuppeteerMonitorChromes(usePowerShell = false) {
  try {
    if (usePowerShell) {
      const psScript = `$chromes = Get-WmiObject Win32_Process -Filter 'name=''chrome.exe''' | Select-Object ProcessId, CommandLine; $killed = 0; foreach ($chrome in $chromes) { if ($chrome.CommandLine -match 'browsermonitor|puppeteer-monitor') { Stop-Process -Id $chrome.ProcessId -Force -ErrorAction SilentlyContinue; $killed++; break } }; Write-Output $killed`;

      try {
        const result = execFileSync(
          'powershell.exe',
          ['-NoProfile', '-Command', psScript],
          { encoding: 'utf8', timeout: 15000 }
        );
        const killed = parseInt(result.trim(), 10) || 0;
        if (killed > 0) {
          log.success('Killed browsermonitor Chrome (PowerShell)');
        }
        return killed;
      } catch (e) {
        log.dim(`PowerShell kill failed: ${e.message}`);
        return 0;
      }
    }

    // wmic version - faster, used in most cases
    const wmicOutput = execSync(
      'wmic.exe process where "name=\'chrome.exe\'" get processid,commandline 2>/dev/null',
      { encoding: 'utf8', timeout: 10000 }
    );

    const lines = wmicOutput.split('\n').filter(line => line.trim());
    const puppeteerMonitorPids = [];

    for (const line of lines) {
      if (line.includes('CommandLine') && line.includes('ProcessId')) continue;

      if (line.includes('browsermonitor') || line.includes('puppeteer-monitor')) {
        const pidMatch = line.match(/(\d+)\s*$/);
        if (pidMatch) {
          puppeteerMonitorPids.push(pidMatch[1]);
        }
      }
    }

    if (puppeteerMonitorPids.length === 0) {
      return 0;
    }

    const mainPid = puppeteerMonitorPids[0];
    log.warn(`Found ${puppeteerMonitorPids.length} Chrome process(es) with browsermonitor profile`);
    log.info(`Killing Chrome process tree (PID: ${mainPid})...`);

    try {
      execSync(
        `taskkill.exe /PID ${mainPid} /T /F 2>/dev/null`,
        { encoding: 'utf8', timeout: 10000 }
      );
      log.success('Killed existing browsermonitor Chrome');
      execSync('sleep 1', { encoding: 'utf8' });
      return 1;
    } catch (e) {
      log.dim(`taskkill returned: ${e.message}`);
      return 0;
    }
  } catch (e) {
    log.dim(`Could not check for existing Chrome: ${e.message}`);
    return 0;
  }
}

/**
 * Legacy wrapper for backward compatibility.
 */
export function checkChromeRunning() {
  const { instances, chromeRunning } = scanChromeInstances();
  if (!chromeRunning) {
    return { running: false, withDebugPort: false, debugPort: null };
  }
  if (instances.length === 0) {
    return { running: true, withDebugPort: false, debugPort: null };
  }
  return {
    running: true,
    withDebugPort: true,
    debugPort: instances[0].port,
    instances,
  };
}

/**
 * Legacy wrapper for backward compatibility.
 */
export function launchChromeFromWSL(chromePath, port) {
  const distroName = getWslDistroName();
  const wslPath = process.cwd();
  const winPath = wslPath.replace(/\//g, '\\');
  const profileDir = `\\\\wsl$\\${distroName}${winPath}\\.puppeteer-profile`;
  return startChromeOnWindows(chromePath, port, profileDir);
}
