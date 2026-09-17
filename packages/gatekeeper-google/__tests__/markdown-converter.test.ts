import { describe, expect, it } from "vitest";
import {
  computeReplaceOperations, docTabToMarkdown, markdownToDocRequests,
} from "../src/markdown-converter";
import type { Segment } from "../src/markdown-converter";
import { BULLET_LIST, buildTab } from "./doc-fixture";

/** A segment with a document counterpart, as opposed to a Markdown-syntax-only one. */
type ContentSegment = Exclude<Segment, { syntaxOnly: true }>;

const isContent = (seg: Segment): seg is ContentSegment => !("syntaxOnly" in seg);

const TAB_ID = "tab-1";
const PARENTHESIZED_URL = "https://en.wikipedia.org/wiki/Function_(mathematics)";

/**
 * The document text as Google stores it, aligned so that a string index equals a doc index: index
 * 0 is the section break, and run text begins at 1.
 */
function docText(runs: string[]): string {
  return "\u0000" + runs.join("");
}

/** Every `Location`/`Range` object nested anywhere inside a batchUpdate request. */
function coordinates(requests: unknown[]): Record<string, unknown>[] {
  let found: Record<string, unknown>[] = [];
  let visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "location" || key === "range") found.push(nested as Record<string, unknown>);
      visit(nested);
    }
  };
  visit(requests);
  return found;
}

describe("docTabToMarkdown", () => {
  it("renders headings, inline styles, links and bullets", () => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Title\n"], namedStyleType: "HEADING_1" },
      { runs: ["Sub\n"], namedStyleType: "HEADING_2" },
      { runs: [
        "Hello ",
        { text: "bold", style: { bold: true } },
        " and ",
        { text: "it", style: { italic: true } },
        " and ",
        { text: "link", style: { link: { url: "https://e.com" } } },
        ".\n",
      ] },
      { runs: ["one\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["two\n"], bullet: { listId: "L1", nestingLevel: 0 } },
    ], BULLET_LIST));

    expect(snapshot.markdown).toBe(
      "# Title\n\n## Sub\n\nHello **bold** and *it* and [link](https://e.com).\n\n- one\n- two\n");
  });

  it("renders subtitles as one italic span", () => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Release summary\n"], namedStyleType: "SUBTITLE" },
    ]));

    expect(snapshot.markdown).toBe("*Release summary*\n");
  });

  it("honors explicit non-italic subtitle runs", () => {
    let paragraph = {
      runs: ["Italic", { text: "Plain", style: { italic: false } }, "\n"],
      namedStyleType: "SUBTITLE",
    };

    expect(docTabToMarkdown(buildTab([paragraph])).markdown).toBe("*Italic*Plain\n");
    expect(docTabToMarkdown(buildTab([{ table: [[{ paragraphs: [paragraph] }]] }])).markdown)
      .toContain("<td><p><em>Italic</em>Plain</p></td>");
  });

  it("renders visible smart-chip content", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { person: { name: "Ada Lovelace", email: "ada@example.com" } },
      " owns ",
      { richLink: { title: "Launch plan", uri: "https://docs.google.com/document/d/plan" } },
      " due ",
      { date: "Sep 16, 2026" },
      "\n",
    ] }]));

    expect(snapshot.markdown).toBe(
      "Ada Lovelace owns [Launch plan](https://docs.google.com/document/d/plan) due Sep 16, 2026\n",
    );
  });

  it("escapes structured display text as Markdown", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { richLink: {
        title: "Plan](https://evil.example)",
        uri: "https://docs.google.com/document/d/safe",
      } },
      "\n",
    ] }]));

    expect(snapshot.markdown).toBe(
      "[Plan\\]\\(https://evil\\.example\\)](https://docs.google.com/document/d/safe)\n",
    );
  });

  it("refuses edits to smart-chip display text", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { date: "Sep 16, 2026" }, "\n",
    ] }]));
    let start = snapshot.markdown.indexOf("Sep 16, 2026");

    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + 12, "Sep 17, 2026", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

  it("renders body horizontal rules as HTML", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [{ horizontalRule: true }, "\n"] }]));

    expect(snapshot.markdown).toBe("<hr>\n");
  });

  it("carries the tab's identity, position and body end index through", () => {
    let snapshot = docTabToMarkdown({
      ...buildTab([{ runs: ["abc\n"] }]),
      tabId: "metrics",
      title: "Metrics",
      parentTabId: "details",
      index: 1,
      nestingLevel: 2,
    });
    expect(snapshot).toMatchObject({
      tabId: "metrics", title: "Metrics", parentTabId: "details", index: 1, nestingLevel: 2,
    });
    // Section break (1) + "abc\n" (4).
    expect(snapshot.bodyEndIndex).toBe(5);
  });
  it.each([
    ["table of contents", "tableOfContents", "[Table of contents]"],
    ["interior section break", "sectionBreak", "[Section break]"],
  ] as const)("protects an omitted %s", (_name, structure, placeholder) => {
    let snapshot = docTabToMarkdown(buildTab([
      { runs: ["Before\n"] },
      { structure, length: 10 },
      { runs: ["After\n"] },
    ]));

    expect(snapshot.markdown).toBe(`Before\n\n${placeholder}\n\nAfter\n`);
    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, snapshot.markdown.length,
      "Updated", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

});

