// Bidirectional conversion between Google Docs structure and Markdown,
// with source mapping to allow Markdown-level edits to be translated back
// to Google Docs batchUpdate operations.

import type {
  GoogleDocsTab, Paragraph, ParagraphElement, StructuralElement, Table, TableCell, TextStyle,
} from "./docs-api";

// ---------------------------------------------------------------------------
// Source map types
// ---------------------------------------------------------------------------

/**
 * The Markdown rendering of one document tab, with the map back to that tab's indices.
 *
 * Every tab body has its own index space, so a snapshot is only ever valid for the tab it was
 * built from — Markdown, source map and end index all restart per tab.
 */
export type DocTabSnapshot = {
  /** The tab this rendering came from; every write derived from it must carry this ID. */
  tabId: string;
  /** Tab name, as shown in the Docs tab list. */
  title: string;
  /** The containing tab, absent for a top-level tab. */
  parentTabId?: string;
  /** Position among the tabs sharing this parent. */
  index: number;
  /** Depth in the tab tree; 0 for a top-level tab. */
  nestingLevel: number;
  /** The Markdown rendering of this tab's content. */
  markdown: string;
  /** Maps Markdown positions back to this tab's Google Docs character indices. */
  sourceMap: SourceMap;
  /** The endIndex of the last structural element in this tab's body. */
  bodyEndIndex: number;
}

export type SourceMap = {
  /** One entry per editable paragraph/heading/list item, in document order. */
  blocks: BlockMapping[];
  /** Rendered structural content that `replaceText()` must not modify or cross. */
  protectedRanges: MarkdownRange[];
}

/** A half-open range in the rendered Markdown string. */
export type MarkdownRange = { mdStart: number; mdEnd: number };

/**
 * Version of this module's rendering. Bump it whenever the Markdown or source map this module
 * produces changes, so callers caching a {@link DocTabSnapshot} discard entries built by older
 * code. It lives here because edits to this file are what invalidate them.
 */
export const MARKDOWN_RENDERING_VERSION = 3;

type ListType = "bullet" | "numbered";

export type BlockMapping = {
  /** Range in the Markdown string [mdStart, mdEnd). */
  mdStart: number;
  mdEnd: number;
  /** Range in Google Docs index space [docStart, docEnd). */
  docStart: number;
  docEnd: number;
  /** Paragraph structure needed to preserve inline-only edits. */
  namedStyleType: string;
  listType: ListType | null;
  listNestingLevel: number;
  /** Fine-grained segments within this block. */
  segments: Segment[];
}

/**
 * A segment maps a range of Markdown characters to Google Docs characters.
 * Content segments have a 1:1 character mapping (since we emit the raw text
 * from the doc). Syntax-only segments represent Markdown syntax characters
 * (like "**", "# ", "- ") that don't exist in the doc.
 */
export type Segment =
  | { mdStart: number; mdEnd: number; docStart: number; docEnd: number; textStyle: TextStyle }
  | { mdStart: number; mdEnd: number; syntaxOnly: true };

type ParagraphListItem = {
  listId: string;
  /** Whether this level numbers its items, derived once from `glyphType`. */
  listType: ListType;
  glyphType: string | undefined;
  glyphSymbol: string | undefined;
  nestingLevel: number;
  startNumber: number;
};
type VisibleParagraphElement = {
  text: string;
  style: TextStyle;
  link?: string;
};

// ---------------------------------------------------------------------------
// Google Docs → Markdown
// ---------------------------------------------------------------------------

/** Convert one document tab to Markdown with a source map into that tab's index space. */
export function docTabToMarkdown(tab: GoogleDocsTab): DocTabSnapshot {
  let md = "";
  let blocks: BlockMapping[] = [];
  let protectedRanges: MarkdownRange[] = [];
  let lastWasListItem = false;

  let elements = tab.body.content;
  let bodyEndIndex = elements.length > 0 ? elements[elements.length - 1].endIndex : 0;

  for (let elem of elements) {
    let structure = elem.table ? tableToHtml(elem.table, tab.lists)
      : elem.tableOfContents ? "[Table of contents]"
      : elem.sectionBreak && elem.startIndex > 0 ? "[Section break]"
      : undefined;
    if (structure !== undefined) {
      let mdStart = md.length;
      if (md.length > 0) md += "\n";
      md += `${structure}\n`;
      protectedRanges.push({ mdStart, mdEnd: md.length });
      lastWasListItem = false;
      continue;
    }
    if (!elem.paragraph) continue;

    let para = elem.paragraph;
    let segments: Segment[] = [];
    let docStart = elem.startIndex;
    let docEnd = elem.endIndex;

    let listItem = paragraphListItem(para, tab.lists);
    let isListItem = listItem !== undefined;

    // Blank line between paragraphs, but not between consecutive list items.
    if (md.length > 0 && !(isListItem && lastWasListItem)) {
      let separatorStart = md.length;
      let previousProtected = protectedRanges.at(-1);
      md += "\n";
      if (previousProtected?.mdEnd === separatorStart) previousProtected.mdEnd = md.length;
    }
    let mdStart = md.length;

    // Paragraph prefix (heading markers, list markers, etc.).
    let prefix = getParagraphPrefix(para, listItem);
    if (prefix) {
      let prefixStart = md.length;
      md += prefix;
      segments.push({ mdStart: prefixStart, mdEnd: md.length, syntaxOnly: true });
    }

    // Emit paragraph content.
    emitParagraphContent(para, segments, () => md.length, (text) => { md += text; });

    // Trailing newline. Every Google Docs paragraph ends with \n in the doc
    // character space. In Markdown, we use \n as the line terminator.
    // The paragraph's trailing \n is already included in the last text run's
    // content, and we handled it in emitParagraphContent by not emitting it.
    // Instead, we add our own Markdown newline here.
    md += "\n";

    let mdEnd = md.length;
    if (para.elements.some(element => !element.textRun)) {
      protectedRanges.push({ mdStart, mdEnd });
    }
    blocks.push({
      mdStart, mdEnd, docStart, docEnd, segments,
      namedStyleType: para.paragraphStyle.namedStyleType,
      listType: listItem?.listType ?? null,
      listNestingLevel: listItem?.nestingLevel ?? 0,
    });
    lastWasListItem = isListItem;
  }

  return {
    tabId: tab.tabId,
    title: tab.title,
    ...tab.parentTabId === undefined ? {} : { parentTabId: tab.parentTabId },
    index: tab.index,
    nestingLevel: tab.nestingLevel,
    markdown: md,
    sourceMap: { blocks, protectedRanges },
    bodyEndIndex,
  };
}

