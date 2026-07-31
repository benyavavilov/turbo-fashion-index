/**
 * Canonical relationship map: Parent Companies → Child Brands.
 * Earnings Whisper universe — volatile small/mid-cap pure-play retail & hype.
 */

export type EntityCategory = "brand" | "trend";

export interface EntityMeta {
  name: string;
  category: EntityCategory;
  ticker?: string;
  parent_description?: string;
}

/** Parent equity listed on Yahoo Finance, with tracked child brands. */
export interface ParentCompany {
  name: string;
  ticker: string;
  /** Google Trends entity names for child brands under this parent. */
  childBrands: string[];
  /** Optional logo domain for the parent or flagship brand. */
  domain?: string;
}

/**
 * Earnings Whisper universe — curated pure-play retail / hype brands.
 * Mega-caps purged; focus on small/mid-cap search↔earnings delta setups.
 */
export const parentCompanies: ParentCompany[] = [
  {
    name: "Abercrombie & Fitch",
    ticker: "ANF",
    childBrands: ["Abercrombie & Fitch", "Hollister", "Gilly Hicks"],
    domain: "abercrombie.com",
  },
  {
    name: "Deckers Outdoor",
    ticker: "DECK",
    childBrands: ["HOKA", "UGG", "Teva"],
    domain: "deckers.com",
  },
  {
    name: "Crocs Inc",
    ticker: "CROX",
    childBrands: ["Crocs", "HeyDude"],
    domain: "crocs.com",
  },
  {
    name: "Urban Outfitters",
    ticker: "URBN",
    childBrands: [
      "Urban Outfitters",
      "Free People",
      "Anthropologie",
      "Nuuly",
    ],
    domain: "urbanoutfitters.com",
  },
  {
    name: "Gap Inc",
    // Yahoo Finance lists Gap as GAP (legacy GPS symbol no longer resolves).
    ticker: "GAP",
    childBrands: ["Gap", "Old Navy", "Athleta", "Banana Republic"],
    domain: "gap.com",
  },
  {
    name: "Levi Strauss & Co",
    ticker: "LEVI",
    childBrands: ["Levi's", "Dockers", "Beyond Yoga"],
    domain: "levi.com",
  },
  {
    name: "Boot Barn",
    ticker: "BOOT",
    childBrands: ["Boot Barn"],
    domain: "bootbarn.com",
  },
  {
    name: "On Holding",
    ticker: "ONON",
    childBrands: ["On Running"],
    domain: "on-running.com",
  },
  {
    name: "American Eagle",
    ticker: "AEO",
    childBrands: ["American Eagle", "Aerie"],
    domain: "ae.com",
  },
  {
    name: "Tapestry",
    ticker: "TPR",
    childBrands: ["Coach", "Kate Spade", "Stuart Weitzman"],
    domain: "tapestry.com",
  },
  {
    name: "E.l.f. Beauty",
    ticker: "ELF",
    childBrands: ["elf cosmetics"],
    domain: "elfcosmetics.com",
  },
  {
    name: "Canada Goose",
    ticker: "GOOS",
    childBrands: ["Canada Goose"],
    domain: "canadagoose.com",
  },
];

/** Flatten parents into brand EntityMeta rows (active catalog). */
function buildBrandEntities(): EntityMeta[] {
  const rows: EntityMeta[] = [];
  const seen = new Set<string>();

  for (const parent of parentCompanies) {
    for (const brand of parent.childBrands) {
      if (seen.has(brand)) continue;
      seen.add(brand);
      rows.push({
        name: brand,
        category: "brand",
        ticker: parent.ticker,
        parent_description: parent.name,
      });
    }
  }

  return rows;
}

/**
 * Trends deactivated for the Curated Intelligence Terminal.
 * Kept for possible future reactivation / historical scripts.
 */
export const INACTIVE_TREND_ENTITIES: EntityMeta[] = [];

/** Active entities = child brands only (no trends). */
export const entities: EntityMeta[] = buildBrandEntities();

const entityByName = new Map(entities.map((e) => [e.name, e]));
const parentByTicker = new Map(
  parentCompanies.map((p) => [p.ticker.toUpperCase(), p])
);

export function getEntityByName(name: string): EntityMeta | undefined {
  return entityByName.get(name);
}

export function getParentByTicker(
  ticker: string
): ParentCompany | undefined {
  return parentByTicker.get(ticker.trim().toUpperCase());
}

export function listParentCompanies(): ParentCompany[] {
  return parentCompanies;
}

export function getActiveBrandNames(): string[] {
  return entities.map((e) => e.name);
}

export function getChildBrandsForTicker(ticker: string): string[] {
  return getParentByTicker(ticker)?.childBrands ?? [];
}

export function normalizeTickerParam(ticker: string): string {
  return ticker.trim().toUpperCase();
}
