import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";
import type {
  ApiDoc,
  Classification,
  ImportanceLevel,
  NseCircular,
  StoredApiDoc,
  StoredCircular,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS circulars (
  circ_display_no    TEXT PRIMARY KEY,
  circ_number        TEXT NOT NULL,
  cir_date           TEXT NOT NULL,
  cir_display_date   TEXT NOT NULL,
  circ_category      TEXT,
  circ_company       TEXT,
  circ_department    TEXT,
  circ_file_size     TEXT,
  circ_filelink      TEXT,
  circ_filename      TEXT,
  file_dept          TEXT,
  file_ext           TEXT,
  sub                TEXT NOT NULL,
  first_seen_at      TEXT NOT NULL,
  notified_at        TEXT,
  importance_level   TEXT NOT NULL,
  importance_score   REAL NOT NULL,
  importance_reasons TEXT NOT NULL,
  importance_tags    TEXT NOT NULL,
  classifier         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_circulars_date  ON circulars (cir_date DESC);
CREATE INDEX IF NOT EXISTS idx_circulars_level ON circulars (importance_level);
CREATE INDEX IF NOT EXISTS idx_circulars_notified ON circulars (notified_at);

-- One row per (document, version) ever seen, so the table doubles as an audit
-- trail of how the API spec has moved over time.
CREATE TABLE IF NOT EXISTS api_docs (
  doc_key       TEXT NOT NULL,
  version       TEXT NOT NULL,
  url           TEXT NOT NULL,
  filename      TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  notified_at   TEXT,
  PRIMARY KEY (doc_key, version)
);

CREATE INDEX IF NOT EXISTS idx_api_docs_notified ON api_docs (notified_at);

CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  window_from  TEXT NOT NULL,
  window_to    TEXT NOT NULL,
  fetched      INTEGER NOT NULL DEFAULT 0,
  inserted     INTEGER NOT NULL DEFAULT 0,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  notified     INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
`;

/** Column order shared by the INSERT statement and the row mapper. */
interface CircularRow {
  circ_display_no: string;
  circ_number: string;
  cir_date: string;
  cir_display_date: string;
  circ_category: string;
  circ_company: string;
  circ_department: string;
  circ_file_size: string;
  circ_filelink: string;
  circ_filename: string;
  file_dept: string;
  file_ext: string;
  sub: string;
  first_seen_at: string;
  notified_at: string | null;
  importance_level: string;
  importance_score: number;
  importance_reasons: string;
  importance_tags: string;
  classifier: string;
}

function toStored(row: CircularRow): StoredCircular {
  return {
    circDisplayNo: row.circ_display_no,
    circNumber: row.circ_number,
    cirDate: row.cir_date,
    cirDisplayDate: row.cir_display_date,
    circCategory: row.circ_category,
    circCompany: row.circ_company,
    circDepartment: row.circ_department,
    circFileSize: row.circ_file_size,
    circFilelink: row.circ_filelink,
    circFilename: row.circ_filename,
    fileDept: row.file_dept,
    fileExt: row.file_ext,
    sub: row.sub,
    first_seen_at: row.first_seen_at,
    notified_at: row.notified_at,
    importance_level: row.importance_level as ImportanceLevel,
    importance_score: row.importance_score,
    importance_reasons: row.importance_reasons,
    importance_tags: row.importance_tags,
    classifier: row.classifier,
  };
}

export class CircularStore {
  private readonly db: Database.Database;

  constructor(path = config.dbPath) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new Database(absolute);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    log.debug(`SQLite ready at ${absolute}`);
  }

  /**
   * Of the given circular numbers, returns the subset we've never stored.
   * Called before classification so a re-fetch of the same window never
   * re-classifies (and never re-spends LLM tokens on) circulars we already know.
   */
  filterUnseen(circulars: NseCircular[]): NseCircular[] {
    if (circulars.length === 0) return [];
    const placeholders = circulars.map(() => "?").join(",");
    const rows = this.db
      .prepare<string[], { circ_display_no: string }>(
        `SELECT circ_display_no FROM circulars WHERE circ_display_no IN (${placeholders})`,
      )
      .all(...circulars.map((c) => c.circDisplayNo));
    const known = new Set(rows.map((row) => row.circ_display_no));
    return circulars.filter((c) => !known.has(c.circDisplayNo));
  }

  /** Inserts a classified circular. Returns false if it was already present. */
  insert(circular: NseCircular, verdict: Classification): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO circulars (
          circ_display_no, circ_number, cir_date, cir_display_date, circ_category,
          circ_company, circ_department, circ_file_size, circ_filelink, circ_filename,
          file_dept, file_ext, sub, first_seen_at, notified_at,
          importance_level, importance_score, importance_reasons, importance_tags, classifier
        ) VALUES (
          @circ_display_no, @circ_number, @cir_date, @cir_display_date, @circ_category,
          @circ_company, @circ_department, @circ_file_size, @circ_filelink, @circ_filename,
          @file_dept, @file_ext, @sub, @first_seen_at, NULL,
          @importance_level, @importance_score, @importance_reasons, @importance_tags, @classifier
        )`,
      )
      .run({
        circ_display_no: circular.circDisplayNo,
        circ_number: circular.circNumber,
        cir_date: circular.cirDate,
        cir_display_date: circular.cirDisplayDate,
        circ_category: circular.circCategory,
        circ_company: circular.circCompany,
        circ_department: circular.circDepartment,
        circ_file_size: circular.circFileSize,
        circ_filelink: circular.circFilelink,
        circ_filename: circular.circFilename,
        file_dept: circular.fileDept,
        file_ext: circular.fileExt,
        sub: circular.sub,
        first_seen_at: new Date().toISOString(),
        importance_level: verdict.level,
        importance_score: verdict.score,
        importance_reasons: JSON.stringify(verdict.reasons),
        importance_tags: JSON.stringify(verdict.tags),
        classifier: verdict.classifier,
      });
    return result.changes > 0;
  }

  /** Circulars stored but never emailed. This is what an alert run sends. */
  pendingNotification(levels: ImportanceLevel[]): StoredCircular[] {
    if (levels.length === 0) return [];
    const placeholders = levels.map(() => "?").join(",");
    const rows = this.db
      .prepare<string[], CircularRow>(
        `SELECT * FROM circulars
         WHERE notified_at IS NULL AND importance_level IN (${placeholders})
         ORDER BY cir_date DESC, circ_number DESC`,
      )
      .all(...levels);
    return rows.map(toStored);
  }

  markNotified(displayNumbers: string[]): void {
    if (displayNumbers.length === 0) return;
    const stamp = new Date().toISOString();
    const statement = this.db.prepare(
      "UPDATE circulars SET notified_at = ? WHERE circ_display_no = ?",
    );
    this.db.transaction((numbers: string[]) => {
      for (const number of numbers) statement.run(stamp, number);
    })(displayNumbers);
  }

  recent(limit = 20): StoredCircular[] {
    return this.db
      .prepare<[number], CircularRow>(
        "SELECT * FROM circulars ORDER BY cir_date DESC, circ_number DESC LIMIT ?",
      )
      .all(limit)
      .map(toStored);
  }

  stats(): { total: number; byLevel: Record<string, number>; unnotified: number; lastRun: string | null } {
    const total =
      this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM circulars").get()?.n ?? 0;
    const byLevel: Record<string, number> = {};
    for (const row of this.db
      .prepare<[], { importance_level: string; n: number }>(
        "SELECT importance_level, COUNT(*) AS n FROM circulars GROUP BY importance_level",
      )
      .all()) {
      byLevel[row.importance_level] = row.n;
    }
    const unnotified =
      this.db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM circulars WHERE notified_at IS NULL")
        .get()?.n ?? 0;
    const lastRun =
      this.db
        .prepare<[], { finished_at: string | null }>(
          "SELECT finished_at FROM runs ORDER BY id DESC LIMIT 1",
        )
        .get()?.finished_at ?? null;
    return { total, byLevel, unnotified, lastRun };
  }

  // ─── API documentation versions ───────────────────────────────────────────

  /** Every version ever recorded for a document, newest insertion first. */
  apiDocVersions(docKey: string): string[] {
    return this.db
      .prepare<[string], { version: string }>(
        "SELECT version FROM api_docs WHERE doc_key = ?",
      )
      .all(docKey)
      .map((row) => row.version);
  }

  /**
   * Records a (doc, version) pair. `notified` is set true for baselines, so the
   * first sighting of a document never produces a "version changed" alert.
   * Returns false when this exact version was already on record.
   */
  insertApiDoc(doc: ApiDoc, notified: boolean): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO api_docs (doc_key, version, url, filename, first_seen_at, notified_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(doc.docKey, doc.version, doc.url, doc.filename, now, notified ? now : null);
    return result.changes > 0;
  }

  /** Recorded API doc versions still awaiting an alert. */
  pendingApiDocs(): StoredApiDoc[] {
    return this.db
      .prepare<[], {
        doc_key: string;
        version: string;
        url: string;
        filename: string;
        first_seen_at: string;
        notified_at: string | null;
      }>("SELECT * FROM api_docs WHERE notified_at IS NULL")
      .all()
      .map((row) => ({
        docKey: row.doc_key,
        version: row.version,
        url: row.url,
        filename: row.filename,
        first_seen_at: row.first_seen_at,
        notified_at: row.notified_at,
      }));
  }

  markApiDocsNotified(entries: { docKey: string; version: string }[]): void {
    if (entries.length === 0) return;
    const stamp = new Date().toISOString();
    const statement = this.db.prepare(
      "UPDATE api_docs SET notified_at = ? WHERE doc_key = ? AND version = ?",
    );
    this.db.transaction((rows: { docKey: string; version: string }[]) => {
      for (const row of rows) statement.run(stamp, row.docKey, row.version);
    })(entries);
  }

  /**
   * Clears the sent-flag on a recorded version so the next notify pass re-sends
   * it. Used by `apidoc check --force` to re-issue a message for review.
   */
  resetApiDocNotification(docKey: string, version: string): void {
    this.db
      .prepare("UPDATE api_docs SET notified_at = NULL WHERE doc_key = ? AND version = ?")
      .run(docKey, version);
  }

  /** Full version history, newest first, for the CLI. */
  apiDocHistory(): StoredApiDoc[] {
    return this.db
      .prepare<[], {
        doc_key: string;
        version: string;
        url: string;
        filename: string;
        first_seen_at: string;
        notified_at: string | null;
      }>("SELECT * FROM api_docs ORDER BY doc_key ASC, first_seen_at DESC")
      .all()
      .map((row) => ({
        docKey: row.doc_key,
        version: row.version,
        url: row.url,
        filename: row.filename,
        first_seen_at: row.first_seen_at,
        notified_at: row.notified_at,
      }));
  }

  startRun(windowFrom: string, windowTo: string): number {
    const result = this.db
      .prepare("INSERT INTO runs (started_at, window_from, window_to) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), windowFrom, windowTo);
    return Number(result.lastInsertRowid);
  }

  finishRun(
    id: number,
    counts: { fetched: number; inserted: number; duplicates: number; notified: number },
    error?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, fetched = ?, inserted = ?, duplicates = ?, notified = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        counts.fetched,
        counts.inserted,
        counts.duplicates,
        counts.notified,
        error ?? null,
        id,
      );
  }

  close(): void {
    this.db.close();
  }
}
