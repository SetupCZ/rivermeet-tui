import {bg, BoxRenderable, type CliRenderer, fg, type KeyEvent, t, TextRenderable,} from "@opentui/core";
import type {Config, SearchResult} from "../types";
import {KeyBindingManager} from "../config";
import {container, TOKENS} from "../di/container";
import {ConfluenceClient} from "../confluence-client";
import {logger} from "../logger";

export interface SearchInputEvents {
  onResultSelect?: (result: SearchResult) => void;
  onEscape?: () => void;
  onResultsChange?: (results: SearchResult[]) => void;
}

export interface SearchInputOptions {
  id: string;
  placeholder?: string;
  showQuickSelect?: boolean;
  maxResults?: number;
}

/**
 * Reusable search input component with results list.
 * Used by both LandingView and SearchModal.
 */
export class SearchInput {
  private renderer: CliRenderer;
  private config: Config;
  private keys: KeyBindingManager;
  private client: ConfluenceClient;
  private events: SearchInputEvents;
  private options: Required<SearchInputOptions>;

  // UI Elements
  public inputContainer: BoxRenderable;
  private inputBox: BoxRenderable;
  private inputText: TextRenderable;
  public resultsBox: BoxRenderable;
  private resultRenderables: (BoxRenderable | TextRenderable)[] = [];

  // State
  private inputBuffer: string = "";
  private results: SearchResult[] = [];
  private selectedIndex: number = 0;
  private isLoading: boolean = false;
  private searchTimeout: ReturnType<typeof setTimeout> | null = null;
  private _isFocused: boolean = false;

  constructor(events: SearchInputEvents = {}, options: SearchInputOptions) {
    this.renderer = container.resolve<CliRenderer>(TOKENS.Renderer);
    this.config = container.resolve<Config>(TOKENS.Config);
    this.keys = container.resolve<KeyBindingManager>(TOKENS.KeyBindings);
    this.client = container.resolve<ConfluenceClient>(TOKENS.Client);
    this.events = events;

    this.options = {
      id: options.id,
      placeholder: options.placeholder ?? "Type to search...",
      showQuickSelect: options.showQuickSelect ?? true,
      maxResults: options.maxResults ?? 10,
    };

    const { theme } = this.config;

    // Container for the entire search input (input + results)
    this.inputContainer = new BoxRenderable(this.renderer, {
      id: `${this.options.id}-container`,
      width: "100%",
      flexDirection: "column",
    });

    // Input box with border
    this.inputBox = new BoxRenderable(this.renderer, {
      id: `${this.options.id}-input-box`,
      width: "100%",
      height: 3,
      borderStyle: "single",
      borderColor: theme.border,
      border: true,
      paddingLeft: 1,
    });
    this.inputContainer.add(this.inputBox);

    // Input text
    this.inputText = new TextRenderable(this.renderer, {
      id: `${this.options.id}-input-text`,
      content: t`${fg(theme.border)(this.options.placeholder)}`,
    });
    this.inputBox.add(this.inputText);

    // Results box
    this.resultsBox = new BoxRenderable(this.renderer, {
      id: `${this.options.id}-results`,
      width: "100%",
      flexDirection: "column",
      marginTop: 1,
    });
    this.inputContainer.add(this.resultsBox);
  }

  /**
   * Focus the search input
   */
  focus(): void {
    this._isFocused = true;
    this.inputBuffer = "";
    this.results = [];
    this.selectedIndex = 0;

    const { theme } = this.config;
    this.inputBox.borderColor = theme.primary;
    this.resultsBox.visible = true;

    this.renderInput();
    this.renderResults();
  }

