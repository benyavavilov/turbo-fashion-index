// Minimal ambient type declaration for `google-trends-api`, which ships no types.
declare module "google-trends-api" {
  interface InterestOverTimeOptions {
    keyword: string | string[];
    startTime?: Date;
    endTime?: Date;
    geo?: string | string[];
    hl?: string;
    timezone?: number;
    category?: number;
    granularTimeResolution?: boolean;
  }

  export function interestOverTime(
    options: InterestOverTimeOptions
  ): Promise<string>;

  export function interestByRegion(options: unknown): Promise<string>;
  export function relatedQueries(options: unknown): Promise<string>;
  export function relatedTopics(options: unknown): Promise<string>;
  export function autoComplete(options: unknown): Promise<string>;
  export function dailyTrends(options: unknown): Promise<string>;
  export function realTimeTrends(options: unknown): Promise<string>;

  const googleTrends: {
    interestOverTime: typeof interestOverTime;
    interestByRegion: typeof interestByRegion;
    relatedQueries: typeof relatedQueries;
    relatedTopics: typeof relatedTopics;
    autoComplete: typeof autoComplete;
    dailyTrends: typeof dailyTrends;
    realTimeTrends: typeof realTimeTrends;
  };

  export default googleTrends;
}
