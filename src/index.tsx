import {
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type SelectOption,
  ASCIIFontRenderable,
  RGBA,
  t,
  fg,
} from "@opentui/core";
import { ScrollBoxRenderable } from "@opentui/core";
import { spawnSync } from "child_process";

import type {
  TreeNode,
  NavigationState,
  Config,
  ADFDocument,
  ReadViewNode,
  ADFNode,
} from "./types";
import { ConfluenceClient } from "./confluence-client";
import { loadConfig, validateConfig, matchesKey } from "./config";
import { PageCache } from "./cache";
import {
  createComponentRegistry,
  createRenderContext,
} from "./markdown-components";
import { logger } from "./logger";

class ConfluenceTUI {
  private renderer: CliRenderer;
  private config: Config;
  private client: ConfluenceClient;
  private cache: PageCache;

  // UI Elements
  private mainContainer: BoxRenderable | null = null;
  private titleRenderable: ASCIIFontRenderable | null = null;
  private treeSelect: SelectRenderable | null = null;
  private treeBox: BoxRenderable | null = null;
  private readViewBox: BoxRenderable | null = null;
  private readViewScroll: ScrollBoxRenderable | null = null;
  private readViewContent: BoxRenderable | null = null;
  private statusBar: TextRenderable | null = null;
  private helpText: TextRenderable | null = null;

  // State
  private state: NavigationState = {
    view: "tree",
    selectedTreeIndex: 0,
    cursorLine: 0,
    cursorColumn: 0,
    scrollOffset: 0,
  };

  private treeNodes: TreeNode[] = [];
  private flattenedNodes: TreeNode[] = [];
  private currentPage: {
    title: string;
    adf: ADFDocument;
    spaceKey: string;
    pageId: string;
    version: number;
  } | null = null;
  private readViewLines: { content: string; sourceNode?: ADFNode }[] = [];
  private lineRenderables: BoxRenderable[] = [];

  constructor(renderer: CliRenderer, config: Config) {
    this.renderer = renderer;
    this.config = config;
    this.client = new ConfluenceClient(config.confluence);
    this.cache = new PageCache(config);
  }

  async initialize(): Promise<void> {
    this.renderer.setBackgroundColor(this.config.theme.background);
    this.createUI();
    this.setupKeyboardHandling();
    await this.loadSpaces();
  }

