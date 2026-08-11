---
created_at: 2026-08-07
repos:
  - patchdesk
  - backnotprop/plannotator
status: research-complete
---

# Plannotator Markdown and Mermaid rendering research

## Question

How does Plannotator render Markdown and Mermaid, and what is relevant to Patchdesk's lost list-item text?

## Sources read

### Patchdesk

- `CONTEXT.md`
- `.agents/tasks/conversation-screen/spec.md`
- `.agents/tasks/conversation-screen/tech-spec.md`
- `src/renderer/src/components/pull-request-description.tsx`
- `tests/renderer/pull-request-description.ui.test.tsx`

### Plannotator

Repository retrieved with `$librarian` to:
`/Users/kwanpham/.cache/checkouts/github.com/backnotprop/plannotator`

Snapshot: `57b0358265fd22a2f84a5b3d9fa4776e9af9e25e` (2026-08-06).

- `packages/review-editor/components/AnnotatableDescription.tsx`
- `packages/ui/components/RenderedMarkdown.tsx`
- `packages/ui/utils/parser.ts`
- `packages/ui/components/BlockRenderer.tsx`
- `packages/ui/components/ListItemBody.tsx`
- `packages/ui/components/InlineMarkdown.tsx`
- `packages/ui/components/Viewer.tsx`
- `packages/ui/components/MermaidBlock.tsx`
- `packages/ui/components/diagramLanguages.ts`
- `packages/ui/components/mermaidSvg.ts`
- `packages/ui/components/blocks/CodeBlock.tsx`
- `packages/ui/utils/sanitizeHtml.ts`
- `packages/ui/utils/parser.test.ts`
- `packages/ui/components/MermaidBlock.test.ts`
- `packages/ui/components/diagramLanguages.test.ts`

## Findings

### Markdown for PR descriptions

Plannotator's review-editor PR description uses `AnnotatableDescription`, which renders the shared `RenderedMarkdown` component. `RenderedMarkdown` calls `parseMarkdownToBlocks()`, groups adjacent list items, then sends every block to `BlockRenderer`.

`parseMarkdownToBlocks()` is a custom line-oriented parser, not a CommonMark AST renderer. It recognizes headings, list items, blockquotes, fenced code, math, tables, raw HTML, directives, and paragraphs. `InlineMarkdown` then scans each block's text for inline formatting, links, images, and other custom features.

List text has a dedicated route:

```text
Markdown list line
  → parser creates { type: "list-item", content }
  → RenderedMarkdown groups adjacent list-item blocks
  → BlockRenderer renders ListItemBody
  → ListItemBody renders its content via InlineMarkdown
```

`ListItemBody` explicitly renders the item content in a `<span>` for one paragraph or `<p>` elements for multiple paragraphs. Therefore the marker and the text are coupled at a dedicated renderer boundary; list text cannot fall through an unhandled generic token case.

The parser tests cover the list-continuation cases: tight and loose continuations, ordered items, nested items, and block elements after lists. See `packages/ui/utils/parser.test.ts` under `parseMarkdownToBlocks — list continuation lines`.

### Mermaid for plans

Plannotator's rich plan `Viewer` treats a fenced block as Mermaid only when `isMermaidLanguage(block.language)` is true. The predicate is case-insensitive and accepts `mermaid` as the first fence-info token.

The viewer dispatches such blocks to `MermaidBlock`, which:

1. Initializes Mermaid once at module load with `startOnLoad: false` and `securityLevel: "strict"`.
2. Calls `mermaid.render(id, block.content)` asynchronously.
3. Normalizes the resulting SVG markup for size and aspect-ratio behavior.
4. Injects the Mermaid-produced SVG into a diagram container.
5. Offers source/diagram switching, zoom from 0.25x through 8x, wheel zoom, drag-to-pan, resize-to-fit behavior, error fallback with source, and an expanded overlay that closes with Escape.

The normalizer has direct unit tests in `MermaidBlock.test.ts`; language detection has direct tests in `diagramLanguages.test.ts`.

### Important distinction: Plannotator PR descriptions do not render Mermaid diagrams

`RenderedMarkdown`, which is the component used by Plannotator's review-editor PR description, delegates every code fence to `BlockRenderer`. `BlockRenderer` renders a `code` block through `CodeBlock`, including a `mermaid` fence.

The Mermaid-specific dispatch exists in `Viewer.tsx`, not in `RenderedMarkdown.tsx` or `BlockRenderer.tsx`. Thus Plannotator renders Mermaid diagrams in its rich plan viewer, but its lean PR-description renderer shows Mermaid as a syntax-highlighted code block. Its own ADR research states this explicitly: `adr/research/SPIKE-renderer-migration-20260630-155500.md` says the lean PR renderer renders Mermaid/Graphviz as code in v1.

### HTML and link safety

Plannotator uses two approaches depending on content type:

- The custom React block/inline renderer escapes text by construction. `InlineMarkdown` rejects dangerous `javascript:`, `data:`, `vbscript:`, and `file:` link protocols before producing anchors.
- For raw HTML blocks it calls `marked.parse()` and then DOMPurify with explicit tag and attribute allowlists (`sanitizeBlockHtml`). Its HTML block applies the sanitized markup imperatively and memoizes it, preserving user-controlled `<details open>` state across parent re-renders.

Mermaid's strict security setting is a relevant defense, but Plannotator injects the Mermaid-generated SVG with `dangerouslySetInnerHTML`; the repository does not add a separate sanitizer to that SVG path.

## Comparison with Patchdesk

Patchdesk calls `marked.lexer()` and recursively maps parser tokens in `PullRequestDescriptionPreview`. For list items, it passes `item.tokens` to `renderBlocks()`. In Marked 18, those list-item children are `text` tokens. Patchdesk `renderBlocks()` has no `text` case, so it returns `null`; the `<li>` still exists and produces a bare bullet. This exactly explains the screenshot.

Plannotator does not provide a ready-made solution to copy wholesale:

- Its custom parser avoids this particular nested-token mismatch by modeling a list item as a first-class block with string content.
- Its rich Mermaid implementation is more complete than Patchdesk's, but it only applies to the plan viewer, not its PR description.
- Porting its parser would replace Patchdesk's GFM `marked` AST with a less general custom parser, which is not justified by the list regression alone.

## Relevant options for a later design

1. **Minimal Patchdesk correction:** render list item bodies as inline tokens, or add a `text` handling case at the `renderBlocks()` boundary. Add a focused regression test for Markdown lists; this directly repairs the observed data loss.
2. **Make the renderer boundary explicit:** distinguish block token rendering from inline token rendering so list-item children always pass through `renderInline()`. This matches Plannotator's useful structural lesson without replacing the GFM parser.
3. **Mermaid follow-up only if needed:** retain Patchdesk's lazy Mermaid loading and strict security mode. Plannotator supplies interaction ideas—source fallback, zoom, fit, pan, expanded view—but its PR description does not establish a reference implementation for that surface.

No implementation was performed.
