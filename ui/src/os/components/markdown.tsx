import type { ReactNode } from "react";

/*
 * A small Markdown renderer for `doc_md`.
 *
 * Renders to React elements rather than an HTML string. That is not only about bundle
 * size: doc_md is written by whoever authors the dag, and injecting it as HTML into the
 * Airflow UI would hand them a script tag in someone else's session. Building elements
 * means the content can never be markup.
 *
 * Supports what docstrings actually use - headings, fenced code, lists, tables of
 * nothing, emphasis, inline code, links - and ignores the rest rather than pretending.
 */

/**
 * Strip the common leading indentation, the way Python's textwrap.dedent does.
 *
 * Docstrings arrive indented to their def, so without this every continuation line
 * looks like a four-space code block and the whole topic renders as source.
 */
export function dedent(text: string): string {
  const lines = text.replace(/\t/gu, "    ").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => (/^\s*/u.exec(line)?.[0] ?? "").length);
  // The first line of a docstring has no indentation, so it would pin the minimum to
  // zero and defeat the whole exercise. Judge by the lines that follow it.
  const relevant = indents.slice(1).length > 0 ? indents.slice(1) : indents;
  const common = relevant.length > 0 ? Math.min(...relevant) : 0;
  // Remove up to `common` *leading spaces*, never that many characters: the first line
  // of a docstring is unindented, and slicing it blindly eats the first four letters.
  return lines
    .map((line) => {
      if (line.trim().length === 0) return "";
      const own = line.length - line.trimStart().length;
      return line.slice(Math.min(common, own));
    })
    .join("\n");
}

/** Inline spans: `code`, **bold**, *italic*, [text](href). */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/gu;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;

    if (token.startsWith("`")) {
      nodes.push(
        <code className="aos-mono" key={key} style={{ background: "#00000010", padding: "0 2px" }}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<b key={key}>{token.slice(2, -2)}</b>);
    } else if (token.startsWith("*")) {
      nodes.push(<i key={key}>{token.slice(1, -1)}</i>);
    } else {
      const link = /\[([^\]]+)\]\(([^)]+)\)/u.exec(token);
      nodes.push(
        link ? (
          <a href={link[2]} key={key} rel="noreferrer noopener" style={{ color: "#008000" }} target="_blank">
            {link[1]}
          </a>
        ) : (
          token
        ),
      );
    }
    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Render dedented Markdown as a list of block elements. */
export function renderMarkdown(source: string): ReactNode {
  const lines = dedent(source).split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p className="aos-help-p" key={`p-${blocks.length}`}>
        {inline(paragraph.join(" "), `p${blocks.length}`)}
      </p>,
    );
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";

    // Fenced code.
    if (line.trimStart().startsWith("```")) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre className="aos-help-pre aos-mono" key={`code-${blocks.length}`}>
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/u.exec(line);
    if (heading) {
      flush();
      const level = (heading[1] ?? "#").length;
      blocks.push(
        <div
          className="aos-help-h"
          key={`h-${blocks.length}`}
          style={{ fontSize: level === 1 ? 15 : level === 2 ? 13 : 11 }}
        >
          {inline(heading[2] ?? "", `h${blocks.length}`)}
        </div>,
      );
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/u.test(line)) {
      flush();
      blocks.push(<hr className="aos-menu-sep" key={`hr-${blocks.length}`} />);
      index += 1;
      continue;
    }

    // Lists: consume the whole run so items stay together.
    if (/^\s*([-*]|\d+\.)\s+/u.test(line)) {
      flush();
      const items: string[] = [];
      const ordered = /^\s*\d+\.\s+/u.test(line);
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/u.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*([-*]|\d+\.)\s+/u, ""));
        index += 1;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag className="aos-help-list" key={`l-${blocks.length}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item, `l${blocks.length}-${itemIndex}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flush();
  return blocks;
}
