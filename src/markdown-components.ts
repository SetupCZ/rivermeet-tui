import type {
  ADFDocument,
  ADFNode,
  MarkdownComponent,
  ParseContext,
  ParseResult,
  ReadViewNode,
  RenderContext,
} from "./types";
import {logger} from './logger.ts'

// ============================================================================
// Inline Parsing Utilities
// ============================================================================

interface InlineMatchResult {
  before: string;
  node: ADFNode;
  after: string;
}

/**
 * Try to match inline patterns (bold, italic, code, links, etc.)
 */
function matchInlinePattern(text: string): InlineMatchResult | null {
  // Inline code (`code`)
  const codeMatch = text.match(/^(.*?)`([^`]+)`(.*)$/s);
  if (codeMatch) {
    return {
      before: codeMatch[1] || "",
      node: {
        type: "text",
        text: codeMatch[2] || "",
        marks: [{ type: "code" }],
      },
      after: codeMatch[3] || "",
    };
  }

  // Bold + Italic (***text*** or ___text___)
  const boldItalicMatch = text.match(/^(.*?)\*\*\*(.+?)\*\*\*(.*)$/s) ||
    text.match(/^(.*?)___(.+?)___(.*)$/s);
  if (boldItalicMatch) {
    return {
      before: boldItalicMatch[1] || "",
      node: {
        type: "text",
        text: boldItalicMatch[2] || "",
        marks: [{ type: "strong" }, { type: "em" }],
      },
      after: boldItalicMatch[3] || "",
    };
  }

  // Bold (**text** or __text__)
  const boldMatch = text.match(/^(.*?)\*\*(.+?)\*\*(.*)$/s) ||
    text.match(/^(.*?)__(.+?)__(.*)$/s);
  if (boldMatch) {
    return {
      before: boldMatch[1] || "",
      node: {
        type: "text",
        text: boldMatch[2] || "",
        marks: [{ type: "strong" }],
      },
      after: boldMatch[3] || "",
    };
  }

  // Italic (*text* or _text_) - be careful not to match ** or __
  const italicMatch = text.match(/^(.*?)(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)(.*)$/s) ||
    text.match(/^(.*?)(?<!_)_(?!_)(.+?)(?<!_)_(?!_)(.*)$/s);
  if (italicMatch) {
    return {
      before: italicMatch[1] || "",
      node: {
        type: "text",
        text: italicMatch[2] || "",
        marks: [{ type: "em" }],
      },
      after: italicMatch[3] || "",
    };
  }

  // Strikethrough (~~text~~)
  const strikeMatch = text.match(/^(.*?)~~(.+?)~~(.*)$/s);
  if (strikeMatch) {
    return {
      before: strikeMatch[1] || "",
      node: {
        type: "text",
        text: strikeMatch[2] || "",
        marks: [{ type: "strike" }],
      },
      after: strikeMatch[3] || "",
    };
  }

  // Link ([text](url))
  const linkMatch = text.match(/^(.*?)\[([^\]]+)\]\(([^)]+)\)(.*)$/s);
  if (linkMatch) {
    return {
      before: linkMatch[1] || "",
      node: {
        type: "text",
        text: linkMatch[2] || "",
        marks: [{ type: "link", attrs: { href: linkMatch[3] || "" } }],
      },
      after: linkMatch[4] || "",
    };
  }

  // Hard break (two spaces at end of line or explicit \n)
  const hardBreakMatch = text.match(/^(.*?)  \n(.*)$/s);
  if (hardBreakMatch) {
    return {
      before: hardBreakMatch[1] || "",
      node: { type: "hardBreak" },
      after: hardBreakMatch[2] || "",
    };
  }

  return null;
}

/**
 * Parse inline content (text with marks like bold, italic, code, links)
 */
export function parseInlineContent(text: string): ADFNode[] {
  if (!text || text.trim() === "") {
    return [];
  }

  const nodes: ADFNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const result = matchInlinePattern(remaining);

    if (result) {
      if (result.before) {
        nodes.push({ type: "text", text: result.before });
      }
      nodes.push(result.node);
      remaining = result.after;
    } else {
      nodes.push({ type: "text", text: remaining });
      break;
    }
  }

  return nodes;
}

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
export function renderUnknown(node: ADFNode): string {
  return `\n\`\`\`json [Unknown Component: ${node.type}]\n${JSON.stringify(node, null, 2)}\n\`\`\`\n`;
}

