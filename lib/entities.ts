/**
 * Canonical relationship map: Parent Companies → Child Brands.
 * Trends are retained below but excluded from active terminal logic (V3).
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
 * Relationship database — Parent Companies and their Child Brands.
 */
export const parentCompanies: ParentCompany[] = [
  {
    name: "VF Corp",
    ticker: "VFC",
    childBrands: [
      "Supreme",
      "Vans",
      "The North Face",
      "Timberland",
      "Dickies",
      "Eastpak",
      "JanSport",
      "Smartwool",
    ],
    domain: "vfc.com",
  },
  {
    name: "Deckers",
    ticker: "DECK",
    childBrands: ["HOKA", "UGG", "Teva", "Sanuk"],
    domain: "deckers.com",
  },
  {
    name: "Tapestry",
    ticker: "TPR",
    childBrands: ["Coach", "Kate Spade", "Stuart Weitzman"],
    domain: "tapestry.com",
  },
  {
    name: "LVMH",
    ticker: "LVMUY",
    childBrands: [
      "Louis Vuitton",
      "Christian Dior",
      "Givenchy",
      "Fendi",
      "Celine",
      "Loewe",
      "Sephora",
      "Tiffany & Co.",
      "Bulgari",
      "TAG Heuer",
    ],
    domain: "lvmh.com",
  },
  {
    name: "Amer Sports",
    ticker: "AS",
    childBrands: [
      "Arc'teryx",
      "Salomon",
      "Wilson",
      "Atomic",
      "Peak Performance",
    ],
    domain: "amersports.com",
  },
  {
    name: "Richemont",
    ticker: "CFRUY",
    childBrands: [
      "Cartier",
      "Van Cleef & Arpels",
      "Montblanc",
      "Chloe",
      "Peter Millar",
      "Alaïa",
    ],
    domain: "richemont.com",
  },
  {
    name: "Etsy",
    ticker: "ETSY",
    childBrands: ["Depop"],
    domain: "etsy.com",
  },
  {
    name: "Nike",
    ticker: "NKE",
    childBrands: ["Nike", "Jordan", "Converse"],
    domain: "nike.com",
  },
  {
    name: "Adidas",
    ticker: "ADDYY",
    childBrands: ["Adidas"],
    domain: "adidas.com",
  },
  {
    name: "On Holding",
    ticker: "ONON",
    childBrands: ["On Running"],
    domain: "on-running.com",
  },
  {
    name: "Columbia Sportswear",
    ticker: "COLM",
    childBrands: ["Columbia", "Sorel", "Mountain Hardwear", "prAna"],
    domain: "columbia.com",
  },
  {
    name: "Levi Strauss",
    ticker: "LEVI",
    childBrands: ["Levi's", "Dockers", "Beyond Yoga"],
    domain: "levi.com",
  },
  {
    name: "Lululemon",
    ticker: "LULU",
    childBrands: ["Lululemon"],
    domain: "lululemon.com",
  },
  {
    name: "Ralph Lauren",
    ticker: "RL",
    childBrands: ["Ralph Lauren"],
    domain: "ralphlauren.com",
  },
  {
    name: "Hermès",
    ticker: "HESAY",
    childBrands: ["Hermès"],
    domain: "hermes.com",
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
    name: "American Eagle",
    ticker: "AEO",
    childBrands: ["American Eagle"],
    domain: "ae.com",
  },
  {
    name: "Abercrombie & Fitch",
    ticker: "ANF",
    childBrands: ["Abercrombie & Fitch", "Hollister", "Gilly Hicks"],
    domain: "abercrombie.com",
  },
  {
    name: "Gap Inc.",
    ticker: "GAP",
    childBrands: ["Gap", "Old Navy", "Athleta", "Banana Republic"],
    domain: "gap.com",
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
 * V3: Trends deactivated for the Curated Intelligence Terminal.
 * Kept for possible future reactivation / historical scripts.
 */
export const INACTIVE_TREND_ENTITIES: EntityMeta[] = [
  // { name: "Hypebeast", category: "trend" },
  // { name: "Gorpcore", category: "trend" },
  // { name: "Athleisure", category: "trend" },
  // { name: "Fast Fashion", category: "trend" },
  // { name: "Quiet Luxury", category: "trend" },
  // { name: "Old Money", category: "trend" },
  // { name: "Vintage", category: "trend" },
  // { name: "Y2K Fashion", category: "trend" },
];

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
