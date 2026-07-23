/**
 * Pierre reconciles controlled CodeView items by their explicit version. A
 * hydrated diff has different source data even though its path stays stable,
 * so it must receive a distinct version rather than being silently reused.
 */
export function reviewDiffItemVersion(input: {
  readonly collapsed: boolean;
  readonly hydrated: boolean;
}): number {
  return (input.collapsed ? 1 : 0) + (input.hydrated ? 2 : 0);
}
