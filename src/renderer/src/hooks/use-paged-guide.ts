import { useCallback, useEffect, useRef, useState } from "react";

import type { GuideGroupId } from "#src/domain/guide";
import type {
  GuideRunStatus,
  GuidePage,
  GuidePageRequest,
  GuideSummary,
} from "#src/domain/guide-progress";
import { requestGuideJson } from "./guide-request-scheduler";
import { useLatestCommitted } from "./use-latest-committed";
import { parseGuidePageReply } from "#src/renderer/src/guide-contracts";
import type { GuideSummaryState } from "./use-guide-summary";

type ReadySummary = Extract<GuideSummary, { _tag: "ready" }>;
type GroupItem = Extract<GuidePage, { kind: "groups" }>["items"][number];
type MemberItem = Extract<GuidePage, { kind: "members" }>["items"][number];
type OtherItem = Extract<GuidePage, { kind: "others" }>["items"][number];

/** One group with its loaded members; `membersNext` is the cursor for more, null once all are loaded. */
type PagedGuideGroup = GroupItem & {
  readonly members: ReadonlyArray<MemberItem>;
  readonly membersNext: string | null;
  readonly membersLoaded: boolean;
  readonly explanationText: string;
  readonly explanationNext: string | null;
};

type PagedGuide =
  | { readonly status: "loading" }
  | { readonly status: "none"; readonly run: GuideRunStatus }
  | { readonly status: "failed" }
  | {
      readonly status: "ready";
      readonly summary: ReadySummary;
      readonly groups: ReadonlyArray<PagedGuideGroup>;
      readonly groupsComplete: boolean;
      readonly others: ReadonlyArray<OtherItem>;
      readonly othersCounts: Extract<GuidePage, { kind: "others" }>["counts"];
      readonly othersNext: string | null;
      readonly othersLoaded: boolean;
    };

export type PagedGuideControls = {
  readonly guide: PagedGuide;
  /** Initial sections and the saved anchor's row exist before scroll restoration records progress. */
  readonly positionReady: boolean;
  readonly loadMoreMembers: (groupId: GuideGroupId) => void;
  readonly loadMoreExplanation: (groupId: GuideGroupId) => void;
  readonly loadMoreOthers: () => void;
};

type Identity = { readonly profileId: string; readonly reviewId: string };

function currentPagedGuide(
  state: GuideSummaryState,
  guide: PagedGuide,
): PagedGuide {
  if (state.status !== "loaded") return { status: state.status };
  const summary = state.summary;
  if (summary._tag === "none") return { status: "none", run: summary.run };
  if (guide.status === "failed") return guide;
  return guide.status === "ready" && guide.summary.digest === summary.digest
    ? guide
    : { status: "loading" };
}

async function readPage(
  identity: Identity,
  digest: string,
  page: GuidePageRequest["page"],
  options: { readonly signal?: AbortSignal } = {},
): Promise<GuidePage> {
  const parsed = parseGuidePageReply(
    await requestGuideJson(
      "/v1/reviews/insights/guide/page",
      {
        method: "POST",
        body: { ...identity, digest, page },
      },
      options,
    ),
  );
  if (parsed === undefined) throw new Error("Invalid Guide page reply");
  return parsed;
}

/**
 * Loads the published Guide as bounded pages: the digest summary, every group page, then each group's first members
 * and the first Others page, continuing only the saved anchor's list until its row is present. Others is the list
 * the worker stored. The shared summary owner selects the exact result before any page is read.
 */
