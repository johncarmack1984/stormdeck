/** Build identity, baked in by Vite (see vite.config.ts). APP_VERSION is the
 * git-derived release version — `vX.Y.Z` exactly on a release, `vX.Y.Z-N-g<sha>`
 * N commits past it, `-dirty` for a local build with uncommitted changes. */
export const APP_VERSION: string = __APP_VERSION__;
export const BUILD_TIME: string = __BUILD_TIME__;
