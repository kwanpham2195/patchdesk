import { useEffect, useRef, useState } from "react";

import { useLatestCommitted } from "./use-latest-committed";

export type NarrowedPatchState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly patch: string }
  | { readonly _tag: "Failed" };

/**
 * Loads the patch a narrowed diff mode shows while `active`, again whenever
 * `requestKey` changes. Only the latest request lands; `load` answers
 * undefined for a response about another revision, which fails the mode
 * rather than showing a patch that does not belong to the Review on screen.
 */
export function useNarrowedPatchRequest({
  active,
  requestKey,
  load,
}: {
  readonly active: boolean;
  readonly requestKey: string;
  readonly load: () => Promise<string | undefined>;
}): NarrowedPatchState {
  const loader = useLatestCommitted(load);
  const token = useRef(0);
  const [state, setState] = useState<NarrowedPatchState>({ _tag: "Idle" });
  useEffect(() => {
    const requestToken = token.current + 1;
    token.current = requestToken;
    if (!active) {
      setState({ _tag: "Idle" });
      return;
    }
    setState({ _tag: "Loading" });
    void loader
      .current()
      .then((patch) => {
        if (token.current !== requestToken) return;
        setState(
          patch === undefined ? { _tag: "Failed" } : { _tag: "Ready", patch },
        );
      })
      .catch(() => {
        if (token.current === requestToken) setState({ _tag: "Failed" });
      });
    return () => {
      if (token.current === requestToken) token.current += 1;
    };
  }, [active, requestKey, loader]);
  return active ? state : { _tag: "Idle" };
}
