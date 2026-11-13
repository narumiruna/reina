import { type CatalogProvider, catalogProviders } from "./providers.js"

export type { CatalogProvider } from "./providers.js"

/** Static metadata only. Listing never resolves credentials or starts authentication. */
export function modelCatalog(): { providers: CatalogProvider[] } {
  return { providers: catalogProviders() }
}