  /**
   * Blur/unfocus the search input
   */
  blur(): void {
    this._isFocused = false;
    this.inputBuffer = "";
    this.results = [];

    const { theme } = this.config;
    this.inputBox.borderColor = theme.border;
    this.resultsBox.visible = false;

    this.inputText.content = t`${fg(theme.border)(this.options.placeholder)}`;

    // Clear any pending search
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = null;
    }
  }

  /**
   * Get current results
   */
  getResults(): SearchResult[] {
    return this.results;
  }

  /**
   * Handle keypress events for the search input
   * Returns true if the key was handled
   */
  handleKeypress(key: KeyEvent): boolean {
    logger.debug("SearchInput.handleKeypress", {
      keyName: key.name,
      keySuper: key.super,
      keyMeta: key.meta,
      resultsCount: this.results.length,
      showQuickSelect: this.options.showQuickSelect,
    });

    // Backspace - remove last character (must be before 'back' check)
    if (key.name === "backspace") {
      if (this.inputBuffer.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        this.renderInput();
        this.triggerSearch();
      }
      return true;
    }

    // Escape to unfocus
    if (key.name === "escape") {
      this.events.onEscape?.();
      return true;
    }

    // Navigate results
    if (this.keys.matches("up", key)) {
      this.selectPrevious();
      return true;
    }

    if (this.keys.matches("down", key)) {
      this.selectNext();
      return true;
    }

    // Select result
    if (this.keys.matches("select", key)) {
      this.selectCurrent();
      return true;
    }

    // Quick select with cmd+1-5
    if (this.options.showQuickSelect) {
      // Log for debugging
      if (key.super || key.meta) {
        logger.debug("Quick select check", {
          keyName: key.name,
          keySuper: key.super,
          keyMeta: key.meta,
          resultsCount: this.results.length,
        });
      }
      
      const qs1 = this.keys.matches("quickSelect1", key);
      const qs2 = this.keys.matches("quickSelect2", key);
      const qs3 = this.keys.matches("quickSelect3", key);
      const qs4 = this.keys.matches("quickSelect4", key);
      const qs5 = this.keys.matches("quickSelect5", key);
      
      logger.debug("Quick select matches", { qs1, qs2, qs3, qs4, qs5 });
      
      if (qs1) {
        logger.debug("Selecting index 0");
        this.selectByIndex(0);
        return true;
      }
      if (qs2) {
        logger.debug("Selecting index 1");
        this.selectByIndex(1);
        return true;
      }
      if (qs3) {
        logger.debug("Selecting index 2");
        this.selectByIndex(2);
        return true;
      }
      if (qs4) {
        logger.debug("Selecting index 3");
        this.selectByIndex(3);
        return true;
      }
      if (qs5) {
        logger.debug("Selecting index 4");
        this.selectByIndex(4);
        return true;
      }
    }

    // Add printable characters to buffer (but not when cmd/super is pressed)
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta && !key.super) {
      this.inputBuffer += key.sequence;
      this.renderInput();
      this.triggerSearch();
      return true;
    }

    return true; // Consume all keys when focused
  }

  private triggerSearch(): void {
    // Debounce search
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }

    if (this.inputBuffer.length < 2) {
      this.results = [];
      this.renderResults();
      this.events.onResultsChange?.(this.results);
      return;
    }

    this.isLoading = true;
    this.renderResults();

    this.searchTimeout = setTimeout(async () => {
      try {
        this.results = await this.client.search(this.inputBuffer, this.options.maxResults);
        this.selectedIndex = 0;
        this.isLoading = false;
        this.renderResults();
        this.events.onResultsChange?.(this.results);
      } catch (error) {
        logger.error("Search failed", { error });
        this.isLoading = false;
        this.renderResults();
      }
    }, 300);
  }

  private renderInput(): void {
    const { theme } = this.config;
    const cursor = "█";
    const displayText = this.inputBuffer || "";

    if (displayText) {
      this.inputText.content = t`${fg(theme.text)(displayText)}${fg(theme.primary)(cursor)}`;
    } else {
      this.inputText.content = t`${fg(theme.border)(this.options.placeholder)}${fg(theme.primary)(cursor)}`;
    }
  }

  private renderResults(): void {
    const { theme } = this.config;

    // Clear existing result renderables
    for (const r of this.resultRenderables) {
      this.resultsBox.remove(r.id);
      r.destroy();
    }
    this.resultRenderables = [];

    if (this.isLoading) {
      const loadingText = new TextRenderable(this.renderer, {
        id: `${this.options.id}-loading`,
        content: t`${fg(theme.border)("  Searching...")}`,
      });
      this.resultsBox.add(loadingText);
      this.resultRenderables.push(loadingText);
      return;
    }

    if (this.inputBuffer.length >= 2 && this.results.length === 0) {
      const noResultsText = new TextRenderable(this.renderer, {
        id: `${this.options.id}-no-results`,
        content: t`${fg(theme.border)("  No results found")}`,
      });
      this.resultsBox.add(noResultsText);
      this.resultRenderables.push(noResultsText);
      return;
    }

    // Render results with new pretty layout
    const displayResults = this.results.slice(0, this.options.maxResults);

    for (let i = 0; i < displayResults.length; i++) {
      const result = displayResults[i]!;
      const isSelected = i === this.selectedIndex;
      const hasQuickSelect = this.options.showQuickSelect && i < 5;

      // Format the date
      const dateStr = this.formatDate(result.lastModified);

      // Truncate title if needed (leave room for date)
      const maxTitleLen = 50;
      const title = result.title.length > maxTitleLen
        ? result.title.slice(0, maxTitleLen - 3) + "..."
        : result.title;

      // Create row container
      const rowBox = new BoxRenderable(this.renderer, {
        id: `${this.options.id}-result-${i}`,
        width: "100%",
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: isSelected ? theme.highlight : undefined,
      });

      // Quick select badge (prominent)
      if (hasQuickSelect) {
        const badgeText = new TextRenderable(this.renderer, {
          id: `${this.options.id}-result-${i}-badge`,
          content: isSelected
            ? t`${fg("#000000")(bg(theme.primary)(` ^${i + 1} `))}`
            : t`${fg(theme.text)(bg(theme.secondary)(` ^${i + 1} `))}`,
        });
        rowBox.add(badgeText);
      } else {
        // Spacer for alignment
        const spacer = new TextRenderable(this.renderer, {
          id: `${this.options.id}-result-${i}-spacer`,
          content: t`     `,
        });
        rowBox.add(spacer);
      }

      // Content column (title + space)
      const contentBox = new BoxRenderable(this.renderer, {
        id: `${this.options.id}-result-${i}-content`,
        flexDirection: "column",
        flexGrow: 1,
        marginLeft: 1,
      });

      // Title row
      const titleText = new TextRenderable(this.renderer, {
        id: `${this.options.id}-result-${i}-title`,
        content: isSelected
          ? t`${fg("#ffffff")(title)}`
          : t`${fg(theme.text)(title)}`,
      });
      contentBox.add(titleText);

      // Space name row (dimmed, smaller)
      const spaceText = new TextRenderable(this.renderer, {
        id: `${this.options.id}-result-${i}-space`,
        content: isSelected
          ? t`${fg("#cccccc")(`in ${result.spaceName}`)}`
          : t`${fg(theme.border)(`in ${result.spaceName}`)}`,
      });
      contentBox.add(spaceText);

      rowBox.add(contentBox);

      // Date column (right aligned)
      if (dateStr) {
        const dateText = new TextRenderable(this.renderer, {
          id: `${this.options.id}-result-${i}-date`,
          content: isSelected
            ? t`${fg("#cccccc")(dateStr)}`
            : t`${fg(theme.border)(dateStr)}`,
        });
        rowBox.add(dateText);
      }

      this.resultsBox.add(rowBox);
      this.resultRenderables.push(rowBox);
    }
  }

  /**
   * Format a date string for display
   */
  private formatDate(dateStr?: string): string {
    if (!dateStr) return "";

    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        return "today";
      } else if (diffDays === 1) {
        return "yesterday";
      } else if (diffDays < 7) {
        return `${diffDays}d ago`;
      } else {
        // Show real date for anything older than a week
        const day = date.getDate();
        const month = date.toLocaleString("en-US", { month: "short" });
        const year = date.getFullYear();
        const currentYear = now.getFullYear();

        if (year === currentYear) {
          return `${month} ${day}`;
        } else {
          return `${month} ${day}, ${year}`;
        }
      }
    } catch {
      return "";
    }
  }

  private selectNext(): void {
    if (this.results.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % Math.min(this.results.length, this.options.maxResults);
    this.renderResults();
  }

  private selectPrevious(): void {
    if (this.results.length === 0) return;
    this.selectedIndex = this.selectedIndex === 0
      ? Math.min(this.results.length, this.options.maxResults) - 1
      : this.selectedIndex - 1;
    this.renderResults();
  }

  private selectByIndex(index: number): void {
    logger.debug("selectByIndex called", { 
      index, 
      resultsLength: this.results.length,
      hasResult: index < this.results.length,
    });
    if (index < this.results.length) {
      this.selectedIndex = index;
      this.selectCurrent();
    }
  }

  private selectCurrent(): void {
    const result = this.results[this.selectedIndex];
    if (result) {
      this.events.onResultSelect?.(result);
    }
  }

  /**
   * Reset the search input state
   */
  reset(): void {
    this.inputBuffer = "";
    this.results = [];
    this.selectedIndex = 0;
    this.isLoading = false;

    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
      this.searchTimeout = null;
    }

    const { theme } = this.config;
    this.inputBox.borderColor = theme.border;
    this.inputText.content = t`${fg(theme.border)(this.options.placeholder)}`;
    this.renderResults();
  }

  destroy(): void {
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }
    this.inputContainer.destroy();
  }
}
