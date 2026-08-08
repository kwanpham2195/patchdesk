/**
 * Pierre reconciles controlled CodeView items by their explicit version. A
 * hydrated diff or changed annotation set has different rendered data even
 * though its path stays stable, so it must receive a distinct version rather
 * than being silently reused.
 */
export function reviewDiffItemVersion(input: {
  readonly collapsed: boolean;
  readonly hydrated: boolean;
  readonly annotationKey?: string;
}): number {
  const sourceVersion = (input.collapsed ? 1 : 0) + (input.hydrated ? 2 : 0);
  if (input.annotationKey === undefined) return sourceVersion;
  return sourceVersion + (stableAnnotationVersion(input.annotationKey) * 4);
}

function stableAnnotationVersion(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  }
  return hash + 1;
}
