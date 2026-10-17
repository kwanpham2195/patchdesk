/** Private spool events preserve token order and UTF-16 code units, including lone surrogates. */
export type LegacyJsonToken =
  | {
      readonly tag: "punctuation";
      readonly value: "{" | "}" | "[" | "]" | ":" | ",";
    }
  | {
      readonly tag:
        | "string_start"
        | "string_end"
        | "number_start"
        | "number_end";
    }
  | {
      readonly tag: "string_fragment" | "number_fragment";
      readonly value: string;
    }
  | { readonly tag: "literal"; readonly value: "true" | "false" | "null" };

/** A lexical failure contains no source text. Structural/schema validation follows spooling. */
export class LegacyJsonLexicalError extends Error {
  readonly _tag = "LegacyJsonLexicalError";

  constructor() {
    super("Invalid legacy JSON token");
  }
}

type NumberState =
  | "minus"
  | "zero"
  | "integer"
  | "dot"
  | "fraction"
  | "exponent"
  | "exponent_sign"
  | "exponent_digits";

/** Incrementally decodes JSON tokens without retaining complete strings, numbers, keys or nesting. */
export class LegacyJsonTokenizer {
  private mode:
    | "value"
    | "string"
    | "escape"
    | "unicode"
    | "number"
    | "literal" = "value";
  private fragment = "";
  private numberState: NumberState = "integer";
  private unicodeValue = 0;
  private unicodeDigits = 0;
  private literal: "true" | "false" | "null" = "null";
  private literalOffset = 0;

  /** The caller applies backpressure to every emitted fragment before requesting another. */
  *write(chunk: string): Generator<LegacyJsonToken> {
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk.charAt(index);
      if (this.mode === "number" && !this.advanceNumber(character)) {
        yield* this.finishNumber();
      }
      switch (this.mode) {
        case "value":
          if (
            character === " " ||
            character === "\n" ||
            character === "\r" ||
            character === "\t"
          )
            break;
          if (
            character === "{" ||
            character === "}" ||
            character === "[" ||
            character === "]" ||
            character === ":" ||
            character === ","
          ) {
            yield { tag: "punctuation", value: character };
          } else if (character === '"') {
            this.mode = "string";
            yield { tag: "string_start" };
          } else if (character === "-" || /[0-9]/.test(character)) {
            this.mode = "number";
            this.numberState =
              character === "-"
                ? "minus"
                : character === "0"
                  ? "zero"
                  : "integer";
            this.fragment = character;
            yield { tag: "number_start" };
          } else if (
            character === "t" ||
            character === "f" ||
            character === "n"
          ) {
            this.mode = "literal";
            this.literal =
              character === "t" ? "true" : character === "f" ? "false" : "null";
            this.literalOffset = 1;
          } else throw new LegacyJsonLexicalError();
          break;
        case "string":
          if (character === '"') {
            if (this.fragment.length > 0)
              yield { tag: "string_fragment", value: this.fragment };
            this.fragment = "";
            this.mode = "value";
            yield { tag: "string_end" };
          } else if (character === "\\") this.mode = "escape";
          else {
            if (character.charCodeAt(0) < 32)
              throw new LegacyJsonLexicalError();
            this.fragment += character;
          }
          break;
        case "escape": {
          const escaped = decodeEscape(character);
          if (character === "u") {
            this.mode = "unicode";
            this.unicodeDigits = 0;
            this.unicodeValue = 0;
          } else if (escaped !== undefined) {
            this.fragment += escaped;
            this.mode = "string";
          } else throw new LegacyJsonLexicalError();
          break;
        }
        case "unicode":
          if (!/[0-9a-fA-F]/.test(character))
            throw new LegacyJsonLexicalError();
          this.unicodeValue =
            this.unicodeValue * 16 + Number.parseInt(character, 16);
          this.unicodeDigits += 1;
          if (this.unicodeDigits === 4) {
            this.fragment += String.fromCharCode(this.unicodeValue);
            this.mode = "string";
          }
          break;
        case "number":
          this.fragment += character;
          break;
        case "literal":
          if (character !== this.literal.charAt(this.literalOffset))
            throw new LegacyJsonLexicalError();
          this.literalOffset += 1;
          if (this.literalOffset === this.literal.length) {
            yield { tag: "literal", value: this.literal };
            this.mode = "value";
          }
          break;
      }
      if (this.fragment.length >= 2048) {
        yield {
          tag: this.mode === "number" ? "number_fragment" : "string_fragment",
          value: this.fragment,
        };
        this.fragment = "";
      }
    }
  }

  /** Rejects incomplete lexical tokens; this deliberately does not attest JSON container grammar. */
  *finish(): Generator<LegacyJsonToken> {
    if (this.mode === "number") yield* this.finishNumber();
    if (this.mode !== "value") throw new LegacyJsonLexicalError();
  }

  private *finishNumber(): Generator<LegacyJsonToken> {
    if (
      this.numberState === "minus" ||
      this.numberState === "dot" ||
      this.numberState === "exponent" ||
      this.numberState === "exponent_sign"
    )
      throw new LegacyJsonLexicalError();
    if (this.fragment.length > 0)
      yield { tag: "number_fragment", value: this.fragment };
    this.fragment = "";
    this.mode = "value";
    yield { tag: "number_end" };
  }

  private advanceNumber(character: string): boolean {
    const digit = /[0-9]/.test(character);
    switch (this.numberState) {
      case "minus":
        if (!digit) return false;
        this.numberState = character === "0" ? "zero" : "integer";
        return true;
      case "zero":
      case "integer":
        if (digit && this.numberState === "integer") return true;
        if (character === ".") {
          this.numberState = "dot";
          return true;
        }
        if (character === "e" || character === "E") {
          this.numberState = "exponent";
          return true;
        }
        return false;
      case "dot":
        if (!digit) return false;
        this.numberState = "fraction";
        return true;
      case "fraction":
        if (digit) return true;
        if (character === "e" || character === "E") {
          this.numberState = "exponent";
          return true;
        }
        return false;
      case "exponent":
        if (character === "+" || character === "-") {
          this.numberState = "exponent_sign";
          return true;
        }
        if (!digit) return false;
        this.numberState = "exponent_digits";
        return true;
      case "exponent_sign":
        if (!digit) return false;
        this.numberState = "exponent_digits";
        return true;
      case "exponent_digits":
        return digit;
    }
  }
}

function decodeEscape(character: string): string | undefined {
  switch (character) {
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return undefined;
  }
}
