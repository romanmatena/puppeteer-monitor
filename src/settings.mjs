/**
 * Settings & paths module for browsermonitor.
 * Replaces the old package.json config approach.
 * All project-specific state lives in <projectRoot>/.browsermonitor/
 */

import fs from 'fs';
import path from 'path';

// Directory and file names
export const BROWSERMONITOR_DIR = '.browsermonitor';
export const PUPPETEER_DIR = '.puppeteer';
export const CHROME_PROFILE_DIR = '.chrome-profile';
export const SETTINGS_FILE = 'settings.json';
export const PID_FILE = 'browsermonitor.pid';

/** Default settings for new projects */
export const DEFAULT_SETTINGS = {
  defaultUrl: 'https://localhost:4000/',
  headless: false,
  navigationTimeout: 60000,
  ignorePatterns: [],
  httpPort: 60001,
  realtime: false,
};

/**
 * Get all resolved paths for a given project root.
 * @param {string} projectRoot - Absolute path to the project directory
 * @returns {Object} All paths used by browsermonitor
 */
export function getPaths(projectRoot) {
  const bmDir = path.join(projectRoot, BROWSERMONITOR_DIR);
  const puppeteerDir = path.join(bmDir, PUPPETEER_DIR);
  return {
    bmDir,
    settingsFile: path.join(bmDir, SETTINGS_FILE),
    puppeteerDir,
    chromeProfileDir: path.join(bmDir, CHROME_PROFILE_DIR),
    pidFile: path.join(bmDir, PID_FILE),
    // Dump outputs inside .puppeteer/
    consoleLog: path.join(puppeteerDir, 'console.log'),
    networkLog: path.join(puppeteerDir, 'network.log'),
    networkDir: path.join(puppeteerDir, 'network-log'),
    cookiesDir: path.join(puppeteerDir, 'cookies'),
    domHtml: path.join(puppeteerDir, 'dom.html'),
    screenshot: path.join(puppeteerDir, 'screenshot.png'),
  };
}

/**
 * Check if settings.json exists (first-run detection).
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function isInitialized(projectRoot) {
  const { settingsFile } = getPaths(projectRoot);
  return fs.existsSync(settingsFile);
}

/**
 * Load settings from .browsermonitor/settings.json, merged with defaults.
 * @param {string} projectRoot
 * @returns {Object} Merged settings
 */
export function loadSettings(projectRoot) {
  const { settingsFile } = getPaths(projectRoot);
  try {
    if (fs.existsSync(settingsFile)) {
      const raw = fs.readFileSync(settingsFile, 'utf8');
      const saved = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch {
    // Ignore parse errors, fall through to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Write settings to .browsermonitor/settings.json.
 * Creates .browsermonitor/ directory if needed.
 * @param {string} projectRoot
 * @param {Object} settings
 */
export function saveSettings(projectRoot, settings) {
  const { bmDir, settingsFile } = getPaths(projectRoot);
  fs.mkdirSync(bmDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Ensure all browsermonitor directories exist.
 * @param {string} projectRoot
 */
export function ensureDirectories(projectRoot) {
  const { bmDir, puppeteerDir, chromeProfileDir } = getPaths(projectRoot);
  fs.mkdirSync(bmDir, { recursive: true });
  fs.mkdirSync(puppeteerDir, { recursive: true });
  fs.mkdirSync(chromeProfileDir, { recursive: true });
}
