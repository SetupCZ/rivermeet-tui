import {
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  BoxRenderable,
  TextRenderable,
  ASCIIFontRenderable,
  RGBA,
  t,
  fg,
  ConsolePosition,
} from "@opentui/core";

import {DEBUG_MODE} from "./constants";
import type {TreeNode, Config} from "./types";
import {ConfluenceClient} from "./confluence-client";
import {loadConfig, validateConfig, matchesKey} from "./config";
import {PageCache} from "./cache";
import {logger} from "./logger";

// DI Container
import {container, TOKENS} from "./di/container";

// Components
import {
  TreeView,
  PageView,
  NavigationHelp,
} from "./components";

class ConfluenceTUI {
  private renderer!: CliRenderer;
  private config!: Config;
  private cache!: PageCache;

  // UI Elements
  private mainContainer: BoxRenderable | null = null;
  private titleRenderable: ASCIIFontRenderable | null = null;
  private contentContainer: BoxRenderable | null = null;
  private statusBar: TextRenderable | null = null;

  // Components
  private treeView!: TreeView;
  private pageView!: PageView;
  private navigationHelp!: NavigationHelp;

  async initialize(): Promise<void> {
    // Resolve dependencies from container
    this.renderer = container.resolve<CliRenderer>(TOKENS.Renderer);
    this.config = container.resolve<Config>(TOKENS.Config);
    this.cache = container.resolve<PageCache>(TOKENS.Cache);

    this.renderer.setBackgroundColor(this.config.theme.background);
    this.createUI();
    this.setupKeyboardHandling();
    if (DEBUG_MODE) {
      await this.openPage({
        label: "Page", spaceKey: "AIS", pageId: "5122097206"
      })
      return
    }
      await this.treeView.loadSpaces();
  }

  private createUI(): void {
    const {theme} = this.config;

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
      text: DEBUG_MODE ? "Confluence [DEBUG]" : "Confluence",
      font: "tiny",
      color: RGBA.fromHex(DEBUG_MODE ? theme.warning : theme.primary),
      marginLeft: 2,
      marginTop: 1,
    });
    this.mainContainer.add(this.titleRenderable);

    // Content container
    this.contentContainer = new BoxRenderable(this.renderer, {
      id: "content-container",
      flexGrow: 1,
      flexDirection: "row",
      backgroundColor: theme.background,
    });
    this.mainContainer.add(this.contentContainer);

    // Status bar
    this.statusBar = new TextRenderable(this.renderer, {
      id: "status-bar",
      content: t`${fg(theme.text)("Loading...")}`,
      marginLeft: 2,
      marginBottom: 1,
    });
    this.mainContainer.add(this.statusBar);

    // Create NavigationHelp first and register in DI
    this.navigationHelp = new NavigationHelp(this.renderer, this.config);
    this.mainContainer.add(this.navigationHelp.container);
    container.registerInstance(TOKENS.NavigationHelp, this.navigationHelp);

    // Setup global key handlers
    this.setupGlobalHandlers();

    // Create components
    this.createComponents();

    // Activate tree view as initial view
    this.treeView.activate();
  }

  private setupGlobalHandlers(): void {
    // Global quit handler
    this.navigationHelp.registerGlobalHandler((key) => {
      if (matchesKey(key, this.config.keyBindings.quit)) {
        this.cleanup();
        return true;
      }
      return false;
    });

    // Global debug toggle handler
    if (DEBUG_MODE) {
      this.navigationHelp.registerGlobalHandler((key) => {
        if (key.name === "d") {
          this.toggleDebugPanel();
          return true;
        }
        return false;
      });
    }
  }

  private createComponents(): void {
    // Create TreeView - it resolves its own dependencies from DI
    this.treeView = new TreeView({
      onPageSelect: (node) => this.openPage(node),
      onStatusUpdate: (msg) => this.updateStatus(msg),
    });
    this.contentContainer!.add(this.treeView.container);
    container.registerInstance(TOKENS.TreeView, this.treeView);

    // Create PageView - it resolves its own dependencies from DI
    this.pageView = new PageView({
      onBack: () => this.showTreeView(),
      onStatusUpdate: (msg) => this.updateStatus(msg),
    });
    this.contentContainer!.add(this.pageView.container);
    container.registerInstance(TOKENS.PageView, this.pageView);
  }

  private setupKeyboardHandling(): void {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      this.navigationHelp.handleKeypress(key);
    });
  }

  private async openPage(node: Pick<TreeNode, "pageId" | "spaceKey" | "label">): Promise<void> {
    await this.pageView.loadPage(node);
    this.showPageView();
  }

  private showTreeView(): void {
    this.treeView.show();
    this.pageView.hide();
    this.treeView.activate();
  }

  private showPageView(): void {
    const currentPage = this.pageView.getPage();
    if (!currentPage) return;

    this.treeView.hide();
    this.pageView.show();
    this.pageView.activate();
  }

  private updateStatus(message: string): void {
    if (this.statusBar) {
      this.statusBar.content = t`${fg(this.config.theme.text)(message)}`;
    }
  }

  // Debug panel methods
  private toggleDebugPanel(): void {
    if (!DEBUG_MODE) return;
    this.renderer.console.toggle();
  }

  private cleanup(): void {
    this.navigationHelp.destroy();
    this.renderer.destroy();
    process.exit(0);
  }
}

async function main(): Promise<void> {
  logger.info("Application starting", {debugMode: DEBUG_MODE});

  if (DEBUG_MODE) {
    logger.info("Debug mode enabled - press 'd' to open debug panel");
  }

  const config = loadConfig();
  logger.debug("Config loaded", {
    baseUrl: config.confluence.baseUrl,
    email: config.confluence.email,
    hasApiToken: !!config.confluence.apiToken,
    cacheDir: config.cacheDir,
    editor: config.editor,
  });

  const errors = validateConfig(config);

  if (errors.length > 0) {
    logger.error("Configuration validation failed", {errors});
    console.error("Configuration errors:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error("\nPlease set the required environment variables:");
    console.error(
      "  ATLASSIAN_BASE_URL - Your Confluence base URL (e.g., https://your-domain.atlassian.net)"
    );
    console.error("  ATLASSIAN_EMAIL - Your Atlassian account email");
    console.error("  ATLASSIAN_API_TOKEN - Your Atlassian API token");
    console.error(
      "\nOr create a config file at ~/.config/rivermeet-tui/config.json"
    );
    console.error(`\nLog file: ${logger.getLogFile()}`);
    process.exit(1);
  }

  logger.info("Configuration validated successfully");

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    consoleOptions: {
      position: ConsolePosition.RIGHT,
      sizePercent: 30,
      colorInfo: "#00FFFF",
      colorWarn: "#FFFF00",
      colorError: "#FF0000",
      startInDebugMode: DEBUG_MODE,
    },
  });

  logger.info("Renderer created");

  // Register core services in DI container
  container.registerInstance(TOKENS.Renderer, renderer);
  container.registerInstance(TOKENS.Config, config);
  container.registerInstance(TOKENS.Client, new ConfluenceClient(config.confluence));
  container.registerInstance(TOKENS.Cache, new PageCache(config));

  const app = new ConfluenceTUI();
  await app.initialize();
}

main().catch((error) => {
  logger.error("Fatal error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  console.error("Fatal error:", error);
  console.error(`\nLog file: ${logger.getLogFile()}`);
  process.exit(1);
});
