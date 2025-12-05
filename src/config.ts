import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Config, KeyBindings } from "./types";

const DEFAULT_KEY_BINDINGS: KeyBindings = {
  up: ["k", "up"],
  down: ["j", "down"],
  left: ["h", "left"],
  right: ["l", "right"],
  select: ["return", "enter"],
  back: ["escape", "backspace"],
  edit: ["i"],
  quit: ["q"],
  search: ["/"],
  refresh: ["r"],
};

const DEFAULT_THEME = {
  primary: "#7aa2f7",
  secondary: "#bb9af7",
  background: "#1a1b26",
  text: "#c0caf5",
  border: "#565f89",
  highlight: "#3b82f6",
  error: "#f7768e",
  warning: "#e0af68",
};

function getDefaultConfig(): Config {
  return {
    keyBindings: DEFAULT_KEY_BINDINGS,
    cacheDir: path.join(os.homedir(), ".cache", "rivermeet-tui"),
    confluence: {
      baseUrl: Bun.env.ATLASSIAN_BASE_URL || "",
      email: Bun.env.ATLASSIAN_EMAIL || "",
      apiToken: Bun.env.ATLASSIAN_API_TOKEN || "",
    },
    editor: Bun.env.EDITOR || "vim",
    theme: DEFAULT_THEME,
  };
}

function getConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "rivermeet-tui", "config.json");
}

export function loadConfig(): Config {
  const config = getDefaultConfig();
  const configPath = getConfigPath();

  if (fs.existsSync(configPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return mergeConfig(config, userConfig);
    } catch (error) {
      console.error(`Failed to load config from ${configPath}:`, error);
    }
  }

  return config;
}

function mergeConfig(base: Config, override: Partial<Config>): Config {
  return {
    keyBindings: {
      ...base.keyBindings,
      ...override.keyBindings,
    },
    cacheDir: override.cacheDir || base.cacheDir,
    confluence: {
      baseUrl: override.confluence?.baseUrl || base.confluence.baseUrl,
      email: override.confluence?.email || base.confluence.email,
      apiToken: override.confluence?.apiToken || base.confluence.apiToken,
    },
    editor: override.editor || base.editor,
    theme: {
      ...base.theme,
      ...override.theme,
    },
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (!config.confluence.baseUrl) {
    errors.push("Missing ATLASSIAN_BASE_URL environment variable or config.confluence.baseUrl");
  } else {
    // Clean and validate URL format
    let url = config.confluence.baseUrl.trim();
    
    // Check for common typos like "hhttps://"
    if (/^h{2,}ttps?:\/\//i.test(url)) {
      console.warn(`Warning: ATLASSIAN_BASE_URL appears to have a typo: "${url}". Auto-correcting...`);
    }
    
    // Normalize the URL for validation
    url = url.replace(/^h+ttps?:\/\//i, "");
    url = url.replace(/^https?:\/\//i, "");
    if (url) {
      url = `https://${url}`;
    }
    
    try {
      new URL(url);
    } catch {
      errors.push(`Invalid ATLASSIAN_BASE_URL: "${config.confluence.baseUrl}" is not a valid URL`);
    }
  }

  if (!config.confluence.email) {
    errors.push("Missing ATLASSIAN_EMAIL environment variable or config.confluence.email");
  }

  if (!config.confluence.apiToken) {
    errors.push("Missing ATLASSIAN_API_TOKEN environment variable or config.confluence.apiToken");
  }

  return errors;
}

export function matchesKey(key: { name: string }, bindings: string[]): boolean {
  return bindings.includes(key.name);
}

export { DEFAULT_KEY_BINDINGS, DEFAULT_THEME };
