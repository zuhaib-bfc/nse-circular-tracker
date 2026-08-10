import type { StoredApiDoc } from "../types.js";

export interface ApiDocAlertEntry {
  doc: StoredApiDoc;
  previousVersion: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function prettyName(docKey: string): string {
  return docKey.replace(/[_-]+/g, " ").trim();
}

/**
 * An entry with no previous version is a baseline — the first time we've seen the
 * document at all. Saying "updated" there would be a false alarm, so the whole
 * message switches wording.
 */
function isBaseline(entries: ApiDocAlertEntry[]): boolean {
  return entries.every((entry) => entry.previousVersion === null);
}

export function buildApiDocSubject(entries: ApiDocAlertEntry[]): string {
  const first = entries[0];
  if (entries.length === 1 && first) {
    if (first.previousVersion === null) {
      return `[API DOCS] Now tracking ${prettyName(first.doc.docKey)} — currently v${first.doc.version}`;
    }
    return `[API DOCS] ${prettyName(first.doc.docKey)} updated — v${first.previousVersion} → v${first.doc.version}`;
  }
  return isBaseline(entries)
    ? `[API DOCS] Now tracking ${entries.length} NSE MF API documents`
    : `[API DOCS] ${entries.length} NSE MF API documents updated`;
}

export function buildApiDocHtml(entries: ApiDocAlertEntry[]): string {
  const baseline = isBaseline(entries);
  const accent = baseline ? "#475467" : "#175cd3";
  const generatedAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const heading = baseline
    ? "Now tracking NSE MF API documentation"
    : "NSE MF API documentation updated";
  const subheading = baseline
    ? "This is the current version on record. You'll only be emailed again when the version number increases."
    : "A new document version is published on NSE MF Desk";
  const footer = baseline
    ? "Baseline recorded by nse-circular-tracker from the API STRUCTURE menu. Nothing has changed yet &mdash; this message confirms the watch is live."
    : "Detected by nse-circular-tracker from the API STRUCTURE menu. The version number changed &mdash; review the document to see what actually changed in the spec.";

  const cards = entries
    .map((entry) => {
      const { doc, previousVersion } = entry;
      const versionLine = previousVersion
        ? `<span style="color:#667085;text-decoration:line-through;">v${escapeHtml(previousVersion)}</span>
           <span style="color:#667085;">&nbsp;→&nbsp;</span>
           <span style="color:${accent};font-weight:700;">v${escapeHtml(doc.version)}</span>`
        : `<span style="color:${accent};font-weight:700;">v${escapeHtml(doc.version)}</span>`;

      return `
      <tr><td style="padding:0 0 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-left:3px solid ${accent};border-radius:6px;background:#ffffff;">
          <tr><td style="padding:16px 18px;">
            <div style="font:600 15px/1.5 -apple-system,Segoe UI,sans-serif;color:#101828;">${escapeHtml(prettyName(doc.docKey))}</div>
            <div style="margin-top:8px;font:600 18px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;">${versionLine}</div>
            <div style="margin-top:10px;font:400 12px/1.6 -apple-system,Segoe UI,sans-serif;color:#667085;">
              ${escapeHtml(doc.filename)}
            </div>
            <div style="margin-top:12px;">
              <a href="${escapeHtml(doc.url)}" style="font:600 13px/1.5 -apple-system,Segoe UI,sans-serif;color:${accent};text-decoration:none;">Open the latest document &rarr;</a>
            </div>
            <div style="margin-top:6px;font:400 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#98a2b3;word-break:break-all;">${escapeHtml(doc.url)}</div>
          </td></tr>
        </table>
      </td></tr>`;
    })
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
        <tr><td style="padding-bottom:18px;">
          <div style="font:700 20px/1.4 -apple-system,Segoe UI,sans-serif;color:#101828;">${heading}</div>
          <div style="margin-top:4px;font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#667085;">
            ${subheading} &middot; ${escapeHtml(generatedAt)} IST
          </div>
        </td></tr>
        ${cards}
        <tr><td style="padding-top:16px;border-top:1px solid #e4e7ec;">
          <div style="font:400 11px/1.6 -apple-system,Segoe UI,sans-serif;color:#98a2b3;">
            ${footer}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function buildApiDocText(entries: ApiDocAlertEntry[]): string {
  const baseline = isBaseline(entries);
  const lines: string[] = [
    baseline ? "Now tracking NSE MF API documentation" : "NSE MF API documentation updated",
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST",
    "",
  ];
  for (const { doc, previousVersion } of entries) {
    lines.push(
      `${prettyName(doc.docKey)}`,
      previousVersion ? `  v${previousVersion} -> v${doc.version}` : `  v${doc.version} (current)`,
      `  ${doc.filename}`,
      `  ${doc.url}`,
      "",
    );
  }
  lines.push(
    ...(baseline
      ? [
          "Baseline recorded from the API STRUCTURE menu on NSE MF Desk. Nothing has",
          "changed yet — this message confirms the watch is live. You'll only be emailed",
          "again when the version number increases.",
        ]
      : [
          "Detected from the API STRUCTURE menu on NSE MF Desk. The version number changed —",
          "review the document to see what actually changed in the spec.",
        ]),
  );
  return lines.join("\n");
}
