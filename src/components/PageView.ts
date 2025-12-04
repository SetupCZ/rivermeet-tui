import {
  type CliRenderer,
  type KeyEvent,
  BoxRenderable,
  TextRenderable,
  t,
  fg,
} from "@opentui/core";
import { ScrollBoxRenderable } from "@opentui/core";
import type { Config, ADFDocument, ADFNode, ReadViewNode, TreeNode } from "../types";
import { matchesKey } from "../config";
import { container, TOKENS } from "../di/container";
import {
  createComponentRegistry,
  createRenderContext,
} from "../markdown-components";
import { logger } from "../logger";
import type { HelpEntry, NavigableComponent, NavigationHelp } from "./NavigationHelp";
import { ConfluenceClient } from "../confluence-client";
import { PageCache } from "../cache";
import { spawnSync } from "child_process";

export interface PageData {
  title: string;
  adf: ADFDocument;
  spaceKey: string;
  pageId: string;
  version: number;
}

export interface PageViewEvents {
  onBack?: () => void;
  onStatusUpdate?: (message: string) => void;
}

export class PageView implements NavigableComponent {
  private renderer: CliRenderer;
  private config: Config;
  private client: ConfluenceClient;
  private cache: PageCache;
  private events: PageViewEvents;
  private navigationHelp: NavigationHelp | null = null;

  // UI Elements
  public container: BoxRenderable;
  public scroll: ScrollBoxRenderable;
  public content: BoxRenderable;

  // State
  private currentPage: PageData | null = null;
  private readViewLines: { content: string; sourceNode?: ADFNode; style?: ReadViewNode["style"] }[] = [];
  private lineRenderables: BoxRenderable[] = [];
  private cursorLine: number = 0;

