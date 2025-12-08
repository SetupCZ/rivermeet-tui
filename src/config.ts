import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Config, KeyBindings, KeyAction } from "./types";
import type { KeyEvent } from "@opentui/core";
import { logger } from "./logger";

const DEFAULT_KEY_BINDINGS: KeyBindings = {
  // Navigation
  up: ["k", "up"],
  down: ["j", "down"],
  left: ["h", "left"],
  right: ["l", "right"],
  select: ["return", "enter"],
  back: ["escape", "backspace"],
  // Page navigation
  halfPageUp: ["ctrl+u"],
  halfPageDown: ["ctrl+d"],
  lineStart: ["0"],
  lineEnd: ["$"],
  documentTop: ["g"],
  documentBottom: ["G"],
  wordForward: ["w"],
  wordBackward: ["b"],
  // Actions
  edit: ["i"],
  quit: ["q"],
  search: ["/"],
  searchNext: ["n"],
  searchPrev: ["N"],
  refresh: ["r"],
  publish: ["p"],
  yank: ["y"],
  visualChar: ["v"],
  visualLine: ["V"],
  confirm: ["y"],
  cancel: ["n", "escape"],
  debug: ["d"],
  // Global search modal
  globalSearch: ["cmd+k"],
  quickSelect1: ["ctrl+1"],
  quickSelect2: ["ctrl+2"],
  quickSelect3: ["ctrl+3"],
  quickSelect4: ["ctrl+4"],
  quickSelect5: ["ctrl+5"],
  openSpaces: ["s"],
  openDocs: ["d"],
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

/**
 * Get built-in default configuration
 */
function getDefaultConfig(): Config {
  return {
    keyBindings: DEFAULT_KEY_BINDINGS,
    cacheDir: path.join(os.homedir(), ".cache", "rivermeet-tui"),
    confluence: {
      baseUrl: "",
      email: "",
      apiToken: "",
    },
    editor: "vim",
    theme: DEFAULT_THEME,
  };
}

/**
 * Get configuration from environment variables
 */
function getEnvConfig(): Partial<Config> {
  const envConfig: Partial<Config> = {};

  // Confluence settings from env
  const baseUrl = Bun.env.ATLASSIAN_BASE_URL;
  const email = Bun.env.ATLASSIAN_EMAIL;
  const apiToken = Bun.env.ATLASSIAN_API_TOKEN;

  if (baseUrl || email || apiToken) {
    envConfig.confluence = {
      baseUrl: baseUrl || "",
      email: email || "",
      apiToken: apiToken || "",
    };
  }

  // Editor from env
  if (Bun.env.EDITOR) {
    envConfig.editor = Bun.env.EDITOR;
  }

  return envConfig;
}

function getConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "rivermeet-tui", "config.json");
}

/**
 * Load configuration from file
 */
function loadFileConfig(): Partial<Config> {
  const configPath = getConfigPath();

  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (error) {
      console.error(`Failed to load config from ${configPath}:`, error);
    }
  }

  return {};
}

/**
 * Load configuration with priority:
 * 1. Environment variables (highest priority)
 * 2. Config file
 * 3. Built-in defaults (lowest priority)
 */
export function loadConfig(): Config {
  const defaults = getDefaultConfig();
  const fileConfig = loadFileConfig();
  const envConfig = getEnvConfig();

  // Merge: defaults <- fileConfig <- envConfig
  const withFileConfig = mergeConfig(defaults, fileConfig);
  const finalConfig = mergeConfig(withFileConfig, envConfig);

  return finalConfig;
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

export function matchesKey(key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; super?: boolean }, bindings: string[]): boolean {
  const result = bindings.some(binding => {
    // Parse binding like "ctrl+u", "shift+g", "cmd+k", "G", etc.
    const parts = binding.toLowerCase().split("+");
    const keyName = parts[parts.length - 1];
    const needsCtrl = parts.includes("ctrl");
    const needsShift = parts.includes("shift");
    const needsMeta = parts.includes("meta") || parts.includes("cmd");

    // Check if it's an uppercase letter (implies shift)
    const isUpperCase = binding.length === 1 && binding === binding.toUpperCase() && binding !== binding.toLowerCase();

    // Match key name
    const nameMatches = key.name?.toLowerCase() === keyName;

    // Match modifiers
    const ctrlMatches = needsCtrl ? !!key.ctrl : !key.ctrl;
    const shiftMatches = needsShift || isUpperCase ? !!key.shift : !key.shift;
    // For cmd/meta, check both meta and super (macOS Command key maps to super in Kitty protocol)
    const hasMetaOrSuper = !!key.meta || !!key.super;
    const metaMatches = needsMeta ? hasMetaOrSuper : !hasMetaOrSuper;

    const matches = nameMatches && ctrlMatches && shiftMatches && metaMatches;

    if (needsMeta || hasMetaOrSuper) {
      logger.debug("matchesKey check", {
        binding,
        keyName,
        keyReceived: key.name,
        needsMeta,
        keyMeta: key.meta,
        keySuper: key.super,
        hasMetaOrSuper,
        nameMatches,
        ctrlMatches,
        shiftMatches,
        metaMatches,
        matches,
      });
    }

    return matches;
  });

  return result;
}

/**
 * KeyBindingManager - centralized keybinding management
 * 
 * Provides:
 * - Action checking via matches(action, key)
 * - Human-readable key labels for help display
 * - Centralized keybinding configuration
 */
export class KeyBindingManager {
  private bindings: KeyBindings;

  constructor(bindings: KeyBindings) {
    this.bindings = bindings;
  }

  /**
   * Check if a key event matches an action
   */
  matches(action: KeyAction, key: KeyEvent): boolean {
    const actionBindings = this.bindings[action];
    if (!actionBindings) return false;
    return matchesKey(key, actionBindings);
  }

  /**
   * Get the key bindings for an action
   */
  getBindings(action: KeyAction): string[] {
    return this.bindings[action] || [];
  }

  /**
   * Get a human-readable label for an action's keybinding
   * Used for help display
   */
  getLabel(action: KeyAction): string {
    const bindings = this.bindings[action];
    if (!bindings || bindings.length === 0) return "";

    // Format the first binding for display
    return this.formatBinding(bindings[0]!);
  }

  /**
   * Get a combined label for multiple actions (e.g., "j/k" for up/down)
   */
  getCombinedLabel(actions: KeyAction[]): string {
    return actions.map(a => this.getLabel(a)).join("/");
  }

  /**
   * Format a binding string for human display
   */
  private formatBinding(binding: string): string {
    // Handle special cases
    const specialKeys: Record<string, string> = {
      "return": "Enter",
      "enter": "Enter",
      "escape": "Esc",
      "backspace": "Bksp",
      "up": "↑",
      "down": "↓",
      "left": "←",
      "right": "→",
    };

    const parts = binding.split("+");
    const formatted = parts.map(p => {
      const lower = p.toLowerCase();
      if (specialKeys[lower]) return specialKeys[lower];
      if (lower === "ctrl") return "Ctrl";
      if (lower === "shift") return "Shift";
      if (lower === "meta" || lower === "cmd") return "⌘";
      return p;
    });

    return formatted.join("+");
  }
}

export { DEFAULT_KEY_BINDINGS, DEFAULT_THEME };
