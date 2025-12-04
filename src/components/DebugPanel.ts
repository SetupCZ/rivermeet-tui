import {
  type CliRenderer,
  type KeyEvent,
  BoxRenderable,
  TextRenderable,
  t,
  fg,
} from "@opentui/core";
import { ScrollBoxRenderable } from "@opentui/core";
import { spawn } from "child_process";
import type { Config } from "../types";
import { container, TOKENS } from "../di/container";
import { logger } from "../logger";
import type { HelpEntry, NavigableComponent, NavigationHelp } from "./NavigationHelp";

export type DebugMode = "logs" | "adf" | "markdown" | "readview";

export interface DebugPanelCallbacks {
  onStatusUpdate?: (message: string) => void;
  onPanelSwitch?: (panel: "main" | "debug") => void;
}

export interface DebugPanelOptions {
  renderer: CliRenderer;
  config: Config;
  getContent: (mode: DebugMode) => string;
  callbacks?: DebugPanelCallbacks;
}

export class DebugPanel implements NavigableComponent {
  private renderer: CliRenderer;
  private config: Config;
  private getContentFn: (mode: DebugMode) => string;
  private callbacks: DebugPanelCallbacks;
  private navigationHelp: NavigationHelp | null = null;

  // UI Elements
  public container: BoxRenderable;
  public scroll: ScrollBoxRenderable;
  public content: BoxRenderable;

  // State
  private mode: DebugMode = "logs";
  private debugPanelLines: BoxRenderable[] = [];
  private logUpdateInterval: ReturnType<typeof setInterval> | null = null;
  private isOpen: boolean = false;

