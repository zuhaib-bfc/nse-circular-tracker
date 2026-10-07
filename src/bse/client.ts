import { config } from "../config.js";
import { log } from "../logger.js";
import type { NseCircular } from "../types.js";

const BSE_NOTICE_BASE = "https://www.bseindia.com/downloads/UploadDocs/Notices/";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** BSE's API expects YYYY-MM-DD, in India time. */
export function formatBseDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** "2026-10-01T00:00:00" -> "October 01, 2026", matching NSE's cirDisplayDate. */
function displayDate(noticeDate: string): string {
  const date = new Date(`${noticeDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return noticeDate;
  return date.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "2-digit", year: "numeric" });
}

/**
 * Notice attachments live under .../Notices/<noticeNo>/, so a bare or relative
 * `FileName` resolves against that directory. Only http(s) links on bseindia.com are kept: the
 * value ends up in an email href, and `javascript:`/`data:` must never get there.
 * Returns "" when there is no usable link.
 */
export function resolveFileLink(fileName: string, noticeNo: string): string {
  if (!fileName) return "";
  try {
    const url = new URL(fileName, `${BSE_NOTICE_BASE}${encodeURIComponent(noticeNo)}/`);
    const isHttp = url.protocol === "https:" || url.protocol === "http:";
    const isBse = url.hostname === "bseindia.com" || url.hostname.endsWith(".bseindia.com");
    return isHttp && isBse ? url.href : "";
  } catch {
    return "";
  }
}

/**
 * Maps one BSE notice onto the shared circular shape so it flows through the
 * same dedup → classify → store → digest path as NSE. Returns null for records
 * without a notice number or subject, which cannot be stored or classified.
 *
 * The notice number ("20261001-59") is globally unique and doubles as the
 * identity, so BSE and NSE ids can never collide.
 */
export function normalizeBseNotice(value: unknown): NseCircular | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const noticeNo = asText(record["Notice_No"]);
  const subject = asText(record["Subject"]).replace(/\s+/g, " ");
  if (!noticeNo || !subject) return null;

  const noticeDate = asText(record["Notice_Date"]);
  const fileLink = resolveFileLink(asText(record["FileName"]), noticeNo);
  const fileExt = /\.([a-z0-9]+)$/i.exec(fileLink.split("?")[0] ?? "")?.[1]?.toLowerCase() ?? "";

  return {
    cirDate: noticeDate.slice(0, 10).replace(/-/g, ""),
    cirDisplayDate: displayDate(noticeDate),
    circCategory: asText(record["category_name"]),
    circCompany: "BSE",
    circDepartment: asText(record["Dept_Name"]) || asText(record["Segment_Name"]) || config.bse.segment,
    circDisplayNo: noticeNo,
    circFileSize: "",
    circFilelink: fileLink,
    circFilename: fileLink.split("/").pop() ?? "",
    circNumber: noticeNo,
    fileDept: "",
    fileExt,
    sub: subject,
  };
}

/**
 * BSE's Akamai edge lets plain HTTP through as long as the request looks like an
 * XHR from bseindia.com (Origin/Referer); it blocks only missing or headless-browser
 * fingerprints. No cookie bootstrap or real browser is needed.
 */
async function fetchPayload(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "user-agent": config.nse.userAgent,
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      origin: "https://www.bseindia.com",
      referer: config.bse.pageUrl,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`BSE returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`BSE returned non-JSON body (${body.slice(0, 120)})`);
  }
}

export class BseClient {
  /** Fetches every notice in the segment for the window, inclusive, across all departments and categories. */
  async fetchCirculars(fromDate: Date, toDate: Date): Promise<NseCircular[]> {
    const params = new URLSearchParams({
      strTxtNoticeNo: "",
      strTxtDate: formatBseDate(fromDate),
      strTxtTodate: formatBseDate(toDate),
      strScripcode: "",
      strDep: "",
      strSegment: config.bse.segment,
      subject: "",
      category: "",
      containgtext: "",
    });
    const url = `${config.bse.apiUrl}?${params.toString()}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= config.bse.maxRetries; attempt++) {
      try {
        const payload = await fetchPayload(url);
        const table = (payload as { Table?: unknown } | null)?.Table;
        // BSE answers an empty window with `"Table": null`.
        if (table === null) return [];
        if (!Array.isArray(table)) throw new Error("BSE response had no `Table` array");

        const circulars = table
          .map(normalizeBseNotice)
          .filter((circular): circular is NseCircular => circular !== null);
        if (circulars.length !== table.length) {
          log.warn(`Dropped ${table.length - circulars.length} invalid BSE record(s)`);
        }
        log.debug(`Fetched ${circulars.length} BSE circulars for ${params.get("strTxtDate")}..${params.get("strTxtTodate")}`);
        return circulars;
      } catch (error) {
        lastError = error;
        if (attempt < config.bse.maxRetries) {
          const backoff = config.bse.retryDelayMs * attempt;
          log.warn(`BSE fetch attempt ${attempt}/${config.bse.maxRetries} failed (${String(error)}); retrying in ${backoff}ms`);
          await sleep(backoff);
        }
      }
    }
    throw new Error(`BSE fetch failed after ${config.bse.maxRetries} attempts: ${String(lastError)}`);
  }
}