describe("Google Docs tables", () => {
  let snapshot = docTabToMarkdown(buildTab([
    { runs: ["Before\n"] },
    { table: [["Owner\n", "Status\n"], ["R&D <ops>\n", "Ready\n"]] },
    { runs: ["After\n"] },
  ]));

  it("renders every cell without inventing a header row", () => {
    expect(snapshot.markdown).toBe(
      "Before\n\n" +
      "<table>\n" +
      "  <tr>\n" +
      "    <td><p>Owner</p></td>\n" +
      "    <td><p>Status</p></td>\n" +
      "  </tr>\n" +
      "  <tr>\n" +
      "    <td><p>R&amp;D &lt;ops&gt;</p></td>\n" +
      "    <td><p>Ready</p></td>\n" +
      "  </tr>\n" +
      "</table>\n\n" +
      "After\n",
    );
  });

  it("preserves each run's link and text styles in cells", () => {
    let linked = {
      text: "Runbook <now>",
      style: {
        bold: true,
        italic: true,
        strikethrough: true,
        link: { url: 'https://example.com/runbook?a=1&team="ops"' },
      },
    };
    let tab = buildTab([{ table: [[{
      paragraphs: [{ runs: ["See ", linked, " today\n"] }],
    }]] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      'See <a href="https://example.com/runbook?a=1&amp;team=&quot;ops&quot;">' +
      "<strong><em><s>Runbook &lt;now&gt;</s></em></strong></a> today",
    );
  });

  it("preserves internal Docs link destinations in cells", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{ runs: [
      { text: "Tab", style: { link: { tabId: "details" } } }, " · ",
      { text: "Bookmark", style: { link: {
        bookmark: { id: "bookmark-1", tabId: "details" },
      } } }, " · ",
      { text: "Heading", style: { link: {
        heading: { id: "heading-1", tabId: "details" },
      } } }, " · ",
      { text: "Bookmark legacy", style: { link: { bookmarkId: "bookmark-2" } } }, " · ",
      { text: "Heading legacy", style: { link: { headingId: "heading-2" } } },
      "\n",
    ] }] }]] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<a href="?tab=details">Tab</a> · ' +
      '<a href="?tab=details#bookmark=bookmark-1">Bookmark</a> · ' +
      '<a href="?tab=details#heading=heading-1">Heading</a> · ' +
      '<a href="#bookmark=bookmark-2">Bookmark legacy</a> · ' +
      '<a href="#heading=heading-2">Heading legacy</a>',
    );
  });

  it("preserves subtitle styling without redundant emphasis", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{
      runs: ["Release ", { text: "summary", style: { italic: true } }, "\n"],
      namedStyleType: "SUBTITLE",
    }] }]] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<td><p><em>Release summary</em></p></td>",
    );
  });

  it("renders visible smart-chip content in cells", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{ runs: [
      { person: { email: "owner@example.com" } },
      " · ",
      { richLink: { title: "Launch plan", uri: "https://docs.google.com/document/d/plan" } },
      " · ",
      { date: "Sep 16, 2026" },
      "\n",
    ] }] }]] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<p>owner@example.com · " +
      '<a href="https://docs.google.com/document/d/plan">Launch plan</a> · Sep 16, 2026</p>',
    );
  });

  it("renders page auto-text in cells", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{ runs: [
      { autoText: "PAGE_NUMBER" }, " of ", { autoText: "PAGE_COUNT" }, "\n",
    ] }] }]] }]);

    expect(docTabToMarkdown(tab).markdown).toContain("<p>[Page number] of [Page count]</p>");
  });

  it("defaults an omitted list nesting level to zero", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{
      runs: ["Step\n"], bullet: { listId: "L1" },
    }] }]] }], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain("<ol><li>Step</li></ol>");
  });
  it("renders nested lists semantically with their configured start", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [
      { runs: ["Prepare\n"], bullet: { listId: "L1" } },
      { runs: ["Check\n"], bullet: { listId: "L1", nestingLevel: 1 } },
      { runs: ["Launch\n"], bullet: { listId: "L1" } },
    ] }]] }], {
      L1: { listProperties: { nestingLevels: [
        { glyphType: "DECIMAL", startNumber: 4 },
        { glyphSymbol: "●" },
      ] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<ol start="4"><li>Prepare<ul style="list-style-type: none"><li>● Check</li></ul></li>' +
      "<li>Launch</li></ol>",
    );
  });

  it("preserves a zero start for decimal lists", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{
      runs: ["Zero\n"], bullet: { listId: "L1" },
    }] }]] }], {
      L1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", startNumber: 0 }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain('<ol start="0"><li>Zero</li></ol>');
  });

  it("preserves ordered list glyph styles", () => {
    let tab = buildTab([{ table: [[
      { paragraphs: [{ runs: ["Alpha\n"], bullet: { listId: "alpha" } }] },
      { paragraphs: [{ runs: ["Zero\n"], bullet: { listId: "zero" } }] },
    ]] }], {
      alpha: { listProperties: { nestingLevels: [{ glyphType: "UPPER_ALPHA", startNumber: 3 }] } },
      zero: { listProperties: { nestingLevels: [{ glyphType: "ZERO_DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<td><ol type="A" start="3"><li>Alpha</li></ol></td>',
    );
    expect(docTabToMarkdown(tab).markdown).toContain(
      '<td><ol style="list-style-type: decimal-leading-zero"><li>Zero</li></ol></td>',
    );
  });

  it("preserves unordered list glyphs", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{
      runs: ["Task\n"], bullet: { listId: "checklist" },
    }] }]] }], {
      checklist: { listProperties: { nestingLevels: [{ glyphSymbol: "☐" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<ul style="list-style-type: none"><li>☐ Task</li></ul>',
    );
  });

  it("renders a horizontal rule in a cell as HTML", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{
      runs: [{ horizontalRule: true }, "\n"],
    }] }]] }]);

    expect(docTabToMarkdown(tab).markdown).toContain("<td><hr></td>");
  });

  it("renders a footnote's visible number", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{ runs: [
      "See ", { footnote: { id: "fn-7", number: "7" } }, "\n",
    ] }] }]] }]);

    expect(docTabToMarkdown(tab).markdown).toContain("<p>See [7]</p>");
  });

  it("marks omitted structured cell content", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [{ runs: [
      "Before ", { richLink: { title: "placeholder", uri: "https://example.com" } }, " after\n",
    ] }] }]] }]);
    let element = tab.body.content[1].table!.tableRows![0].tableCells![0]
      .content![0].paragraph!.elements[1];
    delete element.richLink;
    Object.assign(element, { inlineObjectElement: { inlineObjectId: "image-1" } });

    expect(docTabToMarkdown(tab).markdown).toContain("<p>Before [Image] after</p>");
  });

  it("preserves merged-cell spans", () => {
    let tab = buildTab([{ table: [[{
      paragraphs: [{ runs: ["Merged\n"] }],
      tableCellStyle: { rowSpan: 2, columnSpan: 2 },
    }], []] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      '<td rowspan="2" colspan="2"><p>Merged</p></td>',
    );
  });

  it("separates multiple paragraphs within a cell", () => {
    let tab = buildTab([{ table: [[{
      paragraphs: [{ runs: ["First\n"] }, { runs: ["Second\n"] }],
    }]] }]);

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<td>\n      <p>First</p>\n      <p>Second</p>\n    </td>",
    );
  });

  it("preserves headings, lists, and blank paragraphs within a cell", () => {
    let tab = buildTab([{ table: [[{ paragraphs: [
      { runs: ["Heading\n"], namedStyleType: "HEADING_2" },
      { runs: ["First\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["Second\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["\n"] },
      { runs: ["Step\n"], bullet: { listId: "L2", nestingLevel: 0 } },
    ] }]] }], {
      ...BULLET_LIST,
      L2: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
    });

    expect(docTabToMarkdown(tab).markdown).toContain(
      "<h2>Heading</h2>\n" +
      '      <ul style="list-style-type: none"><li>● First</li><li>● Second</li></ul>\n' +
      "      <p></p>\n" +
      "      <ol><li>Step</li></ol>",
    );
  });

  it("refuses an edit spanning table structure", () => {
    expect(() => computeReplaceOperations(
      snapshot.sourceMap,
      snapshot.markdown,
      0,
      snapshot.markdown.trimEnd().length,
      "Updated",
      TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

  it("refuses an edit within a table cell", () => {
    let start = snapshot.markdown.indexOf("Owner");

    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + "Owner".length, "Lead", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

  it("protects the separators around a table", () => {
    let tableStart = snapshot.markdown.indexOf("<table>");
    let tableEnd = snapshot.markdown.indexOf("</table>") + "</table>".length;

    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, tableStart, "Updated\n", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
    expect(() => computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, tableEnd, snapshot.markdown.length,
      "\nUpdated\n", TAB_ID,
    )).toThrow("replaceText: structured content cannot be edited");
  });

  it("maps edits after a table to document coordinates", () => {
    let start = snapshot.markdown.lastIndexOf("After");

    expect(computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, start, start + "After".length, "Later", TAB_ID,
    ).requests).toEqual([
      { deleteContentRange: { range: { startIndex: 45, endIndex: 47, tabId: TAB_ID } } },
      { insertText: { location: { index: 45, tabId: TAB_ID }, text: "La" } },
      {
        updateTextStyle: {
          range: { startIndex: 45, endIndex: 47, tabId: TAB_ID },
          textStyle: {},
          fields: "bold,italic,strikethrough,link",
        },
      },
    ]);
  });
});

// These are what keeps an edit from landing on the wrong characters. A content segment claims a
// 1:1 mapping between Markdown and document indices, and computeReplaceOperations trusts it.
describe("source map invariants", () => {
  let snapshot = docTabToMarkdown(buildTab([
    { runs: ["Title\n"], namedStyleType: "HEADING_1" },
    { runs: [
      "Hello ",
      { text: "bold", style: { bold: true } },
      " and ",
      { text: "link", style: { link: { url: "https://e.com" } } },
      ".\n",
    ] },
    { runs: ["one\n"], bullet: { listId: "L1", nestingLevel: 0 } },
  ], BULLET_LIST));
  let text = docText(["Title\n", "Hello ", "bold", " and ", "link", ".\n", "one\n"]);
  let segments = snapshot.sourceMap.blocks.flatMap(b => b.segments);
  let contentSegments = segments.filter(isContent);

  it("gives every content segment equal length in both spaces", () => {
    for (let seg of contentSegments) {
      expect(seg.mdEnd - seg.mdStart).toBe(seg.docEnd - seg.docStart);
    }
  });

  it("maps every content segment to the same text in both spaces", () => {
    for (let seg of contentSegments) {
      expect(snapshot.markdown.slice(seg.mdStart, seg.mdEnd))
        .toBe(text.slice(seg.docStart, seg.docEnd));
    }
  });

  it("keeps segments non-overlapping and ordered in both spaces", () => {
    let mdCursor = 0;
    let docCursor = 0;
    for (let seg of segments) {
      expect(seg.mdStart).toBeGreaterThanOrEqual(mdCursor);
      expect(seg.mdEnd).toBeGreaterThanOrEqual(seg.mdStart);
      mdCursor = seg.mdEnd;
      if ("syntaxOnly" in seg) continue;
      expect(seg.docStart).toBeGreaterThanOrEqual(docCursor);
      docCursor = seg.docEnd;
    }
  });

  it("keeps each block's segments inside the block's own ranges", () => {
    for (let block of snapshot.sourceMap.blocks) {
      for (let seg of block.segments) {
        expect(seg.mdStart).toBeGreaterThanOrEqual(block.mdStart);
        expect(seg.mdEnd).toBeLessThanOrEqual(block.mdEnd);
        if ("syntaxOnly" in seg) continue;
        expect(seg.docStart).toBeGreaterThanOrEqual(block.docStart);
        expect(seg.docEnd).toBeLessThanOrEqual(block.docEnd);
      }
    }
  });
});

describe("Markdown links", () => {
  it.each([
    ["balanced", PARENTHESIZED_URL],
    ["escaped", "https://en.wikipedia.org/wiki/Function_\\(mathematics\\)"],
  ])("parses %s destination parentheses", (_name, destination) => {
    let requests = markdownToDocRequests(`[link](${destination})`, 1, TAB_ID);

    expect(requests[0]).toEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "link" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 5, tabId: TAB_ID },
        textStyle: { link: { url: PARENTHESIZED_URL } },
        fields: "link",
      },
    });
  });

  it("renders destination parentheses canonically escaped", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "link", style: { link: { url: PARENTHESIZED_URL } } }, "\n",
    ] }]));

    expect(snapshot.markdown).toBe(
      "[link](https://en.wikipedia.org/wiki/Function_\\(mathematics\\))\n",
    );
  });

  it("preserves a parenthesized link beside a formatting edit", () => {
    let snapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } }, " and ",
      { text: "link", style: { link: { url: PARENTHESIZED_URL } } }, "\n",
    ] }]));
    let requests = computeReplaceOperations(
      snapshot.sourceMap, snapshot.markdown, 0, "**bold**".length, "plain", TAB_ID,
    ).requests;

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "plain and link" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 11, endIndex: 15, tabId: TAB_ID },
        textStyle: { link: { url: PARENTHESIZED_URL } },
        fields: "link",
      },
    });
  });
});