  constructor(events: PageViewEvents = {}) {
    this.renderer = container.resolve<CliRenderer>(TOKENS.Renderer);
    this.config = container.resolve<Config>(TOKENS.Config);
    this.client = container.resolve<ConfluenceClient>(TOKENS.Client);
    this.cache = container.resolve<PageCache>(TOKENS.Cache);
    this.events = events;

    const { theme } = this.config;

    // Read view box
    this.container = new BoxRenderable(this.renderer, {
      id: "read-view-box",
      flexGrow: 1,
      margin: 1,
      borderStyle: "single",
      borderColor: theme.border,
      title: "Page",
      titleAlignment: "left",
      backgroundColor: theme.background,
      border: true,
      visible: false,
    });

    // Read view scroll container
    this.scroll = new ScrollBoxRenderable(this.renderer, {
      id: "read-view-scroll",
      rootOptions: {
        backgroundColor: theme.background,
      },
      viewportOptions: {
        backgroundColor: theme.background,
      },
      contentOptions: {
        backgroundColor: theme.background,
      },
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: theme.primary,
          backgroundColor: theme.border,
        },
      },
    });
    this.container.add(this.scroll);

    // Content container inside scroll
    this.content = new BoxRenderable(this.renderer, {
      id: "read-view-content",
      flexDirection: "column",
      backgroundColor: theme.background,
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
      this.navigationHelp.registerComponent("page", this);
    }
  }

  /**
   * Called when this component becomes active
   */
  onActivate(): void {
    this.focus();
    if (this.currentPage) {
      this.updateStatus(`Viewing: ${this.currentPage.title}`);
    }
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
   * Handle keypress events for page view
   */
  handleKeypress(key: KeyEvent): boolean {
    const { keyBindings } = this.config;

    // Back to tree view
    if (matchesKey(key, keyBindings.back)) {
      this.events.onBack?.();
      return true;
    }

    // Edit mode
    if (matchesKey(key, keyBindings.edit)) {
      this.openEditor();
      return true;
    }

    // Scroll navigation
    if (matchesKey(key, keyBindings.up)) {
      this.cursorLine = Math.max(0, this.cursorLine - 1);
      this.updateCursorDisplay();
      return true;
    }

    if (matchesKey(key, keyBindings.down)) {
      this.cursorLine = Math.min(this.readViewLines.length - 1, this.cursorLine + 1);
      this.updateCursorDisplay();
      return true;
    }

    // Half page up/down with ctrl+u/d
    if (key.ctrl && key.name === "u") {
      this.cursorLine = Math.max(
        0,
        this.cursorLine - Math.floor(this.renderer.terminalHeight / 2)
      );
      this.updateCursorDisplay();
      return true;
    }

    if (key.ctrl && key.name === "d") {
      this.cursorLine = Math.min(
        this.readViewLines.length - 1,
        this.cursorLine + Math.floor(this.renderer.terminalHeight / 2)
      );
      this.updateCursorDisplay();
      return true;
    }

    // Go to top with g
    if (key.name === "g" && !key.shift) {
      this.cursorLine = 0;
      this.updateCursorDisplay();
      return true;
    }

    // Go to bottom with G
    if (key.shift && key.name === "g") {
      this.cursorLine = this.readViewLines.length - 1;
      this.updateCursorDisplay();
      return true;
    }

    return false;
  }

  /**
   * Get help entries for this component
   */
  getHelpEntries(): HelpEntry[] {
    return [
      { key: "j/k", description: "scroll" },
      { key: "gg/G", description: "top/bottom" },
      { key: "Ctrl+u/d", description: "half page" },
      { key: "i", description: "edit" },
      { key: "Esc", description: "back" },
    ];
  }

  private updateCursorDisplay(): void {
    this.updateStatus(
      `Line ${this.cursorLine + 1}/${this.readViewLines.length}`
    );
  }

  private updateStatus(message: string): void {
    this.events.onStatusUpdate?.(message);
  }

  /**
   * Load a page from a tree node
   */
  async loadPage(node: TreeNode): Promise<void> {
    if (!node.pageId || !node.spaceKey) return;

    this.updateStatus(`Loading page: ${node.label}...`);

    try {
      let cached = this.cache.getCachedPage(node.spaceKey, node.pageId);

      if (!cached || this.cache.isStale(cached)) {
        const page = await this.client.getPage(node.pageId);
        const adf = this.client.parseADF(page);

        if (adf) {
          cached = this.cache.savePage(
            node.spaceKey,
            node.pageId,
            page.title,
            adf,
            page.version.number
          );
        }
      }

      if (cached) {
        const pageData: PageData = {
          title: cached.title,
          adf: cached.adf,
          spaceKey: cached.spaceKey,
          pageId: cached.pageId,
          version: cached.version,
        };
        this.setPage(pageData);
      }
    } catch (error) {
      this.updateStatus(`Error loading page: ${error}`);
    }
  }

  /**
   * Open the current page in the configured editor
   */
  openEditor(): void {
    if (!this.currentPage) return;

    const markdownPath = this.cache.getMarkdownPath_public(
      this.currentPage.spaceKey,
      this.currentPage.pageId
    );

    const lineArg = `+${this.cursorLine + 1}`;

    this.renderer.suspend();

    const result = spawnSync(this.config.editor, [lineArg, markdownPath], {
      stdio: "inherit",
    });

    this.renderer.resume();

    if (result.status === 0) {
      this.updateStatus("Editor closed. Changes saved to cache.");
    } else {
      this.updateStatus(`Editor exited with code ${result.status}`);
    }
  }

  getCursorLine(): number {
    return this.cursorLine;
  }

  setCursorLine(line: number): void {
    this.cursorLine = Math.max(0, Math.min(line, this.readViewLines.length - 1));
  }

  resetCursor(): void {
    this.cursorLine = 0;
  }

  setPage(page: PageData): void {
    this.currentPage = page;
    this.container.title = page.title;
    this.cursorLine = 0;
    this.render();
  }

  getPage(): PageData | null {
    return this.currentPage;
  }

  getLines(): typeof this.readViewLines {
    return this.readViewLines;
  }

  getLineCount(): number {
    return this.readViewLines.length;
  }

  focus(): void {
    this.scroll.focus();
  }

  blur(): void {
    this.scroll.blur();
  }

  show(): void {
    this.container.visible = true;
  }

  hide(): void {
    this.container.visible = false;
  }

  private render(): void {
    if (!this.currentPage) return;

    // Log the ADF data for debugging
    logger.debug("Rendering page ADF", {
      title: this.currentPage.title,
      adf: JSON.stringify(this.currentPage.adf, null, 2),
    });

    // Clear existing content
    for (const line of this.lineRenderables) {
      this.content.remove(line.id);
      line.destroy();
    }
    this.lineRenderables = [];

    // Convert ADF to read view nodes
    const components = createComponentRegistry();
    const context = createRenderContext(components);

    const docComponent = components.get("doc");
    if (!docComponent) return;

    const readViewRoot = docComponent.toReadView(this.currentPage.adf, context);

    // Log the read view tree
    logger.debug("ReadView tree", {
      readViewRoot: JSON.stringify(readViewRoot, null, 2),
    });

    // Flatten the read view tree into lines for display
    this.readViewLines = [];
    this.flattenReadViewNode(readViewRoot, "");

    // Log the flattened lines
    logger.debug("Flattened lines", {
      lineCount: this.readViewLines.length,
      lines: this.readViewLines.map((l, i) => `${i}: "${l.content}"`),
    });

    // Render lines
    for (let i = 0; i < this.readViewLines.length; i++) {
      const line = this.readViewLines[i];
      if (!line) continue;

      const lineBox = new BoxRenderable(this.renderer, {
        id: `line-${i}`,
        width: "100%",
        flexDirection: "row",
        paddingLeft: 1,
      });

      // Line number
      const lineNum = new TextRenderable(this.renderer, {
        id: `linenum-${i}`,
        content: t`${fg(this.config.theme.border)((i + 1).toString().padStart(4, " "))} `,
        width: 6,
      });
      lineBox.add(lineNum);

      // Line content
      const lineContent = new TextRenderable(this.renderer, {
        id: `linecontent-${i}`,
        content: line.content || " ",
        fg: this.config.theme.text,
        height: line.style?.size,
      });
      lineBox.add(lineContent);

      this.content.add(lineBox);
      this.lineRenderables.push(lineBox);
    }
  }

  private flattenReadViewNode(node: ReadViewNode, prefix: string): void {
    const currentLine = prefix + node.content;

    // Process children
    if (node.children && node.children.length > 0) {
      logger.debug("Flattening", {
        children: node.children,
        len: node.children?.length,
      });
      let childPrefix = currentLine;

      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        logger.debug("Child", {
          child,
          i,
          childPrefix,
        });
        if (!child) continue;

        if (i === 0) {
          this.flattenReadViewNode(child, childPrefix);
          childPrefix = "";
        } else {
          this.flattenReadViewNode(child, childPrefix);
        }
      }
    } else if (currentLine !== "" || this.readViewLines.length === 0) {
      // Add the line if it has content, or if it's the first line
      // Avoid consecutive empty lines
      const lastLine = this.readViewLines[this.readViewLines.length - 1];
      const isConsecutiveEmpty = currentLine === "" && lastLine?.content === "";
      logger.debug("Empty content", {
        isConsecutiveEmpty,
        lastLine,
        currentLine,
      });
      if (!isConsecutiveEmpty) {
        this.readViewLines.push({
          content: currentLine,
          sourceNode: node.sourceNode,
          style: node.style,
        });
      }
    }
  }

  setBorderColor(color: string): void {
    this.container.borderColor = color;
  }

  destroy(): void {
    for (const line of this.lineRenderables) {
      line.destroy();
    }
    this.lineRenderables = [];
    this.container.destroy();
  }
}
