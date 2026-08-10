import { config } from "../config.js";
import { log } from "../logger.js";
import type { ApiDoc } from "../types.js";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Compares dotted numeric versions segment by segment.
 * String comparison is wrong here — "1.9.10" must sort above "1.9.7".
 * Returns <0 if a is older, 0 if equal, >0 if a is newer.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Picks the highest version from a list. Returns null for an empty list. */
export function highestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((best, candidate) =>
    compareVersions(candidate, best) > 0 ? candidate : best,
  );
}

function browserHeaders(): Record<string, string> {
  return {
    "user-agent": config.nse.userAgent,
    "accept-language": "en-US,en;q=0.9",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };
}

/**
 * Scrapes the NSE MF Desk page for versioned API documentation links.
 *
 * The page is plain server-rendered HTML — the "API STRUCTURE" menu items are
 * ordinary anchors, so no browser automation is needed. We match hrefs against
 * APIDOC_LINK_PATTERN, whose first capture group must be the version.
 */
export async function scrapeApiDocs(): Promise<ApiDoc[]> {
  const pageUrl = config.apiDoc.pageUrl;
  let html = "";
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.nse.maxRetries; attempt++) {
    try {
      const response = await fetch(pageUrl, { headers: browserHeaders() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      html = await response.text();
      break;
    } catch (error) {
      lastError = error;
      if (attempt < config.nse.maxRetries) {
        const backoff = config.nse.retryDelayMs * attempt;
        log.warn(
          `API doc page fetch attempt ${attempt}/${config.nse.maxRetries} failed (${String(error)}); retrying in ${backoff}ms`,
        );
        await sleep(backoff);
      }
    }
  }

  if (!html) {
    throw new Error(`Could not fetch ${pageUrl}: ${String(lastError)}`);
  }

  // Global+case-insensitive copy of the configured pattern, so callers can
  // supply a plain pattern without worrying about flags.
  const versionPattern = new RegExp(config.apiDoc.linkPattern, "gi");
  const hrefPattern = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;

  const found = new Map<string, ApiDoc>();
  for (const match of html.matchAll(hrefPattern)) {
    const href = match[1];
    if (!href) continue;

    versionPattern.lastIndex = 0;
    const versionMatch = versionPattern.exec(href);
    if (!versionMatch) continue;

    const version = versionMatch[1];
    if (!version) {
      log.warn(`APIDOC_LINK_PATTERN matched "${href}" but captured no version group`);
      continue;
    }

    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      log.warn(`Skipping unparseable API doc href: ${href}`);
      continue;
    }

    const filename = decodeURIComponent(absolute.split("/").pop() ?? "");
    // Strip the version token so successive releases share a stable identity.
    const docKey = filename
      .replace(/\.pdf$/i, "")
      .replace(new RegExp(`_?v?${version.replace(/\./g, "\\.")}$`, "i"), "")
      .replace(/[_-]+$/, "");

    // Same doc can be linked more than once on the page; keep one entry.
    found.set(`${docKey}@${version}`, { docKey, version, url: absolute, filename });
  }

  const docs = [...found.values()];
  if (docs.length === 0) {
    // Worth shouting about: it usually means NSE renamed the file, which is
    // itself a change the team wants to know about.
    log.warn(
      `No API docs on ${pageUrl} matched /${config.apiDoc.linkPattern}/ — the page layout or filename may have changed`,
    );
  } else {
    log.debug(`Found API docs: ${docs.map((d) => `${d.docKey} v${d.version}`).join(", ")}`);
  }
  return docs;
}

/**
 * Cheap liveness check on a document URL. The site blocks HEAD (403) and
 * requires a referer, so this issues a 1-byte ranged GET instead of pulling the
 * whole multi-megabyte PDF.
 */
export async function verifyDocLink(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: {
        ...browserHeaders(),
        accept: "application/pdf,*/*",
        referer: config.apiDoc.pageUrl,
        range: "bytes=0-0",
      },
    });
    await response.arrayBuffer();
    return response.ok || response.status === 206;
  } catch (error) {
    log.warn(`Could not verify API doc link ${url}: ${String(error)}`);
    return false;
  }
}
