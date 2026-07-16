/**
 * Convenience re-export of the parent ↔ child relationship database.
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
