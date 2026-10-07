import { GoogleGenAI, ThinkingLevel, Type, type GenerateContentConfig, type Schema } from "@google/genai";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { Classification, ImportanceLevel, NseCircular } from "../types.js";

const SYSTEM_PROMPT = `You classify NSE and BSE (Indian stock exchange) circulars issued by their Mutual Fund departments, for an operations and compliance team that runs a mutual fund distribution platform integrated with NSE MF Invest and BSE StAR MF.

Judge only how much the circular demands attention or action from that team. You are given the circular's subject line, which is all the exchange publishes in the listing.

CRITICAL — the team must act, or be aware, before a specific date or the platform breaks or misbehaves:
- Platform downtime, unavailability, outages, maintenance windows
- Cut-off time changes, settlement or payout schedule changes
- Suspension of subscriptions/redemptions in schemes the platform transacts in
- Mandatory technical changes with a deadline: file format changes, API changes, forced migrations, go-lives
- Mock sessions or disaster-recovery drills requiring participation
- Enforcement, penalties, or fraud advisories

IMPORTANT — the team should read it this week, but nothing breaks today:
- Non-business days for specific schemes or AMCs
- SEBI/AMFI regulatory changes affecting operations
- New optional features, process revisions, revised reporting formats
- Changes to scheme attributes the platform displays or transacts on

ROUTINE — informational; no action:
- New Fund Offer (NFO) launches and scheme availability announcements
- Name/address changes, empanelment notices, routine sub-option introductions
- Anything purely promotional or catalogue-like

Bias toward ROUTINE when the subject is a plain NFO or scheme-availability notice, and toward CRITICAL when a date-bound operational impact is stated or clearly implied.

Respond with JSON matching the required schema and nothing else.`;

/**
 * Gemini's structured-output schema. Note this is Google's `Schema` dialect, not
 * raw JSON Schema — types are the `Type` enum and `additionalProperties` is not
 * supported. `propertyOrdering` makes the generation order deterministic.
 */
const RESULT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    level: {
      type: Type.STRING,
      enum: ["CRITICAL", "IMPORTANT", "ROUTINE"],
      description: "Importance level for the operations team.",
    },
    reason: {
      type: Type.STRING,
      description: "One sentence explaining the classification, referencing the subject line.",
    },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Short uppercase tags, e.g. DOWNTIME, SUSPENSION, CUTOFF_CHANGE, NON_BUSINESS_DAY, REGULATORY, RELEASE, ROUTINE_NFO.",
    },
  },
  required: ["level", "reason", "tags"],
  propertyOrdering: ["level", "reason", "tags"],
};

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  MINIMAL: ThinkingLevel.MINIMAL,
  LOW: ThinkingLevel.LOW,
  MEDIUM: ThinkingLevel.MEDIUM,
  HIGH: ThinkingLevel.HIGH,
};

interface LlmVerdict {
  level: ImportanceLevel;
  reason: string;
  tags: string[];
}

/** Score assigned to an LLM verdict so downstream code has a comparable number. */
function scoreForLevel(level: ImportanceLevel): number {
  if (level === "CRITICAL") return config.classify.criticalThreshold;
  if (level === "IMPORTANT") return config.classify.importantThreshold;
  return 0;
}

export class GeminiClassifier {
  private readonly ai: GoogleGenAI;
  /**
   * Thinking controls are model-dependent on Gemini. If the configured model
   * rejects `thinkingConfig`, we drop it for the rest of the process rather than
   * failing every classification.
   */
  private sendThinkingConfig: boolean;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.sendThinkingConfig = config.classify.thinkingLevel !== "OFF";
  }

  /** True when an API key is configured and the fallback can be used. */
  static isAvailable(): boolean {
    return config.classify.geminiApiKey.length > 0;
  }

  private requestConfig(): GenerateContentConfig {
    const generateConfig: GenerateContentConfig = {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: RESULT_SCHEMA,
      // Classification should be reproducible run to run.
      temperature: 0,
      maxOutputTokens: 2048,
    };
    const level = THINKING_LEVELS[config.classify.thinkingLevel];
    if (this.sendThinkingConfig && level !== undefined) {
      generateConfig.thinkingConfig = { thinkingLevel: level };
    }
    return generateConfig;
  }

  /**
   * Classifies one circular. Returns null on any API failure so the caller can
   * keep the deterministic rule verdict — a classifier outage must never stop
   * the tracker from recording circulars.
   */
  async classify(circular: NseCircular): Promise<Classification | null> {
    const prompt = [
      `Circular number: ${circular.circDisplayNo}`,
      `Date: ${circular.cirDisplayDate}`,
      `Category: ${circular.circCategory}`,
      `Subject: ${circular.sub}`,
    ].join("\n");

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.ai.models.generateContent({
          model: config.classify.model,
          contents: prompt,
          config: this.requestConfig(),
        });

        const text = response.text;
        if (!text) {
          log.warn(
            `Gemini returned no text for ${circular.circDisplayNo}` +
              (response.promptFeedback?.blockReason
                ? ` (blocked: ${response.promptFeedback.blockReason})`
                : ""),
          );
          return null;
        }

        const verdict = JSON.parse(text) as LlmVerdict;
        if (!["CRITICAL", "IMPORTANT", "ROUTINE"].includes(verdict.level)) {
          log.warn(`Gemini returned unknown level ${verdict.level} for ${circular.circDisplayNo}`);
          return null;
        }

        return {
          level: verdict.level,
          score: scoreForLevel(verdict.level),
          reasons: [verdict.reason],
          classifier: "llm",
          tags: Array.isArray(verdict.tags) ? verdict.tags : [],
        };
      } catch (error) {
        const message = String(error);
        // Retry once without thinking controls if that's what the model rejected.
        if (attempt === 0 && this.sendThinkingConfig && /thinking/i.test(message)) {
          log.warn(
            `Model ${config.classify.model} rejected thinkingConfig; disabling it and retrying`,
          );
          this.sendThinkingConfig = false;
          continue;
        }
        log.warn(`Gemini classification failed for ${circular.circDisplayNo}: ${message}`);
        return null;
      }
    }
    return null;
  }
}
