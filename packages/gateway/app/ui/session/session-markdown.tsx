import { Lexer, type MarkedOptions, type MarkedToken, type Token, type Tokens } from "marked";
import { css, type Handle, type RemixNode } from "remix/ui";

const markdownOptions = { gfm: true, breaks: false } satisfies MarkedOptions;

export interface AssistantMarkdownProps {
  readonly completed: boolean;
  readonly text: string;
}

export function AssistantMarkdown(handle: Handle<AssistantMarkdownProps>) {
  return () => {
    const tokens = Lexer.lex(handle.props.text, markdownOptions);
    const blocks = tokens.filter((token) => token.type !== "space" && token.type !== "def");
    return (
      <div
        data-assistant-text
        data-markdown-completed={String(handle.props.completed)}
        data-markdown-block-count={blocks.length}
        mix={markdownStyle}
      >
        {blocks.map((token, index) => (
          <MarkdownBlockView
            key={`block:${index}`}
            token={asBuiltInMarkedToken(token)}
          />
        ))}
        {!handle.props.completed
          ? <span data-markdown-streaming-cursor aria-hidden="true">▍</span>
          : null}
      </div>
    );
  };
}

interface MarkdownBlockProps {
  readonly token: MarkedToken;
}

function MarkdownBlockView(handle: Handle<MarkdownBlockProps>) {
  return () => {
    return (
      <div
        data-markdown-block
        data-markdown-kind={handle.props.token.type}
        mix={markdownBlockStyle}
      >
        {renderBlockToken(handle.props.token, "content")}
      </div>
    );
  };
}

function renderBlockTokens(tokens: readonly Token[], path: string): RemixNode[] {
  return tokens.map((token, index) =>
    renderBlockToken(asBuiltInMarkedToken(token), `${path}:${index}`)
  );
}

function renderBlockToken(token: MarkedToken, key: string): RemixNode {
  switch (token.type) {
    case "space":
      return null;
    case "def":
      return null;
    case "blockquote":
      return <blockquote key={key}>{renderBlockTokens(token.tokens, key)}</blockquote>;
    case "code":
      return (
        <pre key={key} data-language={token.lang}>
          <code>{token.text}</code>
        </pre>
      );
    case "heading":
      return renderHeading(token.depth, renderInlineTokens(token.tokens, key), key);
    case "hr":
      return <hr key={key} />;
    case "html":
      return token.block
        ? (
          <pre key={key} data-markdown-raw-html>
            <code>{token.raw}</code>
          </pre>
        )
        : token.raw;
    case "list": {
      const items = renderListItems(token.items, key);
      return token.ordered
        ? <ol key={key} start={token.start === "" ? undefined : token.start}>{items}</ol>
        : <ul key={key}>{items}</ul>;
    }
    case "paragraph":
      return <p key={key}>{renderInlineTokens(token.tokens, key)}</p>;
    case "table":
      return renderTable(token.header, token.rows, key);
    case "text":
      return token.tokens ? renderInlineTokens(token.tokens, key) : token.text;
    default:
      return renderInlineToken(token, key);
  }
}

function renderListItems(items: readonly Tokens.ListItem[], path: string): RemixNode[] {
  return items.map((item, index) => {
    const itemKey = `${path}:item:${index}`;
    return (
      <li key={itemKey} data-task-list-item={item.task ? "true" : undefined}>
        {renderListItemTokens(item.tokens, itemKey)}
      </li>
    );
  });
}

function renderListItemTokens(tokens: readonly Token[], path: string): RemixNode[] {
  return tokens.map((candidate, index) => {
    const key = `${path}:block:${index}`;
    const token = asBuiltInMarkedToken(candidate);
    return token.type === "text"
      ? <p key={key}>{token.tokens ? renderInlineTokens(token.tokens, key) : token.text}</p>
      : renderBlockToken(token, key);
  });
}

