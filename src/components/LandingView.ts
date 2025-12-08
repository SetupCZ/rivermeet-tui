import {
  ASCIIFontRenderable,
  BoxRenderable,
  type CliRenderer,
  fg,
  type KeyEvent,
  RGBA,
  t,
  TextRenderable,
} from "@opentui/core";
import type { Config, SearchResult } from "../types";
import { KeyBindingManager } from "../config";
import { container, TOKENS } from "../di/container";
import { logger } from "../logger";
import { exec } from "child_process";
import type { HelpEntry, NavigableComponent } from "./NavigationHelp";
import { SearchInput } from "./SearchInput";

export interface LandingViewEvents {
  onPageSelect?: (result: SearchResult) => void;
  onShowSpaces?: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  shortcut: string;
  action: () => void;
}

export class LandingView implements NavigableComponent {
  private renderer: CliRenderer;
  private config: Config;
  private keys: KeyBindingManager;
  private events: LandingViewEvents;

  // UI Elements
  public container: BoxRenderable;
  private headerText: ASCIIFontRenderable;
  private searchBox: BoxRenderable;
  private searchInput: SearchInput;
  private menuContainer: BoxRenderable;
  private menuRenderables: TextRenderable[] = [];

  // State
  private isSearchFocused: boolean = false;
  private selectedMenuIndex: number = 0;

  // Menu items
  private menuItems: MenuItem[] = [];

  constructor(events: LandingViewEvents = {}) {
    this.renderer = container.resolve<CliRenderer>(TOKENS.Renderer);
    this.config = container.resolve<Config>(TOKENS.Config);
    this.keys = container.resolve<KeyBindingManager>(TOKENS.KeyBindings);
    this.events = events;

    const { theme } = this.config;

    // Setup menu items
    this.menuItems = [
      {
        id: "spaces",
        label: "Browse spaces",
        shortcut: "s",
        action: () => {
          this.events.onShowSpaces?.();
        },
      },
      {
        id: "docs",
        label: "Documentation",
        shortcut: "d",
        action: () => {
          this.openUrl("https://setupcz.github.io/rivermeet-tui/");
        },
      },
      {
        id: "quit",
        label: "Quit",
        shortcut: "q",
        action: () => {
          // Quit is handled by global handler
        },
      },
    ];

    // Main container (full width, centered content)
    this.container = new BoxRenderable(this.renderer, {
      id: "landing-view",
      flexGrow: 1,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "flex-start",
      paddingTop: 3,
      backgroundColor: theme.background,
    });

    // ASCII Header - "Rivermeet"
    this.headerText = new ASCIIFontRenderable(this.renderer, {
      id: "landing-header",
      text: "Rivermeet",
      font: "tiny",
      color: RGBA.fromHex(theme.primary),
      marginBottom: 2,
    });
    this.container.add(this.headerText);

    // Search section container
    this.searchBox = new BoxRenderable(this.renderer, {
      id: "landing-search-section",
      width: "50%",
      minWidth: 40,
      maxWidth: 60,
      flexDirection: "column",
      alignItems: "center",
      marginBottom: 2,
    });
    this.container.add(this.searchBox);

    // Create SearchInput component
    this.searchInput = new SearchInput(
      {
        onResultSelect: (result) => {
          this.events.onPageSelect?.(result);
        },
        onEscape: () => {
          this.unfocusSearch();
        },
        onResultsChange: () => {
          // Refresh help entries when results change
          const navigationHelp = container.resolve<any>(TOKENS.NavigationHelp);
          navigationHelp.refreshLocalHelp();
        },
      },
      {
        id: "landing-search",
        placeholder: "⌘K to search...",
        showQuickSelect: true,
        maxResults: 10,
      }
    );
    this.searchBox.add(this.searchInput.inputContainer);
    
    // Initially hide results
    this.searchInput.resultsBox.visible = false;

    // Menu container - prominent list
    this.menuContainer = new BoxRenderable(this.renderer, {
      id: "landing-menu",
      width: "50%",
      minWidth: 40,
      maxWidth: 60,
      flexDirection: "column",
      alignItems: "flex-start",
      marginTop: 2,
    });
    this.container.add(this.menuContainer);

    // Create menu item renderables
    this.createMenuRenderables();
  }

  private createMenuRenderables(): void {
    const { theme } = this.config;

    for (let i = 0; i < this.menuItems.length; i++) {
      const item = this.menuItems[i]!;
      const isSelected = i === this.selectedMenuIndex && !this.isSearchFocused;

      const text = new TextRenderable(this.renderer, {
        id: `landing-menu-${item.id}`,
        content: this.formatMenuItem(item, isSelected),
        marginBottom: 1,
      });
      this.menuContainer.add(text);
      this.menuRenderables.push(text);
    }
  }