function internalDocsDestination(kind: "bookmark" | "heading", id: string, tabId?: string): string {
  let tab = tabId ? `?tab=${encodeURIComponent(tabId)}` : "";
  return `${tab}#${kind}=${encodeURIComponent(id)}`;
}

function docsLinkDestination(link: TextStyle["link"]): string | undefined {
  if (!link) return undefined;
  if ("url" in link) return link.url;
  if ("tabId" in link) return `?tab=${encodeURIComponent(link.tabId)}`;
  if ("bookmark" in link) {
    return internalDocsDestination("bookmark", link.bookmark.id, link.bookmark.tabId);
  }
  if ("heading" in link) {
    return internalDocsDestination("heading", link.heading.id, link.heading.tabId);
  }
  if ("bookmarkId" in link) return internalDocsDestination("bookmark", link.bookmarkId);
  return internalDocsDestination("heading", link.headingId);
}

function visibleParagraphElement(element: ParagraphElement): VisibleParagraphElement | undefined {
  let textRun = element.textRun;
  if (textRun) {
    return {
      text: textRun.content,
      style: textRun.textStyle,
      link: docsLinkDestination(textRun.textStyle.link),
    };
  }

  let person = element.person;
  let personText = person?.personProperties?.name || person?.personProperties?.email;
  if (personText) return { text: personText, style: person?.textStyle ?? {} };

  let richLink = element.richLink;
  let richLinkText = richLink?.richLinkProperties?.title;
  if (richLinkText) {
    return {
      text: richLinkText,
      style: richLink?.textStyle ?? {},
      link: richLink?.richLinkProperties?.uri,
    };
  }

  let dateElement = element.dateElement;
  let dateText = dateElement?.dateElementProperties?.displayText;
  if (dateText) return { text: dateText, style: dateElement?.textStyle ?? {} };

  let autoText = element.autoText;
  if (autoText) {
    let text: string;
    switch (autoText.type) {
      case "PAGE_NUMBER": text = "[Page number]"; break;
      case "PAGE_COUNT": text = "[Page count]"; break;
      default: text = "[Auto text]";
    }
    return { text, style: autoText.textStyle ?? {} };
  }

  // Elements with no text of their own render as a fixed placeholder.
  if (element.inlineObjectElement) {
    return { text: "[Image]", style: element.inlineObjectElement.textStyle ?? {} };
  }
  if (element.equation) return { text: "[Equation]", style: {} };
  if (element.footnoteReference) {
    let { footnoteNumber, textStyle } = element.footnoteReference;
    return { text: footnoteNumber ? `[${footnoteNumber}]` : "[Footnote]", style: textStyle ?? {} };
  }
  if (element.pageBreak) {
    return { text: "[Page break]", style: element.pageBreak.textStyle ?? {} };
  }
  if (element.columnBreak) {
    return { text: "[Column break]", style: element.columnBreak.textStyle ?? {} };
  }

  return undefined;
}

/** Render a table as raw HTML, which Markdown preserves without inventing a header row. */
function tableToHtml(table: Table, lists: GoogleDocsTab["lists"]): string {
  let lines = ["<table>"];
  for (let row of table.tableRows ?? []) {
    lines.push("  <tr>");
    for (let cell of row.tableCells ?? []) {
      lines.push(tableCellToHtml(cell, lists));
    }
    lines.push("  </tr>");
  }
  lines.push("</table>");
  return lines.join("\n");
}

function tableCellToHtml(cell: TableCell, lists: GoogleDocsTab["lists"]): string {
  let style = cell.tableCellStyle;
  let attributes = htmlIntegerAttribute("rowspan", style?.rowSpan) +
    htmlIntegerAttribute("colspan", style?.columnSpan);
  let elements = cell.content ?? [];
  let parts: string[] = [];
  for (let index = 0; index < elements.length;) {
    let paragraph = elements[index].paragraph;
    let item = paragraph && paragraphListItem(paragraph, lists);
    if (item) {
      let list = tableListToHtml(elements, index, lists, item);
      parts.push(list.html);
      index = list.nextIndex;
      continue;
    }
    let part = tableCellElementToHtml(elements[index], lists);
    if (part !== undefined) parts.push(part);
    index++;
  }
  let content = parts.join("\n");
  if (!content.includes("\n")) return `    <td${attributes}>${content}</td>`;
  return `    <td${attributes}>\n${indentHtml(content, 6)}\n    </td>`;
}

function tableListToHtml(
  elements: StructuralElement[],
  startIndex: number,
  lists: GoogleDocsTab["lists"],
  first: ParagraphListItem,
): { html: string; nextIndex: number } {
  let tag = first.listType === "numbered" ? "ol" : "ul";
  let html = htmlListOpeningTag(first);
  let index = startIndex;

  while (index < elements.length) {
    let paragraph = elements[index].paragraph;
    if (!paragraph) break;
    let item = paragraphListItem(paragraph, lists);
    if (!item || item.listId !== first.listId || item.nestingLevel !== first.nestingLevel ||
        item.listType !== first.listType) break;

    let glyph = item.listType === "bullet" && item.glyphSymbol
      ? `${escapeHtml(item.glyphSymbol)} ` : "";
    html += `<li>${glyph}${tableParagraphContentToHtml(paragraph)}`;
    index++;
    while (index < elements.length) {
      let nestedParagraph = elements[index].paragraph;
      let nested = nestedParagraph && paragraphListItem(nestedParagraph, lists);
      if (!nested || nested.listId !== first.listId ||
          nested.nestingLevel <= first.nestingLevel) break;
      let child = tableListToHtml(elements, index, lists, nested);
      html += child.html;
      index = child.nextIndex;
    }
    html += "</li>";
  }

  return { html: `${html}</${tag}>`, nextIndex: index };
}

function tableCellElementToHtml(
  element: StructuralElement,
  lists: GoogleDocsTab["lists"],
): string | undefined {
  if (element.table) return tableToHtml(element.table, lists);
  if (!element.paragraph) return undefined;
  let paragraph = element.paragraph;
  if (paragraph.elements.some(part => part.horizontalRule)) return "<hr>";
  let content = tableParagraphContentToHtml(paragraph);
  let headingLevel = paragraphHeadingLevel(paragraph);
  let tag = headingLevel ? `h${headingLevel}` : "p";
  return `<${tag}>${content}</${tag}>`;
}

