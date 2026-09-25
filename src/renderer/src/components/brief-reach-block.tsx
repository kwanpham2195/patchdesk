import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { definedProps } from "../../../domain/defined-props";
import {
  briefBlastRadius,
  briefBlastRadiusFootnote,
  type BlastRadiusFile,
  type BlastRadiusFolder,
  type BlastRadiusName,
  type BriefReach,
  type BriefReachRow,
} from "../brief-contracts";

/** The chip classes for a surface the change crosses and one it does not. */
const LIT_SURFACE =
  "inline-flex items-center gap-1.5 rounded-md border bg-accent px-2 py-0.5 text-xs";
const UNLIT_SURFACE =
  "inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground";
const FOLD_BUTTON =
  "flex items-center gap-1.5 self-start rounded-sm text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SURFACES_LABEL = "Surfaces crossed";

/**
 * The Blast radius view: what this PR could affect in files it does not
 * change, down to the function that mentions each name. Every count came from
 * a `git grep` in the main process, and the footer says so, because a mention
 * is not a call.
 */
export function ReachBlock({
  reach,
  headSha,
}: {
  readonly reach: BriefReach;
  readonly headSha: string;
}): React.JSX.Element {
  const view = useMemo(() => briefBlastRadius(reach), [reach]);
  const [emptyExpanded, setEmptyExpanded] = useState(false);
  const surfacesRow = (
    <ReachRow
      key="surfaces"
      label={SURFACES_LABEL}
      hint="each flag cites its path"
    >
      <div className="flex flex-wrap gap-1.5">
        {reach.surfaces.map((surface) => (
          <span
            key={surface.surface}
            className={surface.path === undefined ? UNLIT_SURFACE : LIT_SURFACE}
          >
            {surface.surface}
            {surface.path === undefined ? null : (
              <span className="font-mono text-[10px] text-muted-foreground">
                {surface.path}
              </span>
            )}
          </span>
        ))}
      </div>
    </ReachRow>
  );
  const sections = [
    {
      label: SURFACES_LABEL,
      empty: reach.surfaces.every((surface) => surface.path === undefined),
      node: surfacesRow,
    },
    {
      label: view.untested.label,
      empty: view.untested.items.length === 0,
      node: <ReachListRow key={view.untested.label} row={view.untested} />,
    },
  ];
  const empty = sections.filter((section) => section.empty);
  return (
    <section aria-label="Blast radius" className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-sm font-medium">
        Blast radius
        <span className="text-xs font-normal text-muted-foreground">
          what this PR could affect in files it doesn't change
        </span>
      </h3>
      <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3 text-xs">
        <p>{view.summary}</p>
        {view.removed.length === 0 ? null : (
          <NameGroup
            label="Removed but still mentioned"
            names={view.removed}
            warning
          />
        )}
        {view.changed.length === 0 ? null : (
          <NameGroup
            label="Changed and mentioned elsewhere"
            names={view.changed}
            warning={false}
          />
        )}
        {view.quiet.names.length === 0 ? null : (
          <QuietNames label={view.quiet.label} names={view.quiet.names} />
        )}
      </div>
      {sections
        .filter((section) => !section.empty)
        .map((section) => section.node)}
      {/* A row that found nothing still costs a full card, so they fold into one line until asked for. */}
      {empty.length === 0 ? null : (
        <button
          type="button"
          aria-expanded={emptyExpanded}
          onClick={() => setEmptyExpanded((expanded) => !expanded)}
          className={FOLD_BUTTON}
        >
          <ChevronRightIcon
            aria-hidden
            className={`size-3.5 shrink-0 transition-transform ${emptyExpanded ? "rotate-90" : ""}`}
          />
          Nothing found: {empty.map((section) => section.label).join(" · ")}
        </button>
      )}
      {emptyExpanded ? empty.map((section) => section.node) : null}
      <p className="text-[11px] text-muted-foreground">
        {briefBlastRadiusFootnote(reach, headSha)}
      </p>
    </section>
  );
}

/** One labelled group of names, each with its count and where it is mentioned. */
function NameGroup({
  label,
  names,
  warning,
}: {
  readonly label: string;
  readonly names: ReadonlyArray<BlastRadiusName>;
  readonly warning: boolean;
}): React.JSX.Element {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-1.5">
      <h4 className="font-medium">{label}</h4>
      <ul className="flex flex-col gap-2 pl-3">
        {names.map((name) => (
          <NameEntry key={name.name} name={name} warning={warning} />
        ))}
      </ul>
    </section>
  );
}

