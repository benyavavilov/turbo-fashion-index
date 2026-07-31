/**
 * Convenience re-export of the Earnings Whisper parent ↔ child universe.
 * Prefer importing from `@/lib/entities` in new code.
 */
export {
  parentCompanies,
  getParentByTicker,
  listParentCompanies,
  getChildBrandsForTicker,
  getActiveBrandNames,
  normalizeTickerParam,
  type ParentCompany,
  type EntityMeta,
  type EntityCategory,
} from "@/lib/entities";
