import {BoxRenderable, type CliRenderer, fg, type KeyEvent, t, TextRenderable,} from "@opentui/core";
import type {Config, SearchResult} from "../types";
import {container, TOKENS} from "../di/container";
import {logger} from "../logger";
import {SearchInput} from "./SearchInput";

export interface SearchModalEvents {
  onClose?: () => void;
  onPageSelect?: (result: SearchResult) => void;
  onShowSpaces?: () => void;
}

export class SearchModal {
  private renderer: CliRenderer;
  private config: Config;
  private events: SearchModalEvents;

  // UI Elements
  public container: BoxRenderable;
  private backdrop: BoxRenderable;
  private modal: BoxRenderable;
  private titleText: TextRenderable;
  private searchInput: SearchInput;
  private menuBox: BoxRenderable;

  // State
  private isVisible: boolean = false;

  constructor(events: SearchModalEvents = {}) {
    this.renderer = container.resolve<CliRenderer>(TOKENS.Renderer);
    this.config = container.resolve<Config>(TOKENS.Config);
    this.events = events;

    const { theme } = this.config;

    // Main container (covers entire screen)
    this.container = new BoxRenderable(this.renderer, {
      id: "search-modal-container",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      visible: false,
      zIndex: 1000,
    });

    // Semi-transparent backdrop
    this.backdrop = new BoxRenderable(this.renderer, {
      id: "search-modal-backdrop",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: "#00000080",
    });
    this.container.add(this.backdrop);

    // Modal box (centered)
    this.modal = new BoxRenderable(this.renderer, {
      id: "search-modal",
      position: "absolute",
      top: 5,
      left: "25%",
      width: "50%",
      minWidth: 60,
      maxHeight: 20,
      flexDirection: "column",
      backgroundColor: theme.background,
      borderStyle: "single",
      borderColor: theme.primary,
      border: true,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 1,
      paddingBottom: 1,
    });
    this.container.add(this.modal);

    // Title
    this.titleText = new TextRenderable(this.renderer, {
      id: "search-modal-title",
      content: t`${fg(theme.primary)("Search Confluence")}`,
      marginBottom: 1,
    });
    this.modal.add(this.titleText);

    // Create SearchInput component
    this.searchInput = new SearchInput(
      {
        onResultSelect: (result) => {
          this.hide();
          this.events.onPageSelect?.(result);
        },
        onEscape: () => {
          this.hide();
        },
      },
      {
        id: "search-modal",
        placeholder: "Type to search...",
        showQuickSelect: true,
        maxResults: 10,
      }
    );
    this.modal.add(this.searchInput.inputContainer);
  }

  /**
   * Show the search modal
   */
  show(): void {
    this.isVisible = true;
    this.container.visible = true;
    this.searchInput.focus();
    logger.debug("SearchModal shown");
  }

  /**
   * Hide the search modal
   */
  hide(): void {
    this.isVisible = false;
    this.container.visible = false;
    this.searchInput.reset();
    this.events.onClose?.();
    logger.debug("SearchModal hidden");
  }

  /**
   * Check if modal is currently visible
   */
  isOpen(): boolean {
    return this.isVisible;
  }

  /**
   * Handle keypress events
   */
  handleKeypress(key: KeyEvent): boolean {
    if (!this.isVisible) return false;

    // Delegate to SearchInput
    return this.searchInput.handleKeypress(key);
  }

  destroy(): void {
    this.searchInput.destroy();
    this.container.destroy();
  }
}
