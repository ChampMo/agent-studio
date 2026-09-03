/**
 * Drawing what `markdown.ts` parsed.
 *
 * Every branch here returns a React element built from text. There is no
 * `dangerouslySetInnerHTML` anywhere in this file, and there must never be one:
 * the input is model output, some of which was copied off a fetched page, and
 * React escaping every string is what makes that safe by construction rather
 * than by a sanitiser someone has to keep current (§16.6).
 */
import { parseBlocks, type Inline } from "./markdown";

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((span, i) => {
        if (span.kind === "bold")
          return (
            <strong key={i} className="font-semibold text-text">
              {span.text}
            </strong>
          );
        if (span.kind === "italic") return <em key={i}>{span.text}</em>;
        if (span.kind === "code")
          return (
            <code
              key={i}
              className="rounded bg-bg/60 px-1 py-0.5 font-mono text-[0.9em] text-text"
            >
              {span.text}
            </code>
          );
        return <span key={i}>{span.text}</span>;
      })}
    </>
  );
}

export function MarkdownBody({ source }: { source: string }) {
  const blocks = parseBlocks(source);

  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.kind === "heading") {
          // One visual weight for all three levels. A chat bubble is not a
          // document, and an `h1` sized like one inside it reads as shouting.
          return (
            <p key={i} className="pt-1 font-semibold text-text">
              <Spans spans={block.spans} />
            </p>
          );
        }

        if (block.kind === "code") {
          return (
            <pre
              key={i}
              // Scrolls in its own box: a long line used to widen the bubble
              // and, through it, the whole transcript column.
              className="overflow-x-auto rounded-card bg-bg/60 p-2.5 font-mono text-xs leading-relaxed text-muted"
            >
              <code>{block.text}</code>
            </pre>
          );
        }

        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List
              key={i}
              className={
                block.ordered
                  ? "list-decimal space-y-1 pl-5"
                  : "list-disc space-y-1 pl-5"
              }
            >
              {block.items.map((item, j) => (
                <li key={j}>
                  <Spans spans={item} />
                </li>
              ))}
            </List>
          );
        }

        return (
          <p key={i}>
            <Spans spans={block.spans} />
          </p>
        );
      })}
    </div>
  );
}
