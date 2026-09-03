import { formatExactTime, formatRelativeTime } from "@/lib/relative-time";

/** A timestamp as a short age, with the exact time on hover. */
export function RelativeTime({
  iso,
  prefix,
}: {
  readonly iso: string;
  /** Text drawn before the age inside the same element, e.g. "retained ". */
  readonly prefix?: string;
}): React.JSX.Element {
  return (
    <time dateTime={iso} title={formatExactTime(iso)}>
      {prefix}
      {formatRelativeTime(iso)}
    </time>
  );
}
