/** Optional public WASM assets follow Vite's deployment base (including a CDN
 * URL), not the origin root. The override also makes subpath behavior testable. */
export function wasmAssetUrl(asset: string, base?: string): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return `${(base ?? env?.BASE_URL ?? "/").replace(/\/?$/, "/")}${asset.replace(/^\/+/, "")}`;
}
