type CharacterClass = (character: string) => boolean;
type Edge = { readonly accepts: CharacterClass; readonly next: number };
type State = {
  readonly edges: Edge[];
  readonly epsilon: number[];
  readonly end: "none" | "any" | "boundary";
};
type Pattern = {
  readonly prefix: string;
  readonly boundary: boolean;
  readonly runs: ReadonlyArray<{
    readonly accepts: CharacterClass;
    readonly minimum: number;
    readonly separator: string;
  }>;
  readonly end: "any" | "boundary";
};

const word: CharacterClass = (character) => /[A-Za-z0-9_]/.test(character);
const alphaNumeric: CharacterClass = (character) =>
  /[A-Za-z0-9]/.test(character);
const jwt: CharacterClass = (character) => /[A-Za-z0-9_-]/.test(character);

// These finite machines mirror json-file's credential regex, including JS word boundaries.
const machines = buildCredentialMachines();

/** Incremental values-only credential scan; retained state is independent of token and whitespace lengths. */
export class InsightSensitiveStream {
  private active = new Set<number>();
  private previousWord = false;
  private sensitive = false;

  /** Consumes a bounded text chunk without retaining its prose; true remains true for the rest of the scan. */
  push(text: string): boolean {
    if (this.sensitive) return true;
    for (let offset = 0; offset < text.length; offset += 1) {
      const character = text.charAt(offset);
      const currentWord = word(character);
      if (this.acceptsEnd(currentWord)) return true;
      for (const start of machines.starts) {
        if (!start.boundary || !this.previousWord) this.active.add(start.state);
      }
      const next = new Set<number>();
      for (const index of this.active) {
        for (const reachable of machines.closures[index] ?? []) {
          for (const edge of machines.states[reachable]?.edges ?? []) {
            if (edge.accepts(character)) next.add(edge.next);
          }
        }
      }
      this.active = next;
      this.previousWord = currentWord;
    }
    // Boundary-dependent matches must await the next character or finish().
    return this.acceptsUnconditionalEnd();
  }

  /** Signals actual end of input, where the right side of a word boundary is nonword. */
  finish(): boolean {
    return this.sensitive || this.acceptsEnd(false);
  }

  private acceptsEnd(nextWord: boolean): boolean {
    for (const index of this.active) {
      for (const reachable of machines.closures[index] ?? []) {
        const end = machines.states[reachable]?.end;
        if (
          end === "any" ||
          (end === "boundary" && this.previousWord !== nextWord)
        ) {
          this.sensitive = true;
          return true;
        }
      }
    }
    return false;
  }

  private acceptsUnconditionalEnd(): boolean {
    for (const index of this.active) {
      if (
        (machines.closures[index] ?? []).some(
          (reachable) => machines.states[reachable]?.end === "any",
        )
      ) {
        this.sensitive = true;
        return true;
      }
    }
    return false;
  }
}

function buildCredentialMachines() {
  const patterns: Pattern[] = [
    ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((prefix): Pattern => ({
      prefix,
      boundary: false,
      runs: [{ accepts: alphaNumeric, minimum: 20, separator: "" }],
      end: "any",
    })),
    {
      prefix: "github_pat_",
      boundary: false,
      runs: [{ accepts: word, minimum: 20, separator: "" }],
      end: "any",
    },
    {
      prefix: "glpat-",
      boundary: false,
      runs: [{ accepts: jwt, minimum: 20, separator: "" }],
      end: "any",
    },
    ...["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"].map((prefix): Pattern => ({
      prefix,
      boundary: false,
      runs: [
        {
          accepts: (character) => /[A-Za-z0-9-]/.test(character),
          minimum: 20,
          separator: "",
        },
      ],
      end: "any",
    })),
    {
      prefix: "Bearer",
      boundary: true,
      runs: [
        {
          accepts: (character) => /\s/.test(character),
          minimum: 1,
          separator: "",
        },
        {
          accepts: (character) => /[A-Za-z0-9._~-]/.test(character),
          minimum: 16,
          separator: "",
        },
      ],
      end: "boundary",
    },
    {
      prefix: "eyJ",
      boundary: true,
      runs: [
        { accepts: jwt, minimum: 10, separator: "." },
        { accepts: jwt, minimum: 10, separator: "." },
        { accepts: jwt, minimum: 10, separator: "" },
      ],
      end: "boundary",
    },
  ];
  const states: State[] = [];
  function state(end: State["end"] = "none"): number {
    states.push({ edges: [], epsilon: [], end });
    return states.length - 1;
  }
  function literal(from: number, text: string): number {
    let current = from;
    for (const character of text) {
      const next = state();
      states[current]?.edges.push({
        accepts: (candidate) => candidate === character,
        next,
      });
      current = next;
    }
    return current;
  }
  const starts = patterns.map((pattern) => {
    const start = state();
    let current = literal(start, pattern.prefix);
    for (const run of pattern.runs) {
      for (let count = 0; count < run.minimum; count += 1) {
        const next = state();
        states[current]?.edges.push({ accepts: run.accepts, next });
        current = next;
      }
      states[current]?.edges.push({ accepts: run.accepts, next: current });
      const after = state();
      states[current]?.epsilon.push(after);
      current = literal(after, run.separator);
    }
    states[current]?.epsilon.push(state(pattern.end));
    return { state: start, boundary: pattern.boundary };
  });
  const closures = states.map((_entry, index) => {
    const reachable = new Set([index]);
    for (const candidate of reachable) {
      for (const next of states[candidate]?.epsilon ?? []) reachable.add(next);
    }
    return [...reachable];
  });
  return { states, starts, closures };
}
