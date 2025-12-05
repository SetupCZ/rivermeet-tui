import {
  bg,
  BoxRenderable,
  type CliRenderer,
  fg,
  type KeyEvent,
  ScrollBoxRenderable,
  t,
  TextRenderable,
} from "@opentui/core";
import * as fs from "fs";
import type {ADFDocument, ADFNode, Config, ReadViewNode, TreeNode} from "../types";
import {matchesKey} from "../config";
import {container, TOKENS} from "../di/container";
import {createComponentRegistry, createRenderContext,} from "../markdown-components";
import {parseMarkdownToADF} from "../markdown-parser";
import {logger} from "../logger";
import type {HelpEntry, NavigableComponent, NavigationHelp} from "./NavigationHelp";
import {ConfluenceClient} from "../confluence-client";
import {PageCache} from "../cache";
import {spawnSync} from "child_process";
import {DEBUG_MODE} from "../constants.ts";

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

type VisualMode = "none" | "char" | "line";

interface CursorPosition {
  line: number;
  col: number;
}

interface SearchMatch {
  line: number;
  startCol: number;
  endCol: number;
}

interface SearchState {
  pattern: string;
  matches: SearchMatch[];
  currentMatchIndex: number;
  isSearching: boolean;
  inputBuffer: string;
}

interface PendingChangesState {
  hasPendingChanges: boolean;
  originalMarkdown: string;
  editedMarkdown: string;
  confirmingPublish: boolean;
}

export class PageView implements NavigableComponent {
  private renderer: CliRenderer;
  private config: Config;
  private client: ConfluenceClient;
  private cache: PageCache;
  private events: PageViewEvents;
  private navigationHelp: NavigationHelp

  // UI Elements
  public container: BoxRenderable;
  public scroll: ScrollBoxRenderable;
  public content: BoxRenderable;

  // State
  private currentPage: PageData | null = null;
  private readViewLines: { content: string; sourceNode?: ADFNode; style?: ReadViewNode["style"] }[] = [];
  private lineRenderables: BoxRenderable[] = [];
  private lineContentRenderables: TextRenderable[] = [];

  // Cursor state
  private cursorLine: number = 0;
  private cursorCol: number = 0;

  // Visual mode state
  private visualMode: VisualMode = "none";
  private selectionAnchor: CursorPosition = {line: 0, col: 0};

  // Search state
  private search: SearchState = {
    pattern: "",
    matches: [],
    currentMatchIndex: -1,
    isSearching: false,
    inputBuffer: "",
  };

  // Pending changes state
  private pendingChanges: PendingChangesState = {
    hasPendingChanges: false,
    originalMarkdown: "",
    editedMarkdown: "",
    confirmingPublish: false,
  };

