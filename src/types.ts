/** A circular exactly as the NSE API returns it. */
export interface NseCircular {
  cirDate: string; // "20260807"
  cirDisplayDate: string; // "August 07, 2026"
  circCategory: string; // "Trading"
  circCompany: string; // "NSE"
  circDepartment: string; // "Mutual Fund"
  circDisplayNo: string; // "NSE/NMF/75630" — unique, used as the primary key
  circFileSize: string; // "248 KB"
  circFilelink: string; // https://nsearchives.nseindia.com/...
  circFilename: string; // "NMF75630.zip"
  circNumber: string; // "75630"
  fileDept: string; // "NMF"
  fileExt: string; // "zip" | "pdf"
  sub: string; // subject line — the only text we get without downloading the file
}

export type ImportanceLevel = "CRITICAL" | "IMPORTANT" | "ROUTINE";

export interface Classification {
  level: ImportanceLevel;
  score: number;
  /** Human-readable reasons: matched keyword groups, or the LLM's rationale. */
  reasons: string[];
  /** Which classifier produced the final verdict. */
  classifier: "rules" | "llm";
  /** Machine-readable tags, e.g. "DOWNTIME", "SUSPENSION". */
  tags: string[];
}

/** A circular as stored, i.e. the API payload plus our own verdict. */
export interface StoredCircular extends NseCircular {
  first_seen_at: string;
  notified_at: string | null;
  importance_level: ImportanceLevel;
  importance_score: number;
  importance_reasons: string;
  importance_tags: string;
  classifier: string;
}

/** A versioned document scraped from the NSE MF Desk site. */
export interface ApiDoc {
  /** Stable identity across releases, e.g. "NSEMF_API_Details". */
  docKey: string;
  /** Dotted numeric version parsed from the filename, e.g. "1.9.7". */
  version: string;
  url: string;
  filename: string;
}

export interface StoredApiDoc extends ApiDoc {
  first_seen_at: string;
  notified_at: string | null;
}

/** What a scrape decided about one document, relative to what we already knew. */
export interface ApiDocChange {
  doc: ApiDoc;
  /** Version we had on record before this scrape, if any. */
  previousVersion: string | null;
  kind: "baseline" | "upgrade" | "unchanged" | "regression";
}

export interface RunSummary {
  fetched: number;
  inserted: number;
  duplicates: number;
  notified: number;
  byLevel: Record<ImportanceLevel, number>;
  windowFrom: string;
  windowTo: string;
  /** API documents whose version increased during this run. */
  apiDocUpgrades: number;
  /** API doc alerts actually emailed during this run. */
  apiDocsNotified: number;
  /** Exchanges whose fetch failed while the run carried on with the rest, e.g. "BSE: ...". */
  failures: string[];
}
