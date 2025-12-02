import type {
  ADFNode,
  MarkdownComponent,
  RenderContext,
  ReadViewNode,
} from "./types";

// Base class for markdown components
abstract class BaseMarkdownComponent implements MarkdownComponent {
  abstract type: string;

  abstract canRender(node: ADFNode): boolean;

  abstract toMarkdown(node: ADFNode, context: RenderContext): string;

  abstract toReadView(node: ADFNode, context: RenderContext): ReadViewNode;

  protected renderChildren(
    children: ADFNode[] | undefined,
    context: RenderContext
  ): string {
    if (!children) return "";
    return children
      .map((child) => {
        const component = context.components.get(child.type);
        if (component) {
          return component.toMarkdown(child, context);
        }
        return renderUnknown(child);
      })
      .join("");
  }

  protected renderChildrenReadView(
    children: ADFNode[] | undefined,
    context: RenderContext
  ): ReadViewNode[] {
    if (!children) return [];
    return children.map((child) => {
      const component = context.components.get(child.type);
      if (component) {
        return component.toReadView(child, context);
      }
      return createUnknownReadViewNode(child);
    });
  }
}

// Helper function to render unknown components as JSON codeblocks
function renderUnknown(node: ADFNode): string {
  return `\n\`\`\`json [Unknown Component: ${node.type}]\n${JSON.stringify(node, null, 2)}\n\`\`\`\n`;
}

function createUnknownReadViewNode(node: ADFNode): ReadViewNode {
  return {
    content: `[Unknown Component: ${node.type}]\n${JSON.stringify(node, null, 2)}`,
    style: {
      fg: "#e0af68",
      dim: true,
    },
    sourceNode: node,
  };
}

// Document component
class DocumentComponent extends BaseMarkdownComponent {
  type = "doc";

