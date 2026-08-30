import { Spinner } from "@/components/ui/spinner";

export type ReviewOpeningState =
  | {
      readonly status: "opening" | "error";
      readonly error?: string;
    }
  | undefined;

export function ReviewOpeningNotice({
  state,
  className,
}: {
  readonly state: ReviewOpeningState;
  readonly className: string;
}): React.JSX.Element | null {
  if (state?.status === "opening")
    return (
      <span className={className}>
        <Spinner data-icon="inline-start" /> Opening…
      </span>
    );
  if (state?.status === "error")
    return (
      <span role="alert" className={className}>
        <span className="font-medium">Could not open review</span>
        {" — "}
        {state.error}
      </span>
    );
  return null;
}

export function ReviewOpeningButtonContent({
  state,
  children,
}: {
  readonly state: ReviewOpeningState;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return state?.status === "opening" ? (
    <>
      <Spinner data-icon="inline-start" /> Opening…
    </>
  ) : (
    <>{children}</>
  );
}
