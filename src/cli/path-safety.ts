// Shared path-traversal guard for any CLI flag whose value becomes a filesystem path that a
// caller (in particular, the GitHub Action wrapper, which string-concatenates
// `${STATE_DIR}/${STORE_PATH}` in action/run-harvest.sh) might build a larger path out of. A
// `..` segment there could escape the intended directory; absolute paths are still allowed --
// that is an explicit, non-escaping choice a direct CLI user is entitled to make.

export class PathTraversalError extends Error {}

export function assertNoPathTraversal(pathValue: string, flagName: string): void {
  const segments = pathValue.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new PathTraversalError(
      `${flagName} must not contain a ".." segment (got "${pathValue}") -- this could write outside the intended directory`,
    );
  }
}
