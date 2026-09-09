// PROTOTYPE — issue #119, throwaway. Do not build on this.
/// <reference types="vite/client" />
import { useState } from "react";

import { SidebarPrototypeSwitcher } from "./sidebar-prototype-switcher";
import { SidebarVariantATree } from "./sidebar-variant-a-tree";
import { SidebarVariantBQueue } from "./sidebar-variant-b-queue";
import { SidebarVariantCRail } from "./sidebar-variant-c-rail";

/** The registry the switcher walks. Variants B and C are one entry each. */
const variants = [
  {
    id: "A",
    label: "A — Nested tree",
    render: (): React.JSX.Element => <SidebarVariantATree />,
  },
  {
    id: "B",
    label: "B — Queue first",
    render: (): React.JSX.Element => <SidebarVariantBQueue />,
  },
  {
    id: "C",
    label: "C — Workspace rail",
    render: (): React.JSX.Element => <SidebarVariantCRail />,
  },
];

export function SidebarPrototypeHost(): React.JSX.Element | null {
  const [activeId, setActiveId] = useState(requestedVariantId);
  if (!import.meta.env.DEV) return null;
  const active =
    variants.find((variant) => variant.id === activeId) ?? variants[0];
  if (active === undefined) return null;
  return (
    <>
      {active.render()}
      <SidebarPrototypeSwitcher
        variants={variants.map(({ id, label }) => ({ id, label }))}
        activeId={active.id}
        onSelect={(id) => {
          const url = new URL(window.location.href);
          url.searchParams.set("variant", id);
          window.history.replaceState(null, "", url);
          setActiveId(id);
        }}
      />
    </>
  );
}

/** This app has no URL router, so the variant lives in the query string and is
 * read straight off `window.location`. */
function requestedVariantId(): string {
  return (
    new URLSearchParams(window.location.search).get("variant")?.toUpperCase() ??
    "A"
  );
}