export function usePagedGuide(
  identity: Identity,
  summaryState: GuideSummaryState,
): PagedGuideControls {
  const [guide, setGuide] = useState<PagedGuide>({ status: "loading" });
  const requests = useRef<AbortController | null>(null);
  const latest = useLatestCommitted(guide);
  const { profileId, reviewId } = identity;
  const summary =
    summaryState.status === "loaded" ? summaryState.summary : undefined;
  const readySummary = summary?._tag === "ready" ? summary : undefined;
  const latestSummary = useLatestCommitted(readySummary);
  const digest = readySummary?.digest;

  useEffect(() => {
    const summary = latestSummary.current;
    let cancelled = false;
    const controller = new AbortController();
    requests.current = controller;
    const patch = (
      update: (ready: Extract<PagedGuide, { status: "ready" }>) => PagedGuide,
    ): void =>
      setGuide((current) =>
        cancelled || current.status !== "ready" ? current : update(current),
      );
    const stateIdentity: Identity = { profileId, reviewId };
    void (async () => {
      setGuide({ status: "loading" });
      try {
        if (summary === undefined) return;
        setGuide({
          status: "ready",
          summary,
          groups: [],
          groupsComplete: false,
          others: [],
          othersCounts: { changed: 0, renamed: 0, deleted: 0 },
          othersNext: null,
          othersLoaded: false,
        });
        let cursor: string | null = null;
        const loaded: GroupItem[] = [];
        do {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- group pages follow their cursors in order
          const page: GuidePage = await readPage(
            stateIdentity,
            summary.digest,
            { kind: "groups", cursor },
            { signal: controller.signal },
          );
          if (cancelled || page.kind !== "groups") return;
          loaded.push(...page.items);
          cursor = page.next;
          patch((ready) => ({
            ...ready,
            groups: loaded.map((group) => ({
              ...group,
              members: [],
              membersNext: null,
              membersLoaded: false,
              explanationText: group.explanation.text,
              explanationNext: group.explanation.next,
            })),
            groupsComplete: cursor === null,
          }));
        } while (cursor !== null);
        let othersCursor: string | null = null;
        const loadedOthers: OtherItem[] = [];
        do {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- load only through the saved Others anchor
          const others = await readPage(
            stateIdentity,
            summary.digest,
            {
              kind: "others",
              cursor: othersCursor,
            },
            { signal: controller.signal },
          );
          if (cancelled || others.kind !== "others") return;
          loadedOthers.push(...others.items);
          othersCursor = others.next;
          patch((ready) => ({
            ...ready,
            others: [...loadedOthers],
            othersCounts: others.counts,
            othersNext: others.next,
            othersLoaded: true,
          }));
        } while (
          othersCursor !== null &&
          summary.anchor.kind === "file" &&
          summary.anchor.groupId === "others" &&
          !loadedOthers.some(
            (item) =>
              summary.anchor.kind === "file" &&
              item.fileId === summary.anchor.fileId,
          )
        );
        for (const group of loaded) {
          let membersCursor: string | null = null;
          const loadedMembers: MemberItem[] = [];
          do {
            // react-doctor-disable-next-line react-doctor/async-await-in-loop -- load only through the saved anchor in its owning group
            const members = await readPage(
              stateIdentity,
              summary.digest,
              {
                kind: "members",
                groupId: group.id,
                cursor: membersCursor,
              },
              { signal: controller.signal },
            );
            if (cancelled || members.kind !== "members") return;
            loadedMembers.push(...members.items);
            membersCursor = members.next;
            patch((ready) => ({
              ...ready,
              groups: ready.groups.map((candidate) =>
                candidate.id === group.id
                  ? {
                      ...candidate,
                      members: [...loadedMembers],
                      membersNext: members.next,
                      membersLoaded: true,
                    }
                  : candidate,
              ),
            }));
          } while (
            membersCursor !== null &&
            summary.anchor.kind === "file" &&
            summary.anchor.groupId === group.id &&
            !loadedMembers.some(
              (item) =>
                summary.anchor.kind === "file" &&
                item.fileId === summary.anchor.fileId,
            )
          );
        }
      } catch {
        if (!cancelled) setGuide({ status: "failed" });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [profileId, reviewId, digest, latestSummary]);

  const loadMoreMembers = useCallback(
    (groupId: GuideGroupId) => {
      {
        const current = latest.current;
        const controller = requests.current;
        if (
          current.status !== "ready" ||
          controller === null ||
          controller.signal.aborted
        )
          return;
        const group = current.groups.find(
          (candidate) => candidate.id === groupId,
        );
        if (group === undefined || group.membersNext === null) return;
        const cursor = group.membersNext;
        void readPage(
          { profileId, reviewId },
          current.summary.digest,
          {
            kind: "members",
            groupId,
            cursor,
          },
          { signal: controller.signal },
        )
          .then((page) => {
            if (controller.signal.aborted || page.kind !== "members") return;
            setGuide((latest) =>
              latest.status !== "ready"
                ? latest
                : {
                    ...latest,
                    groups: latest.groups.map((candidate) =>
                      candidate.id === groupId &&
                      candidate.membersNext === cursor
                        ? {
                            ...candidate,
                            members: [...candidate.members, ...page.items],
                            membersNext: page.next,
                          }
                        : candidate,
                    ),
                  },
            );
          })
          .catch(() => {
            if (!controller.signal.aborted) setGuide({ status: "failed" });
          });
      }
    },
    [latest, profileId, reviewId],
  );

  const loadMoreExplanation = useCallback(
    (groupId: GuideGroupId) => {
      {
        const current = latest.current;
        const controller = requests.current;
        if (
          current.status !== "ready" ||
          controller === null ||
          controller.signal.aborted
        )
          return;
        const group = current.groups.find(
          (candidate) => candidate.id === groupId,
        );
        if (group === undefined || group.explanationNext === null) return;
        const cursor = group.explanationNext;
        void readPage(
          { profileId, reviewId },
          current.summary.digest,
          {
            kind: "text",
            field: { type: "group_explanation", groupId },
            cursor,
          },
          { signal: controller.signal },
        )
          .then((page) => {
            if (controller.signal.aborted || page.kind !== "text") return;
            setGuide((latest) =>
              latest.status !== "ready"
                ? latest
                : {
                    ...latest,
                    groups: latest.groups.map((candidate) =>
                      candidate.id === groupId &&
                      candidate.explanationNext === cursor
                        ? {
                            ...candidate,
                            explanationText:
                              candidate.explanationText + page.part.text,
                            explanationNext: page.part.next,
                          }
                        : candidate,
                    ),
                  },
            );
          })
          .catch(() => {
            if (!controller.signal.aborted) setGuide({ status: "failed" });
          });
      }
    },
    [latest, profileId, reviewId],
  );

  const loadMoreOthers = useCallback(() => {
    {
      const current = latest.current;
      const controller = requests.current;
      if (
        current.status !== "ready" ||
        current.othersNext === null ||
        controller === null ||
        controller.signal.aborted
      )
        return;
      const cursor = current.othersNext;
      void readPage(
        { profileId, reviewId },
        current.summary.digest,
        {
          kind: "others",
          cursor,
        },
        { signal: controller.signal },
      )
        .then((page) => {
          if (controller.signal.aborted || page.kind !== "others") return;
          setGuide((latest) =>
            latest.status !== "ready" || latest.othersNext !== cursor
              ? latest
              : {
                  ...latest,
                  others: [...latest.others, ...page.items],
                  othersNext: page.next,
                },
          );
        })
        .catch(() => {
          if (!controller.signal.aborted) setGuide({ status: "failed" });
        });
    }
  }, [latest, profileId, reviewId]);

  const anchor = guide.status === "ready" ? guide.summary.anchor : undefined;
  const positionReady =
    guide.status === "ready" &&
    guide.groupsComplete &&
    guide.othersLoaded &&
    guide.groups.every((group) => group.membersLoaded) &&
    (anchor?.kind !== "file" ||
      (anchor.groupId === "others"
        ? guide.others.some((item) => item.fileId === anchor.fileId)
        : guide.groups.some(
            (group) =>
              group.id === anchor.groupId &&
              group.members.some((item) => item.fileId === anchor.fileId),
          )));
  return {
    guide: currentPagedGuide(summaryState, guide),
    positionReady,
    loadMoreMembers,
    loadMoreExplanation,
    loadMoreOthers,
  };
}

type CapturedField = Extract<
  GuidePageRequest["page"],
  { kind: "text" }
>["field"];

/**
 * Loads one bounded text field of the published result a part at a time until it is whole: a file's captured patch or
 * a long inventory entry. It reads the immutable result, never the current source.
 */
export function useCapturedText(
  identity: Identity,
  digest: string,
  field: CapturedField,
  enabled: boolean,
): {
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly text: string;
} {
  const [state, setState] = useState<{
    readonly status: "idle" | "loading" | "ready" | "failed";
    readonly text: string;
  }>({ status: "idle", text: "" });
  const { profileId, reviewId } = identity;
  const fieldKey = JSON.stringify(field);
  const latestField = useLatestCommitted(field);
  useEffect(() => {
    if (!enabled) return;
    const capturedField = latestField.current;
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      setState({ status: "loading", text: "" });
      try {
        let cursor: string | null = null;
        let text = "";
        do {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- parts follow their cursors in order
          const page: GuidePage = await readPage(
            { profileId, reviewId },
            digest,
            { kind: "text", field: capturedField, cursor },
            { signal: controller.signal },
          );
          if (cancelled) return;
          if (page.kind !== "text") throw new Error("Invalid Guide text page");
          text += page.part.text;
          cursor = page.part.next;
        } while (cursor !== null);
        setState({ status: "ready", text });
      } catch {
        if (!cancelled) setState({ status: "failed", text: "" });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // The key tracks semantic field changes while callers may pass a fresh object each render.
  }, [profileId, reviewId, digest, fieldKey, latestField, enabled]);
  return state;
}
