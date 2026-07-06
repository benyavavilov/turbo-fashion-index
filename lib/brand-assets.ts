/** Clearbit logo domains and Yahoo Finance tickers for tracked brands. */

export const BRAND_DOMAINS: Record<string, string> = {
  Abercrombie: "abercrombie.com",
  Adidas: "adidas.com",
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
  "New Balance": "newbalance.com",
  Nike: "nike.com",
  "On Running": "on-running.com",
  Patagonia: "patagonia.com",
  "Peter Millar": "petermillar.com",
  "Ralph Lauren": "ralphlauren.com",
  Shein: "shein.com",
  Supreme: "supreme.com",
  "The North Face": "thenorthface.com",
  Zara: "zara.com",
};

/** Public tickers for the stock overlay (weekly close). */
export const BRAND_TICKERS: Record<string, string> = {
  Abercrombie: "ANF",
  Adidas: "ADDYY",
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

export function getBrandDomain(name: string): string | undefined {
  return BRAND_DOMAINS[name];
}

export function getBrandTicker(name: string): string | undefined {
  const ticker = BRAND_TICKERS[name];
  if (!ticker || ticker === "PRIVATE") return undefined;
  return ticker;
}

export function clearbitLogoUrl(domain: string): string {
  return `https://logo.clearbit.com/${domain}`;
}