export function createUnknownReadViewNode(node: ADFNode): ReadViewNode {
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
        // { content: "\n", sourceNode: node }, // Single line break after paragraph
      ],
      sourceNode: node,
    };
  }

  // Paragraph is the default fallback - it can parse any non-block line
  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    // Don't match empty lines (handled separately) or known block elements
    return line.trim() !== "";
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    const lines: string[] = [];

    while (context.currentLine < context.lines.length) {
      const line = context.lines[context.currentLine] || "";

      // Stop at empty line or block-level element
      if (
        line.trim() === "" ||
        line.startsWith("#") ||
        line.startsWith("```") ||
        line.startsWith("> ") ||
        line === ">" ||
        /^[-*]\s+/.test(line) ||
        /^\d+\.\s+/.test(line) ||
        /^-{3,}$/.test(line) ||
        /^\*{3,}$/.test(line) ||
        /^_{3,}$/.test(line) ||
        /^\|.*\|$/.test(line)
      ) {
        break;
      }

      lines.push(line);
      context.currentLine++;
    }

    const text = lines.join("\n");
    return {
      node: {
        type: "paragraph",
        content: parseInlineContent(text),
      },
      consumed: true,
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
      content: node.text || "",
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
        size: 25 + 1.1 * level
      },
      children: this.renderChildrenReadView(node.content, context),
      sourceNode: node,
    };
  }

  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    return /^#{1,6}\s+/.test(line);
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    const line = context.lines[context.currentLine] || "";
    const match = line.match(/^(#{1,6})\s+(.*)$/);

    if (!match) {
      return { node: null, consumed: false };
    }

    context.currentLine++;
    const level = match[1]!.length;
    const text = match[2] || "";

    return {
      node: {
        type: "heading",
        attrs: { level },
        content: parseInlineContent(text),
      },
      consumed: true,
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

  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    // Match bullet lists but NOT task lists (- [ ] or - [x])
    return /^[-*]\s+/.test(line) && !/^[-*]\s+\[[ xX]\]/.test(line);
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    const items: ADFNode[] = [];

    while (context.currentLine < context.lines.length) {
      const line = context.lines[context.currentLine] || "";
      const match = line.match(/^([-*])\s+(.*)$/);

      if (!match || /^[-*]\s+\[[ xX]\]/.test(line)) break;

      context.currentLine++;
      const itemContent = match[2] || "";

      items.push({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: parseInlineContent(itemContent),
          },
        ],
      });
    }

    return {
      node: {
        type: "bulletList",
        content: items,
      },
      consumed: true,
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

  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    return /^\d+\.\s+/.test(line);
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    const items: ADFNode[] = [];

    while (context.currentLine < context.lines.length) {
      const line = context.lines[context.currentLine] || "";
      const match = line.match(/^\d+\.\s+(.*)$/);

      if (!match) break;

      context.currentLine++;
      const itemContent = match[1] || "";

      items.push({
        type: "listItem",
        content: [
          {
            type: "paragraph",
            content: parseInlineContent(itemContent),
          },
        ],
      });
    }

    return {
      node: {
        type: "orderedList",
        content: items,
      },
      consumed: true,
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

    logger.debug("ListItem", {
      content: `${indent}${marker} `,
      nodeContent: node.content
    })
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

  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    return line.startsWith("```");
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    const firstLine = context.lines[context.currentLine] || "";
    const language = firstLine.slice(3).trim();
    context.currentLine++;

    const codeLines: string[] = [];

    while (context.currentLine < context.lines.length) {
      const line = context.lines[context.currentLine] || "";
      if (line.startsWith("```")) {
        context.currentLine++;
        break;
      }
      codeLines.push(line);
      context.currentLine++;
    }

    return {
      node: {
        type: "codeBlock",
        attrs: language ? { language } : undefined,
        content: [
          {
            type: "text",
            text: codeLines.join("\n"),
          },
        ],
      },
      consumed: true,
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

  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    return line.startsWith("> ") || line === ">";
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    const lines: string[] = [];

    while (context.currentLine < context.lines.length) {
      const line = context.lines[context.currentLine] || "";
      if (line.startsWith("> ")) {
        lines.push(line.slice(2));
        context.currentLine++;
      } else if (line === ">") {
        lines.push("");
        context.currentLine++;
      } else {
        break;
      }
    }

    // Parse the quoted content recursively
    const quotedContent = lines.join("\n");
    const quotedContext: ParseContext = {
      lines: quotedContent.split("\n"),
      currentLine: 0,
      components: context.components,
    };

    const content: ADFNode[] = [];
    while (quotedContext.currentLine < quotedContext.lines.length) {
      const node = parseBlockWithContext(quotedContext);
      if (node) {
        content.push(node);
      }
    }

    return {
      node: {
        type: "blockquote",
        content: content.length > 0 ? content : [{ type: "paragraph", content: [] }],
      },
      consumed: true,
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

  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    return /^-{3,}$/.test(line) || /^\*{3,}$/.test(line) || /^_{3,}$/.test(line);
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    context.currentLine++;
    return {
      node: { type: "rule" },
      consumed: true,
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

  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    return /^[-*]\s+\[[ xX]\]\s+/.test(line);
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    const items: ADFNode[] = [];

    while (context.currentLine < context.lines.length) {
      const line = context.lines[context.currentLine] || "";
      const match = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);

      if (!match) break;

      context.currentLine++;
      const checked = match[1]?.toLowerCase() === "x";
      const itemContent = match[2] || "";

      items.push({
        type: "taskItem",
        attrs: {
          state: checked ? "DONE" : "TODO",
          localId: crypto.randomUUID(),
        },
        content: parseInlineContent(itemContent),
      });
    }

    return {
      node: {
        type: "taskList",
        attrs: { localId: crypto.randomUUID() },
        content: items,
      },
      consumed: true,
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

  canParse(context: ParseContext): boolean {
    const line = context.lines[context.currentLine] || "";
    return /^\|.*\|$/.test(line);
  }

  parseFromMarkdown(context: ParseContext): ParseResult {
    const rows: ADFNode[] = [];
    let isFirstRow = true;

    while (context.currentLine < context.lines.length) {
      const line = context.lines[context.currentLine] || "";

      if (!/^\|.*\|$/.test(line)) break;

      // Skip separator line (| --- | --- |)
      if (/^\|[\s-:|]+\|$/.test(line)) {
        context.currentLine++;
        continue;
      }

      const cells = line
        .slice(1, -1) // Remove leading and trailing |
        .split("|")
        .map((cell) => cell.trim());

      const cellType = isFirstRow ? "tableHeader" : "tableCell";

      rows.push({
        type: "tableRow",
        content: cells.map((cellContent) => ({
          type: cellType,
          content: [
            {
              type: "paragraph",
              content: parseInlineContent(cellContent),
            },
          ],
        })),
      });

      isFirstRow = false;
      context.currentLine++;
    }

    return {
      node: {
        type: "table",
        attrs: {
          isNumberColumnEnabled: false,
          layout: "default",
        },
        content: rows,
      },
      consumed: true,
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

// ============================================================================
// Markdown → ADF Parsing
// ============================================================================

// Order matters! More specific patterns should come before less specific ones.
// e.g., TaskList (- [ ]) before BulletList (- )
const parsingComponents = [
  "codeBlock",    // ```
  "heading",      // #
  "rule",         // ---
  "blockquote",   // >
  "taskList",     // - [ ] or - [x]
  "bulletList",   // - or *
  "orderedList",  // 1.
  "table",        // |
  "paragraph",    // default fallback
];

/**
 * Parse a block using the component registry
 */
function parseBlockWithContext(context: ParseContext): ADFNode | null {
  const line = context.lines[context.currentLine] || "";

  // Skip empty lines
  if (line.trim() === "") {
    context.currentLine++;
    return null;
  }

  // Try each parsing component in order
  for (const componentType of parsingComponents) {
    const component = context.components.get(componentType);
    if (component?.canParse?.(context)) {
      const result = component.parseFromMarkdown!(context);
      if (result.consumed && result.node) {
        return result.node;
      }
    }
  }

  // This shouldn't happen if paragraph is in the list, but just in case
  context.currentLine++;
  return null;
}

/**
 * Create a parse context with the component registry
 */
function createParseContext(lines: string[]): ParseContext {
  return {
    lines,
    currentLine: 0,
    components: createComponentRegistry(),
  };
}

/**
 * Parse markdown text into an ADF document
 */
export function parseMarkdownToADF(markdown: string): ADFDocument {
  const lines = markdown.split("\n");
  const context = createParseContext(lines);

  const content: ADFNode[] = [];

  while (context.currentLine < context.lines.length) {
    const node = parseBlockWithContext(context);
    if (node) {
      content.push(node);
    }
  }

  return {
    type: "doc",
    version: 1,
    content,
  };
}