  constructor(events: PageViewEvents = {}) {
    this.renderer = container.resolve<CliRenderer>(TOKENS.Renderer);
    this.config = container.resolve<Config>(TOKENS.Config);
    this.client = container.resolve<ConfluenceClient>(TOKENS.Client);
    this.cache = container.resolve<PageCache>(TOKENS.Cache);
    this.navigationHelp = container.resolve<NavigationHelp>(TOKENS.NavigationHelp);
    this.events = events;

    const {theme} = this.config;

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

    this.navigationHelp.registerComponent("page", this);
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
   * Returns true when in search mode or confirming publish to prevent global handlers from intercepting keys
   */
  wantsExclusiveInput(): boolean {
    return this.search.isSearching || this.pendingChanges.confirmingPublish;
  }

  /**
   * Activate this component as the current view
   */
  activate(): void {
    this.navigationHelp.setActiveComponent(this);
    this.show();
  }

  /**
   * Handle keypress events for page view
   */
  handleKeypress(key: KeyEvent): boolean {
    this.handleKeypressInternal(key)

    // Don't overwrite status when in search mode
    if (!this.search.isSearching) {
      this.updateStatusLine();
    }

    return true
  }

  handleKeypressInternal(key: KeyEvent): boolean {
    const {keyBindings} = this.config;

    logger.debug("handleKeypressInternal", {
      keyName: key.name,
      keySequence: key.sequence,
      isSearching: this.search.isSearching,
      confirmingPublish: this.pendingChanges.confirmingPublish
    });

    // Handle search input mode
    if (this.search.isSearching) {
      return this.handleSearchInput(key);
    }

    // Handle publish confirmation mode
    if (this.pendingChanges.confirmingPublish) {
      return this.handlePublishConfirmation(key);
    }

    // Escape - cancel selection, clear search, discard pending changes, or go back
    if (matchesKey(key, keyBindings.back)) {
      if (this.visualMode !== "none") {
        this.cancelSelection();
        return true;
      }
      if (this.search.pattern) {
        this.clearSearch();
        return true;
      }
      if (this.pendingChanges.hasPendingChanges) {
        this.discardChanges();
        return true;
      }
      this.events.onBack?.();
      return true;
    }

    // Publish changes with 'p' - now starts confirmation
    if (key.name === "p" && !key.ctrl && !key.shift) {
      if (this.pendingChanges.hasPendingChanges) {
        this.startPublishConfirmation();
        return true;
      }
    }

    // Start search with /
    if (key.sequence === "/" || key.name === "/") {
      this.startSearch();
      return true;
    }

    // Next search match with n
    if (key.name === "n" && !key.shift && !key.ctrl) {
      this.jumpToNextMatch();
      return true;
    }

    // Previous search match with N
    if (key.name === "n" && key.shift) {
      this.jumpToPreviousMatch();
      return true;
    }

    // Yank (copy) selection or current line
    if (key.name === "y") {
      if (this.visualMode !== "none") {
        this.yankSelection();
      } else {
        this.yankCurrentLine();
      }
      return true;
    }

    // Visual mode (character)
    if (key.name === "v" && !key.shift) {
      if (this.visualMode === "char") {
        this.cancelSelection();
      } else {
        this.startVisualMode("char");
      }
      return true;
    }

    // Visual line mode
    if (key.name === "v" && key.shift) {
      if (this.visualMode === "line") {
        this.cancelSelection();
      } else {
        this.startVisualMode("line");
      }
      return true;
    }

    // Edit mode
    if (matchesKey(key, keyBindings.edit)) {
      this.openEditor();
      return true;
    }

    // Movement: h (left)
    if (key.name === "h" && !key.ctrl) {
      this.moveCursor(0, -1);
      return true;
    }

    // Movement: l (right)
    if (key.name === "l" && !key.ctrl) {
      this.moveCursor(0, 1);
      return true;
    }

    // Movement: k (up)
    if (matchesKey(key, keyBindings.up)) {
      this.moveCursor(-1, 0);
      return true;
    }

    // Movement: j (down)
    if (matchesKey(key, keyBindings.down)) {
      this.moveCursor(1, 0);
      return true;
    }

    // Half page up/down with ctrl+u/d
    if (key.ctrl && key.name === "u") {
      const halfPage = Math.floor(this.renderer.terminalHeight / 2);
      this.moveCursor(-halfPage, 0);
      return true;
    }

    if (key.ctrl && key.name === "d") {
      const halfPage = Math.floor(this.renderer.terminalHeight / 2);
      this.moveCursor(halfPage, 0);
      return true;
    }

    // Go to start of line with 0
    if (key.name === "0") {
      this.cursorCol = 0;
      this.updateDisplay();
      return true;
    }

    // Go to end of line with $
    if (key.shift && key.name === "4") { // $ is shift+4
      const lineContent = this.readViewLines[this.cursorLine]?.content || "";
      this.cursorCol = Math.max(0, lineContent.length - 1);
      this.updateDisplay();
      return true;
    }

    // Go to top with gg
    if (key.name === "g" && !key.shift) {
      this.cursorLine = 0;
      this.cursorCol = 0;
      this.updateDisplay();
      return true;
    }

    // Go to bottom with G
    if (key.shift && key.name === "g") {
      this.cursorLine = Math.max(0, this.readViewLines.length - 1);
      this.cursorCol = 0;
      this.updateDisplay();
      return true;
    }

    // Word forward with w
    if (key.name === "w" && !key.ctrl) {
      this.moveWordForward();
      return true;
    }

    // Word backward with b
    if (key.name === "b" && !key.ctrl) {
      this.moveWordBackward();
      return true;
    }

    return false;
  }

  /**
   * Get help entries for this component
   */
  getHelpEntries(): HelpEntry[] {
    if (this.search.isSearching) {
      return [
        {key: "Enter", description: "search"},
        {key: "Esc", description: "cancel"},
      ];
    }
    if (this.pendingChanges.confirmingPublish) {
      return [
        {key: "y", description: "confirm"},
        {key: "n", description: "cancel"},
      ];
    }
    if (this.visualMode !== "none") {
      return [
        {key: "hjkl", description: "move"},
        {key: "y", description: "yank"},
        {key: "Esc", description: "cancel"},
      ];
    }
    if (this.pendingChanges.hasPendingChanges) {
      return [
        {key: "p", description: "publish"},
        {key: "Esc", description: "discard"},
        {key: "i", description: "edit"},
      ];
    }
    if (this.search.matches.length > 0) {
      return [
        {key: "n/N", description: "next/prev"},
        {key: "Esc", description: "back"},
      ];
    }
    return [
      {key: "hjkl", description: "move"},
      {key: "/", description: "search"},
      {key: "v/V", description: "visual"},
      {key: "i", description: "edit"},
      {key: "Esc", description: "back"},
    ];
  }

  // --- Cursor Movement ---

  private moveCursor(deltaLine: number, deltaCol: number): void {
    const newLine = Math.max(0, Math.min(this.readViewLines.length - 1, this.cursorLine + deltaLine));
    const lineContent = this.readViewLines[newLine]?.content || "";
    const maxCol = Math.max(0, lineContent.length - 1);

    let newCol = this.cursorCol + deltaCol;

    // Handle line wrapping when moving left/right
    if (deltaCol !== 0 && deltaLine === 0) {
      if (newCol < 0 && newLine > 0) {
        // Wrap to end of previous line
        this.cursorLine = newLine - 1;
        const prevLineContent = this.readViewLines[this.cursorLine]?.content || "";
        this.cursorCol = Math.max(0, prevLineContent.length - 1);
        this.updateDisplay();
        return;
      } else if (newCol > maxCol && newLine < this.readViewLines.length - 1) {
        // Wrap to start of next line
        this.cursorLine = newLine + 1;
        this.cursorCol = 0;
        this.updateDisplay();
        return;
      }
    }

    this.cursorLine = newLine;
    this.cursorCol = Math.max(0, Math.min(maxCol, newCol));

    // Clamp column to new line length when moving vertically
    if (deltaLine !== 0) {
      const currentLineContent = this.readViewLines[this.cursorLine]?.content || "";
      this.cursorCol = Math.min(this.cursorCol, Math.max(0, currentLineContent.length - 1));
    }

    this.updateDisplay();
  }

  private moveWordForward(): void {
    const lineContent = this.readViewLines[this.cursorLine]?.content || "";
    let col = this.cursorCol;

    // Skip current word
    while (col < lineContent.length && !/\s/.test(lineContent[col] || "")) {
      col++;
    }
    // Skip whitespace
    while (col < lineContent.length && /\s/.test(lineContent[col] || "")) {
      col++;
    }

    if (col >= lineContent.length && this.cursorLine < this.readViewLines.length - 1) {
      // Move to next line
      this.cursorLine++;
      this.cursorCol = 0;
    } else {
      this.cursorCol = Math.min(col, Math.max(0, lineContent.length - 1));
    }

    this.updateDisplay();
  }

  private moveWordBackward(): void {
    const lineContent = this.readViewLines[this.cursorLine]?.content || "";
    let col = this.cursorCol;

    // Move back one if at start of word
    if (col > 0) col--;

    // Skip whitespace
    while (col > 0 && /\s/.test(lineContent[col] || "")) {
      col--;
    }
    // Skip to start of word
    while (col > 0 && !/\s/.test(lineContent[col - 1] || "")) {
      col--;
    }

    if (col <= 0 && this.cursorCol === 0 && this.cursorLine > 0) {
      // Move to end of previous line
      this.cursorLine--;
      const prevLineContent = this.readViewLines[this.cursorLine]?.content || "";
      this.cursorCol = Math.max(0, prevLineContent.length - 1);
    } else {
      this.cursorCol = col;
    }

    this.updateDisplay();
  }

  // --- Visual Mode ---

  private startVisualMode(mode: VisualMode): void {
    this.visualMode = mode;
    this.selectionAnchor = {line: this.cursorLine, col: this.cursorCol};
    this.updateDisplay();
  }

  private cancelSelection(): void {
    this.visualMode = "none";
    this.updateDisplay();
  }

  private yankSelection(): void {
    const selectedText = this.getSelectedText();
    if (selectedText) {
      // Copy to clipboard using pbcopy on macOS or xclip on Linux
      try {
        const clipboardCmd = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard";
        const result = spawnSync("sh", ["-c", `echo -n "${selectedText.replace(/"/g, '\\"')}" | ${clipboardCmd}`], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (result.status === 0) {
          this.updateStatus(`Yanked ${this.visualMode === "line" ? "lines" : "selection"}`);
        } else {
          this.updateStatus("Failed to copy to clipboard");
        }
      } catch (error) {
        this.updateStatus(`Clipboard error: ${error}`);
      }
    }
    this.cancelSelection();
  }

  private yankCurrentLine(): void {
    const lineContent = this.readViewLines[this.cursorLine]?.content || "";
    if (lineContent) {
      try {
        const clipboardCmd = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard";
        const result = spawnSync("sh", ["-c", `echo -n "${lineContent.replace(/"/g, '\\"')}" | ${clipboardCmd}`], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (result.status === 0) {
          this.updateStatus("Yanked line");
        } else {
          this.updateStatus("Failed to copy to clipboard");
        }
      } catch (error) {
        this.updateStatus(`Clipboard error: ${error}`);
      }
    }
  }

  private getSelectedText(): string {
    if (this.visualMode === "none") return "";

    const start = this.getSelectionStart();
    const end = this.getSelectionEnd();

    if (this.visualMode === "line") {
      // Select entire lines
      const lines: string[] = [];
      for (let i = start.line; i <= end.line; i++) {
        lines.push(this.readViewLines[i]?.content || "");
      }
      return lines.join("\n");
    } else {
      // Character selection
      if (start.line === end.line) {
        const lineContent = this.readViewLines[start.line]?.content || "";
        return lineContent.slice(start.col, end.col + 1);
      } else {
        const lines: string[] = [];
        // First line from start col to end
        lines.push((this.readViewLines[start.line]?.content || "").slice(start.col));
        // Middle lines (full)
        for (let i = start.line + 1; i < end.line; i++) {
          lines.push(this.readViewLines[i]?.content || "");
        }
        // Last line from start to end col
        lines.push((this.readViewLines[end.line]?.content || "").slice(0, end.col + 1));
        return lines.join("\n");
      }
    }
  }

  private getSelectionStart(): CursorPosition {
    if (this.visualMode === "line") {
      return {
        line: Math.min(this.selectionAnchor.line, this.cursorLine),
        col: 0,
      };
    }
    // Character mode - compare positions
    if (this.selectionAnchor.line < this.cursorLine ||
      (this.selectionAnchor.line === this.cursorLine && this.selectionAnchor.col <= this.cursorCol)) {
      return this.selectionAnchor;
    }
    return {line: this.cursorLine, col: this.cursorCol};
  }

  private getSelectionEnd(): CursorPosition {
    if (this.visualMode === "line") {
      const endLine = Math.max(this.selectionAnchor.line, this.cursorLine);
      return {
        line: endLine,
        col: (this.readViewLines[endLine]?.content || "").length - 1,
      };
    }
    // Character mode - compare positions
    if (this.selectionAnchor.line > this.cursorLine ||
      (this.selectionAnchor.line === this.cursorLine && this.selectionAnchor.col > this.cursorCol)) {
      return this.selectionAnchor;
    }
    return {line: this.cursorLine, col: this.cursorCol};
  }

  private isPositionSelected(line: number, col: number): boolean {
    if (this.visualMode === "none") return false;

    const start = this.getSelectionStart();
    const end = this.getSelectionEnd();

    if (this.visualMode === "line") {
      return line >= start.line && line <= end.line;
    }

    // Character mode
    if (line < start.line || line > end.line) return false;
    if (line === start.line && line === end.line) {
      return col >= start.col && col <= end.col;
    }
    if (line === start.line) return col >= start.col;
    if (line === end.line) return col <= end.col;
    return true;
  }

  // --- Search ---

  private startSearch(): void {
    this.search.isSearching = true;
    this.search.inputBuffer = "";
    logger.debug("startSearch called", { isSearching: this.search.isSearching });
    this.updateStatus("/");
  }

  private handleSearchInput(key: KeyEvent): boolean {
    logger.debug("handleSearchInput", {
      keyName: key.name,
      keySequence: key.sequence,
      buffer: this.search.inputBuffer
    });

    // Enter - execute search
    if (key.name === "return") {
      this.executeSearch();
      return true;
    }

    // Escape - cancel search
    if (key.name === "escape") {
      this.cancelSearch();
      return true;
    }

    // Backspace - remove last character
    if (key.name === "backspace") {
      this.search.inputBuffer = this.search.inputBuffer.slice(0, -1);
      this.updateStatus(`/${this.search.inputBuffer}`);
      return true;
    }

    // Add printable characters to buffer
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      this.search.inputBuffer += key.sequence;
      logger.debug("Added char to buffer", { buffer: this.search.inputBuffer });
      this.updateStatus(`/${this.search.inputBuffer}`);
      return true;
    }

    return true;
  }

  private executeSearch(): void {
    this.search.isSearching = false;
    const pattern = this.search.inputBuffer.trim();

    if (!pattern) {
      this.clearSearch();
      return;
    }

    this.search.pattern = pattern;
    this.findAllMatches();

    if (this.search.matches.length > 0) {
      // Jump to first match at or after cursor
      this.jumpToNextMatch();
    } else {
      this.updateStatus(`Pattern not found: ${pattern}`);
    }
  }

  private cancelSearch(): void {
    this.search.isSearching = false;
    this.search.inputBuffer = "";
    this.updateStatusLine();
  }

  private clearSearch(): void {
    this.search.pattern = "";
    this.search.matches = [];
    this.search.currentMatchIndex = -1;
    this.updateDisplay();
  }

  private findAllMatches(): void {
    this.search.matches = [];
    const pattern = this.search.pattern.toLowerCase();

    for (let lineIdx = 0; lineIdx < this.readViewLines.length; lineIdx++) {
      const lineContent = (this.readViewLines[lineIdx]?.content || "").toLowerCase();
      let startIdx = 0;

      while (true) {
        const matchIdx = lineContent.indexOf(pattern, startIdx);
        if (matchIdx === -1) break;

        this.search.matches.push({
          line: lineIdx,
          startCol: matchIdx,
          endCol: matchIdx + pattern.length - 1,
        });

        startIdx = matchIdx + 1;
      }
    }
  }

  private jumpToNextMatch(): void {
    if (this.search.matches.length === 0) {
      this.updateStatus(`Pattern not found: ${this.search.pattern}`);
      return;
    }

    // Find first match at or after cursor position
    let nextIdx = this.search.matches.findIndex(
      (m) => m.line > this.cursorLine ||
        (m.line === this.cursorLine && m.startCol > this.cursorCol)
    );

    // Wrap around if no match found after cursor
    if (nextIdx === -1) {
      nextIdx = 0;
    }

    this.search.currentMatchIndex = nextIdx;
    const match = this.search.matches[nextIdx];
    if (match) {
      this.cursorLine = match.line;
      this.cursorCol = match.startCol;
      this.updateDisplay();
      this.updateStatus(`/${this.search.pattern} [${nextIdx + 1}/${this.search.matches.length}]`);
    }
  }

  private jumpToPreviousMatch(): void {
    if (this.search.matches.length === 0) {
      this.updateStatus(`Pattern not found: ${this.search.pattern}`);
      return;
    }

    // Find last match before cursor position
    let prevIdx = -1;
    for (let i = this.search.matches.length - 1; i >= 0; i--) {
      const m = this.search.matches[i];
      if (m && (m.line < this.cursorLine ||
        (m.line === this.cursorLine && m.startCol < this.cursorCol))) {
        prevIdx = i;
        break;
      }
    }

    // Wrap around if no match found before cursor
    if (prevIdx === -1) {
      prevIdx = this.search.matches.length - 1;
    }

    this.search.currentMatchIndex = prevIdx;
    const match = this.search.matches[prevIdx];
    if (match) {
      this.cursorLine = match.line;
      this.cursorCol = match.startCol;
      this.updateDisplay();
      this.updateStatus(`?${this.search.pattern} [${prevIdx + 1}/${this.search.matches.length}]`);
    }
  }

  private isCurrentSearchMatch(line: number, col: number): boolean {
    if (this.search.currentMatchIndex < 0) return false;
    const match = this.search.matches[this.search.currentMatchIndex];
    return match !== undefined && match.line === line && col >= match.startCol && col <= match.endCol;
  }

  private getLineSearchMatches(lineIdx: number): SearchMatch[] {
    return this.search.matches.filter((m) => m.line === lineIdx);
  }

  // --- Publish/Discard ---

  /**
   * Start publish confirmation - ask user for y/n
   */
  private startPublishConfirmation(): void {
    this.pendingChanges.confirmingPublish = true;
    this.updateStatus("Publish changes? (y/n)");
  }

  /**
   * Handle y/n input during publish confirmation
   */
  private handlePublishConfirmation(key: KeyEvent): boolean {
    // 'y' or 'Y' - confirm publish
    if (key.name === "y") {
      this.pendingChanges.confirmingPublish = false;
      this.publishChanges();
      return true;
    }

    // 'n' or 'N' or Escape - cancel confirmation
    if (key.name === "n" || key.name === "escape") {
      this.pendingChanges.confirmingPublish = false;
      this.updateStatus("[MODIFIED] Press 'p' to publish, 'Esc' to discard");
      return true;
    }

    // Ignore other keys during confirmation
    return true;
  }

  /**
   * Publish pending changes to Confluence
   */
  private async publishChanges(): Promise<void> {
    if (!this.currentPage || !this.pendingChanges.hasPendingChanges) return;

    const { pageId, title, spaceKey } = this.currentPage;
    const { editedMarkdown } = this.pendingChanges;

    logger.debug("Publishing changes", { pageId, title, spaceKey });
    this.updateStatus("Publishing changes...");

    try {
      // Fetch the current version from Confluence (it may have changed since we cached)
      const metadata = await this.client.getPageMetadata(pageId);
      const currentVersion = metadata.currentVersion;

      logger.debug("Fetched current version", { pageId, currentVersion });

      // Parse markdown to ADF and publish using atlas_doc_format
      const adf = parseMarkdownToADF(editedMarkdown);
      const adfString = JSON.stringify(adf);

      logger.debug("Calling updatePage", { 
        pageId, 
        title, 
        currentVersion,
        spaceKey,
        adfLength: adfString.length,
        adfPreview: adfString.substring(0, 200)
      });

      await this.client.updatePage(
        pageId,
        title,
        adfString,
        currentVersion,
        "atlas_doc_format",
        spaceKey
      );

      // Clear pending changes
      this.pendingChanges = {
        hasPendingChanges: false,
        originalMarkdown: "",
        editedMarkdown: "",
        confirmingPublish: false,
      };

      // Clear cache to force reload with new version
      this.cache.clearPageCache(spaceKey, pageId);

      // Reload the page to get the new version
      await this.loadPage({
        pageId,
        spaceKey,
        label: title,
      });

      // Update status after reload to show regular controls
      this.updateStatus(`Published successfully! Viewing: ${title}`);
      
      // Refresh navigation help to show regular controls
      this.navigationHelp.refreshLocalHelp();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateStatus(`Publish failed: ${errorMsg}`);
      // Reset confirmingPublish on error so user can try again
      this.pendingChanges.confirmingPublish = false;
      // Refresh navigation help to allow retry
      this.navigationHelp.refreshLocalHelp();
      logger.error("Publish failed", { error: errorMsg, pageId, title });
    }
  }

  /**
   * Discard pending changes and restore original content
   */
  private discardChanges(): void {
    if (!this.currentPage || !this.pendingChanges.hasPendingChanges) return;

    const { spaceKey, pageId, title, version } = this.currentPage;
    const { originalMarkdown } = this.pendingChanges;

    // Write original markdown back to the cache file
    const markdownPath = this.cache.getMarkdownPath_public(spaceKey, pageId);
    
    try {
      fs.writeFileSync(markdownPath, originalMarkdown);

      // Parse original markdown back to ADF and restore the view
      const originalAdf = parseMarkdownToADF(originalMarkdown);
      const restoredPage: PageData = {
        title,
        adf: originalAdf,
        spaceKey,
        pageId,
        version,
      };
      this.setPage(restoredPage);
    } catch (error) {
      logger.error("Failed to restore original markdown", { error });
    }

    // Clear pending changes
    this.pendingChanges = {
      hasPendingChanges: false,
      originalMarkdown: "",
      editedMarkdown: "",
      confirmingPublish: false,
    };

    this.updateStatus("Changes discarded.");
  }

  // --- Display ---

  private updateDisplay(): void {
    this.renderAllLines();
    this.scrollToCursor();
    this.updateStatusLine();
  }

  private updateStatusLine(): void {
    let status = `${this.cursorLine + 1}:${this.cursorCol + 1}`;
    if (this.visualMode === "char") {
      status = `-- VISUAL -- ${status}`;
    } else if (this.visualMode === "line") {
      status = `-- VISUAL LINE -- ${status}`;
    }
    if (this.pendingChanges.hasPendingChanges) {
      status = `[MODIFIED] ${status}`;
    }
    this.updateStatus(status);
  }

  private renderAllLines(): void {
    const {theme} = this.config;
    const searchColor = "#ffff00"; // Yellow for search matches
    const currentMatchColor = "#ff8800"; // Orange for current match

    for (let lineIdx = 0; lineIdx < this.lineContentRenderables.length; lineIdx++) {
      const renderable = this.lineContentRenderables[lineIdx];
      const line = this.readViewLines[lineIdx];
      if (!renderable || !line) continue;

      const content = line.content || " ";
      const isCursorLine = lineIdx === this.cursorLine;

      // Determine if this line needs special rendering (cursor or selection)
      const hasSelection = this.visualMode !== "none" && this.isLineInSelection(lineIdx);
      const lineMatches = this.getLineSearchMatches(lineIdx);
      const hasSearchMatches = lineMatches.length > 0;

      if (!isCursorLine && !hasSelection && !hasSearchMatches) {
        // Simple case: no cursor, no selection, no search matches on this line
        renderable.content = t`${fg(theme.text)(content)}`;
        continue;
      }

      if (!isCursorLine && !hasSelection && hasSearchMatches) {
        // Just search matches, no cursor or selection
        renderable.content = this.renderLineWithSearchMatches(content, lineIdx, lineMatches, theme, searchColor, currentMatchColor);
        continue;
      }

      // Complex case: need to render with cursor and/or selection
      // Split line into three parts: before cursor, cursor char, after cursor
      const cursorCol = this.cursorCol;

      if (isCursorLine && !hasSelection) {
        // Just cursor, no selection
        const before = content.slice(0, cursorCol);
        const cursorChar = content[cursorCol] || " ";
        const after = content.slice(cursorCol + 1);

        if (before && after) {
          renderable.content = t`${fg(theme.text)(before)}${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(after)}`;
        } else if (before) {
          renderable.content = t`${fg(theme.text)(before)}${bg(theme.text)(fg(theme.background)(cursorChar))}`;
        } else if (after) {
          renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(after)}`;
        } else {
          renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}`;
        }
        continue;
      }

      // Selection case (with or without cursor)
      const start = this.getSelectionStart();
      const end = this.getSelectionEnd();

      if (this.visualMode === "line") {
        // Line mode: entire line is selected
        if (isCursorLine) {
          const before = content.slice(0, cursorCol);
          const cursorChar = content[cursorCol] || " ";
          const after = content.slice(cursorCol + 1);

          if (before && after) {
            renderable.content = t`${bg(theme.highlight)(fg(theme.text)(before))}${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(after))}`;
          } else if (before) {
            renderable.content = t`${bg(theme.highlight)(fg(theme.text)(before))}${bg(theme.text)(fg(theme.background)(cursorChar))}`;
          } else if (after) {
            renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(after))}`;
          } else {
            renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}`;
          }
        } else {
          renderable.content = t`${bg(theme.highlight)(fg(theme.text)(content))}`;
        }
        continue;
      }

      // Character selection mode
      let selStart = 0;
      let selEnd = content.length;

      if (lineIdx === start.line && lineIdx === end.line) {
        selStart = start.col;
        selEnd = end.col + 1;
      } else if (lineIdx === start.line) {
        selStart = start.col;
      } else if (lineIdx === end.line) {
        selEnd = end.col + 1;
      }

      const beforeSel = content.slice(0, selStart);
      const selected = content.slice(selStart, selEnd);
      const afterSel = content.slice(selEnd);

      if (isCursorLine) {
        // Cursor within selection
        const cursorInSel = cursorCol >= selStart && cursorCol < selEnd;

        if (cursorInSel) {
          const selBeforeCursor = content.slice(selStart, cursorCol);
          const cursorChar = content[cursorCol] || " ";
          const selAfterCursor = content.slice(cursorCol + 1, selEnd);

          // Build: beforeSel + selBeforeCursor + cursor + selAfterCursor + afterSel
          this.renderComplexLine(renderable, theme, beforeSel, selBeforeCursor, cursorChar, selAfterCursor, afterSel);
        } else if (cursorCol < selStart) {
          // Cursor before selection
          const beforeCursor = content.slice(0, cursorCol);
          const cursorChar = content[cursorCol] || " ";
          const betweenCursorAndSel = content.slice(cursorCol + 1, selStart);

          if (beforeCursor) {
            renderable.content = t`${fg(theme.text)(beforeCursor)}${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(betweenCursorAndSel)}${bg(theme.highlight)(fg(theme.text)(selected))}${fg(theme.text)(afterSel)}`;
          } else {
            renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(betweenCursorAndSel)}${bg(theme.highlight)(fg(theme.text)(selected))}${fg(theme.text)(afterSel)}`;
          }
        } else {
          // Cursor after selection
          const betweenSelAndCursor = content.slice(selEnd, cursorCol);
          const cursorChar = content[cursorCol] || " ";
          const afterCursor = content.slice(cursorCol + 1);

          renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.highlight)(fg(theme.text)(selected))}${fg(theme.text)(betweenSelAndCursor)}${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(afterCursor)}`;
        }
      } else {
        // No cursor on this line, just selection
        if (beforeSel && afterSel) {
          renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.highlight)(fg(theme.text)(selected))}${fg(theme.text)(afterSel)}`;
        } else if (beforeSel) {
          renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.highlight)(fg(theme.text)(selected))}`;
        } else if (afterSel) {
          renderable.content = t`${bg(theme.highlight)(fg(theme.text)(selected))}${fg(theme.text)(afterSel)}`;
        } else {
          renderable.content = t`${bg(theme.highlight)(fg(theme.text)(selected))}`;
        }
      }
    }
  }

  private renderComplexLine(
    renderable: TextRenderable,
    theme: Config["theme"],
    beforeSel: string,
    selBeforeCursor: string,
    cursorChar: string,
    selAfterCursor: string,
    afterSel: string
  ): void {
    // Handle various combinations of empty/non-empty segments
    const hasBefore = beforeSel.length > 0;
    const hasSelBefore = selBeforeCursor.length > 0;
    const hasSelAfter = selAfterCursor.length > 0;
    const hasAfter = afterSel.length > 0;

    if (hasBefore && hasSelBefore && hasSelAfter && hasAfter) {
      renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.highlight)(fg(theme.text)(selBeforeCursor))}${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(selAfterCursor))}${fg(theme.text)(afterSel)}`;
    } else if (hasBefore && hasSelBefore && hasSelAfter) {
      renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.highlight)(fg(theme.text)(selBeforeCursor))}${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(selAfterCursor))}`;
    } else if (hasBefore && hasSelBefore && hasAfter) {
      renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.highlight)(fg(theme.text)(selBeforeCursor))}${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(afterSel)}`;
    } else if (hasBefore && hasSelAfter && hasAfter) {
      renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(selAfterCursor))}${fg(theme.text)(afterSel)}`;
    } else if (hasSelBefore && hasSelAfter && hasAfter) {
      renderable.content = t`${bg(theme.highlight)(fg(theme.text)(selBeforeCursor))}${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(selAfterCursor))}${fg(theme.text)(afterSel)}`;
    } else if (hasBefore && hasSelBefore) {
      renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.highlight)(fg(theme.text)(selBeforeCursor))}${bg(theme.text)(fg(theme.background)(cursorChar))}`;
    } else if (hasBefore && hasSelAfter) {
      renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(selAfterCursor))}`;
    } else if (hasBefore && hasAfter) {
      renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(afterSel)}`;
    } else if (hasSelBefore && hasSelAfter) {
      renderable.content = t`${bg(theme.highlight)(fg(theme.text)(selBeforeCursor))}${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(selAfterCursor))}`;
    } else if (hasSelBefore && hasAfter) {
      renderable.content = t`${bg(theme.highlight)(fg(theme.text)(selBeforeCursor))}${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(afterSel)}`;
    } else if (hasSelAfter && hasAfter) {
      renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(selAfterCursor))}${fg(theme.text)(afterSel)}`;
    } else if (hasBefore) {
      renderable.content = t`${fg(theme.text)(beforeSel)}${bg(theme.text)(fg(theme.background)(cursorChar))}`;
    } else if (hasSelBefore) {
      renderable.content = t`${bg(theme.highlight)(fg(theme.text)(selBeforeCursor))}${bg(theme.text)(fg(theme.background)(cursorChar))}`;
    } else if (hasSelAfter) {
      renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}${bg(theme.highlight)(fg(theme.text)(selAfterCursor))}`;
    } else if (hasAfter) {
      renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}${fg(theme.text)(afterSel)}`;
    } else {
      renderable.content = t`${bg(theme.text)(fg(theme.background)(cursorChar))}`;
    }
  }

  private isLineInSelection(lineIdx: number): boolean {
    if (this.visualMode === "none") return false;
    const start = this.getSelectionStart();
    const end = this.getSelectionEnd();
    return lineIdx >= start.line && lineIdx <= end.line;
  }

  /**
   * Render a line with search match highlighting (no cursor, no selection)
   */
  private renderLineWithSearchMatches(
    content: string,
    lineIdx: number,
    matches: SearchMatch[],
    theme: Config["theme"],
    searchColor: string,
    currentMatchColor: string
  ): ReturnType<typeof t> {
    // Build segments: alternate between normal text and highlighted matches
    type Segment = { text: string; isMatch: boolean; isCurrent: boolean };
    const segments: Segment[] = [];
    let pos = 0;

    // Sort matches by startCol
    const sortedMatches = [...matches].sort((a, b) => a.startCol - b.startCol);

    for (const match of sortedMatches) {
      // Add text before this match
      if (match.startCol > pos) {
        segments.push({text: content.slice(pos, match.startCol), isMatch: false, isCurrent: false});
      }
      // Add the match
      const isCurrent = this.isCurrentSearchMatch(lineIdx, match.startCol);
      segments.push({
        text: content.slice(match.startCol, match.endCol + 1),
        isMatch: true,
        isCurrent,
      });
      pos = match.endCol + 1;
    }

    // Add remaining text after last match
    if (pos < content.length) {
      segments.push({text: content.slice(pos), isMatch: false, isCurrent: false});
    }

    // Build the template literal based on segment count
    // Due to template literal constraints, we handle common cases explicitly
    if (segments.length === 0) {
      return t`${fg(theme.text)(content)}`;
    }

    // Build a simple combined output - segment by segment
    // Since we can't dynamically build template literals, we need explicit cases
    // The `t` template tag requires TextChunks as interpolations

    // For simplicity, build the output for common segment counts
    const s = segments;
    type TextChunk = ReturnType<ReturnType<typeof fg>>;
    const getChunk = (seg: Segment): TextChunk => {
      if (seg.isMatch) {
        const bgColor = seg.isCurrent ? currentMatchColor : searchColor;
        return bg(bgColor)(fg(theme.background)(seg.text));
      }
      return fg(theme.text)(seg.text);
    };

    // Handle different segment counts with explicit template literals
    switch (s.length) {
      case 1:
        return t`${getChunk(s[0]!)}`;
      case 2:
        return t`${getChunk(s[0]!)}${getChunk(s[1]!)}`;
      case 3:
        return t`${getChunk(s[0]!)}${getChunk(s[1]!)}${getChunk(s[2]!)}`;
      case 4:
        return t`${getChunk(s[0]!)}${getChunk(s[1]!)}${getChunk(s[2]!)}${getChunk(s[3]!)}`;
      case 5:
        return t`${getChunk(s[0]!)}${getChunk(s[1]!)}${getChunk(s[2]!)}${getChunk(s[3]!)}${getChunk(s[4]!)}`;
      case 6:
        return t`${getChunk(s[0]!)}${getChunk(s[1]!)}${getChunk(s[2]!)}${getChunk(s[3]!)}${getChunk(s[4]!)}${getChunk(s[5]!)}`;
      case 7:
        return t`${getChunk(s[0]!)}${getChunk(s[1]!)}${getChunk(s[2]!)}${getChunk(s[3]!)}${getChunk(s[4]!)}${getChunk(s[5]!)}${getChunk(s[6]!)}`;
      default:
        // For more segments, just show first 7
        return t`${getChunk(s[0]!)}${getChunk(s[1]!)}${getChunk(s[2]!)}${getChunk(s[3]!)}${getChunk(s[4]!)}${getChunk(s[5]!)}${getChunk(s[6]!)}`;
    }
  }

  private scrollToCursor(): void {
    // Each line is 1 row high, scroll to keep cursor visible
    const lineHeight = 1;
    const cursorPosition = this.cursorLine * lineHeight;

    // Get viewport height (approximate from terminal height minus UI chrome)
    const viewportHeight = Math.max(1, this.renderer.terminalHeight - 10);

    // Calculate scroll position to keep cursor in view
    const currentScroll = this.scroll.scrollTop;

    if (cursorPosition < currentScroll) {
      // Cursor is above viewport, scroll up
      this.scroll.scrollTo(cursorPosition);
    } else if (cursorPosition >= currentScroll + viewportHeight) {
      // Cursor is below viewport, scroll down
      this.scroll.scrollTo(cursorPosition - viewportHeight + lineHeight);
    }
  }

  private updateStatus(message: string): void {
    this.events.onStatusUpdate?.(message);
  }

  /**
   * Load a page from a tree node
   */
  async loadPage(node: Pick<TreeNode, "pageId" | "spaceKey" | "label">): Promise<void> {
    if (!node.pageId || !node.spaceKey) return;

    this.updateStatus(`Loading page: ${node.label}...`);

    try {
      logger.debug("Loading page", node);
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

    const { spaceKey, pageId, title, version } = this.currentPage;

    // Read original markdown before editing
    const originalMarkdown = this.cache.readMarkdownFile(spaceKey, pageId) || "";

    const markdownPath = this.cache.getMarkdownPath_public(spaceKey, pageId);
    const lineArg = `+${this.cursorLine + 1}`;

    this.renderer.suspend();

    const result = spawnSync(this.config.editor, [lineArg, markdownPath], {
      stdio: "inherit",
    });

    this.renderer.resume();

    if (result.status === 0) {
      // Read the edited markdown
      const editedMarkdown = this.cache.readMarkdownFile(spaceKey, pageId) || "";

      // Check if there are changes
      if (editedMarkdown !== originalMarkdown) {
        this.pendingChanges = {
          hasPendingChanges: true,
          originalMarkdown,
          editedMarkdown,
          confirmingPublish: false,
        };

        // Parse the edited markdown to ADF and update the view
        try {
          const newAdf = parseMarkdownToADF(editedMarkdown);
          logger.debug("Parsed markdown to ADF", { adf: JSON.stringify(newAdf, null, 2) });

          // Update the current page with the new ADF
          const updatedPage: PageData = {
            title,
            adf: newAdf,
            spaceKey,
            pageId,
            version,
          };

          this.setPage(updatedPage);
          this.updateStatus("[MODIFIED] Press 'p' to publish, 'Esc' to discard");
        } catch (error) {
          logger.error("Failed to parse markdown", { error });
          this.updateStatus(`[MODIFIED] Parse error - Press 'p' to publish, 'Esc' to discard`);
        }
      } else {
        this.updateStatus("No changes made.");
      }
    } else {
      this.updateStatus(`Editor exited with code ${result.status}`);
    }
  }

  setPage(page: PageData): void {
    this.currentPage = page;
    this.container.title = DEBUG_MODE ? `${page.title} - ${page.pageId} - ${page.spaceKey}` : page.title;
    this.cursorLine = 0;
    this.cursorCol = 0;
    this.visualMode = "none";
    this.render();
    this.renderAllLines();
  }

  getPage(): PageData | null {
    return this.currentPage;
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
    this.lineContentRenderables = [];

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

      // Line content - will be updated by renderAllLines()
      const lineContent = new TextRenderable(this.renderer, {
        id: `linecontent-${i}`,
        content: t`${fg(this.config.theme.text)(line.content || " ")}`,
        height: line.style?.size,
      });
      lineBox.add(lineContent);

      this.content.add(lineBox);
      this.lineRenderables.push(lineBox);
      this.lineContentRenderables.push(lineContent);
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
}