  constructor(options: DebugPanelOptions) {
    this.renderer = options.renderer;
    this.config = options.config;
    this.getContentFn = options.getContent;
    this.callbacks = options.callbacks ?? {};

    const { theme } = this.config;

    // Debug panel box
    this.container = new BoxRenderable(this.renderer, {
      id: "debug-panel-box",
      width: "40%",
      margin: 1,
      borderStyle: "single",
      borderColor: theme.warning,
      title: "Debug: LOGS",
      titleAlignment: "left",
      backgroundColor: "#1f1f28",
      border: true,
      visible: false,
    });

    // Debug panel scroll
    this.scroll = new ScrollBoxRenderable(this.renderer, {
      id: "debug-panel-scroll",
      rootOptions: {
        backgroundColor: "#1f1f28",
      },
      viewportOptions: {
        backgroundColor: "#1f1f28",
      },
      contentOptions: {
        backgroundColor: "#1f1f28",
        flexShrink: 0,
      },
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: theme.warning,
          backgroundColor: theme.border,
        },
      },
      scrollX: true,
      scrollY: true,
    });
    this.container.add(this.scroll);

    // Debug panel content
    this.content = new BoxRenderable(this.renderer, {
      id: "debug-panel-content",
      flexDirection: "column",
      backgroundColor: "#1f1f28",
      flexShrink: 0,
    });
    this.scroll.add(this.content);

    this.registerWithNavigationHelp();
  }

  /**
   * Register this component with NavigationHelp via DI
   */
  private registerWithNavigationHelp(): void {
    if (container.has(TOKENS.NavigationHelp)) {
      this.navigationHelp = container.resolve<NavigationHelp>(TOKENS.NavigationHelp);
      this.navigationHelp.registerComponent("debug", this);
    }
  }

  /**
   * Late binding for NavigationHelp (called after DI setup is complete)
   */
  bindNavigationHelp(navHelp: NavigationHelp): void {
    this.navigationHelp = navHelp;
    this.navigationHelp.registerComponent("debug", this);
  }

  /**
   * Called when this component becomes active
   */
  onActivate(): void {
    this.focus();
    this.callbacks.onStatusUpdate?.(
      `Debug: ${this.mode.toUpperCase()} | [/]: switch | Tab: mode | c: copy`
    );
  }

  /**
   * Called when this component becomes inactive
   */
  onDeactivate(): void {
    this.blur();
  }

  /**
   * Activate this component as the current view
   */
  activate(): void {
    if (this.navigationHelp) {
      this.navigationHelp.setActiveComponent(this);
    }
    this.show();
  }

  /**
   * Handle keypress events for debug panel
   */
  handleKeypress(key: KeyEvent): boolean {
    if (!this.isOpen) return false;

    // Toggle debug panel with 'd'
    if (key.name === "d") {
      this.toggle();
      return true;
    }

    // Cycle debug mode with Tab
    if (key.name === "tab") {
      this.cycleMode();
      return true;
    }

    // Copy to clipboard with 'c'
    if (key.name === "c") {
      this.copyToClipboard();
      return true;
    }

    // Panel navigation with [ and ]
    if (key.sequence === "[") {
      this.callbacks.onPanelSwitch?.("main");
      return true;
    }
    if (key.sequence === "]") {
      this.callbacks.onPanelSwitch?.("debug");
      return true;
    }

    return false;
  }

  /**
   * Get help entries for this component
   */
  getHelpEntries(): HelpEntry[] {
    return [
      { key: "d", description: "toggle debug" },
      { key: "[/]", description: "switch panel" },
      { key: "Tab", description: "mode" },
      { key: "c", description: "copy" },
    ];
  }

  /**
   * Extend the active component's help with debug panel help
   */
  extendActiveHelp(): void {
    if (this.navigationHelp && this.isOpen) {
      this.navigationHelp.extendLocalHelp(this.getHelpEntries());
    }
  }

  getMode(): DebugMode {
    return this.mode;
  }

  setMode(mode: DebugMode): void {
    this.mode = mode;
    this.container.title = `Debug: ${mode.toUpperCase()}`;
    this.updateLogRefresh();
    this.render();
  }

  cycleMode(): void {
    const modes: DebugMode[] = ["logs", "markdown", "adf", "readview"];
    const currentIndex = modes.indexOf(this.mode);
    this.setMode(modes[(currentIndex + 1) % modes.length] ?? "logs");
    this.callbacks.onStatusUpdate?.(
      `Debug: ${this.mode.toUpperCase()} | [/]: switch | Tab: mode | c: copy`
    );
  }

  focus(): void {
    this.scroll.focus();
  }

  blur(): void {
    this.scroll.blur();
  }

  show(): void {
    this.container.visible = true;
    this.isOpen = true;
    this.updateLogRefresh();
    this.render();
  }

  hide(): void {
    this.container.visible = false;
    this.isOpen = false;
    this.stopLogRefresh();
  }

  isVisible(): boolean {
    return this.isOpen;
  }

  toggle(): void {
    if (this.isVisible()) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Toggle using the renderer's console (alternative debug mode)
   */
  toggleConsole(): void {
    this.renderer.console.toggle();
  }

  private updateLogRefresh(): void {
    this.stopLogRefresh();

    // Start refresh interval if in logs mode and panel is visible
    if (this.mode === "logs" && this.isOpen) {
      this.logUpdateInterval = setInterval(() => {
        this.render();
      }, 500);
    }
  }

  private stopLogRefresh(): void {
    if (this.logUpdateInterval) {
      clearInterval(this.logUpdateInterval);
      this.logUpdateInterval = null;
    }
  }

  render(): void {
    // Clear existing content
    for (const line of this.debugPanelLines) {
      this.content.remove(line.id);
      line.destroy();
    }
    this.debugPanelLines = [];

    const contentText = this.getContentFn(this.mode);
    const lines = contentText.split("\n");

    // Calculate max line width for horizontal scrolling
    const maxLineLength = Math.max(...lines.map((l) => l.length), 80);

    // Render lines with syntax highlighting
    const isJson = this.mode === "adf";
    const isLogs = this.mode === "logs";

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";

      const lineBox = new BoxRenderable(this.renderer, {
        id: `debug-line-${i}`,
        width: maxLineLength + 10,
        flexDirection: "row",
        paddingLeft: 1,
        flexShrink: 0,
      });

      // Line number (skip for logs mode to save space)
      if (!isLogs) {
        const lineNum = new TextRenderable(this.renderer, {
          id: `debug-linenum-${i}`,
          content: t`${fg("#565f89")((i + 1).toString().padStart(4, " "))} `,
          width: 6,
        });
        lineBox.add(lineNum);
      }

      // Line content with syntax highlighting
      let textColor = "#9aa5ce"; // Default dim text

      if (isJson) {
        // Simple JSON syntax highlighting
        if (lineText.includes('"type"') || lineText.includes('"text"')) {
          textColor = "#7aa2f7"; // Blue for type/text keys
        } else if (lineText.includes('"content"') || lineText.includes('"children"')) {
          textColor = "#bb9af7"; // Purple for structural keys
        } else if (lineText.includes('"attrs"') || lineText.includes('"marks"')) {
          textColor = "#e0af68"; // Orange for attributes
        } else if (lineText.match(/:\s*"[^"]*"/)) {
          textColor = "#9ece6a"; // Green for string values
        }
      } else if (isLogs) {
        // Log level highlighting
        if (lineText.includes("ERR") || lineText.includes("ERROR")) {
          textColor = "#f7768e"; // Red for errors
        } else if (lineText.includes("WRN") || lineText.includes("WARN")) {
          textColor = "#e0af68"; // Orange for warnings
        } else if (lineText.includes("DBG") || lineText.includes("DEBUG")) {
          textColor = "#565f89"; // Dim for debug
        } else if (lineText.includes("INF") || lineText.includes("INFO")) {
          textColor = "#7aa2f7"; // Blue for info
        }
      }

      const lineContent = new TextRenderable(this.renderer, {
        id: `debug-linecontent-${i}`,
        content: lineText || " ",
        fg: textColor,
      });
      lineBox.add(lineContent);

      this.content.add(lineBox);
      this.debugPanelLines.push(lineBox);
    }

    // Set content container width to accommodate longest line
    this.content.width = maxLineLength + 10;
  }

  copyToClipboard(): { success: boolean; message: string } {
    const content = this.getContentFn(this.mode);

    // Use pbcopy on macOS, xclip on Linux
    const platform = process.platform;
    let copyCmd: string;
    let copyArgs: string[];

    if (platform === "darwin") {
      copyCmd = "pbcopy";
      copyArgs = [];
    } else {
      copyCmd = "xclip";
      copyArgs = ["-selection", "clipboard"];
    }

    try {
      const child = spawn(copyCmd, copyArgs, {
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.stdin?.write(content);
      child.stdin?.end();

      const message = `Copied ${this.mode.toUpperCase()} to clipboard (${content.length} chars)`;
      this.callbacks.onStatusUpdate?.(message);
      return { success: true, message };
    } catch (error) {
      logger.error("Copy to clipboard failed", { error });
      const message = `Failed to copy: ${error}`;
      this.callbacks.onStatusUpdate?.(message);
      return { success: false, message };
    }
  }

  setBorderColor(color: string): void {
    this.container.borderColor = color;
  }

  destroy(): void {
    this.stopLogRefresh();
    for (const line of this.debugPanelLines) {
      line.destroy();
    }
    this.debugPanelLines = [];
    this.container.destroy();
  }
}