function NameEntry({
  name,
  warning,
}: {
  readonly name: BlastRadiusName;
  readonly warning: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const folders = expanded ? name.folders : name.collapsed;
  const allShown = expanded || name.hidden === 0;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span
          className={`font-mono ${warning ? "text-[var(--status-warning)]" : ""}`}
        >
          {name.name}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {name.count}
        </span>
      </div>
      <FolderList folders={folders} />
      {name.hidden === 0 ? null : (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className={`${FOLD_BUTTON} pl-3 font-mono text-[11px]`}
        >
          {expanded ? "Show fewer" : `+${String(name.hidden)} more`}
        </button>
      )}
      {allShown && name.unlisted > 0 ? (
        <p className="pl-3 font-mono text-[11px] text-muted-foreground">
          +{name.unlisted} not listed
        </p>
      ) : null}
    </li>
  );
}

/** Each folder once, then its file names; a path never wraps in the middle. */
function FolderList({
  folders,
}: {
  readonly folders: ReadonlyArray<BlastRadiusFolder>;
}): React.JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 pl-3 font-mono text-[11px] text-muted-foreground">
      {folders.map((group) => (
        <div
          key={`${String(group.tests)}:${group.folder}`}
          className="contents"
        >
          <span className="whitespace-nowrap">{group.folder}</span>
          {group.files.some((file) => file.sites.length > 0) ? (
            <ul className="flex min-w-0 flex-col gap-0.5">
              {group.files.map((file) => (
                <SiteFile key={file.name} file={file} />
              ))}
            </ul>
          ) : (
            <ul className="flex min-w-0 flex-wrap gap-x-1.5">
              {group.files.map((file) => (
                <li
                  key={file.name}
                  className="whitespace-nowrap text-foreground not-first:before:mr-1.5 not-first:before:text-muted-foreground not-first:before:content-['·']"
                >
                  {file.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/** One file and the sites in it that mention the name: where, what kind, which line. */
function SiteFile({
  file,
}: {
  readonly file: BlastRadiusFile;
}): React.JSX.Element {
  return (
    <li className="flex min-w-0 flex-col">
      <span className="whitespace-nowrap text-foreground">{file.name}</span>
      {file.sites.length === 0 ? null : (
        <ul
          aria-label={`Mentions in ${file.name}`}
          className="flex flex-col pl-3"
        >
          {file.sites.map((site) => (
            <li
              key={`${String(site.line)}:${site.kind}`}
              className="flex min-w-0 gap-x-2"
            >
              <span className="truncate text-foreground">{site.label}</span>
              <span>{site.kind}</span>
              <span className="tabular-nums">L{site.line}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Names nothing outside this PR mentions: they cannot break anything there, so they fold into one line. */
function QuietNames({
  label,
  names,
}: {
  readonly label: string;
  readonly names: ReadonlyArray<string>;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const preview = names.slice(0, 2).join(", ");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className={FOLD_BUTTON}
      >
        <ChevronRightIcon
          aria-hidden
          className={`size-3.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        {label}
        {expanded ? null : `: ${preview}${names.length > 2 ? ", …" : ""}`}
      </button>
      {expanded ? (
        <ul
          aria-label={label}
          className="flex flex-wrap gap-x-3 gap-y-0.5 pl-5 font-mono"
        >
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One list row: each changed file no changed test matches. */
function ReachListRow({
  row,
}: {
  readonly row: BriefReachRow;
}): React.JSX.Element {
  return (
    <ReachRow label={row.label} {...definedProps({ hint: row.hint })}>
      {row.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{row.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {row.items.map((item) => (
            <li
              key={item}
              className="font-mono text-xs text-[var(--status-warning)]"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </ReachRow>
  );
}

/** One row of the Blast radius view: its own labelled region, so each is reachable by name. */
function ReachRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={label}
      className="grid min-w-0 gap-x-4 gap-y-1.5 rounded-md border p-3 md:grid-cols-[10rem_minmax(0,1fr)]"
    >
      <h4 className="text-xs font-medium">
        {label}
        {hint === undefined ? null : (
          <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
            {hint}
          </span>
        )}
      </h4>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
