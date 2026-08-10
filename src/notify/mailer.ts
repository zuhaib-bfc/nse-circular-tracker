import nodemailer, { type Transporter } from "nodemailer";
import { assertMailConfigured, config } from "../config.js";
import { log } from "../logger.js";
import type { StoredCircular } from "../types.js";
import {
  buildApiDocHtml,
  buildApiDocSubject,
  buildApiDocText,
  type ApiDocAlertEntry,
} from "./apidoc-template.js";
import { buildHtml, buildSubject, buildText } from "./template.js";

let cached: Transporter | null = null;

function transporter(): Transporter {
  if (cached) return cached;
  assertMailConfigured();
  cached = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  return cached;
}

/**
 * Sends the digest for a set of newly-stored circulars.
 * Returns true when the message was handed to the SMTP server (or logged in dry-run).
 */
export async function sendDigest(circulars: StoredCircular[]): Promise<boolean> {
  if (circulars.length === 0) return false;

  const subject = buildSubject(circulars);
  const html = buildHtml(circulars);
  const text = buildText(circulars);

  if (config.mail.dryRun) {
    log.info(`[dry-run] Would email ${config.mail.to.join(", ") || "(no recipients)"}: ${subject}`);
    log.debug(`[dry-run] Body:\n${text}`);
    return true;
  }

  const info = await transporter().sendMail({
    from: config.mail.from,
    to: config.mail.to,
    cc: config.mail.cc.length > 0 ? config.mail.cc : undefined,
    subject,
    text,
    html,
  });

  log.info(`Emailed ${circulars.length} circular(s) to ${config.mail.to.join(", ")} (${info.messageId})`);
  return true;
}

/**
 * Sends the API-documentation version alert. Kept separate from the circular
 * digest because it answers a different question and has its own recipients-facing
 * shape: what changed, from which version, and where the new document lives.
 */
export async function sendApiDocAlert(entries: ApiDocAlertEntry[]): Promise<boolean> {
  if (entries.length === 0) return false;

  const subject = buildApiDocSubject(entries);
  const html = buildApiDocHtml(entries);
  const text = buildApiDocText(entries);

  if (config.mail.dryRun) {
    log.info(`[dry-run] Would email ${config.mail.to.join(", ") || "(no recipients)"}: ${subject}`);
    log.debug(`[dry-run] Body:\n${text}`);
    return true;
  }

  const info = await transporter().sendMail({
    from: config.mail.from,
    to: config.mail.to,
    cc: config.mail.cc.length > 0 ? config.mail.cc : undefined,
    subject,
    text,
    html,
  });

  log.info(`Emailed API doc update to ${config.mail.to.join(", ")} (${info.messageId})`);
  return true;
}

/** Verifies SMTP credentials and sends a short test message. */
export async function sendTestEmail(): Promise<void> {
  if (config.mail.dryRun) {
    log.info("[dry-run] MAIL_DRY_RUN=true — no test email sent");
    return;
  }
  const transport = transporter();
  await transport.verify();
  log.info("SMTP credentials verified");
  const info = await transport.sendMail({
    from: config.mail.from,
    to: config.mail.to,
    subject: "NSE Circular Tracker — test email",
    text: "If you can read this, the tracker can reach your stakeholders.",
    html: '<p style="font:400 14px/1.6 -apple-system,Segoe UI,sans-serif;color:#101828;">If you can read this, the tracker can reach your stakeholders.</p>',
  });
  log.info(`Test email sent to ${config.mail.to.join(", ")} (${info.messageId})`);
}
