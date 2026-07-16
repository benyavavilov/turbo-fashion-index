import { entities, getEntityByName } from "@/lib/entities";

/**
 * Maps tracked entity display names → clean web domains for logo favicons.
 * Trend entities intentionally have no domain and fall back to letter avatars.
 */
export const ENTITY_DOMAIN_MAP: Record<string, string> = {
  "Abercrombie & Fitch": "abercrombie.com",
  Adidas: "adidas.com",
  "American Eagle": "ae.com",
  Anthropologie: "anthropologie.com",
  "Arc'teryx": "arcteryx.com",
  Athleta: "athleta.gap.com",
  Atomic: "atomic.com",
  "Banana Republic": "bananarepublic.gap.com",
  "Beyond Yoga": "beyondyoga.com",
  Bulgari: "bulgari.com",
  Cartier: "cartier.com",
  Celine: "celine.com",
  Chloe: "chloe.com",
  "Christian Dior": "dior.com",
  Columbia: "columbia.com",
  Coach: "coach.com",
  Converse: "converse.com",
  Depop: "depop.com",
  Dickies: "dickies.com",
  Dockers: "dockers.com",
  Eastpak: "eastpak.com",
  Fendi: "fendi.com",
  "Free People": "freepeople.com",
  Gap: "gap.com",
  "Gilly Hicks": "gillyhicks.com",
  Givenchy: "givenchy.com",
  Hermès: "hermes.com",
  HOKA: "hoka.com",
  Hollister: "hollisterco.com",
  Hypebeast: "hypebeast.com",
  JanSport: "jansport.com",
  Jordan: "nike.com",
  "Kate Spade": "katespade.com",
  "Levi's": "levi.com",
  Loewe: "loewe.com",
  "Louis Vuitton": "louisvuitton.com",
  Lululemon: "lululemon.com",
  Montblanc: "montblanc.com",
  "Mountain Hardwear": "mountainhardwear.com",
  Nike: "nike.com",
  Nuuly: "nuuly.com",
  "Old Navy": "oldnavy.gap.com",
  "On Running": "on-running.com",
  "Peak Performance": "peakperformance.com",
  "Peter Millar": "petermillar.com",
  prAna: "prana.com",
  "Ralph Lauren": "ralphlauren.com",
  Salomon: "salomon.com",
  Sanuk: "sanuk.com",
  Sephora: "sephora.com",
  Smartwool: "smartwool.com",
  Sorel: "sorel.com",
  "Stuart Weitzman": "stuartweitzman.com",
  Supreme: "supreme.com",
  "TAG Heuer": "tagheuer.com",
  Teva: "teva.com",
  "The North Face": "thenorthface.com",
  "Tiffany & Co.": "tiffany.com",
  Timberland: "timberland.com",
  "Urban Outfitters": "urbanoutfitters.com",
  UGG: "ugg.com",
  "Van Cleef & Arpels": "vancleefarpels.com",
  Vans: "vans.com",
  Wilson: "wilson.com",
  Alaïa: "maison-alaia.com",
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