function tableParagraphContentToHtml(paragraph: Paragraph): string {
  let inheritedItalic = paragraph.paragraphStyle.namedStyleType === "SUBTITLE";
  let content = "";
  let italic = false;
  for (let [index, part] of paragraph.elements.entries()) {
    let visible = visibleParagraphElement(part);
    if (!visible) continue;
    let text = visible.text;
    if (part.textRun && index === paragraph.elements.length - 1) text = text.replace(/\n$/, "");
    if (!text) continue;
    let nextItalic = inheritedItalic && (visible.style.italic ?? true);
    if (nextItalic !== italic) content += nextItalic ? "<em>" : "</em>";
    content += styledTextToHtml(text, visible.style, visible.link, !inheritedItalic);
    italic = nextItalic;
  }
  return content + (italic ? "</em>" : "");
}

function styledTextToHtml(
  text: string,
  style: TextStyle,
  link = docsLinkDestination(style.link),
  renderItalic = true,
): string {
  if (!text) return "";
  let html = escapeHtml(text);
  if (style.strikethrough) html = `<s>${html}</s>`;
  if (renderItalic && style.italic) html = `<em>${html}</em>`;
  if (style.bold) html = `<strong>${html}</strong>`;
  if (link) html = `<a href="${escapeHtmlAttribute(link)}">${html}</a>`;
  return html;
}

function htmlListStartAttribute(value: number): string {
  return Number.isInteger(value) && value !== 1 ? ` start="${value}"` : "";
}

function htmlOrderedListType(glyphType: string): string | undefined {
  switch (glyphType) {
    case "ALPHA": return "a";
    case "UPPER_ALPHA": return "A";
    case "ROMAN": return "i";
    case "UPPER_ROMAN": return "I";
    default: return undefined;
  }
}

function htmlListOpeningTag(item: ParagraphListItem): string {
  if (item.glyphType === undefined) {
    return `<ul${item.glyphSymbol ? ' style="list-style-type: none"' : ""}>`;
  }

  let type = htmlOrderedListType(item.glyphType);
  let typeAttribute = type ? ` type="${type}"` : "";
  let style = item.glyphType === "ZERO_DECIMAL"
    ? ' style="list-style-type: decimal-leading-zero"' : "";
  return `<ol${typeAttribute}${style}${htmlListStartAttribute(item.startNumber)}>`;
}

function htmlIntegerAttribute(name: string, value: number | undefined): string {
  return typeof value === "number" && Number.isInteger(value) && value > 1
    ? ` ${name}="${value}"` : "";
}

/**
 * Escape only what changes how the table markup parses. Deliberately narrower than the kit's
 * `escapeHtml()`: this output is read by an agent, so quotes and apostrophes in cell prose stay
 * as typed rather than becoming entities.
 */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]{}()#+\-.!|>~]/g, "\\$&");
}

