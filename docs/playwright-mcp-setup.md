# Playwright MCP Server Setup

## Problem

The default `@playwright/mcp` config tries to launch `chrome` from `/opt/google/chrome/chrome`, which does not exist in this environment. Additionally, there is no display server (no X11/Wayland), so headed mode fails.

## Solution

Pass two flags to `@playwright/mcp@latest`:

- `--executable-path` — point to the actual Chromium binary installed by Playwright
- `--headless` — required because there is no display server
- `--no-sandbox` — required in sandboxed/container environments without user namespaces

## Config Location

```
/home/claude-runner/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/playwright/.mcp.json
```

## Working Config

```json
{
  "playwright": {
    "command": "npx",
    "args": [
      "@playwright/mcp@latest",
      "--executable-path",
      "/home/claude-runner/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
      "--headless",
      "--no-sandbox"
    ]
  }
}
```

## How `@playwright/mcp` CLI Args Work

The MCP server accepts standard Playwright launch options as CLI flags. Relevant ones:

| Flag | Description |
|------|-------------|
| `--executable-path <path>` | Path to browser binary to use instead of the default |
| `--headless` | Run browser in headless mode (no display required) |
| `--no-sandbox` | Disable sandbox (required in container/CI environments) |
| `--browser <browser>` | `chrome`, `firefox`, `webkit`, `msedge` — defaults to `chromium` |

## Activation

After updating `.mcp.json`, you must **restart Claude Code** (or the MCP plugin host) for the new config to take effect. The MCP server process is launched once on startup and cached.

## Finding the Chromium Binary

If the binary path changes (e.g., after `playwright install` updates the version), find it with:

```bash
ls ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome
```

The version number (e.g., `chromium-1217`) is embedded in the directory name and changes with Playwright releases.

## Verifying It Works

Once Claude Code is restarted, call:

```
mcp__plugin_playwright_playwright__browser_navigate { url: "https://example.com" }
```

A successful response (no "not found at" error) confirms the fix is working.
