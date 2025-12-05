import type { ADFDocument, ADFNode, ADFMark } from "./types";
import { logger } from "./logger";

/**
 * Markdown to ADF Parser
 * Parses markdown text and converts it to Atlassian Document Format (ADF)
 */

interface ParseContext {
  lines: string[];
  currentLine: number;
}

/**
 * Parse markdown text into an ADF document
 */
export function parseMarkdownToADF(markdown: string): ADFDocument {
  const lines = markdown.split("\n");
  const context: ParseContext = {
    lines,
    currentLine: 0,
  };

  const content: ADFNode[] = [];

  while (context.currentLine < context.lines.length) {
    const node = parseBlock(context);
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

/**
 * Parse a block-level element
 */
function parseBlock(context: ParseContext): ADFNode | null {
  const line = context.lines[context.currentLine] || "";

  // Skip empty lines
  if (line.trim() === "") {
    context.currentLine++;
    return null;
  }

  // Code block (```language)
  if (line.startsWith("```")) {
    return parseCodeBlock(context);
  }

  // Heading (# ## ### etc)
  const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    context.currentLine++;
    return parseHeading(headingMatch[1]!.length, headingMatch[2] || "");
  }

  // Horizontal rule (---)
  if (line.match(/^-{3,}$/) || line.match(/^\*{3,}$/) || line.match(/^_{3,}$/)) {
    context.currentLine++;
    return { type: "rule" };
  }

  // Blockquote (> text)
  if (line.startsWith("> ") || line === ">") {
    return parseBlockquote(context);
  }

  // Task list item (- [ ] or - [x])
  const taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
  if (taskMatch) {
    return parseTaskList(context);
  }

  // Unordered list (- or *)
  if (line.match(/^[-*]\s+/)) {
    return parseBulletList(context);
  }

  // Ordered list (1. 2. etc)
  if (line.match(/^\d+\.\s+/)) {
    return parseOrderedList(context);
  }

  // Table (| col | col |)
  if (line.match(/^\|.*\|$/)) {
    return parseTable(context);
  }

  // Default: paragraph
  return parseParagraph(context);
}

/**
 * Parse a heading
 */
function parseHeading(level: number, text: string): ADFNode {
  return {
    type: "heading",
    attrs: { level },
    content: parseInlineContent(text),
  };
}

/**
 * Parse a code block
 */
function parseCodeBlock(context: ParseContext): ADFNode {
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
    type: "codeBlock",
    attrs: language ? { language } : undefined,
    content: [
      {
        type: "text",
        text: codeLines.join("\n"),
      },
    ],
  };
}

/**
 * Parse a blockquote
 */
function parseBlockquote(context: ParseContext): ADFNode {
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

  const quotedContent = lines.join("\n");
  const quotedContext: ParseContext = {
    lines: quotedContent.split("\n"),
    currentLine: 0,
  };

  const content: ADFNode[] = [];
  while (quotedContext.currentLine < quotedContext.lines.length) {
    const node = parseBlock(quotedContext);
    if (node) {
      content.push(node);
    }
  }

  return {
    type: "blockquote",
    content: content.length > 0 ? content : [{ type: "paragraph", content: [] }],
  };
}

/**
 * Parse a bullet list
 */
function parseBulletList(context: ParseContext): ADFNode {
  const items: ADFNode[] = [];

  while (context.currentLine < context.lines.length) {
    const line = context.lines[context.currentLine] || "";
    const match = line.match(/^([-*])\s+(.*)$/);

    if (!match) break;

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
    type: "bulletList",
    content: items,
  };
}

/**
 * Parse an ordered list
 */
function parseOrderedList(context: ParseContext): ADFNode {
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
    type: "orderedList",
    content: items,
  };
}

/**
 * Parse a task list
 */
function parseTaskList(context: ParseContext): ADFNode {
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
    type: "taskList",
    attrs: { localId: crypto.randomUUID() },
    content: items,
  };
}

/**
 * Parse a table
 */
function parseTable(context: ParseContext): ADFNode {
  const rows: ADFNode[] = [];
  let isFirstRow = true;
  let skipNextLine = false;

  while (context.currentLine < context.lines.length) {
    const line = context.lines[context.currentLine] || "";

    if (!line.match(/^\|.*\|$/)) break;

    // Skip separator line (| --- | --- |)
    if (line.match(/^\|[\s-:|]+\|$/)) {
      context.currentLine++;
      skipNextLine = false;
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
    type: "table",
    attrs: {
      isNumberColumnEnabled: false,
      layout: "default",
    },
    content: rows,
  };
}

/**
 * Parse a paragraph
 */
function parseParagraph(context: ParseContext): ADFNode {
  const lines: string[] = [];

  while (context.currentLine < context.lines.length) {
    const line = context.lines[context.currentLine] || "";

    // Stop at empty line or block-level element
    if (
      line.trim() === "" ||
      line.startsWith("#") ||
      line.startsWith("```") ||
      line.startsWith("> ") ||
      line.match(/^[-*]\s+/) ||
      line.match(/^\d+\.\s+/) ||
      line.match(/^-{3,}$/) ||
      line.match(/^\|.*\|$/)
    ) {
      break;
    }

    lines.push(line);
    context.currentLine++;
  }

  const text = lines.join("\n");
  return {
    type: "paragraph",
    content: parseInlineContent(text),
  };
}

/**
 * Parse inline content (text with marks like bold, italic, code, links)
 */
function parseInlineContent(text: string): ADFNode[] {
  if (!text || text.trim() === "") {
    return [];
  }

  const nodes: ADFNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Try to match inline patterns
    const result = matchInlinePattern(remaining);

    if (result) {
      // Add any text before the match
      if (result.before) {
        nodes.push({ type: "text", text: result.before });
      }

      // Add the matched node
      nodes.push(result.node);

      // Continue with remaining text
      remaining = result.after;
    } else {
      // No patterns matched, add remaining as plain text
      nodes.push({ type: "text", text: remaining });
      break;
    }
  }

  return nodes;
}

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
 * Utility to create an ADF document from parsed content
 */
export function createADFDocument(content: ADFNode[]): ADFDocument {
  return {
    type: "doc",
    version: 1,
    content,
  };
}
