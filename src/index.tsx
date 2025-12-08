#!/usr/bin/env bun
import {
  ASCIIFontRenderable,
  BoxRenderable,
  type CliRenderer,
  ConsolePosition,
  createCliRenderer,
  fg,
  type KeyEvent,
  RGBA,
  t,
  TextRenderable,
} from "@opentui/core";

import {DEBUG_MODE} from "./constants";
import type {Config, TreeNode} from "./types";
import {ConfluenceClient} from "./confluence-client";
import {KeyBindingManager, loadConfig, validateConfig} from "./config";
import {PageCache} from "./cache";
import {logger} from "./logger";

// DI Container
import {container, TOKENS} from "./di/container";

// Components
import {LandingView, NavigationHelp, PageView, SearchModal, TreeView,} from "./components";

class ConfluenceTUI {
  private renderer!: CliRenderer;
  private config!: Config;
  private cache!: PageCache;
  private keys!: KeyBindingManager;

  // UI Elements
  private mainContainer: BoxRenderable | null = null;
  private titleRenderable: ASCIIFontRenderable | null = null;
  private contentContainer: BoxRenderable | null = null;
  private statusBar: TextRenderable | null = null;

  // Components
  private treeView!: TreeView;
  private pageView!: PageView;
  private landingView!: LandingView;
  private navigationHelp!: NavigationHelp;
  private searchModal!: SearchModal;

  async initialize(): Promise<void> {
    // Resolve dependencies from container
    this.renderer = container.resolve<CliRenderer>(TOKENS.Renderer);
    this.config = container.resolve<Config>(TOKENS.Config);
    this.cache = container.resolve<PageCache>(TOKENS.Cache);
    this.keys = container.resolve<KeyBindingManager>(TOKENS.KeyBindings);

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
      text: DEBUG_MODE ? "Rivermeet [DEBUG]" : "Rivermeet",
      font: "tiny",
      color: RGBA.fromHex(DEBUG_MODE ? theme.warning : theme.primary),
      marginLeft: 2,
      marginTop: 1,
      visible: false
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
    this.navigationHelp = new NavigationHelp(this.renderer, this.config, this.keys);
    this.mainContainer.add(this.navigationHelp.container);
    container.registerInstance(TOKENS.NavigationHelp, this.navigationHelp);

    // Setup global key handlers
    this.setupGlobalHandlers();

    // Create components
    this.createComponents();

    // Show landing view as initial view (tree loads in background)
    this.landingView.activate();
  }

  private setupGlobalHandlers(): void {
    // Global search handler (cmd+K) - highest priority
    // Only show modal when NOT on landing view (landing view has search built-in)
    this.navigationHelp.registerGlobalHandler((key) => {
      if (this.keys.matches("globalSearch", key)) {
        // Don't show modal if we're on the landing view
        if (this.landingView.container.visible) {
          return false; // Let landing view handle it
        }
        this.searchModal.show();
        return true;
      }
      return false;
    });

    // Global quit handler
    this.navigationHelp.registerGlobalHandler((key) => {
      if (this.keys.matches("quit", key)) {
        this.cleanup();
        return true;
      }
      return false;
    });

    // Global debug toggle handler
    if (DEBUG_MODE) {
      this.navigationHelp.registerGlobalHandler((key) => {
        if (this.keys.matches("debug", key)) {
          this.toggleDebugPanel();
          return true;
        }
        return false;
      });
    }
  }

  private createComponents(): void {
    // Create LandingView - initial landing page with search
    this.landingView = new LandingView({
      onPageSelect: async (result) => {
        await this.openPage({
          pageId: result.id,
          spaceKey: result.spaceKey,
          label: result.title,
        });
      },
      onShowSpaces: () => {
        this.showTreeView();
      },
    });
    this.contentContainer!.add(this.landingView.container);
    container.registerInstance(TOKENS.LandingView, this.landingView);

    // Create TreeView - it resolves its own dependencies from DI
    this.treeView = new TreeView({
      onPageSelect: (node) => this.openPage(node),
      onStatusUpdate: (msg) => this.updateStatus(msg),
      onBack: () => this.showLandingView(),
    });
    this.contentContainer!.add(this.treeView.container);
    this.treeView.hide(); // Hidden initially
    container.registerInstance(TOKENS.TreeView, this.treeView);

    // Create PageView - it resolves its own dependencies from DI
    this.pageView = new PageView({
      onBack: () => this.showLandingView(),
      onStatusUpdate: (msg) => this.updateStatus(msg),
    });
    this.contentContainer!.add(this.pageView.container);
    container.registerInstance(TOKENS.PageView, this.pageView);

    // Create SearchModal - global search overlay (for cmd+K from other views)
    this.searchModal = new SearchModal({
      onClose: () => {
        // Restore focus to the previous active component
        this.navigationHelp.refreshLocalHelp();
      },
      onPageSelect: async (result) => {
        // Navigate to the selected page
        await this.openPage({
          pageId: result.id,
          spaceKey: result.spaceKey,
          label: result.title,
        });
      },
      onShowSpaces: () => {
        this.showTreeView();
      },
    });
    // Add search modal to root so it overlays everything
    this.renderer.root.add(this.searchModal.container);
  }

  private setupKeyboardHandling(): void {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      // Log ALL key events for debugging
      logger.debug("Keypress", {
        name: key.name,
        ctrl: key.ctrl,
        shift: key.shift,
        meta: key.meta,
        super: key.super,
      });

      // If search modal is open, route all keys to it first
      if (this.searchModal.isOpen()) {
        this.searchModal.handleKeypress(key);
        return;
      }

      this.navigationHelp.handleKeypress(key);
    });
  }

  private async openPage(node: Pick<TreeNode, "pageId" | "spaceKey" | "label">): Promise<void> {
    await this.pageView.loadPage(node);
    this.showPageView();
  }

  private showLandingView(): void {
    if (this.titleRenderable){
      this.titleRenderable.visible=false
    }
    this.landingView.show();
    this.treeView.hide();
    this.pageView.hide();
    this.landingView.activate();
  }

  private showTreeView(): void {
    if (this.titleRenderable){
      this.titleRenderable.visible=true
    }
    this.landingView.hide();
    this.treeView.show();
    this.pageView.hide();
    this.treeView.activate();
  }

  private showPageView(): void {
    if (this.titleRenderable){
      this.titleRenderable.visible=true
    }
    const currentPage = this.pageView.getPage();
    if (!currentPage) return;

    this.landingView.hide();
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
    this.landingView.destroy();
    this.searchModal.destroy();
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
  container.registerInstance(TOKENS.KeyBindings, new KeyBindingManager(config.keyBindings));
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
