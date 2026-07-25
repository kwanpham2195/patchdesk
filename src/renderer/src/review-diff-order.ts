/** Mirrors Pierre's folder-first tree traversal in the all-files CodeView. */
export function compareTreePaths(left: string, right: string): number {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const sharedLength = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const leftPart = leftParts[index] ?? "";
    const rightPart = rightParts[index] ?? "";
    if (leftPart === rightPart) continue;

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }

  return leftParts.length - rightParts.length;
}
