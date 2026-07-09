import { entities, getEntityByName } from "@/lib/entities";

/**
 * Maps tracked entity display names → clean web domains for logo favicons.
 * Trend entities intentionally have no domain and fall back to letter avatars.
 */
export const ENTITY_DOMAIN_MAP: Record<string, string> = {
  Abercrombie: "abercrombie.com",
  Adidas: "adidas.com",
  "American Eagle": "ae.com",
  "Arc'teryx": "arcteryx.com",
  Columbia: "columbia.com",
  Coach: "coach.com",
  Depop: "depop.com",
  Gap: "gap.com",
  Hermès: "hermes.com",
  HOKA: "hoka.com",
  Hypebeast: "hypebeast.com",
  "Kate Spade": "katespade.com",
  "Levi's": "levi.com",
  "Louis Vuitton": "louisvuitton.com",
  Lululemon: "lululemon.com",
  Nike: "nike.com",
  "On Running": "on-running.com",
  "Peter Millar": "petermillar.com",
  "Ralph Lauren": "ralphlauren.com",
  Supreme: "supreme.com",
  "The North Face": "thenorthface.com",
  "Urban Outfitters": "urbanoutfitters.com",
  UGG: "ugg.com",
  Vans: "vans.com",
};

/** @deprecated Use ENTITY_DOMAIN_MAP */
export const BRAND_DOMAINS = ENTITY_DOMAIN_MAP;

/** Public tickers for the stock overlay (weekly close), derived from entity catalog. */
export const BRAND_TICKERS: Record<string, string> = Object.fromEntries(
  entities
    .filter((e) => e.ticker)
    .map((e) => [e.name, e.ticker!])
);

/** Resolve a tracked entity name to its logo domain (exact + case-insensitive). */
export function getBrandDomain(entityName: string): string | undefined {
  const trimmed = entityName.trim();
  if (ENTITY_DOMAIN_MAP[trimmed]) return ENTITY_DOMAIN_MAP[trimmed];

  const lower = trimmed.toLowerCase();
  for (const [key, domain] of Object.entries(ENTITY_DOMAIN_MAP)) {
    if (key.toLowerCase() === lower) return domain;
  }
  return undefined;
}

/** Build a Google favicon logo URL from an entity name via the domain map. */
export function getEntityLogoUrlForEntity(entityName: string): string | null {
  const domain = getBrandDomain(entityName);
  if (!domain) return null;
  return entityLogoUrl(domain);
}

/** @deprecated Use getEntityLogoUrlForEntity */
export function getClearbitLogoUrlForEntity(entityName: string): string | null {
  return getEntityLogoUrlForEntity(entityName);
}

export function getBrandTicker(name: string): string | undefined {
  return getEntityByName(name)?.ticker;
}

export function entityLogoUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

/** @deprecated Use entityLogoUrl */
export function clearbitLogoUrl(domain: string): string {
  return entityLogoUrl(domain);
}
