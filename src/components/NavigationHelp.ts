import {
  type CliRenderer,
  type KeyEvent,
  TextRenderable,
  t,
  fg,
} from "@opentui/core";
import type { Config } from "../types";
import { DEBUG_MODE } from "../constants";

export interface HelpEntry {
  key: string;
  description: string;
}

export interface HelpProvider {
  getHelpEntries(): HelpEntry[];
}

export interface KeyHandler {
  handleKeypress(key: KeyEvent): boolean;
}

/**
 * Component that can activate itself with NavigationHelp
 */
export interface NavigableComponent extends HelpProvider, KeyHandler {
  /**
   * Called when the component becomes active
   */
  onActivate?(): void;

  /**
   * Called when the component becomes inactive
   */
  onDeactivate?(): void;

  /**
   * Returns true if the component wants exclusive input (e.g., during search mode)
   * When true, global handlers will be skipped
   */
  wantsExclusiveInput?(): boolean;
}

/**
 * NavigationHelp manages global and local keybindings display.
 *
 * It maintains:
 * - Global help entries (always shown, e.g., quit)
 * - Local help entries (context-specific, from active component)
 *
 * Components can register themselves and activate when they become visible.
 */
export class NavigationHelp {
  private renderer: CliRenderer;
  private config: Config;

  // UI Elements
  public container: TextRenderable;

  // Help entries
  private globalEntries: HelpEntry[] = [];
  private localEntries: HelpEntry[] = [];

  // Global key handlers (quit, etc.)
  private globalKeyHandlers: ((key: KeyEvent) => boolean)[] = [];

  // Current active component
  private activeComponent: NavigableComponent | null = null;

  // Registered components by name
  private registeredComponents = new Map<string, NavigableComponent>();

  constructor(renderer: CliRenderer, config: Config) {
    this.renderer = renderer;
    this.config = config;

    // Create the help text renderable
    this.container = new TextRenderable(this.renderer, {
      id: "help-text",
      content: "",
      marginLeft: 2,
      marginBottom: 1,
    });

    // Setup global help entries
    this.setupGlobalHelp();
  }

  private setupGlobalHelp(): void {
    // Global keybindings that are always active
    this.globalEntries = [
      { key: "q", description: "quit" },
    ];

    // Add debug help if in debug mode
    if (DEBUG_MODE) {
      this.globalEntries.push({ key: "d", description: "debug" });
    }
  }

  /**
   * Register a global key handler (e.g., for quit)
   */
  registerGlobalHandler(handler: (key: KeyEvent) => boolean): void {
    this.globalKeyHandlers.push(handler);
  }

  /**
   * Register a component by name for later activation
   */
  registerComponent(name: string, component: NavigableComponent): void {
    this.registeredComponents.set(name, component);
  }

  /**
   * Set the active component that will receive key events
   */
  setActiveComponent(component: NavigableComponent | null): void {
    // Deactivate previous component
    if (this.activeComponent && this.activeComponent !== component) {
      this.activeComponent.onDeactivate?.();
    }

    this.activeComponent = component;

    if (component) {
      // Set help from the component
      this.localEntries = component.getHelpEntries();
      component.onActivate?.();
    } else {
      this.localEntries = [];
    }

    this.render();
  }


  /**
   * Extend local help with additional entries (e.g., from debug panel)
   */
  extendLocalHelp(entries: HelpEntry[]): void {
    this.localEntries = [...this.localEntries, ...entries];
    this.render();
  }

  /**
   * Clear local help entries
   */
  clearLocalHelp(): void {
    this.localEntries = [];
    this.render();
  }

  /**
   * Handle keypress - tries global handlers first, then active component
   * Unless the component wants exclusive input (e.g., during search mode)
   */
  handleKeypress(key: KeyEvent): boolean {
    // Check if active component wants exclusive input
    const exclusiveInput = this.activeComponent?.wantsExclusiveInput?.() ?? false;

    // Try global handlers first, unless component wants exclusive input
    if (!exclusiveInput) {
      for (const handler of this.globalKeyHandlers) {
        if (handler(key)) {
          return true;
        }
      }
    }

    // Try active component's handler
    if (this.activeComponent) {
      const handled = this.activeComponent.handleKeypress(key);
      // Refresh help entries after handling (component state may have changed)
      this.refreshLocalHelp();
      return handled;
    }

    return false;
  }

  /**
   * Refresh help entries from the active component
   */
  refreshLocalHelp(): void {
    if (this.activeComponent) {
      this.localEntries = this.activeComponent.getHelpEntries();
      this.render();
    }
  }

  /**
   * Format and render the help text
   */
  render(): void {
    const allEntries = [...this.localEntries, ...this.globalEntries];
    const helpText = allEntries
      .map(e => `${e.key}: ${e.description}`)
      .join(" | ");

    this.container.content = t`${fg(this.config.theme.border)(helpText)}`;
  }

  /**
   * Update global help entries
   */
  setGlobalHelp(entries: HelpEntry[]): void {
    this.globalEntries = entries;
    this.render();
  }

  /**
   * Add a global help entry
   */
  addGlobalHelp(entry: HelpEntry): void {
    this.globalEntries.push(entry);
    this.render();
  }

  destroy(): void {
    this.container.destroy();
  }
}

/**
 * Helper to create a help entry
 */
export function helpEntry(key: string, description: string): HelpEntry {
  return { key, description };
}
