/**
 * Reads GitHub's own image substitutions (`GitHubImageRewrites`) out of the
 * rendered HTML it returns beside a comment body.
 *
 * GitHub proxies every off-site image in a comment through camo and records
 * the URL the author wrote on `data-canonical-src`:
 *
 * ```html
 * <img src="https://camo.githubusercontent.com/<digest>/<hex>"
 *      alt="Passed" data-canonical-src="https://sonarcloud.io/....svg">
 * ```
 *
 * The camo copy is on `*.githubusercontent.com`, which the main process's
 * image resolver already allows, while the original host is not — so a body
 * that carries badges renders them only if the renderer fetches the proxied
 * URL instead. This is the mapping that lets it, read from `body_html` (which
 * `Accept: application/vnd.github.full+json` adds to a REST comment read) and
 * discarded here rather than carried any further.
 *
 * A regex is enough: the input is GitHub's own generated HTML, never author
 * text, and only two attributes of one void element are read.
 */

import type { GitHubImageRewrites } from "../../domain/github-context";

const imageTagPattern = /<img\b[^>]*>/gi;
const attributePattern = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Maps each proxied image's original URL to the camo URL GitHub serves it from. */
export function extractImageRewrites(
  bodyHtml: string | undefined,
): GitHubImageRewrites {
  const rewrites: Record<string, string> = {};
  if (bodyHtml === undefined) return rewrites;
  for (const tag of bodyHtml.match(imageTagPattern) ?? []) {
    const attributes = new Map<string, string>();
    for (const [, name, quoted, singleQuoted] of tag.matchAll(
      attributePattern,
    )) {
      const value = quoted ?? singleQuoted;
      if (name !== undefined && value !== undefined)
        attributes.set(name.toLowerCase(), unescapeAttribute(value));
    }
    const canonical = attributes.get("data-canonical-src");
    const src = attributes.get("src");
    // An image GitHub served unproxied has no canonical source and needs no rewrite.
    if (
      canonical !== undefined &&
      canonical.length > 0 &&
      src !== undefined &&
      src.length > 0
    )
      rewrites[canonical] = src;
  }
  return rewrites;
}

/** GitHub escapes attribute values; the Markdown source the renderer matches against is not escaped. */
function unescapeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
