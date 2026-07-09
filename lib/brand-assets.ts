/**
 * Maps tracked entity display names → clean web domains for logo favicons.
 * Trend entities intentionally have no domain and fall back to letter avatars.
 */
export const ENTITY_DOMAIN_MAP: Record<string, string> = {
  Abercrombie: "abercrombie.com",
  Adidas: "adidas.com",
  ASOS: "asos.com",
  "Arc'teryx": "arcteryx.com",
  Bape: "bape.com",
  Carhartt: "carhartt.com",
  Depop: "depop.com",
  Gap: "gap.com",
  Goyard: "goyard.com",
  "H&M": "hm.com",
  Hermès: "hermes.com",
  "Louis Vuitton": "louisvuitton.com",
  Lululemon: "lululemon.com",
  "Levi's": "levi.com",
  "New Balance": "newbalance.com",
  Nike: "nike.com",
  "On Running": "on-running.com",
  Patagonia: "patagonia.com",
  "Peter Millar": "petermillar.com",
  "Ralph Lauren": "ralphlauren.com",
  Shein: "shein.com",
  Supreme: "supreme.com",
  Hypebeast: "hypebeast.com",
  "The North Face": "thenorthface.com",
  Uniqlo: "uniqlo.com",
  Zara: "zara.com",
};

/** @deprecated Use ENTITY_DOMAIN_MAP */
export const BRAND_DOMAINS = ENTITY_DOMAIN_MAP;

/** Public tickers for the stock overlay (weekly close). */
export const BRAND_TICKERS: Record<string, string> = {
  Abercrombie: "ANF",
  Adidas: "ADDYY",
  ASOS: "ASOMY",
  Gap: "GAP",
  "H&M": "HM-B.ST",
  Lululemon: "LULU",
  Nike: "NKE",
  "On Running": "ONON",
  "Ralph Lauren": "RL",
  Shein: "SHEIN",
  Zara: "IDEXY",
  "The North Face": "VFC",
  Patagonia: "PRIVATE",
  "Louis Vuitton": "LVMUY",
  Hermès: "HESAY",
};

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
  const ticker = BRAND_TICKERS[name];
  if (!ticker || ticker === "PRIVATE") return undefined;
  return ticker;
}

export function entityLogoUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

/** @deprecated Use entityLogoUrl */
export function clearbitLogoUrl(domain: string): string {
  return entityLogoUrl(domain);
}