function escapeMarkdownLinkDestination(url: string): string {
  return url.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function indentHtml(text: string, spaces: number): string {
  let prefix = " ".repeat(spaces);
  return prefix + text.replaceAll("\n", `\n${prefix}`);
}

/** Determine the Markdown prefix for a paragraph based on its style. */
function getParagraphPrefix(para: Paragraph, listItem: ParagraphListItem | undefined): string {
  if (listItem) {
    let indent = "  ".repeat(listItem.nestingLevel);
    return listItem.listType === "numbered" ? `${indent}1. ` : `${indent}- `;
  }
  let headingLevel = paragraphHeadingLevel(para);
  return headingLevel ? `${"#".repeat(headingLevel)} ` : "";
}

function paragraphListItem(
  paragraph: Paragraph,
  lists: GoogleDocsTab["lists"],
): ParagraphListItem | undefined {
  let bullet = paragraph.bullet;
  if (!bullet) return undefined;
  let nestingLevel = bullet.nestingLevel ?? 0;
  let level = lists[bullet.listId]?.listProperties.nestingLevels[nestingLevel];
  return {
    listId: bullet.listId,
    listType: level?.glyphType !== undefined ? "numbered" : "bullet",
    glyphType: level?.glyphType,
    glyphSymbol: level?.glyphSymbol,
    nestingLevel,
    startNumber: level?.startNumber ?? 1,
  };
}

function paragraphHeadingLevel(paragraph: Paragraph): number | undefined {
  switch (paragraph.paragraphStyle.namedStyleType) {
    case "TITLE":
    case "HEADING_1": return 1;
    case "HEADING_2": return 2;
    case "HEADING_3": return 3;
    case "HEADING_4": return 4;
    case "HEADING_5": return 5;
    case "HEADING_6": return 6;
    default: return undefined;
  }
}

/**
 * Emit the content of a paragraph's elements, tracking formatting transitions
 * and recording source map segments.
 *
 * We track open/close state for each formatting type (bold, italic, etc.)
 * and emit Markdown markers at transitions.
 */
function emitParagraphContent(
  para: Paragraph,
  segments: Segment[],
  getMdPos: () => number,
  emit: (text: string) => void,
): void {
  // Track which formatting is currently "open" in the Markdown output.
  let currentBold = false;
  let currentItalic = false;
  let currentStrikethrough = false;
  let currentLink: string | undefined = undefined;

  let isSubtitle = para.paragraphStyle.namedStyleType === "SUBTITLE";

  for (let element of para.elements) {
    if (element.horizontalRule) {
      let pos = getMdPos();
      emit("<hr>");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      continue;
    }

    let visible = visibleParagraphElement(element);
    if (!visible) continue;

    let { style } = visible;
    let text = visible.text;
    if (!element.textRun) text = escapeMarkdownText(text);
    let docStart = element.startIndex;

    let isLastElement = element === para.elements[para.elements.length - 1];
    if (element.textRun && isLastElement && text.endsWith("\n")) {
      text = text.slice(0, -1);
    }

    if (text.length === 0) continue;

    let wantBold = !!style.bold;
    let wantItalic = style.italic ?? isSubtitle;
    let wantStrikethrough = !!style.strikethrough;
    let wantLink = visible.link;

    // Close formatting that is no longer wanted (reverse order of opening).
    if (currentLink && currentLink !== wantLink) {
      let pos = getMdPos();
      emit(`](${escapeMarkdownLinkDestination(currentLink)})`);
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentLink = undefined;
    }
    if (currentStrikethrough && !wantStrikethrough) {
      let pos = getMdPos();
      emit("~~");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentStrikethrough = false;
    }
    if (currentBold && !wantBold) {
      let pos = getMdPos();
      emit("**");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentBold = false;
    }
    if (currentItalic && !wantItalic) {
      let pos = getMdPos();
      emit("*");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentItalic = false;
    }

    // Open formatting that is newly wanted.
    if (wantItalic && !currentItalic) {
      let pos = getMdPos();
      emit("*");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentItalic = true;
    }
    if (wantBold && !currentBold) {
      let pos = getMdPos();
      emit("**");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentBold = true;
    }
    if (wantStrikethrough && !currentStrikethrough) {
      let pos = getMdPos();
      emit("~~");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentStrikethrough = true;
    }
    if (wantLink && !currentLink) {
      let pos = getMdPos();
      emit("[");
      segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
      currentLink = wantLink;
    }

    let mdContentStart = getMdPos();
    emit(text);
    let mdContentEnd = getMdPos();
    if (element.textRun) {
      segments.push({
        mdStart: mdContentStart,
        mdEnd: mdContentEnd,
        docStart,
        docEnd: docStart + text.length,
        textStyle: style,
      });
    } else {
      segments.push({ mdStart: mdContentStart, mdEnd: mdContentEnd, syntaxOnly: true });
    }
  }

  // Close any remaining open formatting at end of paragraph.
  if (currentLink) {
    let pos = getMdPos();
    emit(`](${escapeMarkdownLinkDestination(currentLink)})`);
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
  if (currentStrikethrough) {
    let pos = getMdPos();
    emit("~~");
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
  if (currentBold) {
    let pos = getMdPos();
    emit("**");
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
  if (currentItalic) {
    let pos = getMdPos();
    emit("*");
    segments.push({ mdStart: pos, mdEnd: getMdPos(), syntaxOnly: true });
  }
}

// ---------------------------------------------------------------------------
// Markdown → Google Docs batchUpdate requests
// ---------------------------------------------------------------------------

/** Parsed representation of a Markdown block. */
type ParsedBlock = {
  /** Plain text content (no Markdown syntax). */
  plainText: string;
  /** Paragraph style: heading level (1-6), or null for normal text. */
  headingLevel: number | null;
  /** If this is a list item: "bullet" or "numbered". */
  listType: ListType | null;
  /** Nesting level for list items (0-based). */
  nestingLevel: number;
  /** Inline formatting spans, relative to plainText. */
  spans: FormattingSpan[];
}

type FormattingSpan = {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: string;
}

/**
 * Parse a Markdown string into blocks. This is a simple parser that handles
 * the subset of Markdown we support.
 *
 * Unlike standard Markdown, we preserve blank lines as empty blocks so that
 * they produce empty paragraphs in Google Docs. This ensures that `\n\n` in
 * the input produces two paragraph breaks (i.e., a visible blank line) in
 * the document, rather than collapsing to a single paragraph break.
 */
function parseMarkdown(markdown: string): ParsedBlock[] {
  let blocks: ParsedBlock[] = [];

  let lines = markdown.split("\n");
  // Track whether we just flushed content lines, so we know when a blank
  // line follows content (= paragraph separator) vs. additional blank lines
  // (= empty paragraphs).
  let currentLines: string[] = [];
  let justFlushed = false;

  function flushBlock() {
    if (currentLines.length === 0) return;
    let blockText = currentLines.join("\n");
    currentLines = [];

    // Each line could be a heading or list item on its own, so split them.
    let sublines = blockText.split("\n");
    for (let line of sublines) {
      if (line.length === 0) continue;
      blocks.push(parseLine(line));
    }
    justFlushed = true;
  }

  for (let line of lines) {
    if (line.trim() === "") {
      flushBlock();
      if (justFlushed) {
        // First blank line after content is the normal paragraph separator
        // (already handled by the \n between blocks in the output). Reset
        // the flag so subsequent blank lines produce empty paragraphs.
        justFlushed = false;
      } else {
        // Additional blank line — emit an empty block so it becomes an
        // empty paragraph (\n) in the document.
        blocks.push({
          plainText: "",
          headingLevel: null,
          listType: null,
          nestingLevel: 0,
          spans: [],
        });
      }
    } else {
      currentLines.push(line);
      justFlushed = false;
    }
  }
  flushBlock();

  return blocks;
}

/** Parse a single line of Markdown into a ParsedBlock. */
function parseLine(line: string): ParsedBlock {
  let headingLevel: number | null = null;
  let listType: "bullet" | "numbered" | null = null;
  let nestingLevel = 0;
  let content = line;

  // Check for heading prefix.
  let headingMatch = content.match(/^(#{1,6}) /);
  if (headingMatch) {
    headingLevel = headingMatch[1].length;
    content = content.slice(headingMatch[0].length);
  }

  // Check for list item prefix (with optional indentation).
  if (headingLevel === null) {
    let bulletMatch = content.match(/^( *)- /);
    let numberedMatch = content.match(/^( *)(\d+)\. /);
    if (bulletMatch) {
      listType = "bullet";
      nestingLevel = Math.floor(bulletMatch[1].length / 2);
      content = content.slice(bulletMatch[0].length);
    } else if (numberedMatch?.[2] === "1") {
      listType = "numbered";
      nestingLevel = Math.floor(numberedMatch[1].length / 2);
      content = content.slice(numberedMatch[0].length);
    }
  }

  // Parse inline formatting.
  let { plainText, spans } = parseInlineFormatting(content);

  return { plainText, headingLevel, listType, nestingLevel, spans };
}

function parseLinkDestination(
  text: string,
  start: number,
): { end: number; url: string } | undefined {
  let depth = 0;
  let url = "";
  for (let index = start; index < text.length; index++) {
    let character = text[index];
    let escaped = text[index + 1];
    if (character === "\\" && (escaped === "\\" || escaped === "(" || escaped === ")")) {
      url += escaped;
      index++;
    } else if (character === "(") {
      depth++;
      url += character;
    } else if (character === ")") {
      if (depth === 0) return { end: index, url };
      depth--;
      url += character;
    } else {
      url += character;
    }
  }
  return undefined;
}

/**
 * Match a `[label](url)` link starting at `index`. Shared so that canonicalization and parsing
 * always agree on which spans are links.
 */
function matchMarkdownLink(
  text: string,
  index: number,
): { label: string; url: string; end: number } | undefined {
  if (text[index] !== "[") return undefined;
  let closeBracket = text.indexOf("]", index + 1);
  if (closeBracket === -1 || text[closeBracket + 1] !== "(") return undefined;
  let destination = parseLinkDestination(text, closeBracket + 2);
  if (!destination) return undefined;
  return {
    label: text.slice(index + 1, closeBracket),
    url: destination.url,
    end: destination.end,
  };
}

/** Canonicalize escapes to the form returned by a subsequent document read. */
export function canonicalizeMarkdownEscapes(markdown: string): string {
  let result = "";
  for (let index = 0; index < markdown.length;) {
    let link = matchMarkdownLink(markdown, index);
    if (link) {
      result += `[${canonicalizeMarkdownEscapes(link.label)}]` +
        `(${escapeMarkdownLinkDestination(link.url)})`;
      index = link.end + 1;
      continue;
    }

    let escaped = markdown[index + 1];
    if (markdown[index] === "\\" && escaped && isMarkdownPunctuation(escaped)) {
      result += escaped;
      index += 2;
    } else {
      result += markdown[index++];
    }
  }
  return result;
}

function isMarkdownPunctuation(character: string): boolean {
  let code = character.charCodeAt(0);
  return code >= 0x21 && code <= 0x2f || code >= 0x3a && code <= 0x40 ||
    code >= 0x5b && code <= 0x60 || code >= 0x7b && code <= 0x7e;
}

function startsMarkdownEscape(markdown: string, index: number): boolean {
  if (index < 0 || markdown[index] !== "\\" ||
      !markdown[index + 1] || !isMarkdownPunctuation(markdown[index + 1])) return false;
  let preceding = 0;
  while (markdown[index - preceding - 1] === "\\") preceding++;
  return preceding % 2 === 0;
}

function analyzeMarkdownReplacement(oldMarkdown: string, newMarkdown: string): {
  prefixLen: number;
  suffixLen: number;
  canonicalMarkdown: string;
} {
  let prefixLen = 0;
  while (prefixLen < oldMarkdown.length && prefixLen < newMarkdown.length &&
      oldMarkdown[prefixLen] === newMarkdown[prefixLen]) prefixLen++;
  if (startsMarkdownEscape(newMarkdown, prefixLen - 1)) prefixLen--;

  let suffixLen = 0;
  while (suffixLen < oldMarkdown.length - prefixLen &&
      suffixLen < newMarkdown.length - prefixLen &&
      oldMarkdown[oldMarkdown.length - suffixLen - 1] ===
        newMarkdown[newMarkdown.length - suffixLen - 1]) suffixLen++;
  if (suffixLen > 0 && startsMarkdownEscape(newMarkdown, newMarkdown.length - suffixLen - 1)) {
    suffixLen--;
  }

  let changed = newMarkdown.slice(prefixLen, newMarkdown.length - suffixLen);
  return {
    prefixLen,
    suffixLen,
    canonicalMarkdown: oldMarkdown.slice(0, prefixLen) + canonicalizeMarkdownEscapes(changed) +
      oldMarkdown.slice(oldMarkdown.length - suffixLen),
  };
}

/** Canonicalize changed Markdown while preserving copied document text. */
export function canonicalizeMarkdownReplacement(
  oldMarkdown: string,
  newMarkdown: string,
): string {
  return analyzeMarkdownReplacement(oldMarkdown, newMarkdown).canonicalMarkdown;
}

/**
 * Parse inline Markdown formatting from a string, returning the plain text
 * and an array of formatting spans.
 *
 * Handles: **bold**, *italic*, ***bold+italic***, ~~strikethrough~~, [text](url)
 */
function parseInlineFormatting(text: string): { plainText: string; spans: FormattingSpan[] } {
  let plainText = "";
  let spans: FormattingSpan[] = [];
  let i = 0;

  // Stack of open formatting contexts.
  let formatStack: { type: "bold" | "italic" | "bolditalic" | "strikethrough" | "link"; start: number; url?: string }[] = [];

  while (i < text.length) {
    let escaped = text[i + 1];
    if (text[i] === "\\" && escaped && isMarkdownPunctuation(escaped)) {
      plainText += escaped;
      i += 2;
      continue;
    }

    // Check for link: [text](url)
    let link = matchMarkdownLink(text, i);
    if (link) {
      let start = plainText.length;
      let inner = parseInlineFormatting(link.label);
      plainText += inner.plainText;
      spans.push({ start, end: plainText.length, link: link.url });
      for (let s of inner.spans) {
        spans.push({ ...s, start: start + s.start, end: start + s.end });
      }
      i = link.end + 1;
      continue;
    }

    // Check for bold+italic: ***
    if (text.slice(i, i + 3) === "***") {
      let openIdx = formatStack.findIndex(f => f.type === "bolditalic");
      if (openIdx !== -1) {
        // Closing.
        let open = formatStack.splice(openIdx, 1)[0];
        spans.push({ start: open.start, end: plainText.length, bold: true, italic: true });
      } else {
        formatStack.push({ type: "bolditalic", start: plainText.length });
      }
      i += 3;
      continue;
    }

    // Check for bold: **
    if (text.slice(i, i + 2) === "**") {
      let openIdx = formatStack.findIndex(f => f.type === "bold");
      if (openIdx !== -1) {
        let open = formatStack.splice(openIdx, 1)[0];
        spans.push({ start: open.start, end: plainText.length, bold: true });
      } else {
        formatStack.push({ type: "bold", start: plainText.length });
      }
      i += 2;
      continue;
    }

    // Check for strikethrough: ~~
    if (text.slice(i, i + 2) === "~~") {
      let openIdx = formatStack.findIndex(f => f.type === "strikethrough");
      if (openIdx !== -1) {
        let open = formatStack.splice(openIdx, 1)[0];
        spans.push({ start: open.start, end: plainText.length, strikethrough: true });
      } else {
        formatStack.push({ type: "strikethrough", start: plainText.length });
      }
      i += 2;
      continue;
    }

    // Check for italic: *
    if (text[i] === "*") {
      let openIdx = formatStack.findIndex(f => f.type === "italic");
      if (openIdx !== -1) {
        let open = formatStack.splice(openIdx, 1)[0];
        spans.push({ start: open.start, end: plainText.length, italic: true });
      } else {
        formatStack.push({ type: "italic", start: plainText.length });
      }
      i += 1;
      continue;
    }

    // Regular character.
    plainText += text[i];
    i++;
  }

  // Any unclosed formatting markers are treated as literal text.
  // We need to re-insert them. For simplicity, we don't handle this case
  // perfectly — unclosed markers are just lost. This is acceptable because
  // the agent should be producing well-formed Markdown.

  return { plainText, spans };
}

type MarkdownWriteOptions = {
  /** The blocks being rewritten, and the rendering their mappings refer to. */
  source?: { blocks: BlockMapping[]; markdown: string };
  /** Whether blocks with no source counterpart must be reset to a plain paragraph first. */
  resetParagraphs?: boolean;
  /** Style to apply across the insertion, for an edit that stays inside one text run. */
  sourceTextStyle?: TextStyle;
};

function targetNamedStyle(block: ParsedBlock, source?: BlockMapping): string {
  if (block.headingLevel !== null) {
    return block.headingLevel === 1 && source?.namedStyleType === "TITLE"
      ? "TITLE"
      : `HEADING_${block.headingLevel}`;
  }
  return source?.namedStyleType === "SUBTITLE" && block.listType === null
    ? "SUBTITLE"
    : "NORMAL_TEXT";
}

function sourceBlockText(source: BlockMapping, markdown: string): string {
  let text = "";
  for (let segment of source.segments) {
    if (!("syntaxOnly" in segment)) text += markdown.slice(segment.mdStart, segment.mdEnd);
  }
  return text;
}

function blocksMatch(source: BlockMapping, target: ParsedBlock, markdown: string): boolean {
  return sourceBlockText(source, markdown) === target.plainText &&
    source.listType === target.listType && source.listNestingLevel === target.nestingLevel &&
    source.namedStyleType === targetNamedStyle(target, source);
}

function listPreservation(
  sources: readonly (BlockMapping | undefined)[] | undefined,
  targets: readonly ParsedBlock[],
  rebuild: boolean,
): boolean[] {
  let preserved = targets.map((target, index) => {
    let source = sources?.[index];
    return !rebuild && target.listType !== null && source?.listType === target.listType &&
      source.listNestingLevel === target.nestingLevel;
  });
  for (let start = 0; start < targets.length;) {
    let listType = targets[start].listType;
    if (!listType) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < targets.length && targets[end].listType === listType) end++;
    if (!preserved[start]) {
      for (let index = start + 1; index < end; index++) {
        if (!preserved[index]) continue;
        preserved.fill(false, start, end);
        break;
      }
    }
    start = end;
  }
  return preserved;
}

function alignSourceBlocks(
  sources: BlockMapping[],
  targets: ParsedBlock[],
  markdown: string,
): (BlockMapping | undefined)[] {
  if (sources.length === targets.length) return sources;

  let aligned = targets.map<BlockMapping | undefined>(() => undefined);
  let prefix = 0;
  while (prefix < sources.length && prefix < targets.length &&
      blocksMatch(sources[prefix], targets[prefix], markdown)) {
    aligned[prefix] = sources[prefix];
    prefix++;
  }

  let sourceEnd = sources.length - 1;
  let targetEnd = targets.length - 1;
  while (sourceEnd >= prefix && targetEnd >= prefix &&
      blocksMatch(sources[sourceEnd], targets[targetEnd], markdown)) {
    aligned[targetEnd--] = sources[sourceEnd--];
  }

  let sourceListChanged = sources.some((source, index) =>
    index >= prefix && index <= sourceEnd && source.listType !== null);
  let targetListChanged = targets.some((target, index) =>
    index >= prefix && index <= targetEnd && target.listType !== null);
  if (sourceListChanged && targetListChanged) {
    throw new Error(
      "replaceText: cannot preserve list formatting when one edit changes the block count.",
    );
  }
  return aligned;
}

/**
 * One `updateParagraphStyle` request. At least one of a style change or an indent reset must be
 * asked for, since Google rejects a request that names no fields.
 */
function updateParagraphStyleRequest(
  range: { startIndex: number; endIndex: number; tabId: string },
  namedStyleType: string | undefined,
  clearIndent: boolean,
): any {
  let paragraphStyle: Record<string, unknown> = {};
  let fields: string[] = [];
  if (namedStyleType !== undefined) {
    paragraphStyle.namedStyleType = namedStyleType;
    fields.push("namedStyleType");
  }
  if (clearIndent) {
    paragraphStyle.indentStart = { magnitude: 0, unit: "PT" };
    paragraphStyle.indentFirstLine = { magnitude: 0, unit: "PT" };
    fields.push("indentStart", "indentFirstLine");
  }
  return { updateParagraphStyle: { range, paragraphStyle, fields: fields.join(",") } };
}

/**
 * Convert a Markdown string into Google Docs batchUpdate request objects that insert the content
 * at the given index inside tab `tabId`.
 *
 * Every emitted coordinate names that tab: tab bodies have independent index spaces, so an
 * unqualified index lands in whichever tab Google picks.
 *
 * Returns requests in the order they should appear in the batchUpdate array.
 */
export function markdownToDocRequests(
  markdown: string,
  insertAt: number,
  tabId: string,
  options: MarkdownWriteOptions = {},
): any[] {
  let blocks = parseMarkdown(markdown);
  if (blocks.length === 0) return [];

  let sourceBlockCount = options.source?.blocks.length ?? 0;
  let rebuild = sourceBlockCount > 1;
  let resetParagraphs = options.resetParagraphs || rebuild ||
    options.source !== undefined && sourceBlockCount !== blocks.length;
  let sourceBlocks: (BlockMapping | undefined)[] | undefined = options.source &&
    alignSourceBlocks(options.source.blocks, blocks, options.source.markdown);
  let preserveLists = listPreservation(sourceBlocks, blocks, rebuild);
  // Positions are known from the text lengths alone, so lay every block out in one pass.
  let offset = insertAt;
  let positioned = blocks.map((block, index) => {
    let source = sourceBlocks?.[index];
    let preserveList = preserveLists[index];
    let prefix = block.listType && !preserveList ? "\t".repeat(block.nestingLevel) : "";
    let paragraphStart = offset;
    offset += prefix.length + block.plainText.length + 1;
    return {
      block,
      source,
      preserveList,
      targetStyle: targetNamedStyle(block, source),
      prefix,
      paragraphStart,
      textStart: paragraphStart + prefix.length,
      paragraphEnd: offset,
    };
  });
  let fullText = positioned.map(({ block, prefix }) => prefix + block.plainText).join("\n");
  let insertText = fullText;
  if (!insertText && (!resetParagraphs || !markdown.trim())) insertText = markdown;

  let requests: any[] = [];
  if (insertText.length > 0) {
    requests.push({ insertText: { location: { index: insertAt, tabId }, text: insertText } });
  }

  let clearListIndent = options.source?.blocks.some(block => block.listType) ?? false;

  for (let { block, source, preserveList, targetStyle, paragraphStart, textStart,
    paragraphEnd } of positioned) {
    let range = { startIndex: paragraphStart, endIndex: paragraphEnd, tabId };
    if (source) {
      let resetList = rebuild || source.listType !== null && !preserveList;
      if (resetList) requests.push({ deleteParagraphBullets: { range } });

      let restyle = rebuild || source.namedStyleType !== targetStyle;
      if (restyle || resetList) {
        requests.push(
          updateParagraphStyleRequest(range, restyle ? targetStyle : undefined, resetList));
      }
    } else {
      if (resetParagraphs) {
        requests.push(updateParagraphStyleRequest(range, "NORMAL_TEXT", clearListIndent));
        requests.push({ deleteParagraphBullets: { range } });
      }
      if (targetStyle !== "NORMAL_TEXT") {
        requests.push(updateParagraphStyleRequest(range, targetStyle, false));
      }
    }

    if (block.plainText.length > 0) {
      let textRange = {
        startIndex: textStart,
        endIndex: textStart + block.plainText.length,
        tabId,
      };
      requests.push({
        updateTextStyle: {
          range: textRange,
          textStyle: options.sourceTextStyle ?? {},
          fields: "bold,italic,strikethrough,link",
        },
      });
      if (targetStyle === "SUBTITLE") {
        requests.push({
          updateTextStyle: { range: textRange, textStyle: { italic: false }, fields: "italic" },
        });
      }
    }

    for (let span of block.spans) {
      let startIndex = textStart + span.start;
      let endIndex = textStart + span.end;
      if (startIndex >= endIndex) continue;

      if (span.bold || span.italic || span.strikethrough) {
        let textStyle: Record<string, true> = {};
        let fields: string[] = [];
        if (span.bold) { textStyle.bold = true; fields.push("bold"); }
        if (span.italic) { textStyle.italic = true; fields.push("italic"); }
        if (span.strikethrough) { textStyle.strikethrough = true; fields.push("strikethrough"); }
        requests.push({
          updateTextStyle: {
            range: { startIndex, endIndex, tabId }, textStyle, fields: fields.join(","),
          },
        });
      }
      if (span.link) {
        requests.push({
          updateTextStyle: {
            range: { startIndex, endIndex, tabId },
            textStyle: { link: { url: span.link } },
            fields: "link",
          },
        });
      }
    }
  }

  let bulletGroups: { listType: ListType; startIndex: number; endIndex: number }[] = [];
  for (let { block, preserveList, paragraphStart, paragraphEnd } of positioned) {
    if (!block.listType || preserveList) continue;
    let previous = bulletGroups.at(-1);
    if (previous?.listType === block.listType && previous.endIndex === paragraphStart) {
      previous.endIndex = paragraphEnd;
    } else {
      bulletGroups.push({
        listType: block.listType, startIndex: paragraphStart, endIndex: paragraphEnd,
      });
    }
  }
  for (let { listType, startIndex, endIndex } of bulletGroups.toReversed()) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex, endIndex, tabId },
        bulletPreset: listType === "numbered"
          ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Replace operations: map a Markdown edit back to doc operations
// ---------------------------------------------------------------------------

/** Refuse edits that would modify or bridge structural content without a safe source mapping. */
export function assertMarkdownRangeEditable(
  protectedRanges: readonly MarkdownRange[],
  mdStart: number,
  mdEnd: number,
): void {
  if (protectedRanges.some(range => mdStart < range.mdEnd && mdEnd > range.mdStart)) {
    throw new Error(
      "replaceText: structured content cannot be edited. Narrow the match to plain text.",
    );
  }
}

/**
 * Slice rendered Markdown, escaping the parts that came from document text so a re-parse reads
 * them as the literal characters they are. Syntax the renderer emitted is left alone, so it
 * re-parses back into the formatting it stands for.
 */
function literalMarkdownSlice(
  sourceMap: SourceMap,
  markdown: string,
  start: number,
  end: number,
): string {
  let result = "";
  let cursor = start;
  for (let block of sourceMap.blocks) {
    if (block.mdEnd <= start) continue;
    if (block.mdStart >= end) break;
    for (let segment of block.segments) {
      if ("syntaxOnly" in segment || segment.mdEnd <= start || segment.mdStart >= end) continue;
      let overlapStart = Math.max(start, segment.mdStart);
      let overlapEnd = Math.min(end, segment.mdEnd);
      result += markdown.slice(cursor, overlapStart);
      result += escapeMarkdownText(markdown.slice(overlapStart, overlapEnd));
      cursor = overlapEnd;
    }
  }
  return result + markdown.slice(cursor, end);
}

/**
 * A line opening a heading or list item. `m` so it matches any line of a multi-line string, which
 * is what makes this usable both on caller-supplied Markdown and on one rendered block.
 */
const BLOCK_SYNTAX_LINE = /^(?:#{1,6}| *-| *\d+\.) /m;

function markdownRangeTouches(
  mdStart: number,
  mdEnd: number,
  range: MarkdownRange,
): boolean {
  return mdStart === mdEnd
    ? mdStart >= range.mdStart && mdStart < range.mdEnd
    : mdStart < range.mdEnd && mdEnd > range.mdStart;
}

type BlockReplacementRange = MarkdownRange & {
  docStart: number;
  docEnd: number;
  blocks: BlockMapping[];
};

function blockReplacementRange(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
  force: boolean,
): BlockReplacementRange | undefined {
  let replaceWholeBlocks = force;
  let blocks: BlockMapping[] = [];

  for (let block of sourceMap.blocks) {
    if (block.mdStart > mdEnd) break;
    if (!markdownRangeTouches(mdStart, mdEnd, block)) continue;
    blocks.push(block);
    replaceWholeBlocks ||= block.segments.some(segment =>
      "syntaxOnly" in segment && markdownRangeTouches(mdStart, mdEnd, segment));
  }
  replaceWholeBlocks ||= blocks.length > 1;
  let first = blocks[0];
  let last = blocks.at(-1);
  if (!replaceWholeBlocks || !first || !last) return undefined;
  return {
    mdStart: first.mdStart,
    mdEnd: last.mdEnd,
    docStart: first.docStart,
    docEnd: Math.max(last.docStart, last.docEnd - 1),
    blocks,
  };
}

function textStylesEqual(left: TextStyle, right: TextStyle): boolean {
  return left.bold === right.bold && left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    docsLinkDestination(left.link) === docsLinkDestination(right.link);
}

function mappedTextStyle(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
): TextStyle | undefined {
  let preceding: TextStyle | undefined;
  let matched: TextStyle | undefined;
  for (let block of sourceMap.blocks) {
    // Inclusive: a block ending exactly at an insertion point still supplies `preceding`.
    if (block.mdEnd < mdStart) continue;
    if (block.mdStart > mdEnd) break;
    for (let segment of block.segments) {
      if ("syntaxOnly" in segment) continue;
      if (mdStart === mdEnd) {
        if (mdStart >= segment.mdStart && mdStart < segment.mdEnd) return segment.textStyle;
        if (mdStart === segment.mdEnd) preceding = segment.textStyle;
      } else if (mdStart < segment.mdEnd && mdEnd > segment.mdStart) {
        if (matched && !textStylesEqual(matched, segment.textStyle)) return undefined;
        matched ??= segment.textStyle;
      }
    }
  }
  return matched ?? preceding;
}

/**
 * Compute the batch-update operations that replace one range in a tab's Markdown rendering.
 *
 * Unchanged leading and trailing text is trimmed before document indices are calculated;
 * `trimmedOld` and `trimmedNew` report what was left to change after that trimming.
 */
export function computeReplaceOperations(
  sourceMap: SourceMap,
  markdown: string,
  matchStart: number,
  matchEnd: number,
  newMarkdown: string,
  tabId: string,
): { requests: any[]; trimmedOld: string; trimmedNew: string } {
  assertMarkdownRangeEditable(sourceMap.protectedRanges, matchStart, matchEnd);
  let oldText = markdown.slice(matchStart, matchEnd);
  let { prefixLen, suffixLen } = analyzeMarkdownReplacement(oldText, newMarkdown);
  if (oldText === newMarkdown) {
    return { requests: [], trimmedOld: "", trimmedNew: "" };
  }

  let trimmedMatchStart = matchStart + prefixLen;
  let trimmedMatchEnd = matchEnd - suffixLen;
  let trimmedNew = newMarkdown.slice(prefixLen, newMarkdown.length - suffixLen);
  let trimmedOld = oldText.slice(prefixLen, oldText.length - suffixLen);

  let blockRange = blockReplacementRange(
    sourceMap,
    trimmedMatchStart,
    trimmedMatchEnd,
    BLOCK_SYNTAX_LINE.test(trimmedNew),
  );
  let docRange: { start: number; end: number } | null;
  let insertMarkdown = trimmedNew;
  let writeOptions: MarkdownWriteOptions;
  if (blockRange) {
    assertMarkdownRangeEditable(sourceMap.protectedRanges, blockRange.mdStart, blockRange.mdEnd);
    insertMarkdown = (
      literalMarkdownSlice(sourceMap, markdown, blockRange.mdStart, trimmedMatchStart) +
      insertMarkdown +
      literalMarkdownSlice(sourceMap, markdown, trimmedMatchEnd, blockRange.mdEnd)
    ).replace(/\n$/, "");
    docRange = { start: blockRange.docStart, end: blockRange.docEnd };
    writeOptions = {
      source: { blocks: blockRange.blocks, markdown },
      resetParagraphs: blockRange.blocks.some(block =>
        BLOCK_SYNTAX_LINE.test(markdown.slice(block.mdStart, block.mdEnd))),
    };
  } else {
    docRange = mdRangeToDocRange(sourceMap, trimmedMatchStart, trimmedMatchEnd);
    writeOptions = {
      sourceTextStyle: mappedTextStyle(sourceMap, trimmedMatchStart, trimmedMatchEnd),
    };
  }

  if (!docRange) {
    throw new Error(
      "replaceText: could not map the Markdown range to document indices. " +
      "The match may span unsupported content.");
  }

  let requests: any[] = [];
  if (docRange.start < docRange.end) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: docRange.start, endIndex: docRange.end, tabId },
      },
    });
  }

  if (insertMarkdown.length > 0 || blockRange) {
    requests.push(...markdownToDocRequests(insertMarkdown, docRange.start, tabId, writeOptions));
  }

  return { requests, trimmedOld, trimmedNew };
}

/**
 * Map a Markdown character range [mdStart, mdEnd) to a Google Docs
 * character range, using the source map.
 *
 * Content segments have 1:1 character mapping between Markdown and Doc.
 * Syntax-only segments (Markdown markers like "**", "# ") have no Doc
 * counterpart. If the range falls entirely within syntax-only segments,
 * we expand to the surrounding content boundaries.
 */
function mdRangeToDocRange(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
): { start: number; end: number } | null {
  if (mdStart === mdEnd) {
    let docIndex = mdPointToDocIndex(sourceMap, mdStart);
    return docIndex === null ? null : { start: docIndex, end: docIndex };
  }

  let docStart: number | null = null;
  let docEnd: number | null = null;

  for (let block of sourceMap.blocks) {
    // Skip blocks entirely before or after our range.
    if (block.mdEnd <= mdStart) continue;
    if (block.mdStart >= mdEnd) break;

    for (let seg of block.segments) {
      // Skip segments entirely outside our range.
      if (seg.mdEnd <= mdStart) continue;
      if (seg.mdStart >= mdEnd) break;

      if ("syntaxOnly" in seg) {
        // Syntax-only segment overlaps the range. We can't map to doc indices
        // directly, but we need to extend to the nearest content boundary.
        // Use the block's doc range as a fallback.
        if (docStart === null) docStart = block.docStart;
        docEnd = block.docEnd;
        continue;
      }

      // Content segment — compute the overlapping doc range.
      let overlapMdStart = Math.max(mdStart, seg.mdStart);
      let overlapMdEnd = Math.min(mdEnd, seg.mdEnd);

      // 1:1 character mapping within content segments.
      let segDocStart = seg.docStart + (overlapMdStart - seg.mdStart);
      let segDocEnd = seg.docStart + (overlapMdEnd - seg.mdStart);

      if (docStart === null || segDocStart < docStart) docStart = segDocStart;
      if (docEnd === null || segDocEnd > docEnd) docEnd = segDocEnd;
    }
  }

  if (docStart === null || docEnd === null) return null;
  return { start: docStart, end: docEnd };
}

function mdPointToDocIndex(sourceMap: SourceMap, mdPoint: number): number | null {
  for (let block of sourceMap.blocks) {
    if (mdPoint < block.mdStart) continue;
    if (mdPoint > block.mdEnd) continue;

    let preceding: number | undefined;
    for (let seg of block.segments) {
      if ("syntaxOnly" in seg) continue;
      if (mdPoint < seg.mdStart) return preceding ?? seg.docStart;
      if (mdPoint <= seg.mdEnd) return seg.docStart + (mdPoint - seg.mdStart);
      preceding = seg.docEnd;
    }

    if (preceding !== undefined) return preceding;
    return block.docStart;
  }

  return null;
}