  private formatMenuItem(item: MenuItem, isSelected: boolean): ReturnType<typeof t> {
    const { theme } = this.config;
    const shortcutPad = item.shortcut.padEnd(4);

    if (isSelected) {
      return t`${fg(theme.primary)(">")} ${fg(theme.primary)(shortcutPad)} ${fg(theme.text)(item.label)}`;
    }
    return t`  ${fg(theme.border)(shortcutPad)} ${fg(theme.text)(item.label)}`;
  }

  private updateMenuRenderables(): void {
    for (let i = 0; i < this.menuItems.length; i++) {
      const item = this.menuItems[i]!;
      const isSelected = i === this.selectedMenuIndex && !this.isSearchFocused;
      this.menuRenderables[i]!.content = this.formatMenuItem(item, isSelected);
    }
  }

  // NavigableComponent implementation
  getHelpEntries(): HelpEntry[] {
    if (this.isSearchFocused) {
      const entries: HelpEntry[] = [
        { key: "esc", description: "cancel" },
        { key: "↑/↓", description: "navigate" },
        { key: "enter", description: "select" },
      ];
      if (this.searchInput.getResults().length > 0) {
        entries.push({ key: "^1-5", description: "quick select" });
      }
      return entries;
    }

    return [
      { key: "↑/↓", description: "navigate" },
      { key: "enter", description: "select" },
    ];
  }

  wantsExclusiveInput(): boolean {
    return this.isSearchFocused;
  }

  handleKeypress(key: KeyEvent): boolean {
    if (this.isSearchFocused) {
      return this.searchInput.handleKeypress(key);
    }
    return this.handleMenuKeypress(key);
  }

  private handleMenuKeypress(key: KeyEvent): boolean {
    // Navigate menu
    if (this.keys.matches("up", key)) {
      this.selectedMenuIndex = this.selectedMenuIndex === 0
        ? this.menuItems.length - 1
        : this.selectedMenuIndex - 1;
      this.updateMenuRenderables();
      return true;
    }

    if (this.keys.matches("down", key)) {
      this.selectedMenuIndex = (this.selectedMenuIndex + 1) % this.menuItems.length;
      this.updateMenuRenderables();
      return true;
    }

    // Select menu item
    if (this.keys.matches("select", key)) {
      this.menuItems[this.selectedMenuIndex]?.action();
      return true;
    }

    // Direct shortcuts
    if (this.keys.matches("globalSearch", key)) {
      this.focusSearch();
      return true;
    }

    if (this.keys.matches("openSpaces", key)) {
      this.menuItems.find(m => m.id === "spaces")?.action();
      return true;
    }

    if (this.keys.matches("openDocs", key)) {
      this.menuItems.find(m => m.id === "docs")?.action();
      return true;
    }

    return false;
  }

  private focusSearch(): void {
    this.isSearchFocused = true;
    this.searchInput.focus();
    this.updateMenuRenderables();

    // Refresh help entries
    const navigationHelp = container.resolve<any>(TOKENS.NavigationHelp);
    navigationHelp.refreshLocalHelp();
  }

  private unfocusSearch(): void {
    this.isSearchFocused = false;
    this.searchInput.blur();
    this.updateMenuRenderables();

    // Refresh help entries
    const navigationHelp = container.resolve<any>(TOKENS.NavigationHelp);
    navigationHelp.refreshLocalHelp();
  }

  onActivate(): void {
    this.show();
    // Reset to menu mode
    this.isSearchFocused = false;
    this.selectedMenuIndex = 0;
    this.searchInput.reset();
    this.searchInput.resultsBox.visible = false;
    this.updateMenuRenderables();
  }

  onDeactivate(): void {
    this.hide();
  }

  /**
   * Activate this component
   */
  activate(): void {
    const navigationHelp = container.resolve<any>(TOKENS.NavigationHelp);
    navigationHelp.setActiveComponent(this);
  }

  show(): void {
    this.container.visible = true;
  }

  hide(): void {
    this.container.visible = false;
  }

  private openUrl(url: string): void {
    // Open URL in default browser
    const command = process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;

    exec(command, (error) => {
      if (error) {
        logger.error("Failed to open URL", { url, error });
      }
    });
  }

  destroy(): void {
    this.searchInput.destroy();
    this.container.destroy();
  }
}
