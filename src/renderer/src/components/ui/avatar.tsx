import { useState } from "react";

import { cn } from "@/lib/utils";

export type AvatarProps = {
  /** Comment author's display name; used only to derive the initials fallback. */
  readonly name: string;
  /** `data:` URI resolved from the avatar cache; absent whenever the avatar was never synced, failed to sync, or the author has none. */
  readonly dataUri?: string | undefined;
  readonly className?: string;
};

/**
 * One commenter's avatar: the cached image when available, otherwise an
 * initials badge matching the size-9 circular treatment already used for
 * comment authors elsewhere in the review surface.
 *
 * Decorative by design: every call site renders the author's name as text
 * immediately alongside this element (see `ConversationCommentRow`), so the
 * name is already announced once. A visible `alt`/label here would repeat
 * it for screen-reader users with no added information, so both the image
 * and the fallback are `aria-hidden`.
 */
function Avatar({ name, dataUri, className }: AvatarProps) {
  if (dataUri !== undefined) {
    return (
      <AvatarImage
        key={dataUri}
        name={name}
        dataUri={dataUri}
        className={className}
      />
    );
  }
  return <AvatarFallback name={name} className={className} />;
}

function AvatarImage({
  name,
  dataUri,
  className,
}: {
  readonly name: string;
  readonly dataUri: string;
  readonly className: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  if (!failed) {
    return (
      <img
        src={dataUri}
        alt=""
        aria-hidden="true"
        data-slot="avatar"
        onError={() => setFailed(true)}
        className={cn(
          "size-9 shrink-0 rounded-full border object-cover",
          className,
        )}
      />
    );
  }
  return <AvatarFallback name={name} className={className} />;
}

function AvatarFallback({
  name,
  className,
}: {
  readonly name: string;
  readonly className: string | undefined;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="avatar"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-sky-300/30 bg-sky-400/20 text-xs font-semibold text-sky-200",
        className,
      )}
    >
      {initialsFor(name)}
    </span>
  );
}

/** First letter of the author's display name, uppercased; `?` for an empty name. */
function initialsFor(name: string): string {
  const initial = name.trim().charAt(0);
  return initial === "" ? "?" : initial.toUpperCase();
}

export { Avatar };
