import { config } from "../config.js";
import type { CircularStore } from "../db.js";
import { log } from "../logger.js";
import { sendApiDocAlert } from "../notify/mailer.js";
import type { ApiDocChange } from "../types.js";
import { compareVersions, highestVersion, scrapeApiDocs, verifyDocLink } from "./scraper.js";

/**
 * Scrapes the NSE MF Desk site and reconciles what it finds against the versions
 * already on record.
 *
 * First sighting of a document is stored as a silent baseline — otherwise the
 * very first run would email "the API docs changed" when nothing has. Only a
 * genuine version increase produces an alert.
 */
export async function checkApiDocs(store: CircularStore): Promise<ApiDocChange[]> {
  const docs = await scrapeApiDocs();
  const changes: ApiDocChange[] = [];

  for (const doc of docs) {
    const known = store.apiDocVersions(doc.docKey);
    const previousVersion = highestVersion(known);

    if (known.includes(doc.version)) {
      changes.push({ doc, previousVersion, kind: "unchanged" });
      continue;
    }

    if (previousVersion === null) {
      store.insertApiDoc(doc, true); // baseline: recorded, not alerted
      log.info(`API doc baseline recorded: ${doc.docKey} v${doc.version}`);
      changes.push({ doc, previousVersion: null, kind: "baseline" });
      continue;
    }

    const direction = compareVersions(doc.version, previousVersion);
    if (direction > 0) {
      store.insertApiDoc(doc, false); // queued for alerting
      log.info(`API doc UPGRADED: ${doc.docKey} v${previousVersion} -> v${doc.version}`);
      changes.push({ doc, previousVersion, kind: "upgrade" });
    } else {
      // An older version reappearing usually means NSE rolled a document back.
      // Record it for the audit trail but don't alert on a downgrade.
      store.insertApiDoc(doc, true);
      log.warn(
        `API doc version went backwards: ${doc.docKey} v${doc.version} (we had v${previousVersion}) — recorded, not alerted`,
      );
      changes.push({ doc, previousVersion, kind: "regression" });
    }
  }

  return changes;
}

/**
 * Emails any recorded-but-unalerted API doc versions, then marks them sent.
 * Marking happens only after the SMTP server accepts the message, so a mail
 * failure retries on the next run rather than silently dropping the alert.
 */
export async function notifyApiDocChanges(
  store: CircularStore,
  changes: ApiDocChange[],
): Promise<number> {
  const pending = store.pendingApiDocs();
  if (pending.length === 0) return 0;

  // Pair each pending row with the previous version discovered this run, so the
  // email can say "1.9.7 -> 1.9.8" rather than just naming the new version.
  const previousByKey = new Map<string, string | null>();
  for (const change of changes) previousByKey.set(change.doc.docKey, change.previousVersion);

  const enriched = pending.map((doc) => {
    const previous = previousByKey.get(doc.docKey) ?? null;
    return {
      doc,
      // A "previous" equal to the version being sent means there is no distinct
      // prior release (first sighting, or a forced re-send). Render it as a
      // baseline rather than a nonsensical "v1.9.7 -> v1.9.7".
      previousVersion: previous === doc.version ? null : previous,
    };
  });

  if (config.apiDoc.verifyLink) {
    for (const entry of enriched) {
      const live = await verifyDocLink(entry.doc.url);
      if (!live) log.warn(`API doc link may not be reachable: ${entry.doc.url}`);
    }
  }

  const sent = await sendApiDocAlert(enriched);
  if (!sent) return 0;

  store.markApiDocsNotified(
    enriched.map((entry) => ({ docKey: entry.doc.docKey, version: entry.doc.version })),
  );
  return enriched.length;
}
