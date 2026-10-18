/** Matches only the old json-file.ts predicates over decoded UTF16 code units. */
export class LegacySensitiveString {
  private suffix = "";
  private matched = false;
  private previousWord = false;
  private github = -1;
  private githubPat = -1;
  private gitlab = -1;
  private slack = -1;
  private bearer = -1;
  private bearerSpace = false;
  private bearerPrefix = false;
  private jwtFirst = -1;
  private jwtSecond = -1;
  private jwtThird = -1;

  /** Keys never use credential matching; ordinary string values never use key-word matching. */
  constructor(private readonly kind: "key" | "string") {}

  /** Fragment boundaries do not supply a word boundary or end the scalar. */
  write(fragment: string): boolean {
    for (let index = 0; index < fragment.length && !this.matched; index += 1) {
      const character = fragment.charAt(index);
      this.suffix = (this.suffix + character).slice(-13);
      if (this.kind === "key") {
        this.matched = /(?:secret|authorization|cookie|password)/i.test(
          this.suffix,
        );
      } else this.consumeValue(character);
    }
    return this.matched;
  }

  /** Only scalar_end supplies the true non-word EOF for the two boundary-ended alternatives. */
  finish(): boolean {
    return this.matched || (this.kind === "string" && this.boundary(false));
  }

  private consumeValue(character: string): void {
    const word = /\w/.test(character);
    if (this.boundary(word)) {
      this.matched = true;
      return;
    }
    const alphanumeric = /[A-Za-z0-9]/.test(character);
    const jwtUnit = /[A-Za-z0-9_-]/.test(character);
    this.github = advance(this.github, alphanumeric, 20);
    this.githubPat = advance(
      this.githubPat,
      /[A-Za-z0-9_]/.test(character),
      20,
    );
    this.gitlab = advance(this.gitlab, jwtUnit, 20);
    this.slack = advance(this.slack, /[A-Za-z0-9-]/.test(character), 20);
    if (
      this.github === 20 ||
      this.githubPat === 20 ||
      this.gitlab === 20 ||
      this.slack === 20
    ) {
      this.matched = true;
      return;
    }

    const whitespace = /\s/.test(character);
    const bearerUnit = /[A-Za-z0-9._~-]/.test(character);
    this.bearer = this.bearerSpace
      ? bearerUnit
        ? 1
        : -1
      : advance(this.bearer, bearerUnit, 16);
    this.bearerSpace = whitespace && (this.bearerSpace || this.bearerPrefix);
    this.bearerPrefix = /\bBearer$/.test(this.suffix);

    // At a dot, qualifying first and second runs advance simultaneously, not in-place.
    const second = this.jwtFirst >= 10 && character === ".";
    const third = this.jwtSecond >= 10 && character === ".";
    this.jwtFirst = advance(this.jwtFirst, jwtUnit, 10);
    this.jwtSecond = second ? 0 : advance(this.jwtSecond, jwtUnit, 10);
    this.jwtThird = third ? 0 : advance(this.jwtThird, jwtUnit, 10);

    // Earlier starts dominate later starts within the same run because these classes are identical.
    if (/gh[pousr]_$/.test(this.suffix)) this.github = Math.max(this.github, 0);
    if (/github_pat_$/.test(this.suffix))
      this.githubPat = Math.max(this.githubPat, 0);
    if (/glpat-$/.test(this.suffix)) this.gitlab = Math.max(this.gitlab, 0);
    if (/xox[baprs]-$/.test(this.suffix)) this.slack = Math.max(this.slack, 0);
    if (/\beyJ$/.test(this.suffix)) this.jwtFirst = Math.max(this.jwtFirst, 0);
    this.previousWord = word;
  }

  private boundary(nextWord: boolean): boolean {
    return (
      this.previousWord !== nextWord &&
      (this.bearer >= 16 || this.jwtThird >= 10)
    );
  }
}

function advance(count: number, accepted: boolean, minimum: number): number {
  return accepted && count >= 0 ? Math.min(minimum, count + 1) : -1;
}