// Tab bodies have independent index spaces, so a coordinate without the selected tab's ID would
// land in whichever tab Google picks by default.
describe("selected-tab write coordinates", () => {
  it("stamps the tab ID on every inserted location and styled range", () => {
    let requests = markdownToDocRequests(
      "# Head\n\n- one\n\n**bold** and [link](https://e.com)\n", 7, "metrics");

    let found = coordinates(requests);
    expect(found).toHaveLength(requests.length);
    for (const coordinate of found) expect(coordinate.tabId).toBe("metrics");
  });
});

describe("computeReplaceOperations", () => {
  let snapshot = docTabToMarkdown(buildTab([
    { runs: ["Title\n"], namedStyleType: "HEADING_1" },
    { runs: ["Hello ", { text: "bold", style: { bold: true } }, " world.\n"] },
  ]));
  let md = snapshot.markdown;
  let replace = (oldText: string, newText: string) => {
    let start = md.indexOf(oldText);
    expect(start).toBeGreaterThanOrEqual(0);
    return computeReplaceOperations(
      snapshot.sourceMap, md, start, start + oldText.length, newText, TAB_ID);
  };

  it("renders the fixture as expected", () => {
    expect(md).toBe("# Title\n\nHello **bold** world.\n");
  });

  it("emits nothing when the text is unchanged", () => {
    expect(replace("world", "world")).toEqual({ requests: [], trimmedOld: "", trimmedNew: "" });
  });

  it("deletes then re-inserts at the mapped document range", () => {
    let result = replace("world", "there");

    expect(result).toMatchObject({ trimmedOld: "world", trimmedNew: "there" });
    expect(result.requests.slice(0, 2)).toEqual([
      { deleteContentRange: { range: { startIndex: 18, endIndex: 23, tabId: TAB_ID } } },
      { insertText: { location: { index: 18, tabId: TAB_ID }, text: "there" } },
    ]);
  });

  it("trims a shared prefix down to a bare insert", () => {
    let result = replace("world", "worlds");

    expect(result).toMatchObject({ trimmedOld: "", trimmedNew: "s" });
    expect(result.requests[0]).toEqual({
      insertText: { location: { index: 23, tabId: TAB_ID }, text: "s" },
    });
  });

  it("emits only a delete when the replacement is empty", () => {
    expect(replace("world", "")).toEqual({
      trimmedOld: "world",
      trimmedNew: "",
      requests: [{ deleteContentRange: { range: { startIndex: 18, endIndex: 23, tabId: TAB_ID } } }],
    });
  });

  it("preserves surrounding text when the range spans Markdown syntax", () => {
    expect(replace("**bold**", "plain").requests.slice(0, 2)).toEqual([
      { deleteContentRange: { range: { startIndex: 7, endIndex: 24, tabId: TAB_ID } } },
      { insertText: { location: { index: 7, tabId: TAB_ID }, text: "Hello plain world." } },
    ]);
  });

  it("does not expand an insertion into a preceding protected list item", () => {
    let protectedSnapshot = docTabToMarkdown(buildTab([
      { runs: [
        { richLink: { title: "Plan", uri: "https://docs.google.com/document/d/plan" } },
        "\n",
      ], bullet: { listId: "L1" } },
      { runs: ["second\n"], bullet: { listId: "L1" } },
    ], BULLET_LIST));
    let oldText = "- second";
    let start = protectedSnapshot.markdown.indexOf(oldText);

    let { requests } = computeReplaceOperations(
      protectedSnapshot.sourceMap,
      protectedSnapshot.markdown,
      start,
      start + oldText.length,
      `Intro\n${oldText}`,
      TAB_ID,
    );

    expect(requests[0]).toEqual({
      deleteContentRange: { range: { startIndex: 3, endIndex: 9, tabId: TAB_ID } },
    });
  });

  it("preserves untouched literal Markdown punctuation", () => {
    let punctuationSnapshot = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } }, " costs 2 * 3 = 6\n",
    ] }]));
    let oldText = "**bold**";
    let start = punctuationSnapshot.markdown.indexOf(oldText);

    let { requests } = computeReplaceOperations(
      punctuationSnapshot.sourceMap,
      punctuationSnapshot.markdown,
      start,
      start + oldText.length,
      "plain",
      TAB_ID,
    );

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "plain costs 2 * 3 = 6" },
    });
  });

  it("preserves untouched backslashes during block rewrites", () => {
    let path = String.raw`\\server\share`;
    let pathSnapshot = docTabToMarkdown(buildTab([{
      runs: [`Path ${path}\n`], namedStyleType: "HEADING_1",
    }]));

    let { requests } = computeReplaceOperations(
      pathSnapshot.sourceMap, pathSnapshot.markdown, 0, pathSnapshot.markdown.trimEnd().length,
      `Path ${path}`, TAB_ID,
    );

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: `Path ${path}` },
    });
  });

  it("turns escaped formatting delimiters into literal text", () => {
    let bold = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } }, "\n",
    ] }]));
    let { requests } = computeReplaceOperations(
      bold.sourceMap, bold.markdown, 0, "**bold**".length,
      String.raw`\*\*bold\*\*`, TAB_ID,
    );

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "**bold**" },
    });
    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 9, tabId: TAB_ID },
        textStyle: {},
        fields: "bold,italic,strikethrough,link",
      },
    });
  });

  it.each(["# heading", "- item", "1. item"])(
    "keeps %s literal inside a paragraph",
    replacement => {
      let plain = docTabToMarkdown(buildTab([{ runs: ["Alpha target omega\n"] }]));
      let start = plain.markdown.indexOf("target");
      let { requests } = computeReplaceOperations(
        plain.sourceMap, plain.markdown, start, start + "target".length, replacement, TAB_ID,
      );

      expect(requests).toContainEqual({
        insertText: {
          location: { index: 1, tabId: TAB_ID },
          text: `Alpha ${replacement} omega`,
        },
      });
      expect(requests.some(request =>
        "updateParagraphStyle" in request || "createParagraphBullets" in request ||
        "deleteParagraphBullets" in request,
      )).toBe(false);
    },
  );

  it("applies block syntax isolated by trimming", () => {
    let plain = docTabToMarkdown(buildTab([{ runs: ["Title\n"] }]));

    let { requests } = computeReplaceOperations(
      plain.sourceMap, plain.markdown, 0, "Title".length, "# Title", TAB_ID,
    );

    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
        paragraphStyle: { namedStyleType: "HEADING_1" },
        fields: "namedStyleType",
      },
    });
  });

  it.each([
    ["bullet", "- Title", "BULLET_DISC_CIRCLE_SQUARE"],
    ["numbered", "1. Title", "NUMBERED_DECIMAL_ALPHA_ROMAN"],
  ])("applies %s syntax at a paragraph boundary", (_name, replacement, bulletPreset) => {
    let plain = docTabToMarkdown(buildTab([{ runs: ["Title\n"] }]));
    let { requests } = computeReplaceOperations(
      plain.sourceMap, plain.markdown, 0, "Title".length, replacement, TAB_ID,
    );

    expect(requests).toContainEqual({
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
        bulletPreset,
      },
    });
  });
  it("creates contiguous numbered items as one list", () => {
    let requests = markdownToDocRequests("1. First\n1. Second", 1, TAB_ID);

    expect(requests.filter(request => "createParagraphBullets" in request)).toEqual([{
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 14, tabId: TAB_ID },
        bulletPreset: "NUMBERED_DECIMAL_ALPHA_ROMAN",
      },
    }]);
  });

  it("clears removed heading and list styles", () => {
    let heading = docTabToMarkdown(buildTab([{
      runs: ["Title\n"], namedStyleType: "HEADING_1",
    }]));
    let list = docTabToMarkdown(buildTab([{
      runs: ["item\n"], bullet: { listId: "L1" },
    }], BULLET_LIST));

    let headingRequests = computeReplaceOperations(
      heading.sourceMap, heading.markdown, 0, "# Title".length, "Title", TAB_ID,
    ).requests;
    let listRequests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, "- item".length, "item", TAB_ID,
    ).requests;

    expect(headingRequests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
    expect(listRequests).toContainEqual({
      deleteParagraphBullets: { range: { startIndex: 1, endIndex: 6, tabId: TAB_ID } },
    });
  });

  it("clears indentation after removing list bullets", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["nested\n"], bullet: { listId: "L1", nestingLevel: 1 },
    }], BULLET_LIST));
    let requests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, "  - nested".length, "nested", TAB_ID,
    ).requests;
    let deleteIndex = requests.findIndex(request => "deleteParagraphBullets" in request);

    expect(requests.slice(deleteIndex, deleteIndex + 2)).toEqual([
      { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 8, tabId: TAB_ID } } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 8, tabId: TAB_ID },
          paragraphStyle: {
            indentStart: { magnitude: 0, unit: "PT" },
            indentFirstLine: { magnitude: 0, unit: "PT" },
          },
          fields: "indentStart,indentFirstLine",
        },
      },
    ]);
  });

  it("clears list indentation when one item becomes plain paragraphs", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["nested\n"], bullet: { listId: "L1", nestingLevel: 1 },
    }], BULLET_LIST));
    let requests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, list.markdown.trimEnd().length,
      "plain\n\nsecond", TAB_ID,
    ).requests;

    expect(requests.filter(request =>
      "updateParagraphStyle" in request || "deleteParagraphBullets" in request,
    )).toEqual([
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 7, tabId: TAB_ID },
          paragraphStyle: {
            namedStyleType: "NORMAL_TEXT",
            indentStart: { magnitude: 0, unit: "PT" },
            indentFirstLine: { magnitude: 0, unit: "PT" },
          },
          fields: "namedStyleType,indentStart,indentFirstLine",
        },
      },
      { deleteParagraphBullets: { range: { startIndex: 1, endIndex: 7, tabId: TAB_ID } } },
      {
        updateParagraphStyle: {
          range: { startIndex: 7, endIndex: 14, tabId: TAB_ID },
          paragraphStyle: {
            namedStyleType: "NORMAL_TEXT",
            indentStart: { magnitude: 0, unit: "PT" },
            indentFirstLine: { magnitude: 0, unit: "PT" },
          },
          fields: "namedStyleType,indentStart,indentFirstLine",
        },
      },
      { deleteParagraphBullets: { range: { startIndex: 7, endIndex: 14, tabId: TAB_ID } } },
    ]);
  });

  it("rebuilds list nesting after deleting paragraph terminators", () => {
    let nestedList = docTabToMarkdown(buildTab([
      { runs: ["One\n"], bullet: { listId: "L1", nestingLevel: 0 } },
      { runs: ["Two\n"], bullet: { listId: "L1", nestingLevel: 1 } },
    ], {
      L1: { listProperties: { nestingLevels: [{ glyphSymbol: "•" }, { glyphSymbol: "◦" }] } },
    }));

    let requests = computeReplaceOperations(
      nestedList.sourceMap, nestedList.markdown, 0, nestedList.markdown.trimEnd().length,
      "- Alpha\n  - Beta", TAB_ID,
    ).requests;

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "Alpha\n\tBeta" },
    });
    expect(requests.filter(request => "createParagraphBullets" in request)).toEqual([{
      createParagraphBullets: {
        range: { startIndex: 1, endIndex: 13, tabId: TAB_ID },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    }]);
  });

  it("refuses list edits whose block count cannot preserve formatting", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["Task\n"], bullet: { listId: "check" },
    }], {
      check: { listProperties: { nestingLevels: [{ glyphSymbol: "☐" }] } },
    }));

    expect(() => computeReplaceOperations(
      list.sourceMap, list.markdown, 0, list.markdown.trimEnd().length,
      "- One\n- Two", TAB_ID,
    )).toThrow("cannot preserve list formatting");
  });

  it("preserves an unchanged custom list when inserting an adjacent block", () => {
    let list = docTabToMarkdown(buildTab([{
      runs: ["Task\n"], bullet: { listId: "check" },
    }], {
      check: { listProperties: { nestingLevels: [{ glyphSymbol: "☐" }] } },
    }));
    let requests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, list.markdown.trimEnd().length,
      "Intro\n- Task", TAB_ID,
    ).requests;

    expect(requests.some(request => "createParagraphBullets" in request)).toBe(false);
  });

  it("preserves title and custom list styles during inline edits", () => {
    let title = docTabToMarkdown(buildTab([{
      runs: [{ text: "Title", style: { bold: true } }, "\n"], namedStyleType: "TITLE",
    }]));
    let list = docTabToMarkdown(buildTab([{
      runs: [{ text: "Task", style: { bold: true } }, "\n"], bullet: { listId: "check" },
    }], {
      check: { listProperties: { nestingLevels: [{ glyphSymbol: "☐" }] } },
    }));
    let titleRequests = computeReplaceOperations(
      title.sourceMap, title.markdown, 0, "# **Title**".length, "# Title", TAB_ID,
    ).requests;
    let listRequests = computeReplaceOperations(
      list.sourceMap, list.markdown, 0, "- **Task**".length, "- Task", TAB_ID,
    ).requests;

    expect(titleRequests.some(request => "updateParagraphStyle" in request)).toBe(false);
    expect(listRequests.some(request =>
      "deleteParagraphBullets" in request || "createParagraphBullets" in request,
    )).toBe(false);
  });

  it("applies bold from a mapped inline source", () => {
    let requests = replace("bold", "bald").requests;

    expect(requests.slice(2)).toEqual([{
      updateTextStyle: {
        range: { startIndex: 14, endIndex: 15, tabId: TAB_ID },
        textStyle: { bold: true },
        fields: "bold,italic,strikethrough,link",
      },
    }]);
  });

  it("applies a link from a mapped inline source", () => {
    let linked = docTabToMarkdown(buildTab([{ runs: [
      { text: "link", style: { link: { url: "https://example.com" } } }, "\n",
    ] }]));
    let start = linked.markdown.indexOf("link");
    let requests = computeReplaceOperations(
      linked.sourceMap, linked.markdown, start, start + "link".length, "lint", TAB_ID,
    ).requests;

    expect(requests.slice(2)).toEqual([{
      updateTextStyle: {
        range: { startIndex: 4, endIndex: 5, tabId: TAB_ID },
        textStyle: { link: { url: "https://example.com" } },
        fields: "bold,italic,strikethrough,link",
      },
    }]);
  });

  it("preserves a shared style across adjacent source segments", () => {
    let styled = docTabToMarkdown(buildTab([{ runs: [
      { text: "one", style: { bold: true } },
      { text: "two", style: { bold: true } },
      "\n",
    ] }]));
    let start = styled.markdown.indexOf("onetwo");
    let requests = computeReplaceOperations(
      styled.sourceMap, styled.markdown, start, start + "onetwo".length, "new", TAB_ID,
    ).requests;

    expect(requests.at(-1)).toEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 4, tabId: TAB_ID },
        textStyle: { bold: true },
        fields: "bold,italic,strikethrough,link",
      },
    });
  });

  it("resets a mapped plain source beside styled text", () => {
    let mixed = docTabToMarkdown(buildTab([{ runs: [
      { text: "bold", style: { bold: true } }, "plain\n",
    ] }]));
    let start = mixed.markdown.indexOf("plain");
    let requests = computeReplaceOperations(
      mixed.sourceMap, mixed.markdown, start, start + "plain".length, "new", TAB_ID,
    ).requests;

    expect(requests.slice(2)).toEqual([{
      updateTextStyle: {
        range: { startIndex: 5, endIndex: 8, tabId: TAB_ID },
        textStyle: {},
        fields: "bold,italic,strikethrough,link",
      },
    }]);
  });

  it("resets inherited styles before applying Markdown styles", () => {
    let styled = docTabToMarkdown(buildTab([{ runs: [{
      text: "Old\n",
      style: {
        bold: true,
        italic: true,
        strikethrough: true,
        link: { url: "https://example.com" },
      },
    }] }]));
    let requests = computeReplaceOperations(
      styled.sourceMap, styled.markdown, 0, styled.markdown.trimEnd().length,
      "**New**", TAB_ID,
    ).requests;

    expect(requests.filter(request => "updateTextStyle" in request)).toEqual([
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 4, tabId: TAB_ID },
          textStyle: {},
          fields: "bold,italic,strikethrough,link",
        },
      },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 4, tabId: TAB_ID },
          textStyle: { bold: true },
          fields: "bold",
        },
      },
    ]);
  });

  it("uses an explicit italic override when removing subtitle emphasis", () => {
    let subtitle = docTabToMarkdown(buildTab([{
      runs: ["Subtitle\n"], namedStyleType: "SUBTITLE",
    }]));
    let requests = computeReplaceOperations(
      subtitle.sourceMap, subtitle.markdown, 0, "*Subtitle*".length, "Subtitle", TAB_ID,
    ).requests;

    expect(requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 1, endIndex: 9, tabId: TAB_ID },
        textStyle: { italic: false },
        fields: "italic",
      },
    });
    expect(requests.some(request =>
      "updateParagraphStyle" in request &&
      request.updateParagraphStyle.paragraphStyle.namedStyleType === "NORMAL_TEXT",
    )).toBe(false);
  });

  it("reuses the existing terminator when emptying a block", () => {
    let heading = docTabToMarkdown(buildTab([{
      runs: ["Title\n"], namedStyleType: "HEADING_1",
    }]));

    let { requests } = computeReplaceOperations(
      heading.sourceMap, heading.markdown, 0, "# Title".length, "", TAB_ID,
    );

    expect(requests.some(request => "insertText" in request)).toBe(false);
  });

  it("preserves list nesting", () => {
    let requests = markdownToDocRequests("  - nested", 1, TAB_ID);

    expect(requests).toContainEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "\tnested" },
    });
  });

  it("parses backslash-escaped Markdown punctuation", () => {
    let requests = markdownToDocRequests(String.raw`\* literal C:\temp`, 1, TAB_ID);

    expect(requests).toEqual([
      { insertText: { location: { index: 1, tabId: TAB_ID }, text: "* literal C:\\temp" } },
      {
        updateTextStyle: {
          range: { startIndex: 1, endIndex: 18, tabId: TAB_ID },
          textStyle: {},
          fields: "bold,italic,strikethrough,link",
        },
      },
    ]);
  });

  it("inserts unsupported numbered starts literally", () => {
    let requests = markdownToDocRequests("2. item", 1, TAB_ID);

    expect(requests[0]).toEqual({
      insertText: { location: { index: 1, tabId: TAB_ID }, text: "2. item" },
    });
    expect(requests.some(request => "createParagraphBullets" in request)).toBe(false);
  });
});
