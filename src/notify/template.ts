import type { ImportanceLevel, StoredCircular } from "../types.js";

const LEVEL_ORDER: ImportanceLevel[] = ["CRITICAL", "IMPORTANT", "ROUTINE"];

const LEVEL_STYLE: Record<ImportanceLevel, { accent: string; bg: string; label: string }> = {
  CRITICAL: { accent: "#b42318", bg: "#fef3f2", label: "Critical" },
  IMPORTANT: { accent: "#b54708", bg: "#fffaeb", label: "Important" },
  ROUTINE: { accent: "#475467", bg: "#f9fafb", label: "Routine" },
};

// Rows stored before the fetch layer normalized nulls can still carry them, so
// the digest must render a partial circular rather than fail the whole run.
function escapeHtml(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseJsonArray(raw: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function groupByLevel(circulars: StoredCircular[]): Map<ImportanceLevel, StoredCircular[]> {
  const groups = new Map<ImportanceLevel, StoredCircular[]>();
  for (const level of LEVEL_ORDER) {
    const matching = circulars.filter((c) => c.importance_level === level);
    if (matching.length > 0) groups.set(level, matching);
  }
  return groups;
}

/** Exchanges present in a batch, e.g. "BSE & NSE" — all sources share one digest. */
function exchangeLabel(circulars: StoredCircular[]): string {
  const names = [...new Set(circulars.map((c) => (c.circCompany === "BSE" ? "BSE" : "NSE")))].sort();
  return names.length > 0 ? names.join(" & ") : "NSE";
}

export function buildSubject(circulars: StoredCircular[]): string {
  const critical = circulars.filter((c) => c.importance_level === "CRITICAL").length;
  const important = circulars.filter((c) => c.importance_level === "IMPORTANT").length;
  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (important > 0) parts.push(`${important} important`);
  const detail = parts.length > 0 ? parts.join(", ") : `${circulars.length} new`;
  const prefix = critical > 0 ? "[ACTION NEEDED] " : "";
  return `${prefix}${exchangeLabel(circulars)} MF circulars — ${detail}`;
}

export function buildHtml(circulars: StoredCircular[]): string {
  const groups = groupByLevel(circulars);
  const generatedAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  const sections = [...groups.entries()]
    .map(([level, items]) => {
      const style = LEVEL_STYLE[level];
      const cards = items
        .map((circular) => {
          const tags = parseJsonArray(circular.importance_tags);
          const reasons = parseJsonArray(circular.importance_reasons);
          const tagHtml =
            tags.length > 0
              ? `<div style="margin-top:10px;">${tags
                  .map(
                    (tag) =>
                      `<span style="display:inline-block;font:600 11px/1.6 -apple-system,Segoe UI,sans-serif;letter-spacing:.4px;color:${style.accent};background:${style.bg};border:1px solid ${style.accent}22;border-radius:4px;padding:1px 7px;margin:0 6px 4px 0;">${escapeHtml(tag)}</span>`,
                  )
                  .join("")}</div>`
              : "";
          const reasonHtml =
            reasons.length > 0
              ? `<div style="margin-top:8px;font:400 12px/1.6 -apple-system,Segoe UI,sans-serif;color:#667085;">Why: ${escapeHtml(reasons.join("; "))}</div>`
              : "";
          return `
      <tr><td style="padding:0 0 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-left:3px solid ${style.accent};border-radius:6px;background:#ffffff;">
          <tr><td style="padding:16px 18px;">
            <div style="font:600 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:${style.accent};">${escapeHtml(circular.circDisplayNo)}</div>
            <div style="margin-top:6px;font:600 15px/1.5 -apple-system,Segoe UI,sans-serif;color:#101828;">${escapeHtml(circular.sub)}</div>
            <div style="margin-top:8px;font:400 12px/1.6 -apple-system,Segoe UI,sans-serif;color:#667085;">
              ${[circular.circCompany, circular.cirDisplayDate, circular.circDepartment, circular.circCategory, circular.circFileSize]
                .filter(Boolean)
                .map(escapeHtml)
                .join(" &nbsp;·&nbsp; ")}
            </div>
            ${reasonHtml}
            ${tagHtml}
            ${
              /^https?:[/][/]/i.test(circular.circFilelink)
                ? `<div style="margin-top:12px;">
              <a href="${escapeHtml(circular.circFilelink)}" style="font:600 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#175cd3;text-decoration:none;">Download circular${circular.fileExt ? ` (${escapeHtml(circular.fileExt.toUpperCase())})` : ""} &rarr;</a>
            </div>`
                : ""
            }
          </td></tr>
        </table>
      </td></tr>`;
        })
        .join("");

      return `
    <tr><td style="padding:10px 0 6px;">
      <div style="font:700 12px/1.6 -apple-system,Segoe UI,sans-serif;letter-spacing:1px;text-transform:uppercase;color:${style.accent};">
        ${style.label} &nbsp;(${items.length})
      </div>
    </td></tr>
    ${cards}`;
    })
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
        <tr><td style="padding-bottom:18px;">
          <div style="font:700 20px/1.4 -apple-system,Segoe UI,sans-serif;color:#101828;">${exchangeLabel(circulars)} Mutual Fund circulars</div>
          <div style="margin-top:4px;font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#667085;">
            ${circulars.length} new circular${circulars.length === 1 ? "" : "s"} detected &middot; ${escapeHtml(generatedAt)} IST
          </div>
        </td></tr>
        ${sections}
        <tr><td style="padding-top:16px;border-top:1px solid #e4e7ec;">
          <div style="font:400 11px/1.6 -apple-system,Segoe UI,sans-serif;color:#98a2b3;">
            Sent automatically by circular-tracker. Importance is inferred from the circular subject line &mdash; open the attachment before acting.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function buildText(circulars: StoredCircular[]): string {
  const groups = groupByLevel(circulars);
  const lines: string[] = [
    `${exchangeLabel(circulars)} Mutual Fund circulars — ${circulars.length} new`,
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST",
    "",
  ];

  for (const [level, items] of groups) {
    lines.push(`== ${LEVEL_STYLE[level].label.toUpperCase()} (${items.length}) ==`, "");
    for (const circular of items) {
      const reasons = parseJsonArray(circular.importance_reasons);
      lines.push(
        `[${exchangeLabel([circular])}] ${circular.circDisplayNo} — ${circular.cirDisplayDate}`,
        `  ${circular.sub}`,
        reasons.length > 0 ? `  Why: ${reasons.join("; ")}` : "",
        circular.circFilelink ? `  ${circular.circFilelink}` : "",
        "",
      );
    }
  }

  lines.push("Importance is inferred from the subject line — open the attachment before acting.");
  return lines.filter((line) => line !== undefined).join("\n");
}
