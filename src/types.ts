// Confluence API Types
export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: "global" | "personal";
  status: "current" | "archived";
  description?: string;
  homepage?: ConfluencePageRef;
}

export interface ConfluencePageRef {
  id: string;
  title: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  spaceId: string;
  parentId?: string;
  status: "current" | "draft" | "archived";
  body: ConfluenceBody;
  version: {
    number: number;
    message?: string;
    createdAt: string;
  };
  children?: ConfluencePageRef[];
}

export interface ConfluenceBody {
  storage?: {
    value: string;
    representation: "storage";
  };
  atlas_doc_format?: {
    value: string;
    representation: "atlas_doc_format";
  };
}

// Atlas Document Format (ADF) Types
export interface ADFDocument {
  type: "doc";
  version: 1;
  content: ADFNode[];
}

export interface ADFNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ADFNode[];
  text?: string;
  marks?: ADFMark[];
}

export interface ADFMark {
  type: string;
  attrs?: Record<string, unknown>;
}

// Tree View Types
export interface TreeNode {
  id: string;
  label: string;
  type: "space" | "page";
  expanded: boolean;
  children: TreeNode[];
  depth: number;
  spaceKey?: string;
  pageId?: string;
  parentId?: string;
}

// Keybinding Action - all possible actions in the app
export type KeyAction =
  // Navigation
  | "up"
  | "down"
  | "left"
  | "right"
  | "select"
  | "back"
  // Page navigation
  | "halfPageUp"
  | "halfPageDown"
  | "lineStart"
  | "lineEnd"
  | "documentTop"
  | "documentBottom"
  | "wordForward"
  | "wordBackward"
  // Actions
  | "edit"
  | "quit"
  | "search"
  | "searchNext"
  | "searchPrev"
  | "refresh"
  | "publish"
  | "yank"
  | "visualChar"
  | "visualLine"
  | "confirm"
  | "cancel"
  | "debug";

// Config Types - maps actions to key combinations
export interface KeyBindings {
  // Navigation
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  select: string[];
  back: string[];
  // Page navigation
  halfPageUp: string[];
  halfPageDown: string[];
  lineStart: string[];
  lineEnd: string[];
  documentTop: string[];
  documentBottom: string[];
  wordForward: string[];
  wordBackward: string[];
  // Actions
  edit: string[];
  quit: string[];
  search: string[];
  searchNext: string[];
  searchPrev: string[];
  refresh: string[];
  publish: string[];
  yank: string[];
  visualChar: string[];
  visualLine: string[];
  confirm: string[];
  cancel: string[];
  debug: string[];
}

export interface Config {
  keyBindings: KeyBindings;
  cacheDir: string;
  confluence: {
    baseUrl: string;
    email: string;
    apiToken: string;
  };
  editor: string;
  theme: {
    primary: string;
    secondary: string;
    background: string;
    text: string;
    border: string;
    highlight: string;
    error: string;
    warning: string;
  };
}

// Markdown Parsing Context
export interface ParseContext {
  lines: string[];
  currentLine: number;
  components: Map<string, MarkdownComponent>;
}

// Parse result from a component
export interface ParseResult {
  node: ADFNode | null;
  consumed: boolean;  // Whether this component handled the current line(s)
}

// Markdown Component Interface - Bidirectional conversion
export interface MarkdownComponent {
  type: string;
  
  // ADF → Check if this component can handle the node
  canRender(node: ADFNode): boolean;
  
  // ADF → Markdown
  toMarkdown(node: ADFNode, context: RenderContext): string;
  
  // ADF → ReadView (for display)
  toReadView(node: ADFNode, context: RenderContext): ReadViewNode;
  
  // Markdown → Check if this component can parse the current line
  canParse?(context: ParseContext): boolean;
  
  // Markdown → ADF
  parseFromMarkdown?(context: ParseContext): ParseResult;
}

export interface RenderContext {
  indent: number;
  listDepth: number;
  orderedListCounter?: number;
  inCodeBlock: boolean;
  components: Map<string, MarkdownComponent>;
}

export interface ReadViewNode {
  content: string;
  style?: {
    fg?: string;
    bg?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    dim?: boolean;
    size?: number
  };
  children?: ReadViewNode[];
  sourceNode?: ADFNode;
  lineNumber?: number;
}

// Navigation State
export interface NavigationState {
  view: "tree" | "read" | "edit";
  selectedTreeIndex: number;
  selectedPageId?: string;
  selectedSpaceKey?: string;
  cursorLine: number;
  cursorColumn: number;
  scrollOffset: number;
  debugPanelOpen: boolean;
  debugPanelMode: "logs" | "adf" | "markdown" | "readview";
  activePanel: "main" | "debug";
}

// Cache types
export interface CachedPage {
  pageId: string;
  spaceKey: string;
  title: string;
  markdown: string;
  adf: ADFDocument;
  fetchedAt: number;
  version: number;
}
