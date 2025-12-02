# Confluence TUI

A terminal user interface for reading and editing Confluence pages, built with [OpenTUI](https://github.com/sst/opentui).

## Features

- **Tree View**: Browse Confluence spaces and pages in a hierarchical tree
- **Read View**: View Confluence pages rendered as markdown with line numbers
- **Edit Mode**: Press `i` to open the page in your configured `$EDITOR`
- **Vim Navigation**: Navigate with `hjkl` keys and standard vim motions
- **Caching**: Pages are cached locally as markdown files
- **Extensible**: Custom confluence components (panels, decisions, tasks) are rendered with appropriate styling

## Requirements

- [Bun](https://bun.sh) runtime
- [Zig](https://ziglang.org) (required for OpenTUI)
- Confluence Cloud account with API access

## Installation

```bash
bun install
```

## Configuration

### Environment Variables

Set the following environment variables:

```bash
export ATLASSIAN_BASE_URL="https://your-domain.atlassian.net"
export ATLASSIAN_EMAIL="your-email@example.com"
export ATLASSIAN_API_TOKEN="your-api-token"
export EDITOR="vim"  # or your preferred editor
```

To create an API token, visit: https://id.atlassian.com/manage-profile/security/api-tokens

### Config File (Optional)

Create `~/.config/confluence-tui/config.json`:

```json
{
  "confluence": {
    "baseUrl": "https://your-domain.atlassian.net",
    "email": "your-email@example.com",
    "apiToken": "your-api-token"
  },
  "editor": "vim",
  "cacheDir": "~/.cache/confluence-tui",
  "keyBindings": {
    "up": ["k", "up"],
    "down": ["j", "down"],
    "left": ["h", "left"],
    "right": ["l", "right"],
    "select": ["return", "enter"],
    "back": ["escape", "backspace"],
    "edit": ["i"],
    "quit": ["q"],
    "search": ["/"],
    "refresh": ["r"]
  },
  "theme": {
    "primary": "#7aa2f7",
    "secondary": "#bb9af7",
    "background": "#1a1b26",
    "text": "#c0caf5",
    "border": "#565f89",
    "highlight": "#3b82f6",
    "error": "#f7768e",
    "warning": "#e0af68"
  }
}
```

## Usage

```bash
# Development mode with hot reload
bun dev

# Normal run
bun start
```

## Key Bindings

### Tree View

| Key | Action |
|-----|--------|
| `j` / `↓` | Move down |
| `k` / `↑` | Move up |
| `l` / `→` / `Enter` | Expand space / Open page |
| `h` / `←` | Collapse space |
| `r` | Refresh spaces |
| `q` | Quit |

### Read View

| Key | Action |
|-----|--------|
| `j` / `↓` | Scroll down |
| `k` / `↑` | Scroll up |
| `Ctrl+d` | Half page down |
| `Ctrl+u` | Half page up |
| `g` | Go to top |
| `G` | Go to bottom |
| `i` | Edit in $EDITOR |
| `Esc` / `Backspace` | Return to tree |
| `q` | Quit |

## Supported Confluence Components

The following Confluence/ADF components are supported:

### Basic Markdown
- Paragraphs
- Headings (H1-H6)
- Bold, italic, underline, strikethrough
- Code (inline and blocks)
- Links
- Lists (ordered and unordered)
- Blockquotes
- Horizontal rules
- Tables

### Confluence-Specific
- **Panels**: Info, note, warning, error, success panels
- **Decision Items**: Decision lists with status
- **Task Lists**: Checkboxes with completion state
- **Status Labels**: Colored status badges
- **Mentions**: @mentions of users
- **Dates**: Date components
- **Expand**: Collapsible sections
- **Media**: Attachments (shown as placeholders)
- **Emoji**: Emoji shortcodes

### Unknown Components
Components not yet implemented are rendered as JSON code blocks with a label indicating the component type, making it easy to identify what needs to be supported.

## Cache

Markdown files are cached in `~/.cache/confluence-tui/<space-key>/<page-id>.md`. This allows you to:

1. View pages offline
2. Edit pages in your preferred editor
3. Keep a local copy of changes

## Architecture

```
src/
├── index.tsx              # Main application entry
├── types.ts               # TypeScript type definitions
├── config.ts              # Configuration loading
├── confluence-client.ts   # Confluence API client
├── cache.ts               # File system caching
└── markdown-components.ts # ADF to Markdown converters
```

## Extending

### Adding New Components

1. Create a new class extending `BaseMarkdownComponent` in `markdown-components.ts`
2. Implement `canRender`, `toMarkdown`, and `toReadView` methods
3. Add the component to `createComponentRegistry()`

Example:

```typescript
class MyCustomComponent extends BaseMarkdownComponent {
  type = "myCustomType";

  canRender(node: ADFNode): boolean {
    return node.type === "myCustomType";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    return `[Custom: ${node.attrs?.value}]`;
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: `[Custom: ${node.attrs?.value}]`,
      style: { fg: "#ff00ff" },
      sourceNode: node,
    };
  }
}
```

## License

MIT
