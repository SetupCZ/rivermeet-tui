import {
  type CliRenderer,
  type KeyEvent,
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type SelectOption,
} from "@opentui/core";
import type { TreeNode, Config } from "../types";
import { matchesKey } from "../config";
import { container, TOKENS } from "../di/container";
import type { HelpEntry, NavigableComponent, NavigationHelp } from "./NavigationHelp";
import { ConfluenceClient } from "../confluence-client";

export interface TreeViewEvents {
  onPageSelect?: (node: TreeNode) => void;
  onStatusUpdate?: (message: string) => void;
}

export class TreeView implements NavigableComponent {
  private renderer: CliRenderer;
  private config: Config;
  private client: ConfluenceClient;
  private events: TreeViewEvents;
  private navigationHelp: NavigationHelp | null = null;

  // UI Elements
  public container: BoxRenderable;
  public select: SelectRenderable;

  // State
  private treeNodes: TreeNode[] = [];
  private flattenedNodes: TreeNode[] = [];

  constructor(events: TreeViewEvents = {}) {
    this.renderer = container.resolve<CliRenderer>(TOKENS.Renderer);
    this.config = container.resolve<Config>(TOKENS.Config);
    this.client = container.resolve<ConfluenceClient>(TOKENS.Client);
    this.events = events;

    const { theme } = this.config;

    // Tree view box
    this.container = new BoxRenderable(this.renderer, {
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

    // Tree select
    this.select = new SelectRenderable(this.renderer, {
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
    this.container.add(this.select);

    this.setupEventHandlers();
    this.registerWithNavigationHelp();
  }

  /**
   * Register this component with NavigationHelp via DI
   */
  private registerWithNavigationHelp(): void {
    // Try to get NavigationHelp from container (may not be available yet)
    if (container.has(TOKENS.NavigationHelp)) {
      this.navigationHelp = container.resolve<NavigationHelp>(TOKENS.NavigationHelp);
      this.navigationHelp.registerComponent("tree", this);
    }
  }

  private setupEventHandlers(): void {
    this.select.on(
      SelectRenderableEvents.ITEM_SELECTED,
      (_index: number, option: SelectOption) => {
        const node = option.value as TreeNode;
        this.handleNodeSelect(node);
      }
    );
  }

  /**
   * Called when this component becomes active
   */
  onActivate(): void {
    this.focus();
    this.updateStatus("Navigate spaces and pages");
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
   * Handle keypress events for tree view
   */
  handleKeypress(key: KeyEvent): boolean {
    const { keyBindings } = this.config;

    // Expand/collapse or navigate into with right/l
    if (matchesKey(key, keyBindings.right)) {
      const node = this.getSelectedNode();
      if (node) {
        if (node.type === "space" && !node.expanded) {
          this.toggleExpand(node);
          return true;
        } else if (node.type === "page") {
          this.events.onPageSelect?.(node);
          return true;
        }
      }
    }

    // Collapse with left/h
    if (matchesKey(key, keyBindings.left)) {
      const node = this.getSelectedNode();
      if (node && node.type === "space" && node.expanded) {
        this.toggleExpand(node);
        return true;
      }
    }

    // Refresh
    if (matchesKey(key, keyBindings.refresh)) {
      this.loadSpaces();
      return true;
    }

    return false;
  }

  /**
   * Get help entries for this component
   */
  getHelpEntries(): HelpEntry[] {
    return [
      { key: "j/k", description: "navigate" },
      { key: "l/Enter", description: "open" },
      { key: "h", description: "collapse" },
      { key: "r", description: "refresh" },
    ];
  }

  private handleNodeSelect(node: TreeNode): void {
    if (node.type === "space") {
      this.toggleExpand(node);
    } else if (node.type === "page") {
      this.events.onPageSelect?.(node);
    }
  }

  async toggleExpand(node: TreeNode): Promise<void> {
    node.expanded = !node.expanded;

    // If expanding and no children loaded yet, load pages from API
    if (node.expanded && node.children.length === 0 && node.type === "space") {
      await this.loadSpacePages(node);
    }

    this.refresh();
  }

  /**
   * Load all spaces from the API
   */
  async loadSpaces(): Promise<void> {
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

      this.updateStatus(`Loaded ${spaces.length} spaces`);
      this.refresh();
    } catch (error) {
      this.updateStatus(`Error loading spaces: ${error}`);
    }
  }

  /**
   * Load pages for a space from the API
   */
  private async loadSpacePages(node: TreeNode): Promise<void> {
    if (!node.spaceKey) return;

    this.updateStatus(`Loading pages for ${node.label}...`);

    try {
      const pages = await this.client.getSpacePages(node.id);
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
      this.updateStatus(`Loaded ${pages.length} pages for ${node.label}`);
    } catch (error) {
      this.updateStatus(`Error loading pages: ${error}`);
    }
  }

  private updateStatus(message: string): void {
    this.events.onStatusUpdate?.(message);
  }

  setNodes(nodes: TreeNode[]): void {
    this.treeNodes = nodes;
    this.refresh();
  }

  getNodes(): TreeNode[] {
    return this.treeNodes;
  }

  getFlattenedNodes(): TreeNode[] {
    return this.flattenedNodes;
  }

  getSelectedIndex(): number {
    return this.select.getSelectedIndex() ?? 0;
  }

  getSelectedNode(): TreeNode | undefined {
    const index = this.getSelectedIndex();
    return this.flattenedNodes[index];
  }

  focus(): void {
    this.select.focus();
  }

  blur(): void {
    this.select.blur();
  }

  show(): void {
    this.container.visible = true;
  }

  hide(): void {
    this.container.visible = false;
  }

  refresh(): void {
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

    this.select.options = options;
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

  setBorderColor(color: string): void {
    this.container.borderColor = color;
  }

  destroy(): void {
    this.container.destroy();
  }
}
