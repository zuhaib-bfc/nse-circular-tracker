import { checkApiDocs, notifyApiDocChanges } from "./apidoc/tracker.js";
import { Classifier } from "./classify/index.js";
import { config } from "./config.js";
import { CircularStore } from "./db.js";
import { log } from "./logger.js";
import { NseClient, daysAgo, formatNseDate } from "./nse/client.js";
import { sendDigest } from "./notify/mailer.js";
import type { ImportanceLevel, RunSummary } from "./types.js";

export interface RunOptions {
  /** Window start. Defaults to NSE_LOOKBACK_DAYS before today. */
  from?: Date;
  /** Window end. Defaults to today. */
  to?: Date;
  /** Skip the email step entirely (used by backfill). */
  skipNotify?: boolean;
  /** Skip the API-doc check (backfill chunks would repeat it pointlessly). */
  skipApiDocs?: boolean;
  store?: CircularStore;
}

function levelsToNotify(): ImportanceLevel[] {
  return config.mail.notifyOnRoutine
    ? ["CRITICAL", "IMPORTANT", "ROUTINE"]
    : ["CRITICAL", "IMPORTANT"];
}

/**
 * One full cycle: fetch the window, drop circulars already stored, classify the
 * genuinely new ones, persist them, and email whatever crosses the alert bar.
 *
 * Dedup happens before classification so re-running the same window is cheap and
 * never re-spends LLM tokens; the overlapping lookback window is what makes a
 * missed run self-heal.
 */
export async function runOnce(options: RunOptions = {}): Promise<RunSummary> {
  const to = options.to ?? new Date();
  const from = options.from ?? daysAgo(config.nse.lookbackDays, to);
  const windowFrom = formatNseDate(from);
  const windowTo = formatNseDate(to);

  const store = options.store ?? new CircularStore();
  const ownsStore = options.store === undefined;
  const runId = store.startRun(windowFrom, windowTo);

  const summary: RunSummary = {
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    notified: 0,
    byLevel: { CRITICAL: 0, IMPORTANT: 0, ROUTINE: 0 },
    apiDocUpgrades: 0,
    apiDocsNotified: 0,
    windowFrom,
    windowTo,
  };

  try {
    log.info(`Fetching NSE ${config.nse.dept} circulars for ${windowFrom} .. ${windowTo}`);
    const fetched = await new NseClient().fetchCirculars(from, to);
    summary.fetched = fetched.length;

    const unseen = store.filterUnseen(fetched);
    summary.duplicates = fetched.length - unseen.length;
    log.info(`${fetched.length} fetched, ${summary.duplicates} already stored, ${unseen.length} new`);

    if (unseen.length > 0) {
      const verdicts = await new Classifier().classifyAll(unseen);
      for (const circular of unseen) {
        const verdict = verdicts.get(circular.circDisplayNo);
        if (!verdict) continue;
        if (store.insert(circular, verdict)) {
          summary.inserted += 1;
          summary.byLevel[verdict.level] += 1;
          log.info(
            `[${verdict.level}] ${circular.circDisplayNo} (score ${verdict.score}, via ${verdict.classifier}) — ${circular.sub}`,
          );
        } else {
          // Lost a race with a concurrent run; treat as a duplicate.
          summary.duplicates += 1;
        }
      }
    }

    if (!options.skipNotify) {
      const pending = store.pendingNotification(levelsToNotify());
      if (pending.length > 0) {
        const sent = await sendDigest(pending);
        if (sent) {
          store.markNotified(pending.map((circular) => circular.circDisplayNo));
          summary.notified = pending.length;
        }
      } else {
        log.info("Nothing crosses the alert threshold — no email sent");
      }
    }

    // API doc tracking is deliberately after circulars and independently
    // guarded: a layout change on nseinvest.com must never cost us a circular run.
    if (config.apiDoc.enabled && !options.skipApiDocs) {
      try {
        const changes = await checkApiDocs(store);
        summary.apiDocUpgrades = changes.filter((change) => change.kind === "upgrade").length;
        if (!options.skipNotify) {
          summary.apiDocsNotified = await notifyApiDocChanges(store, changes);
        }
      } catch (error) {
        log.error(`API doc check failed (circulars were unaffected): ${String(error)}`);
      }
    }

    store.finishRun(runId, summary);
    return summary;
  } catch (error) {
    store.finishRun(runId, summary, String(error));
    throw error;
  } finally {
    if (ownsStore) store.close();
  }
}

/**
 * Walks a long date range in chunks. NSE's API degrades on very wide windows, and
 * chunking also lets a partial failure keep everything fetched so far.
 */
export async function backfill(days: number, chunkDays = 30): Promise<RunSummary> {
  const store = new CircularStore();
  const total: RunSummary = {
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    notified: 0,
    byLevel: { CRITICAL: 0, IMPORTANT: 0, ROUTINE: 0 },
    apiDocUpgrades: 0,
    apiDocsNotified: 0,
    windowFrom: formatNseDate(daysAgo(days)),
    windowTo: formatNseDate(new Date()),
  };

  try {
    for (let offset = 0; offset < days; offset += chunkDays) {
      const to = daysAgo(offset);
      const from = daysAgo(Math.min(offset + chunkDays - 1, days));
      const chunk = await runOnce({ from, to, skipNotify: true, skipApiDocs: true, store });
      total.fetched += chunk.fetched;
      total.inserted += chunk.inserted;
      total.duplicates += chunk.duplicates;
      for (const level of ["CRITICAL", "IMPORTANT", "ROUTINE"] as const) {
        total.byLevel[level] += chunk.byLevel[level];
      }
    }
    // Backfilled circulars are historical; mark them notified so the next
    // scheduled run doesn't email months of back-catalogue in one blast.
    const historical = store.pendingNotification(["CRITICAL", "IMPORTANT", "ROUTINE"]);
    store.markNotified(historical.map((circular) => circular.circDisplayNo));
    log.info(`Backfill suppressed alerts for ${historical.length} historical circular(s)`);
    return total;
  } finally {
    store.close();
  }
}
