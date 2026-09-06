import { describe, expect, it } from "vitest";

import { extractImageRewrites } from "../../src/adapters/github/github-image-rewrites";

describe("extractImageRewrites", () => {
  it("maps a proxied image from its original URL to the camo URL", () => {
    expect(
      extractImageRewrites(
        '<p><img src="https://camo.githubusercontent.com/digest/hex" alt="Passed" data-canonical-src="https://sonarcloud.io/images/passed.svg" style="max-width: 100%;"></p>',
      ),
    ).toEqual({
      "https://sonarcloud.io/images/passed.svg":
        "https://camo.githubusercontent.com/digest/hex",
    });
  });

  it("omits an image GitHub left unproxied, which carries no canonical source", () => {
    expect(
      extractImageRewrites(
        '<img src="https://github.com/user-attachments/assets/1" alt="shot">',
      ),
    ).toEqual({});
  });

  it("maps every proxied image in one body", () => {
    expect(
      extractImageRewrites(
        [
          '<img data-canonical-src="https://sonarcloud.io/a.svg" src="https://camo.githubusercontent.com/a">',
          '<img src="https://camo.githubusercontent.com/b" data-canonical-src="https://sonarcloud.io/b.svg">',
          '<img src="https://github.com/user-attachments/assets/2">',
        ].join("\n"),
      ),
    ).toEqual({
      "https://sonarcloud.io/a.svg": "https://camo.githubusercontent.com/a",
      "https://sonarcloud.io/b.svg": "https://camo.githubusercontent.com/b",
    });
  });

  it("unescapes the attribute values so a query string matches the Markdown source", () => {
    expect(
      extractImageRewrites(
        '<img src="https://camo.githubusercontent.com/c?x=1&amp;y=2" data-canonical-src="https://sonarcloud.io/api/badge?project=a&amp;metric=alert_status">',
      ),
    ).toEqual({
      "https://sonarcloud.io/api/badge?project=a&metric=alert_status":
        "https://camo.githubusercontent.com/c?x=1&y=2",
    });
  });

  it("returns an empty map for absent, empty, or malformed HTML", () => {
    expect(extractImageRewrites(undefined)).toEqual({});
    expect(extractImageRewrites("")).toEqual({});
    expect(
      extractImageRewrites('<img src="https://camo.example/a" data-canonical'),
    ).toEqual({});
    expect(extractImageRewrites("<<img >>> not really html")).toEqual({});
  });
});
