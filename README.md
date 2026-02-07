<div align="center">

![Browser Monitor](docs/banner.png)

# Browser Monitor

[![CI](https://github.com/romanmatena/browsermonitor/actions/workflows/ci.yml/badge.svg)](https://github.com/romanmatena/browsermonitor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@romanmatena/browsermonitor.svg)](https://www.npmjs.com/package/@romanmatena/browsermonitor)
[![npm downloads](https://img.shields.io/npm/dm/@romanmatena/browsermonitor.svg)](https://www.npmjs.com/package/@romanmatena/browsermonitor)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-romanmatena%2Fbrowsermonitor-24292e?logo=github)](https://github.com/romanmatena/browsermonitor)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

Browser console, network, DOM, and screenshot monitoring for debugging and LLM workflows.

**[npm](https://www.npmjs.com/package/@romanmatena/browsermonitor)** · **[GitHub](https://github.com/romanmatena/browsermonitor)**

[Installation](#installation) · [Quick Start](#quick-start) · [HTTP API](#http-api) · [Contributing](CONTRIBUTING.md)

</div>

**What it is:** Browser Monitor lets you capture the live state of a browser—console output, network requests, cookies, screenshot, and the current page DOM—and write it all to files. You (or an LLM agent) can then read those files instead of asking someone to copy-paste from DevTools or the browser.

**Why it's useful:** When debugging a frontend app or feeding context to an AI assistant, you need the real console, the real DOM, and the real network traffic. Manual copy-paste is slow and error-prone. This tool connects to Chrome via Puppeteer, records everything in one place, and exposes a simple "dump" so the next step is always "read the files" instead of "please open the browser and copy this."

**Who needs it:** Frontend and full-stack developers who debug in the browser; teams using LLM coding agents that need up-to-date DOM and network data; anyone who wants a repeatable way to snapshot browser state for logs, tests, or AI context. If you've ever asked a colleague to "send me what you see in the console" or "paste the HTML of that element," you need this. Without it, getting a reliable, one-command snapshot of the live browser is much harder.

**Entry point:** `browsermonitor` (global CLI). Run it in any project directory.

### Features

- **Console, network, DOM, cookies, screenshot** – capture full browser state in one dump
- **Screenshot** – each dump writes `.browsermonitor/.puppeteer/screenshot.png` (current tab viewport); ideal for LLM vision or quick visual checks
- **HTTP REST API** – trigger dump, status, clear, tab switch via `curl` (ideal for LLM agents)
- **Multiple modes** – Interactive (menu), Open (launch Chrome), Join (attach to existing)
- **WSL + Windows** – Chrome on Windows, app in WSL with automatic port proxy
- **Native Linux** – run with GUI on Ubuntu or headless
- **Lazy or realtime** – buffer in memory or write logs immediately

## Screenshots (demo)

| Interactive mode | Open mode / Dump output |
|------------------|--------------------------|
| ![Interactive](docs/Screenshot_1.png) | ![Output](docs/Screenshot_2.png) |

## Installation

Install globally from [npm](https://www.npmjs.com/package/@romanmatena/browsermonitor):

```bash
# Using npm
npm install -g @romanmatena/browsermonitor

# Or pnpm
pnpm add -g @romanmatena/browsermonitor
```

**Note:** Chromium download is skipped — browsermonitor uses your system Chrome/Chromium. No extra 300 MB download.

**First run:** When you run `browsermonitor` in a project directory for the first time, it auto-creates `.browsermonitor/` with `settings.json` and optionally updates agent files (`CLAUDE.md`, `AGENTS.md`, `memory.md`).

**Manual setup:** Run `browsermonitor init` to re-run the setup wizard.

## Quick Start

```bash
browsermonitor                    # Interactive: menu → o (open) or j (join)
browsermonitor --open             # Open mode: launch new Chrome and monitor
browsermonitor --join=9222        # Join mode: attach to existing Chrome on port 9222
```

## Modes

| Mode        | How to run              | When to use |
|------------|--------------------------|-------------|
| **Interactive** | `browsermonitor` (no flags) | Menu asks for project root, then: **o** = open Chrome, **j** = join running Chrome, **q** = quit. |
| **Open**   | `browsermonitor --open [url]` | Launch a new Chrome and monitor it. Uses current dir for logs. |
| **Join**   | `browsermonitor --join=PORT`  | Attach to an existing Chrome with remote debugging on PORT (e.g. 9222). Port is required. |

---

## Windows (native)

**When to use:** You develop directly on Windows using IIS, XAMPP, or other local server.

```powershell
cd C:\Projects\my-app
browsermonitor --open https://localhost:5173/
```

Open mode launches Chrome via Puppeteer. No port proxy or firewall setup needed.

---

## Windows + WSL

**When to use:** Your app runs in WSL (Node.js, Python, etc.) but you want Chrome on Windows for GPU/WebGL.

**Usage:** Run from WSL:

```bash
cd /srv/project
browsermonitor --open https://localhost:5173/
```

**How it works:** Open mode detects WSL and launches Chrome Canary on Windows, sets up port proxy (0.0.0.0:9222 → Chrome), and connects from WSL via the Windows gateway IP. Port proxy requires Administrator (one-time) on first run.

**Join mode** (attach to existing Chrome): Start Chrome manually with `--remote-debugging-port=9222`, then `browsermonitor --join=9222` from WSL. For port proxy, run in PowerShell (Admin): `netsh interface portproxy add v4tov4 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=127.0.0.1`

---

## Linux (Ubuntu) with GUI

**When to use:** You develop on native Linux (Ubuntu, etc.) with a display. Chrome/Chromium runs with GUI on the same machine.

```bash
browsermonitor --open https://localhost:5173/
```

Chrome/Chromium is started via Puppeteer with `--remote-debugging-port`. No port proxy needed; direct localhost connection.

**Requirements:**
- Chrome or Chromium installed: `apt install chromium-browser` or install Google Chrome
- Display available (X11 or Wayland)

For **join mode** (attach to existing Chrome): start Chrome manually with `--remote-debugging-port=9222`, then `browsermonitor --join=9222`.

---

## Chrome Profile

Each project gets its own Chrome profile:
- **WSL:** `%LOCALAPPDATA%\browsermonitor\{project}_{hash}` (Windows path)
- **Native:** `.browsermonitor-profile/` in project dir

Separate cookies and logins per project; won't interfere with your regular Chrome.

---

## Chrome Canary (Required)

browsermonitor **requires Chrome Canary** for launching Chrome (`--open` and `--join` when no Chrome is running). Regular Chrome cannot be used because Chrome is a singleton — all instances bind to the first launched process. If your regular Chrome is already open, a new Chrome with `--remote-debugging-port` would just open a window in the existing process and the debug port would be ignored.

Chrome Canary runs as a completely **separate process** from regular Chrome (different singleton, different profile directory), so:
- Your regular Chrome stays completely untouched
- Debug port is guaranteed to work
- No singleton hijacking issues

**Installation:**
1. Download from: https://www.google.com/chrome/canary/
2. Install (goes to `%LOCALAPPDATA%\Google\Chrome SxS\`)
3. browsermonitor will detect it automatically

**Note:** If you already have Chrome running with `--remote-debugging-port` (e.g. started manually), you can connect to it with `browsermonitor --join=PORT` regardless of whether it's Canary or regular Chrome.

---

## Project Directory Structure

When browsermonitor runs in a project directory, it creates:

```
<project-root>/
├── .browsermonitor/
│   ├── settings.json          # Project config (defaultUrl, httpPort, etc.)
│   ├── browsermonitor.pid     # PID file for recovery
│   └── .puppeteer/            # All dump outputs
│       ├── console.log
│       ├── network.log
│       ├── network-log/       # Per-request JSON files
│       ├── cookies/           # Per-domain cookie JSONs
│       ├── dom.html
│       └── screenshot.png
└── .browsermonitor-profile/   # Chrome profile (native) or
                               # %LOCALAPPDATA%\browsermonitor\ (WSL)
```

## Keyboard Controls (open/join mode)

| Key | Action |
|-----|--------|
| `d` | Dump logs, cookies, screenshot, and current page HTML to files |
| `c` | Clear in-memory buffer |
| `s` | Show status (buffer counts, URLs) |
| `p` | Pause/resume recording (stop/start collecting) |
| `t` | Switch monitored tab |
| `h` | Full help (incl. LLM instructions and HTTP API) |
| `k` | Kill Chrome and exit [open] / kill Chrome and quit [join] |
| `q` | Quit (Chrome stays open) [open] / disconnect only [join] |

## Output Files

| File | Description |
|------|-------------|
| `.browsermonitor/.puppeteer/console.log` | Console output |
| `.browsermonitor/.puppeteer/network.log` | Network requests |
| `.browsermonitor/.puppeteer/network-log/` | Detailed request/response JSON |
| `.browsermonitor/.puppeteer/cookies/` | Cookies per domain |
| `.browsermonitor/.puppeteer/dom.html` | Current page HTML (JS-modified element tree). **LLM: read this for the live DOM structure.** |
| `.browsermonitor/.puppeteer/screenshot.png` | Screenshot of the current tab viewport (PNG). Written on each dump. |

All files are written on dump (key `d` or `curl …/dump`).

## HTTP API

Use `curl` to communicate with the HTTP API over REST. Default URL: `http://localhost:60001`.

| Endpoint | Description |
|----------|-------------|
| `GET /dump` | Dump logs, DOM, cookies, screenshot to files; returns output paths |
| `GET /status` | Current status, monitored URLs, stats, output file paths |
| `GET /stop` | Pause collecting (console/network) |
| `GET /start` | Resume collecting |
| `GET /clear` | Clear in-memory buffers |
| `GET /tabs` | List all user tabs (index, url) |
| `GET /tab?index=N` | Switch monitored tab (1-based index) |
| `GET /computed-styles?selector=...` | Get computed CSS for first element matching selector (default: body) |
| `POST /puppeteer` | Call Puppeteer page method. Body: `{ "method": "page.goto", "args": ["https://..."] }` |

**Puppeteer whitelist:** `content`, `click`, `focus`, `goto`, `hover`, `pdf`, `screenshot`, `select`, `setDefaultNavigationTimeout`, `setDefaultTimeout`, `setViewport`, `title`, `type`, `url`, `waitForSelector`, `waitForTimeout`

```bash
curl http://localhost:60001/dump       # Dump to files
curl http://localhost:60001/status     # Check status
curl http://localhost:60001/clear      # Clear buffers
curl http://localhost:60001/tabs       # List tabs
curl "http://localhost:60001/tab?index=2"  # Switch to tab 2
curl "http://localhost:60001/computed-styles?selector=.my-class"  # Get computed CSS
curl -X POST http://localhost:60001/puppeteer -H "Content-Type: application/json" \
  -d '{"method":"page.goto","args":["https://example.com"]}'  # Navigate via API
```

## CLI Options

| Option | Description |
|--------|-------------|
| `--open` | Go directly to open mode (launch new Chrome) |
| `--join=PORT` | Go directly to join mode; attach to Chrome at PORT (port required) |
| `--port=PORT` | HTTP API port (default: from settings or 60001) |
| `--headless` | Run Chrome without GUI |
| `--realtime` | Write logs immediately (default: lazy buffer) |
| `--timeout=MS` | Hard timeout in ms; process exits after (0 = disabled) |
| `--nav-timeout=MS` | Navigation timeout in ms (default: from settings, 0 = no limit) |

**Config (`.browsermonitor/settings.json`):** `defaultUrl`, `headless`, `navigationTimeout`, `ignorePatterns`, `httpPort`, `realtime`

---

## Troubleshooting WSL

### Connection refused from WSL

1. **Verify Chrome is listening:**
   ```powershell
   netstat -ano | findstr "127.0.0.1:9222.*LISTEN"
   ```

2. **Verify port proxy:**
   ```powershell
   netsh interface portproxy show v4tov4 | findstr 9222
   ```
   Should show: `0.0.0.0  9222  127.0.0.1  9222`

3. **Test from WSL:**
   ```bash
   curl -s http://$(ip route | grep default | awk '{print $3}'):9222/json/version
   ```

### Chrome won't start with debug port

Port proxy blocks port 9222 during Chrome startup. Open mode handles this automatically; if it fails, run PowerShell as Administrator so the port proxy can be configured.

### Manual reset

```powershell
# 1. Remove port proxy (both types)
netsh interface portproxy delete v4tov4 listenport=9222 listenaddress=0.0.0.0
netsh interface portproxy delete v4tov6 listenport=9222 listenaddress=0.0.0.0

# 2. Kill ONLY browsermonitor Chrome (NOT your regular browser!)
Get-WmiObject Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -match 'browsermonitor' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 3. Start Chrome Canary (recommended - isolated from regular Chrome)
Start-Process "$env:LOCALAPPDATA\Google\Chrome SxS\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=$env:LOCALAPPDATA\browsermonitor\manual"

# 4. Wait 5s, check binding, add appropriate proxy
Start-Sleep 5
# Check if IPv4 or IPv6:
netstat -ano | findstr "9222.*LISTEN"
# If 127.0.0.1:9222:
netsh interface portproxy add v4tov4 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=127.0.0.1
# If [::1]:9222:
netsh interface portproxy add v4tov6 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=::1
```

**WARNING:** Never use `Stop-Process -Name chrome -Force` - it kills ALL Chrome including your personal browser!

---

## For Developers: WSL→Windows Chrome Internals

This section documents the technical details of connecting to Chrome from WSL2 when Chrome runs on Windows.

### WSL2 Network Architecture

WSL2 runs in a lightweight Hyper-V virtual machine with its own network stack:

```
┌─────────────────────────────────────────────────────────┐
│ Windows Host                                            │
│   Chrome: 127.0.0.1:9222 (localhost only by default)    │
│                                                         │
│   ┌─────────────────────────────────────────────────┐   │
│   │ WSL2 VM (e.g., 172.29.100.50)                   │   │
│   │                                                 │   │
│   │   browsermonitor trying to connect...           │   │
│   │   → 127.0.0.1:9222 ❌ (WSL's own localhost)     │   │
│   │   → 172.29.96.1:9222 ✅ (Windows gateway)       │   │
│   └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Key insight:** `localhost` in WSL2 refers to WSL's own network, not Windows. To reach Windows services, WSL must connect via the Windows gateway IP (typically `172.x.x.1`).

### Chrome Singleton Behavior

Chrome uses a singleton pattern - only one instance runs per user profile:

```
First launch:  chrome.exe --remote-debugging-port=9222 --user-data-dir=X
               → Starts Chrome, listens on port 9222 ✅

Second launch: chrome.exe --remote-debugging-port=9223 --user-data-dir=Y
               → If Chrome is already running, the new process:
                 1. Sends command to existing Chrome via IPC
                 2. Opens new window in EXISTING process
                 3. New process exits immediately
                 4. --remote-debugging-port=9223 is IGNORED! ❌
```

**Consequence:** If user has Chrome open for regular browsing, launching a new Chrome with debug flags does nothing - the existing Chrome (without debugging) handles it.

**Detection method (used in monitor.mjs):**
```bash
# From WSL, query Windows WMI for Chrome processes:
wmic.exe process where "name='chrome.exe'" get processid,commandline

# Parse output to find --remote-debugging-port=XXXX
# Multiple subprocesses report same port - deduplicate with Set
```

### Remote Debugging Address Binding

**Important: Chrome M113+ Security Change**

Since Chrome M113 (May 2023), Chrome **ignores** the `--remote-debugging-address=0.0.0.0` flag for security reasons. Chrome always binds to `127.0.0.1` only.

Sources:
- [Chromium Issue #40261787](https://issues.chromium.org/issues/40261787)
- [Docker Chromium CDP Port Guide](https://www.ytyng.com/en/blog/docker-chromium-cdp-port/)

| Flag | Binding | Accessible from |
|------|---------|-----------------|
| `--remote-debugging-port=9222` | 127.0.0.1:9222 | Windows localhost only |
| `--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0` | 127.0.0.1:9222 | **IGNORED since Chrome M113** |

**For WSL access, port proxy is REQUIRED** - there is no way to make Chrome bind to 0.0.0.0.

### Port Proxy Mechanism

Windows `netsh` port proxy forwards connections from one address to another.

**IPv4 vs IPv6 Binding:**

Chrome may bind to either IPv4 (`127.0.0.1`) or IPv6 (`[::1]`) depending on system configuration. The monitor automatically detects which address Chrome uses and configures the appropriate proxy type:

| Chrome Binds To | Proxy Type | Command |
|-----------------|------------|---------|
| `127.0.0.1:9222` | v4tov4 | `netsh interface portproxy add v4tov4 ... connectaddress=127.0.0.1` |
| `[::1]:9222` | v4tov6 | `netsh interface portproxy add v4tov6 ... connectaddress=::1` |

**Detection logic (used in open mode):**
```javascript
// Check netstat output for Chrome's binding
const netstatOutput = execSync('netstat.exe -ano', { encoding: 'utf8' });
const lines = netstatOutput.split('\n').filter(l => l.includes(':9222') && l.includes('LISTEN'));
// Parse for 127.0.0.1:9222 or [::1]:9222
```

**Manual proxy commands:**

```powershell
# IPv4 proxy: forward 0.0.0.0:9222 → 127.0.0.1:9222
netsh interface portproxy add v4tov4 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=127.0.0.1

# IPv6 proxy: forward 0.0.0.0:9222 → [::1]:9222
netsh interface portproxy add v4tov6 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=::1

# List existing proxies (check both types!)
netsh interface portproxy show v4tov4
netsh interface portproxy show v4tov6

# Remove proxy
netsh interface portproxy delete v4tov4 listenport=9222 listenaddress=0.0.0.0
netsh interface portproxy delete v4tov6 listenport=9222 listenaddress=0.0.0.0
```

**How it works:**
```
WSL (172.29.100.50) → Windows gateway (172.29.96.1:9222)
                              ↓ port proxy (v4tov4 or v4tov6)
                      Windows (127.0.0.1:9222 or [::1]:9222)
                              ↓
                      Chrome DevTools Protocol
```

**Important:** Port proxy requires Administrator privileges to configure.

### Windows Firewall

Inbound connections to port 9222 require a firewall rule that allows WSL subnet:

```powershell
# Check existing rules
Get-NetFirewallRule -DisplayName "*Chrome*" | Get-NetFirewallPortFilter

# Add rule with WSL subnet (one-time, persists across reboots)
# 172.16.0.0/12 covers the WSL2 dynamic IP range
New-NetFirewallRule -DisplayName "Chrome Debug (browsermonitor)" -Direction Inbound -LocalPort 9222-9299 -Protocol TCP -Action Allow -RemoteAddress LocalSubnet,172.16.0.0/12

# Update existing rule if it doesn't include WSL subnet
Set-NetFirewallRule -DisplayName "Chrome Remote Debugging" -RemoteAddress LocalSubnet,172.16.0.0/12
```

**Note:** If firewall rule exists but connections still timeout, check that `RemoteAddress` includes the WSL subnet (172.x.x.x range).

### The 7-Step Diagnostic Process

The `runWslDiagnostics()` function performs:

| Step | Check | Method |
|------|-------|--------|
| 1 | Chrome instances on Windows | `wmic.exe process where "name='chrome.exe'"` |
| 2 | Network bindings | `netstat.exe -ano \| findstr 9222` |
| 3 | Port configuration | Parse `--remote-debugging-port` (note: `--remote-debugging-address` is ignored since Chrome M113) |
| 4 | Windows Firewall | `netsh.exe advfirewall firewall show rule name=all` |
| 5 | Port proxy config | `netsh.exe interface portproxy show v4tov4` |
| 6 | Scan port range | Check 9222-9299 for existing proxies |
| 7 | Connectivity test | `fetch('http://gateway:port/json/version')` |

### Automatic Chrome Detection Flow

```
┌──────────────────────────────────────────────────────────────┐
│ browsermonitor --join=9222                                    │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │ Detect Windows gateway IP     │
              │ (ip route | grep default)     │
              └───────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │ Try connect to gateway:9222   │
              └───────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                 Success              Fail
                    │                   │
                    ▼                   ▼
              ┌───────────┐    ┌───────────────────┐
              │ Connected │    │ Run diagnostics   │
              └───────────┘    └───────────────────┘
                                        │
                                        ▼
                               ┌───────────────────┐
                               │ Chrome running    │
                               │ with debug port?  │
                               └───────────────────┘
                                        │
                              ┌─────────┴─────────┐
                              │                   │
                             Yes                 No
                              │                   │
                              ▼                   ▼
                    ┌──────────────────┐  ┌──────────────────┐
                    │ Offer port proxy │  │ Show how to      │
                    │ setup (admin)    │  │ start Chrome     │
                    └──────────────────┘  └──────────────────┘
```

### Common Issues and Solutions

| Symptom | Cause | Solution |
|---------|-------|----------|
| Connection refused | Chrome binds to 127.0.0.1 only | Set up port proxy |
| Connection timeout | Chrome binds to IPv6 (`[::1]`) but proxy forwards to IPv4 | Use `v4tov6` proxy instead of `v4tov4` |
| New Chrome ignores debug flags | Singleton joined existing process | Close all Chrome windows first, or use port proxy to existing debug port |
| Port proxy won't start | Chrome already listening on 0.0.0.0 | Remove proxy, start Chrome, re-add proxy |
| "Access denied" from WSL | Firewall blocking | Add inbound rule for port 9222 |

**IPv6 Troubleshooting:**

If connection times out after Chrome starts, check what address Chrome is listening on:

```powershell
# Check Chrome's binding
netstat -ano | findstr "9222.*LISTEN"

# If you see [::1]:9222 (IPv6), you need v4tov6 proxy:
netsh interface portproxy delete v4tov4 listenport=9222 listenaddress=0.0.0.0
netsh interface portproxy add v4tov6 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=::1

# If you see 127.0.0.1:9222 (IPv4), use v4tov4 proxy:
netsh interface portproxy add v4tov4 listenport=9222 listenaddress=0.0.0.0 connectport=9222 connectaddress=127.0.0.1
```

### Environment Detection

The monitor detects WSL environment via:

```javascript
const isWsl = process.platform === 'linux' &&
  (process.env.WSL_DISTRO_NAME ||
   fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'));
```

### Debugging Tips

```bash
# From WSL: Get Windows gateway IP
ip route | grep default | awk '{print $3}'
# Result: 172.29.96.1

# From WSL: Test Chrome DevTools endpoint
curl -s http://172.29.96.1:9222/json/version | jq

# From WSL: Query Windows processes
wmic.exe process where "name='chrome.exe'" get processid,commandline

# From WSL: Check Windows netstat
netstat.exe -ano | grep 9222

# From Windows: Check what's listening
netstat -ano | findstr "9222.*LISTEN"
```

### Code References

- **Entry point:** [cli.mjs](src/cli.mjs) – argument parsing, mode dispatch
- **Settings:** [settings.mjs](src/settings.mjs) – project paths, config loading
- **Modes:** [monitor.mjs](src/monitor.mjs) re-exports; implementations in [monitor/join-mode.mjs](src/monitor/join-mode.mjs), [monitor/open-mode.mjs](src/monitor/open-mode.mjs), [monitor/interactive-mode.mjs](src/monitor/interactive-mode.mjs)
- **WSL:** [os/wsl/index.mjs](src/os/wsl/index.mjs) – `runWslDiagnostics()`, `scanChromeInstances()`, Chrome launch and port proxy helpers
- **Chrome launch (WSL):** [os/wsl/chrome.mjs](src/os/wsl/chrome.mjs) – `startChromeOnWindows()`, port proxy, profile path
