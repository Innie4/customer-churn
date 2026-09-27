/**
 * Ambient declaration for the `server-only` marker module.
 *
 * Next.js resolves `server-only` internally and swaps in a throwing stub for
 * client bundles. The published package ships no type declarations, so without
 * this file `tsc --noEmit` cannot resolve the import in the data access layer.
 */
declare module "server-only" {
  const marker: void;
  export default marker;
}
