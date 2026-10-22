import type {
  WalkthroughPage,
  WalkthroughPageRequest,
} from "#src/domain/walkthrough-progress";
import { requestJson } from "#src/renderer/src/api-client";
import { parseWalkthroughPageReply } from "#src/renderer/src/walkthrough-contracts";

/** Identity of a single immutable reading graph. */
export type WalkthroughSource = Pick<
  WalkthroughPageRequest,
  "profileId" | "reviewId" | "digest"
>;
/** Only the selected section and one window of each list are retained. */
export type WalkthroughReaderSnapshot = {
  readonly section: Extract<WalkthroughPage, { kind: "section" }> | null;
  readonly navigation: Extract<WalkthroughPage, { kind: "navigation" }> | null;
  readonly citations: Extract<WalkthroughPage, { kind: "citations" }> | null;
  readonly loading: boolean;
  readonly failed: boolean;
};

/** Reads one strict bounded page through the desktop bridge. */
export async function readWalkthroughPage(
  source: WalkthroughSource,
  page: WalkthroughPageRequest["page"],
  options?: { readonly signal?: AbortSignal },
): Promise<WalkthroughPage> {
  const parsed = parseWalkthroughPageReply(
    await requestJson(
      "/v1/reviews/insights/walkthrough/page",
      {
        method: "POST",
        body: { ...source, page },
      },
      options,
    ),
  );
  if (parsed === undefined) throw new Error("Invalid Walkthrough page reply");
  return parsed;
}

/** Selection epochs fence replies while cancellation releases obsolete queued reads. */
export class WalkthroughReaderController {
  private snapshot: WalkthroughReaderSnapshot = {
    section: null,
    navigation: null,
    citations: null,
    loading: true,
    failed: false,
  };
  private readonly listeners = new Set<() => void>();
  private selection = 0;
  private navigationRequest = 0;
  private citationRequest = 0;
  private disposed = false;
  private sectionAbort: AbortController | undefined;
  private navigationAbort: AbortController | undefined;
  private citationAbort: AbortController | undefined;
  constructor(private readonly source: WalkthroughSource) {}

  /** React observes stable snapshots rather than an accumulating page cache. */
  readonly getSnapshot = (): WalkthroughReaderSnapshot => this.snapshot;
  /** Subscribe to accepted responses only. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Invalidates outstanding requests when the digest or Review changes. */
  dispose(): void {
    this.disposed = true;
    this.selection += 1;
    this.sectionAbort?.abort();
    this.navigationAbort?.abort();
    this.citationAbort?.abort();
  }

  /** A confirmed mark updates only rows already in the bounded window. */
  setReviewed(sectionId: string, reviewed: boolean): void {
    this.update({
      ...this.snapshot,
      section:
        this.snapshot.section?.sectionId === sectionId
          ? { ...this.snapshot.section, reviewed }
          : this.snapshot.section,
      navigation:
        this.snapshot.navigation === null
          ? null
          : {
              ...this.snapshot.navigation,
              items: this.snapshot.navigation.items.map((item) =>
                item.sectionId === sectionId ? { ...item, reviewed } : item,
              ),
            },
    });
  }

  /** Direct section reads restore a saved position without walking prior pages. */
  readonly selectSection = (sectionId: string): void => {
    this.disposed = false;
    const epoch = ++this.selection;
    this.navigationRequest += 1;
    this.citationRequest += 1;
    this.sectionAbort?.abort();
    this.navigationAbort?.abort();
    this.citationAbort?.abort();
    this.sectionAbort = new AbortController();
    this.update({
      ...this.snapshot,
      section: null,
      citations: null,
      loading: true,
      failed: false,
    });
    void readWalkthroughPage(
      this.source,
      { kind: "section", sectionId },
      { signal: this.sectionAbort.signal },
    )
      .then((page) => {
        if (this.disposed || epoch !== this.selection) return;
        if (page.kind !== "section" || page.sectionId !== sectionId)
          throw new Error("Invalid Walkthrough section");
        this.update({ ...this.snapshot, section: page, loading: false });
        if (
          !this.snapshot.navigation?.items.some(
            (item) => item.sectionId === sectionId,
          )
        )
          this.loadNavigation(page.navigationCursor);
        this.loadCitations(null);
      })
      .catch(() => {
        if (!this.disposed && epoch === this.selection)
          this.update({ ...this.snapshot, loading: false, failed: true });
      });
  };

  /** A window replaces the prior window; Previous/More never concatenate all navigation. */
  readonly loadNavigation = (cursor: string | null): void => {
    const epoch = ++this.navigationRequest;
    this.navigationAbort?.abort();
    this.navigationAbort = new AbortController();
    void readWalkthroughPage(
      this.source,
      { kind: "navigation", cursor },
      { signal: this.navigationAbort.signal },
    )
      .then((page) => {
        if (this.disposed || epoch !== this.navigationRequest) return;
        if (page.kind !== "navigation")
          throw new Error("Invalid Walkthrough navigation");
        this.update({ ...this.snapshot, navigation: page });
      })
      .catch(() => {
        if (!this.disposed && epoch === this.navigationRequest)
          this.update({ ...this.snapshot, failed: true });
      });
  };

  /** Citation windows unmount their previous cards and release their captured text. */
  readonly loadCitations = (cursor: string | null): void => {
    const sectionId = this.snapshot.section?.sectionId;
    if (sectionId === undefined) return;
    const selection = this.selection;
    const epoch = ++this.citationRequest;
    this.citationAbort?.abort();
    this.citationAbort = new AbortController();
    this.update({ ...this.snapshot, citations: null });
    void readWalkthroughPage(
      this.source,
      {
        kind: "citations",
        sectionId,
        cursor,
      },
      { signal: this.citationAbort.signal },
    )
      .then((page) => {
        if (
          this.disposed ||
          selection !== this.selection ||
          epoch !== this.citationRequest
        )
          return;
        if (page.kind !== "citations" || page.sectionId !== sectionId)
          throw new Error("Invalid Walkthrough citations");
        this.update({ ...this.snapshot, citations: page });
      })
      .catch(() => {
        if (
          !this.disposed &&
          selection === this.selection &&
          epoch === this.citationRequest
        )
          this.update({ ...this.snapshot, failed: true });
      });
  };

  private update(snapshot: WalkthroughReaderSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