  private createUI(): void {
    const { theme } = this.config;

    // Main container
    this.mainContainer = new BoxRenderable(this.renderer, {
      id: "main-container",
      flexGrow: 1,
      flexDirection: "column",
      backgroundColor: theme.background,
    });
    this.renderer.root.add(this.mainContainer);

    // Title
    this.titleRenderable = new ASCIIFontRenderable(this.renderer, {
      id: "title",
      text: "Confluence",
      font: "tiny",
      color: RGBA.fromHex(theme.primary),
      marginLeft: 2,
      marginTop: 1,
    });
    this.mainContainer.add(this.titleRenderable);

    // Tree view box
    this.treeBox = new BoxRenderable(this.renderer, {
      id: "tree-box",
      flexGrow: 1,
      margin: 1,
      borderStyle: "single",
      borderColor: theme.border,
      focusedBorderColor: theme.highlight,
      title: "Spaces & Pages",
      titleAlignment: "left",
      backgroundColor: theme.background,
      border: true,
    });
    this.mainContainer.add(this.treeBox);

    // Tree select
    this.treeSelect = new SelectRenderable(this.renderer, {
      id: "tree-select",
      height: "100%",
      options: [],
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      selectedBackgroundColor: theme.highlight,
      textColor: theme.text,
      selectedTextColor: "#ffffff",
      descriptionColor: theme.border,
      selectedDescriptionColor: theme.text,
      showScrollIndicator: true,
      wrapSelection: false,
      showDescription: true,
      fastScrollStep: 10,
    });
    this.treeBox.add(this.treeSelect);

    // Read view box (initially hidden)
    this.readViewBox = new BoxRenderable(this.renderer, {
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
    this.mainContainer.add(this.readViewBox);

    // Read view scroll container
    this.readViewScroll = new ScrollBoxRenderable(this.renderer, {
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
    this.readViewBox.add(this.readViewScroll);

    // Content container inside scroll
    this.readViewContent = new BoxRenderable(this.renderer, {
      id: "read-view-content",
      flexDirection: "column",
      backgroundColor: theme.background,
    });
    this.readViewScroll.add(this.readViewContent);

    // Status bar
    this.statusBar = new TextRenderable(this.renderer, {
      id: "status-bar",
      content: t`${fg(theme.text)("Loading...")}`,
      marginLeft: 2,
      marginBottom: 1,
    });
    this.mainContainer.add(this.statusBar);

    // Help text
    this.helpText = new TextRenderable(this.renderer, {
      id: "help-text",
      content: t`${fg(theme.border)("j/k: navigate | l/Enter: open | h/Esc: back | i: edit | q: quit")}`,
      marginLeft: 2,
      marginBottom: 1,
    });
    this.mainContainer.add(this.helpText);

    this.treeSelect.focus();
  }

  private setupKeyboardHandling(): void {
    const { keyBindings } = this.config;

    this.treeSelect?.on(
      SelectRenderableEvents.ITEM_SELECTED,
      (_index: number, option: SelectOption) => {
        const node = option.value as TreeNode;
        this.handleTreeSelect(node);
      }
    );

    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      // Global quit
      if (matchesKey(key, keyBindings.quit)) {
        this.cleanup();
        return;
      }

      if (this.state.view === "tree") {
        this.handleTreeKeypress(key);
      } else if (this.state.view === "read") {
        this.handleReadViewKeypress(key);
      }
    });
  }

  private handleTreeKeypress(key: KeyEvent): void {
    const { keyBindings } = this.config;

    // Expand/collapse or navigate into with right/l
    if (matchesKey(key, keyBindings.right)) {
      const selectedIndex = this.treeSelect?.getSelectedIndex() ?? 0;
      const node = this.flattenedNodes[selectedIndex];
      if (node) {
        if (node.type === "space" && !node.expanded) {
          this.toggleExpand(node);
        } else if (node.type === "page") {
          this.openPage(node);
        }
      }
    }

    // Collapse with left/h
    if (matchesKey(key, keyBindings.left)) {
      const selectedIndex = this.treeSelect?.getSelectedIndex() ?? 0;
      const node = this.flattenedNodes[selectedIndex];
      if (node && node.type === "space" && node.expanded) {
        this.toggleExpand(node);
      }
    }

    // Refresh
    if (matchesKey(key, keyBindings.refresh)) {
      this.loadSpaces();
    }
  }

  private handleReadViewKeypress(key: KeyEvent): void {
    const { keyBindings } = this.config;

    // Back to tree view
    if (matchesKey(key, keyBindings.back)) {
      this.showTreeView();
      return;
    }

    // Edit mode
    if (matchesKey(key, keyBindings.edit)) {
      this.openEditor();
      return;
    }

    // Scroll navigation
    if (matchesKey(key, keyBindings.up)) {
      this.state.cursorLine = Math.max(0, this.state.cursorLine - 1);
      this.updateCursorDisplay();
    }

    if (matchesKey(key, keyBindings.down)) {
      this.state.cursorLine = Math.min(
        this.readViewLines.length - 1,
        this.state.cursorLine + 1
      );
      this.updateCursorDisplay();
    }

    // Half page up/down with ctrl+u/d (vim default)
    if (key.ctrl && key.name === "u") {
      this.state.cursorLine = Math.max(
        0,
        this.state.cursorLine - Math.floor(this.renderer.terminalHeight / 2)
      );
      this.updateCursorDisplay();
    }

    if (key.ctrl && key.name === "d") {
      this.state.cursorLine = Math.min(
        this.readViewLines.length - 1,
        this.state.cursorLine + Math.floor(this.renderer.terminalHeight / 2)
      );
      this.updateCursorDisplay();
    }

    // Go to top with gg (handled by 'g' key twice)
    if (key.name === "g") {
      // Simplified: single g goes to top
      this.state.cursorLine = 0;
      this.updateCursorDisplay();
    }

    // Go to bottom with G
    if (key.shift && key.name === "g") {
      this.state.cursorLine = this.readViewLines.length - 1;
      this.updateCursorDisplay();
    }
  }

  private handleTreeSelect(node: TreeNode): void {
    if (node.type === "space") {
      this.toggleExpand(node);
    } else if (node.type === "page") {
      this.openPage(node);
    }
  }

  private async toggleExpand(node: TreeNode): Promise<void> {
    node.expanded = !node.expanded;

    if (node.expanded && node.children.length === 0 && node.spaceKey) {
      // Load pages for this space
      this.updateStatus(`Loading pages for ${node.label}...`);
      try {
        const space = this.treeNodes.find((n) => n.id === node.id);
        if (space) {
          const pages = await this.client.getSpacePages(space.id);
          node.children = pages.map((page) => ({
            id: page.id,
            label: page.title,
            type: "page" as const,
            expanded: false,
            children: [],
            depth: node.depth + 1,
            spaceKey: node.spaceKey,
            pageId: page.id,
          }));
        }
      } catch (error) {
        this.updateStatus(`Error loading pages: ${error}`);
      }
    }

    this.refreshTreeView();
  }

  private async openPage(node: TreeNode): Promise<void> {
    if (!node.pageId || !node.spaceKey) return;

    this.updateStatus(`Loading page: ${node.label}...`);

    try {
      // Check cache first
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
        this.currentPage = {
          title: cached.title,
          adf: cached.adf,
          spaceKey: cached.spaceKey,
          pageId: cached.pageId,
          version: cached.version,
        };
        this.showReadView();
      }
    } catch (error) {
      this.updateStatus(`Error loading page: ${error}`);
    }
  }

  private showTreeView(): void {
    this.state.view = "tree";

    if (this.treeBox) this.treeBox.visible = true;
    if (this.readViewBox) this.readViewBox.visible = false;

    this.treeSelect?.focus();
    this.readViewScroll?.blur();

    this.updateStatus("Navigate spaces and pages");
    this.updateHelp(
      "j/k: navigate | l/Enter: open | h: collapse | r: refresh | q: quit"
    );
  }

  private showReadView(): void {
    if (!this.currentPage) return;

    this.state.view = "read";
    this.state.cursorLine = 0;
    this.state.cursorColumn = 0;

    if (this.treeBox) this.treeBox.visible = false;
    if (this.readViewBox) {
      this.readViewBox.visible = true;
      this.readViewBox.title = this.currentPage.title;
    }

    this.treeSelect?.blur();
    this.readViewScroll?.focus();

    this.renderReadView();
    this.updateStatus(`Viewing: ${this.currentPage.title}`);
    this.updateHelp(
      "j/k: scroll | gg/G: top/bottom | Ctrl+u/d: half page | i: edit | Esc: back | q: quit"
    );
  }

  private renderReadView(): void {
    if (!this.currentPage || !this.readViewContent) return;

    // Log the ADF data for debugging
    logger.debug("Rendering page ADF", {
      title: this.currentPage.title,
      adf: JSON.stringify(this.currentPage.adf, null, 2)
    });

    // Clear existing content
    for (const line of this.lineRenderables) {
      this.readViewContent.remove(line.id);
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
      readViewRoot: JSON.stringify(readViewRoot, null, 2)
    });

    // Flatten the read view tree into lines for display
    this.readViewLines = [];
    this.flattenReadViewNode(readViewRoot, "");

    // Log the flattened lines
    logger.debug("Flattened lines", {
      lineCount: this.readViewLines.length,
      lines: this.readViewLines.map((l, i) => `${i}: "${l.content}"`)
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
      });
      lineBox.add(lineContent);

      this.readViewContent.add(lineBox);
      this.lineRenderables.push(lineBox);
    }
  }

  private flattenReadViewNode(
    node: ReadViewNode,
    prefix: string
  ): void {
    let currentLine = prefix + node.content;

    // Handle newlines in content
    if (currentLine.includes("\n")) {
      const parts = currentLine.split("\n");
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] ?? "";
        const isLast = i === parts.length - 1;
        
        if (isLast && node.children?.length) {
          // Last part continues with children
          currentLine = part;
        } else if (isLast && part === "") {
          // Skip trailing empty string from split (e.g., "text\n" splits to ["text", ""])
          // This prevents extra empty lines after hardBreaks
          continue;
        } else {
          // Add non-empty lines, prevent consecutive empty lines
          const lastLine = this.readViewLines[this.readViewLines.length - 1];
          const isConsecutiveEmpty = part === "" && lastLine?.content === "";
          if (!isConsecutiveEmpty) {
            this.readViewLines.push({
              content: part,
              sourceNode: node.sourceNode,
            });
          }
        }
      }
    }

    // Process children
    if (node.children && node.children.length > 0) {
      let childPrefix = currentLine;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
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
      if (!isConsecutiveEmpty) {
        this.readViewLines.push({
          content: currentLine,
          sourceNode: node.sourceNode,
        });
      }
    }
  }

  private updateCursorDisplay(): void {
    // Update status with cursor position
    this.updateStatus(
      `Line ${this.state.cursorLine + 1}/${this.readViewLines.length}`
    );
  }

  private openEditor(): void {
    if (!this.currentPage) return;

    const markdownPath = this.cache.getMarkdownPath_public(
      this.currentPage.spaceKey,
      this.currentPage.pageId
    );

    // Calculate the line number based on cursor position
    const lineArg = `+${this.state.cursorLine + 1}`;

    // Suspend the renderer before opening editor
    this.renderer.suspend();

    // Open editor
    const result = spawnSync(this.config.editor, [lineArg, markdownPath], {
      stdio: "inherit",
    });

    // Resume renderer after editor closes
    this.renderer.resume();

    if (result.status === 0) {
      this.updateStatus("Editor closed. Changes saved to cache.");
      // TODO: Implement sync back to Confluence if desired
    } else {
      this.updateStatus(`Editor exited with code ${result.status}`);
    }
  }

  private async loadSpaces(): Promise<void> {
    this.updateStatus("Loading spaces...");

    try {
      const spaces = await this.client.getSpaces();

      this.treeNodes = spaces.map((space) => ({
        id: space.id,
        label: space.name,
        type: "space" as const,
        expanded: false,
        children: [],
        depth: 0,
        spaceKey: space.key,
      }));

      this.refreshTreeView();
      this.updateStatus(`Loaded ${spaces.length} spaces`);
    } catch (error) {
      this.updateStatus(`Error loading spaces: ${error}`);
    }
  }

  private refreshTreeView(): void {
    this.flattenedNodes = this.flattenTree(this.treeNodes);

    const options: SelectOption[] = this.flattenedNodes.map((node) => {
      const indent = "  ".repeat(node.depth);
      const icon =
        node.type === "space"
          ? node.expanded
            ? "▼ 📁"
            : "▶ 📁"
          : "  📄";

      return {
        name: `${indent}${icon} ${node.label}`,
        description:
          node.type === "space"
            ? `Space: ${node.spaceKey}`
            : `Page ID: ${node.pageId}`,
        value: node,
      };
    });

    if (this.treeSelect) {
      this.treeSelect.options = options;
    }
  }

  private flattenTree(nodes: TreeNode[]): TreeNode[] {
    const result: TreeNode[] = [];

    for (const node of nodes) {
      result.push(node);
      if (node.expanded && node.children.length > 0) {
        result.push(...this.flattenTree(node.children));
      }
    }

    return result;
  }

  private updateStatus(message: string): void {
    if (this.statusBar) {
      this.statusBar.content = t`${fg(this.config.theme.text)(message)}`;
    }
  }

  private updateHelp(message: string): void {
    if (this.helpText) {
      this.helpText.content = t`${fg(this.config.theme.border)(message)}`;
    }
  }

  private cleanup(): void {
    this.renderer.destroy();
    process.exit(0);
  }
}

