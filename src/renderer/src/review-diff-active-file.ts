export type ActiveFileItem = { readonly id: string };

export function activeFilePathAtScrollTop(
  items: ReadonlyArray<ActiveFileItem>,
  scrollTop: number,
  getTopForItem: (id: string) => number | undefined,
): string | undefined {
  let activePath: string | undefined;
  let activeTop = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const top = getTopForItem(item.id);
    if (top === undefined || top > scrollTop || top <= activeTop) continue;

    activePath = item.id;
    activeTop = top;
  }

  return activePath;
}
