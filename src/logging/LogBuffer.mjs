/**
 * LogBuffer – in-memory or realtime buffers for console, network, and request details.
 */

import fs from 'fs';
import path from 'path';
import { C, log } from '../utils/colors.mjs';
import { DEFAULT_IGNORE_PATTERNS } from './constants.mjs';
import { HMR_PATTERNS } from './constants.mjs';
import { getTimestamp, getFullTimestamp } from './timestamps.mjs';
import {
  dumpBuffersToFiles as doDumpBuffersToFiles,
  dumpCookiesFromPage as doDumpCookiesFromPage,
  dumpDomFromPage as doDumpDomFromPage,
  dumpScreenshotFromPage as doDumpScreenshotFromPage,
  DOM_DUMP_MAX_BYTES,
} from './dump.mjs';

/**
 * LogBuffer class - manages logging buffers for a monitoring session.
 */
export class LogBuffer {
  static DOM_DUMP_MAX_BYTES = DOM_DUMP_MAX_BYTES;

  constructor(options = {}) {
    const {
      outputDir = process.cwd(),
      paths = null,
      lazyMode = true,
      ignorePatterns = [],
    } = options;

    this.outputDir = outputDir;
    this.lazyMode = lazyMode;

    if (paths) {
      this.CONSOLE_LOG = paths.consoleLog;
      this.NETWORK_LOG = paths.networkLog;
      this.NETWORK_DIR = paths.networkDir;
      this.COOKIES_DIR = paths.cookiesDir;
      this.DOM_HTML = paths.domHtml;
      this.SCREENSHOT = paths.screenshot;
    } else {
      this.CONSOLE_LOG = path.join(outputDir, 'puppeteer-console.log');
      this.NETWORK_LOG = path.join(outputDir, 'puppeteer-network.log');
      this.NETWORK_DIR = path.join(outputDir, 'puppeteer-network-log');
      this.COOKIES_DIR = path.join(outputDir, 'puppeteer-cookies');
      this.DOM_HTML = path.join(outputDir, 'puppeteer-dom.html');
      this.SCREENSHOT = path.join(outputDir, 'puppeteer-screenshot.png');
    }

    this.consoleBuffer = [];
    this.networkBuffer = [];
    this.requestDetails = new Map();
    this.requestCounter = 0;

    this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns];
  }

  nextRequestId() {
    this.requestCounter++;
    return String(this.requestCounter).padStart(3, '0');
  }

  shouldIgnore(message) {
    return this.ignorePatterns.some(p => message.includes(p));
  }

  isHmr(message) {
    return HMR_PATTERNS.some(p => message.includes(p));
  }

  logConsole(message) {
    if (this.lazyMode) {
      this.consoleBuffer.push(message);
    } else {
      console.log(message);
      fs.appendFileSync(this.CONSOLE_LOG, message + '\n');
    }
  }

  clearConsoleBuffer() {
    if (this.lazyMode) {
      this.consoleBuffer.length = 0;
      log.dim(`Console buffer cleared (${getTimestamp()})`);
    } else {
      fs.writeFileSync(this.CONSOLE_LOG, '');
    }
  }

  printConsoleSeparator(title) {
    const line = '='.repeat(80);
    this.logConsole(line);
    this.logConsole(`[${getTimestamp()}] *** ${title} ***`);
    this.logConsole(line);
  }

  logNetwork(message) {
    if (this.lazyMode) {
      this.networkBuffer.push(message);
    } else {
      fs.appendFileSync(this.NETWORK_LOG, message + '\n');
    }
  }

  clearNetworkDir() {
    if (fs.existsSync(this.NETWORK_DIR)) {
      fs.rmSync(this.NETWORK_DIR, { recursive: true });
    }
    fs.mkdirSync(this.NETWORK_DIR, { recursive: true });
  }

  printNetworkSeparator(title) {
    const line = '='.repeat(80);
    this.logNetwork(line);
    this.logNetwork(`[${getFullTimestamp()}] ${title}`);
    this.logNetwork(line);
  }

  saveRequestDetail(id, data) {
    if (this.lazyMode) {
      this.requestDetails.set(id, data);
    } else {
      const filePath = path.join(this.NETWORK_DIR, `${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
  }

  updateRequestDetail(id, updates) {
    if (this.lazyMode) {
      const existing = this.requestDetails.get(id) || {};
      this.requestDetails.set(id, { ...existing, ...updates });
    } else {
      const filePath = path.join(this.NETWORK_DIR, `${id}.json`);
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const updated = { ...existing, ...updates };
        fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
      } catch (e) {
        this.saveRequestDetail(id, updates);
      }
    }
  }

  clearAllBuffers() {
    this.consoleBuffer.length = 0;
    this.networkBuffer.length = 0;
    this.requestDetails.clear();
    this.requestCounter = 0;
    log.success(`All buffers cleared (${getTimestamp()})`);
  }

  getStats() {
    return {
      consoleEntries: this.consoleBuffer.length,
      networkEntries: this.networkBuffer.length,
      requestDetails: this.requestDetails.size,
    };
  }

  async dumpBuffersToFiles(options = {}) {
    return doDumpBuffersToFiles(this, options);
  }

  async dumpCookiesFromPage(page) {
    return doDumpCookiesFromPage(this, page);
  }

  async dumpDomFromPage(page) {
    return doDumpDomFromPage(this, page);
  }

  async dumpScreenshotFromPage(page) {
    return doDumpScreenshotFromPage(this, page);
  }
}