async function main(): Promise<void> {
  logger.info("Application starting");
  
  const config = loadConfig();
  logger.debug("Config loaded", { 
    baseUrl: config.confluence.baseUrl,
    email: config.confluence.email,
    hasApiToken: !!config.confluence.apiToken,
    cacheDir: config.cacheDir,
    editor: config.editor
  });
  
  const errors = validateConfig(config);

  if (errors.length > 0) {
    logger.error("Configuration validation failed", { errors });
    console.error("Configuration errors:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error("\nPlease set the required environment variables:");
    console.error("  ATLASSIAN_BASE_URL - Your Confluence base URL (e.g., https://your-domain.atlassian.net)");
    console.error("  ATLASSIAN_EMAIL - Your Atlassian account email");
    console.error("  ATLASSIAN_API_TOKEN - Your Atlassian API token");
    console.error("\nOr create a config file at ~/.config/confluence-tui/config.json");
    console.error(`\nLog file: ${logger.getLogFile()}`);
    process.exit(1);
  }

  logger.info("Configuration validated successfully");

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
  });

  logger.info("Renderer created");

  const app = new ConfluenceTUI(renderer, config);
  await app.initialize();
}

main().catch((error) => {
  logger.error("Fatal error", { 
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined
  });
  console.error("Fatal error:", error);
  console.error(`\nLog file: ${logger.getLogFile()}`);
  process.exit(1);
});
