export type EntityCategory = "brand" | "trend";

export interface EntityMeta {
  name: string;
  category: EntityCategory;
  ticker?: string;
  parent_description?: string;
}

export const entities: EntityMeta[] = [
  {
    name: "Supreme",
    category: "brand",
    ticker: "VFC",
    parent_description: "VF Corp",
  },
  {
    name: "Vans",
    category: "brand",
    ticker: "VFC",
    parent_description: "VF Corp",
  },
  { name: "Hypebeast", category: "trend" },
  {
    name: "Arc'teryx",
    category: "brand",
    ticker: "AS",
    parent_description: "Amer Sports",
  },
  {
    name: "The North Face",
    category: "brand",
    ticker: "VFC",
    parent_description: "VF Corp",
  },
  { name: "Columbia", category: "brand", ticker: "COLM" },
  { name: "Levi's", category: "brand", ticker: "LEVI" },
  { name: "Gorpcore", category: "trend" },
  { name: "Nike", category: "brand", ticker: "NKE" },
  { name: "Adidas", category: "brand", ticker: "ADDYY" },
  { name: "On Running", category: "brand", ticker: "ONON" },
  {
    name: "HOKA",
    category: "brand",
    ticker: "DECK",
    parent_description: "Deckers",
  },
  {
    name: "UGG",
    category: "brand",
    ticker: "DECK",
    parent_description: "Deckers",
  },
  { name: "Athleisure", category: "trend" },
  { name: "Urban Outfitters", category: "brand", ticker: "URBN" },
  { name: "American Eagle", category: "brand", ticker: "AEO" },
  { name: "Fast Fashion", category: "trend" },
  {
    name: "Louis Vuitton",
    category: "brand",
    ticker: "LVMUY",
    parent_description: "LVMH",
  },
  { name: "Hermès", category: "brand", ticker: "HESAY" },
  {
    name: "Coach",
    category: "brand",
    ticker: "TPR",
    parent_description: "Tapestry",
  },
  {
    name: "Kate Spade",
    category: "brand",
    ticker: "TPR",
    parent_description: "Tapestry",
  },
  { name: "Lululemon", category: "brand", ticker: "LULU" },
  { name: "Ralph Lauren", category: "brand", ticker: "RL" },
  {
    name: "Peter Millar",
    category: "brand",
    ticker: "CFRUY",
    parent_description: "Richemont",
  },
  { name: "Quiet Luxury", category: "trend" },
  { name: "Old Money", category: "trend" },
  { name: "Abercrombie", category: "brand", ticker: "ANF" },
  { name: "Gap", category: "brand", ticker: "GAP" },
  {
    name: "Depop",
    category: "brand",
    ticker: "ETSY",
    parent_description: "Etsy",
  },
  { name: "Vintage", category: "trend" },
  { name: "Y2K Fashion", category: "trend" },
];

const entityByName = new Map(entities.map((e) => [e.name, e]));

export function getEntityByName(name: string): EntityMeta | undefined {
  return entityByName.get(name);
}
