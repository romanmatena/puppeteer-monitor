/**
 * browsermonitor init – first-run setup and agent file updates.
 *
 * Called by:
 *   - `browsermonitor init` subcommand (explicit)
 *   - Auto-init on first run when .browsermonitor/ does not exist
 *
 * What it does:
 *   1. Creates .browsermonitor/ directory structure
 *   2. Creates settings.json with defaults (prompts for URL if TTY)
 *   3. Updates CLAUDE.md, AGENTS.md, memory.md with Browser Monitor section
 *   4. Suggests adding .browsermonitor/ to .gitignore
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_SETTINGS,
  ensureDirectories,
  getPaths,
  saveSettings,
} from './settings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BEGIN_TAG_PREFIX = '<!-- BEGIN browser-monitor-llm-section';
const END_TAG_PREFIX = '<!-- END browser-monitor-llm-section';

const TEMPLATE_PATH = path.resolve(__dirname, 'agents.llm/browser-monitor-section.md');

/**
 * Replace existing tagged block or append template to a doc file.
 * Section is identified by BEGIN/END tags.
 * @param {string} hostDir
 * @param {string} docFilename - e.g. 'CLAUDE.md', 'AGENTS.md', 'memory.md'
 * @param {string} templateContent - full block including BEGIN and END tags
 * @returns {boolean} true if file was updated
 */
function replaceOrAppendSection(hostDir, docFilename, templateContent) {
  const hostPath = path.join(hostDir, docFilename);
  if (!fs.existsSync(hostPath)) return false;

  const content = fs.readFileSync(hostPath, 'utf8');
  const trimmedTemplate = templateContent.trimEnd();
  const beginIndex = content.indexOf(BEGIN_TAG_PREFIX);

  let newContent;
  if (beginIndex === -1) {
    newContent = content.trimEnd() + '\n\n' + trimmedTemplate + '\n';
    console.log(`[browsermonitor] Appended Browser Monitor section to ${docFilename}`);
  } else {
    const endTagStartIndex = content.indexOf(END_TAG_PREFIX, beginIndex);
    if (endTagStartIndex === -1) {
      console.error(`[browsermonitor] ${docFilename}: BEGIN tag found but no END tag; skipping`);
      return false;
    }
    const afterEndComment = content.indexOf('-->', endTagStartIndex) + 3;
    const lineEnd = content.indexOf('\n', afterEndComment);
    const endIndex = lineEnd === -1 ? content.length : lineEnd + 1;
    newContent = content.slice(0, beginIndex) + trimmedTemplate + '\n' + content.slice(endIndex);
    console.log(`[browsermonitor] Replaced Browser Monitor section in ${docFilename}`);
  }

  try {
    fs.writeFileSync(hostPath, newContent);
    return true;
  } catch (err) {
    console.error(`[browsermonitor] Could not write ${docFilename}:`, err.message);
    return false;
  }
}

/**
 * Prompt user for default URL (stdin line read).
 * @param {string} defaultValue
 * @returns {Promise<string>}
 */
function askDefaultUrl(defaultValue) {
  return new Promise((resolve) => {
    process.stdout.write(`  Default URL [${defaultValue}]: `);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      process.stdin.pause();
      const trimmed = chunk.toString().trim().split('\n')[0].trim();
      resolve(trimmed || defaultValue);
    });
  });
}

/**
 * Suggest adding .browsermonitor/ to .gitignore if not already present.
 * @param {string} projectRoot
 */
function suggestGitignore(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return;

  const content = fs.readFileSync(gitignorePath, 'utf8');
  if (content.includes('.browsermonitor')) return;

  console.log(`[browsermonitor] Tip: add .browsermonitor/ to your .gitignore`);
}

/**
 * Run browsermonitor initialization.
 * @param {string} projectRoot - Absolute path to the project
 * @param {Object} [options]
 * @param {boolean} [options.askForUrl=true] - Prompt for default URL
 * @param {boolean} [options.updateAgentFiles=true] - Update CLAUDE.md/AGENTS.md/memory.md
 */
export async function runInit(projectRoot, options = {}) {
  const { askForUrl = true, updateAgentFiles = true } = options;

  console.log('');
  console.log('========================================');
  console.log('  Browser Monitor - Setup');
  console.log('========================================');
  console.log('');
  console.log(`[browsermonitor] Project: ${projectRoot}`);
  console.log('');

  // 1. Create directory structure
  ensureDirectories(projectRoot);
  console.log('[browsermonitor] Created .browsermonitor/ directory structure');

  // 2. Create settings.json if it doesn't exist
  const { settingsFile } = getPaths(projectRoot);
  if (!fs.existsSync(settingsFile)) {
    let defaultUrl = DEFAULT_SETTINGS.defaultUrl;
    if (askForUrl && process.stdin.isTTY) {
      defaultUrl = await askDefaultUrl(defaultUrl);
    }
    const settings = { ...DEFAULT_SETTINGS, defaultUrl };
    saveSettings(projectRoot, settings);
    console.log(`[browsermonitor] Created settings.json (defaultUrl: ${defaultUrl})`);
  } else {
    console.log('[browsermonitor] settings.json already exists, skipping');
  }

  // 3. Update agent files
  if (updateAgentFiles) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      console.error('[browsermonitor] Agent template not found:', TEMPLATE_PATH);
    } else {
      const templateContent = fs.readFileSync(TEMPLATE_PATH, 'utf8');
      replaceOrAppendSection(projectRoot, 'CLAUDE.md', templateContent);
      replaceOrAppendSection(projectRoot, 'AGENTS.md', templateContent);
      replaceOrAppendSection(projectRoot, 'memory.md', templateContent);
    }
  }

  // 4. Suggest .gitignore
  suggestGitignore(projectRoot);

  console.log('');
  console.log('[browsermonitor] Setup complete.');
  console.log('  browsermonitor          - Interactive menu (o=open, j=join, q=quit)');
  console.log('  browsermonitor --open   - Launch Chrome at default URL');
  console.log('');
}