  canRender(node: ADFNode): boolean {
    return node.type === "doc";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    return this.renderChildren(node.content, context);
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "",
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

// Paragraph component
class ParagraphComponent extends BaseMarkdownComponent {
  type = "paragraph";

  canRender(node: ADFNode): boolean {
    return node.type === "paragraph";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const content = this.renderChildren(node.content, context);
    return content + "\n\n";
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    // Add a single newline after paragraph content for spacing
    return {
      content: "",
      children: [
        ...this.renderChildrenReadView(node.content, context),
      ],
      sourceNode: node,
    };
  }
}

// Text component
class TextComponent extends BaseMarkdownComponent {
  type = "text";

  canRender(node: ADFNode): boolean {
    return node.type === "text";
  }

  toMarkdown(node: ADFNode, _context: RenderContext): string {
    let text = node.text || "";

    if (node.marks) {
      for (const mark of node.marks) {
        switch (mark.type) {
          case "strong":
            text = `**${text}**`;
            break;
          case "em":
            text = `*${text}*`;
            break;
          case "code":
            text = `\`${text}\``;
            break;
          case "strike":
            text = `~~${text}~~`;
            break;
          case "underline":
            text = `<u>${text}</u>`;
            break;
          case "link":
            text = `[${text}](${(mark.attrs as { href: string })?.href || ""})`;
            break;
        }
      }
    }

    return text;
  }

  toReadView(node: ADFNode, _context: RenderContext): ReadViewNode {
    const style: ReadViewNode["style"] = {};

    if (node.marks) {
      for (const mark of node.marks) {
        switch (mark.type) {
          case "strong":
            style.bold = true;
            break;
          case "em":
            style.italic = true;
            break;
          case "code":
            style.bg = "#2d3748";
            style.fg = "#f7768e";
            break;
          case "strike":
            style.dim = true;
            break;
          case "underline":
            style.underline = true;
            break;
          case "link":
            style.fg = "#7aa2f7";
            style.underline = true;
            break;
        }
      }
    }

    return {
      content: `<>${node.text || ""}</>`,
      style,
      sourceNode: node,
    };
  }
}

// Heading component
class HeadingComponent extends BaseMarkdownComponent {
  type = "heading";

  canRender(node: ADFNode): boolean {
    return node.type === "heading";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const level = (node.attrs?.level as number) || 1;
    const prefix = "#".repeat(level);
    const content = this.renderChildren(node.content, context);
    return `${prefix} ${content}\n\n`;
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const level = (node.attrs?.level as number) || 1;
    const prefix = "#".repeat(level) + " ";
    const colors = ["#bb9af7", "#7aa2f7", "#7dcfff", "#9ece6a", "#e0af68", "#f7768e"];

    return {
      content: prefix,
      style: {
        bold: true,
        fg: colors[level - 1] || colors[0],
      },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

// Bullet list component
class BulletListComponent extends BaseMarkdownComponent {
  type = "bulletList";

  canRender(node: ADFNode): boolean {
    return node.type === "bulletList";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const newContext = { ...context, listDepth: context.listDepth + 1 };
    const items = this.renderChildren(node.content, newContext);
    return items + "\n";
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const newContext = { ...context, listDepth: context.listDepth + 1 };
    return {
      content: "",
      children: this.renderChildrenReadView(node.content, newContext),
      sourceNode: node,
    };
  }
}

// Ordered list component
class OrderedListComponent extends BaseMarkdownComponent {
  type = "orderedList";

  canRender(node: ADFNode): boolean {
    return node.type === "orderedList";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const newContext = {
      ...context,
      listDepth: context.listDepth + 1,
      orderedListCounter: 1,
    };
    const items = node.content
      ?.map((child, index) => {
        const itemContext = { ...newContext, orderedListCounter: index + 1 };
        const component = context.components.get(child.type);
        if (component) {
          return component.toMarkdown(child, itemContext);
        }
        return renderUnknown(child);
      })
      .join("");
    return (items || "") + "\n";
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const newContext = {
      ...context,
      listDepth: context.listDepth + 1,
      orderedListCounter: 1,
    };
    return {
      content: "",
      children: node.content?.map((child, index) => {
        const itemContext = { ...newContext, orderedListCounter: index + 1 };
        const component = context.components.get(child.type);
        if (component) {
          return component.toReadView(child, itemContext);
        }
        return createUnknownReadViewNode(child);
      }),
      sourceNode: node,
    };
  }
}

// List item component
class ListItemComponent extends BaseMarkdownComponent {
  type = "listItem";

  canRender(node: ADFNode): boolean {
    return node.type === "listItem";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const indent = "  ".repeat(context.listDepth - 1);
    const marker =
      context.orderedListCounter !== undefined
        ? `${context.orderedListCounter}.`
        : "-";
    const content = this.renderChildren(node.content, context).trim();
    return `${indent}${marker} ${content}\n`;
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const indent = "  ".repeat(context.listDepth - 1);
    const marker =
      context.orderedListCounter !== undefined
        ? `${context.orderedListCounter}.`
        : "•";

    return {
      content: `${indent}${marker} `,
      style: { fg: "#565f89" },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

// Code block component
class CodeBlockComponent extends BaseMarkdownComponent {
  type = "codeBlock";

  canRender(node: ADFNode): boolean {
    return node.type === "codeBlock";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const language = (node.attrs?.language as string) || "";
    const newContext = { ...context, inCodeBlock: true };
    const content = this.renderChildren(node.content, newContext);
    return `\`\`\`${language}\n${content}\n\`\`\`\n\n`;
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const language = (node.attrs?.language as string) || "";
    const newContext = { ...context, inCodeBlock: true };

    return {
      content: `\`\`\`${language}\n`,
      style: {
        fg: "#565f89",
        bg: "#1f2335",
      },
      children: this.renderChildrenReadView(node.content, newContext),
      sourceNode: node,
    };
  }
}

// Blockquote component
class BlockquoteComponent extends BaseMarkdownComponent {
  type = "blockquote";

  canRender(node: ADFNode): boolean {
    return node.type === "blockquote";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const content = this.renderChildren(node.content, context);
    const lines = content.split("\n").map((line) => `> ${line}`);
    return lines.join("\n") + "\n";
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "│ ",
      style: {
        fg: "#565f89",
        italic: true,
      },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

// Rule (horizontal line) component
class RuleComponent extends BaseMarkdownComponent {
  type = "rule";

  canRender(node: ADFNode): boolean {
    return node.type === "rule";
  }

  toMarkdown(_node: ADFNode, _context: RenderContext): string {
    return "\n---\n\n";
  }

  toReadView(node: ADFNode, _context: RenderContext): ReadViewNode {
    return {
      content: "─".repeat(40),
      style: { fg: "#565f89", dim: true },
      sourceNode: node,
    };
  }
}

// Hard break component
class HardBreakComponent extends BaseMarkdownComponent {
  type = "hardBreak";

  canRender(node: ADFNode): boolean {
    return node.type === "hardBreak";
  }

  toMarkdown(_node: ADFNode, _context: RenderContext): string {
    return "  \n";
  }

  toReadView(node: ADFNode, _context: RenderContext): ReadViewNode {
    return {
      content: "\n",
      sourceNode: node,
    };
  }
}

// Panel component (for info, warning, error, success panels)
class PanelComponent extends BaseMarkdownComponent {
  type = "panel";

  canRender(node: ADFNode): boolean {
    return node.type === "panel";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const panelType = (node.attrs?.panelType as string) || "info";
    const content = this.renderChildren(node.content, context);
    const icon = this.getPanelIcon(panelType);
    return `> ${icon} **${panelType.toUpperCase()}**\n> ${content.trim().split("\n").join("\n> ")}\n\n`;
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const panelType = (node.attrs?.panelType as string) || "info";
    const icon = this.getPanelIcon(panelType);
    const color = this.getPanelColor(panelType);

    return {
      content: `${icon} [${panelType.toUpperCase()}] `,
      style: {
        fg: color,
        bold: true,
      },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }

  private getPanelIcon(panelType: string): string {
    switch (panelType) {
      case "info":
        return "ℹ";
      case "note":
        return "📝";
      case "warning":
        return "⚠";
      case "error":
        return "❌";
      case "success":
        return "✓";
      default:
        return "•";
    }
  }

  private getPanelColor(panelType: string): string {
    switch (panelType) {
      case "info":
        return "#7aa2f7";
      case "note":
        return "#bb9af7";
      case "warning":
        return "#e0af68";
      case "error":
        return "#f7768e";
      case "success":
        return "#9ece6a";
      default:
        return "#c0caf5";
    }
  }
}

// Decision component
class DecisionListComponent extends BaseMarkdownComponent {
  type = "decisionList";

  canRender(node: ADFNode): boolean {
    return node.type === "decisionList";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    return this.renderChildren(node.content, context) + "\n";
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "",
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

class DecisionItemComponent extends BaseMarkdownComponent {
  type = "decisionItem";

  canRender(node: ADFNode): boolean {
    return node.type === "decisionItem";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const state = (node.attrs?.state as string) || "DECIDED";
    const content = this.renderChildren(node.content, context);
    const icon = state === "DECIDED" ? "✓" : "○";
    return `- [${icon}] **DECISION**: ${content.trim()}\n`;
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const state = (node.attrs?.state as string) || "DECIDED";
    const icon = state === "DECIDED" ? "✓" : "○";

    return {
      content: `[${icon}] DECISION: `,
      style: {
        fg: state === "DECIDED" ? "#9ece6a" : "#e0af68",
        bold: true,
      },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

// Task list component
class TaskListComponent extends BaseMarkdownComponent {
  type = "taskList";

  canRender(node: ADFNode): boolean {
    return node.type === "taskList";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    return this.renderChildren(node.content, context) + "\n";
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "",
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

class TaskItemComponent extends BaseMarkdownComponent {
  type = "taskItem";

  canRender(node: ADFNode): boolean {
    return node.type === "taskItem";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const state = (node.attrs?.state as string) || "TODO";
    const content = this.renderChildren(node.content, context);
    const checkbox = state === "DONE" ? "[x]" : "[ ]";
    return `- ${checkbox} ${content.trim()}\n`;
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const state = (node.attrs?.state as string) || "TODO";
    const checkbox = state === "DONE" ? "☑" : "☐";

    return {
      content: `${checkbox} `,
      style: {
        fg: state === "DONE" ? "#9ece6a" : "#565f89",
      },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

// Table components
class TableComponent extends BaseMarkdownComponent {
  type = "table";

  canRender(node: ADFNode): boolean {
    return node.type === "table";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const rows = node.content || [];
    if (rows.length === 0) return "";

    const result: string[] = [];
    let isHeaderRow = true;

    for (const row of rows) {
      if (row.type === "tableRow") {
        const cells = row.content || [];
        const cellContents = cells.map((cell) => {
          const content = this.renderChildren(cell.content, context).trim();
          return content || " ";
        });
        result.push(`| ${cellContents.join(" | ")} |`);

        if (isHeaderRow) {
          result.push(`| ${cellContents.map(() => "---").join(" | ")} |`);
          isHeaderRow = false;
        }
      }
    }

    return result.join("\n") + "\n\n";
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "",
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

class TableRowComponent extends BaseMarkdownComponent {
  type = "tableRow";

  canRender(node: ADFNode): boolean {
    return node.type === "tableRow";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    return this.renderChildren(node.content, context);
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "│ ",
      style: { fg: "#565f89" },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

class TableCellComponent extends BaseMarkdownComponent {
  type = "tableCell";

  canRender(node: ADFNode): boolean {
    return node.type === "tableCell";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    return this.renderChildren(node.content, context);
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "",
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

class TableHeaderComponent extends BaseMarkdownComponent {
  type = "tableHeader";

  canRender(node: ADFNode): boolean {
    return node.type === "tableHeader";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    return this.renderChildren(node.content, context);
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "",
      style: { bold: true },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

// Media components
class MediaSingleComponent extends BaseMarkdownComponent {
  type = "mediaSingle";

  canRender(node: ADFNode): boolean {
    return node.type === "mediaSingle";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    return this.renderChildren(node.content, context);
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    return {
      content: "",
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

class MediaComponent extends BaseMarkdownComponent {
  type = "media";

  canRender(node: ADFNode): boolean {
    return node.type === "media";
  }

  toMarkdown(node: ADFNode, _context: RenderContext): string {
    const mediaType = node.attrs?.type as string;
    const id = node.attrs?.id as string;
    const alt = (node.attrs?.alt as string) || "media";

    if (mediaType === "file") {
      return `![${alt}](attachment:${id})\n\n`;
    }

    return `[Media: ${id}]\n\n`;
  }

  toReadView(node: ADFNode, _context: RenderContext): ReadViewNode {
    const alt = (node.attrs?.alt as string) || "media";
    return {
      content: `[📎 ${alt}]`,
      style: { fg: "#7dcfff" },
      sourceNode: node,
    };
  }
}

// Expand component (collapsible sections)
class ExpandComponent extends BaseMarkdownComponent {
  type = "expand";

  canRender(node: ADFNode): boolean {
    return node.type === "expand";
  }

  toMarkdown(node: ADFNode, context: RenderContext): string {
    const title = (node.attrs?.title as string) || "Expand";
    const content = this.renderChildren(node.content, context);
    return `<details>\n<summary>${title}</summary>\n\n${content}\n</details>\n\n`;
  }

  toReadView(node: ADFNode, context: RenderContext): ReadViewNode {
    const title = (node.attrs?.title as string) || "Expand";
    return {
      content: `▶ ${title}\n`,
      style: { fg: "#7dcfff" },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }
}

// Status component
class StatusComponent extends BaseMarkdownComponent {
  type = "status";

  canRender(node: ADFNode): boolean {
    return node.type === "status";
  }

  toMarkdown(node: ADFNode, _context: RenderContext): string {
    const text = (node.attrs?.text as string) || "";
    const color = (node.attrs?.color as string) || "neutral";
    return `[${color.toUpperCase()}: ${text}]`;
  }

  toReadView(node: ADFNode, _context: RenderContext): ReadViewNode {
    const text = (node.attrs?.text as string) || "";
    const color = (node.attrs?.color as string) || "neutral";
    const colorMap: Record<string, string> = {
      neutral: "#565f89",
      purple: "#bb9af7",
      blue: "#7aa2f7",
      red: "#f7768e",
      yellow: "#e0af68",
      green: "#9ece6a",
    };

    return {
      content: `[${text}]`,
      style: {
        fg: colorMap[color] || colorMap.neutral,
        bold: true,
      },
      sourceNode: node,
    };
  }
}

// Emoji component
class EmojiComponent extends BaseMarkdownComponent {
  type = "emoji";

  canRender(node: ADFNode): boolean {
    return node.type === "emoji";
  }

  toMarkdown(node: ADFNode, _context: RenderContext): string {
    const shortName = (node.attrs?.shortName as string) || "";
    const text = (node.attrs?.text as string) || shortName;
    return text || `:${shortName}:`;
  }

  toReadView(node: ADFNode, _context: RenderContext): ReadViewNode {
    const text = (node.attrs?.text as string) || "";
    const shortName = (node.attrs?.shortName as string) || "";
    return {
      content: text || `:${shortName}:`,
      sourceNode: node,
    };
  }
}

// Mention component
class MentionComponent extends BaseMarkdownComponent {
  type = "mention";

  canRender(node: ADFNode): boolean {
    return node.type === "mention";
  }

  toMarkdown(node: ADFNode, _context: RenderContext): string {
    const text = (node.attrs?.text as string) || "";
    return `@${text}`;
  }

  toReadView(node: ADFNode, _context: RenderContext): ReadViewNode {
    const text = (node.attrs?.text as string) || "";
    return {
      content: `@${text}`,
      style: { fg: "#7aa2f7", bold: true },
      sourceNode: node,
    };
  }
}

// Date component
class DateComponent extends BaseMarkdownComponent {
  type = "date";

  canRender(node: ADFNode): boolean {
    return node.type === "date";
  }

  toMarkdown(node: ADFNode, _context: RenderContext): string {
    const timestamp = node.attrs?.timestamp as number;
    if (timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleDateString();
    }
    return "[Date]";
  }

  toReadView(node: ADFNode, _context: RenderContext): ReadViewNode {
    const timestamp = node.attrs?.timestamp as number;
    let content = "[Date]";
    if (timestamp) {
      const date = new Date(timestamp);
      content = date.toLocaleDateString();
    }
    return {
      content,
      style: { fg: "#7dcfff" },
      sourceNode: node,
    };
  }
}

// Create and export all components
export function createComponentRegistry(): Map<string, MarkdownComponent> {
  const components = new Map<string, MarkdownComponent>();

  const allComponents: MarkdownComponent[] = [
    new DocumentComponent(),
    new ParagraphComponent(),
    new TextComponent(),
    new HeadingComponent(),
    new BulletListComponent(),
    new OrderedListComponent(),
    new ListItemComponent(),
    new CodeBlockComponent(),
    new BlockquoteComponent(),
    new RuleComponent(),
    new HardBreakComponent(),
    new PanelComponent(),
    new DecisionListComponent(),
    new DecisionItemComponent(),
    new TaskListComponent(),
    new TaskItemComponent(),
    new TableComponent(),
    new TableRowComponent(),
    new TableCellComponent(),
    new TableHeaderComponent(),
    new MediaSingleComponent(),
    new MediaComponent(),
    new ExpandComponent(),
    new StatusComponent(),
    new EmojiComponent(),
    new MentionComponent(),
    new DateComponent(),
  ];

  for (const component of allComponents) {
    components.set(component.type, component);
  }

  return components;
}

export function createRenderContext(
  components: Map<string, MarkdownComponent>
): RenderContext {
  return {
    indent: 0,
    listDepth: 0,
    inCodeBlock: false,
    components,
  };
}

export { renderUnknown, createUnknownReadViewNode };
