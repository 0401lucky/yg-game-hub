// These standard globals exist in both supported hosts; DOM and Node types stay out
// of the independent engine typecheck.
export {};
declare global {
  function structuredClone<T>(value: T): T;
  const performance: { now(): number };
}