function renderTable(
  header: readonly Tokens.TableCell[],
  rows: readonly (readonly Tokens.TableCell[])[],
  key: string,
): RemixNode {
  return (
    <div
      key={key}
      data-markdown-table-scroll
    >
      <table>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={`${key}:head:${index}`} style={{ textAlign: cell.align ?? undefined }}>
                {renderInlineTokens(cell.tokens, `${key}:head:${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${key}:row:${rowIndex}`} data-markdown-table-row>
              {row.map((cell, cellIndex) => (
                <td
                  key={`${key}:row:${rowIndex}:cell:${cellIndex}`}
                  style={{ textAlign: cell.align ?? undefined }}
                >
                  {renderInlineTokens(cell.tokens, `${key}:row:${rowIndex}:cell:${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInlineTokens(tokens: readonly Token[], path: string): RemixNode[] {
  return tokens.map((token, index) =>
    renderInlineToken(asBuiltInMarkedToken(token), `${path}:inline:${index}`)
  );
}

function renderInlineToken(token: MarkedToken, key: string): RemixNode {
  switch (token.type) {
    case "br":
      return <br key={key} />;
    case "checkbox":
      return (
        <input
          key={key}
          type="checkbox"
          checked={token.checked}
          disabled
          aria-label={token.checked ? "Completed task" : "Incomplete task"}
        />
      );
    case "codespan":
      return <code key={key}>{token.text}</code>;
    case "del":
      return <del key={key}>{renderInlineTokens(token.tokens, key)}</del>;
    case "em":
      return <em key={key}>{renderInlineTokens(token.tokens, key)}</em>;
    case "escape":
      return token.text;
    case "html":
      return token.raw;
    case "image": {
      const href = safeLinkHref(token.href);
      const label = token.text.trim().length > 0 ? `Image: ${token.text}` : "Image";
      return href === undefined ? label : (
        <a
          key={key}
          href={href}
          title={token.title ?? undefined}
          target="_blank"
          rel="noreferrer"
        >
          {label}
        </a>
      );
    }
    case "link": {
      const content = renderInlineTokens(token.tokens, key);
      const href = safeLinkHref(token.href);
      return href === undefined ? content : (
        <a
          key={key}
          href={href}
          title={token.title ?? undefined}
          target="_blank"
          rel="noreferrer"
        >
          {content}
        </a>
      );
    }
    case "strong":
      return <strong key={key}>{renderInlineTokens(token.tokens, key)}</strong>;
    case "text":
      return token.tokens ? renderInlineTokens(token.tokens, key) : token.text;
    default:
      return token.raw;
  }
}

function asBuiltInMarkedToken(token: Token): MarkedToken {
  // SAFETY: This module configures Marked without extensions, so its lexer emits built-in tokens.
  return token as MarkedToken;
}

function renderHeading(depth: number, children: RemixNode, key: string): RemixNode {
  switch (depth) {
    case 1:
      return <h1 key={key}>{children}</h1>;
    case 2:
      return <h2 key={key}>{children}</h2>;
    case 3:
      return <h3 key={key}>{children}</h3>;
    case 4:
      return <h4 key={key}>{children}</h4>;
    case 5:
      return <h5 key={key}>{children}</h5>;
    default:
      return <h6 key={key}>{children}</h6>;
  }
}

function safeLinkHref(href: string): string | undefined {
  let compactHref = "";
  for (const character of href) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0x20 && codePoint !== 0x7f) compactHref += character;
  }
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(compactHref)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto"
    ? href
    : undefined;
}

const markdownBlockStyle = css({ display: "contents" });
const markdownStyle = css({
  display: "grid",
  gap: "12px",
  minWidth: 0,
  color: "var(--foreground)",
  fontSize: "15px",
  lineHeight: 1.75,
  overflowWrap: "anywhere",
  "& p, & h1, & h2, & h3, & h4, & h5, & h6, & blockquote, & pre, & ul, & ol": {
    minWidth: 0,
    margin: 0,
  },
  "& h1": { fontSize: "1.5em", lineHeight: 1.3 },
  "& h2": { fontSize: "1.3em", lineHeight: 1.35 },
  "& h3": { fontSize: "1.15em", lineHeight: 1.4 },
  "& h4, & h5, & h6": { fontSize: "1em", lineHeight: 1.5 },
  "& ul, & ol": { display: "grid", gap: "4px", paddingLeft: "24px" },
  "& li": { minWidth: 0 },
  "& li > p": { margin: 0 },
  "& li[data-task-list-item='true']": {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    alignItems: "baseline",
    columnGap: "8px",
    listStyle: "none",
  },
  "& li[data-task-list-item='true'] > input": { gridColumn: 1, gridRow: 1, margin: 0 },
  "& li[data-task-list-item='true'] > :not(input)": { gridColumn: 2 },
  "& blockquote": {
    paddingLeft: "14px",
    color: "var(--muted-foreground)",
    borderLeft: "3px solid var(--border)",
  },
  "& pre": {
    boxSizing: "border-box",
    width: "100%",
    maxWidth: "100%",
    padding: "12px",
    overflow: "auto",
    background: "var(--muted)",
    borderRadius: "var(--radius-md)",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: 1.55,
    whiteSpace: "pre",
  },
  "& :not(pre) > code": {
    padding: "0.15em 0.35em",
    background: "var(--muted)",
    borderRadius: "var(--radius-sm)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
  },
  "& a": { color: "var(--primary)", textUnderlineOffset: "3px" },
  "& hr": { width: "100%", margin: 0, border: 0, borderTop: "1px solid var(--border)" },
  "& [data-markdown-table-scroll]": { maxWidth: "100%", overflowX: "auto" },
  "& table": {
    width: "100%",
    minWidth: "560px",
    borderCollapse: "collapse",
    fontSize: "14px",
  },
  "& th, & td": {
    padding: "6px 10px",
    overflowWrap: "normal",
    border: "1px solid var(--border)",
  },
  "& th": { background: "var(--muted)", fontWeight: 600 },
  "& [data-markdown-streaming-cursor]": {
    width: "0.65em",
    color: "var(--muted-foreground)",
    animation: "markdown-cursor-blink 1s steps(1, end) infinite",
  },
  "@keyframes markdown-cursor-blink": {
    "0%, 55%": { opacity: 1 },
    "56%, 100%": { opacity: 0 },
  },
});
