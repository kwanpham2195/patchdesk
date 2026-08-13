import logoUrl from "../../../../resources/branding/patchdesk-logo.svg?url";

export function BrandMark({
  size = 32,
}: {
  readonly size?: number;
}): React.JSX.Element {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className="shrink-0 rounded-[22%]"
    />
  );
}
