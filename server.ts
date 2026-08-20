// bb-plugin-headroom — context budget monitoring for BB coding agents.
//
// Registers `headroom_status` as a native agent tool that reports:
//   - context window size (model provider cap)
//   - estimated tokens used
//   - remaining headroom
//   - recommendation: green / yellow / red
//
// It reads real usage from `thread/contextWindowUsage/updated` events when
// available and falls back to a message-count × rough-average estimate.
// Also runs a log-based background monitor that tracks per-thread context
// usage and logs when a thread crosses the warning threshold. The monitor
// writes to the plugin log only — it does not inject messages into threads.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── Model context caps (fallback defaults — real usage events override) ───

const DEFAULT_CONTEXT_WINDOW = 128_000;
const TOKENS_PER_MESSAGE_ESTIMATE = 500; // rough average across code + chat

// Known provider caps (tokens)
const PROVIDER_CAPS: Record<string, number> = {
  "claude-3.5-sonnet": 200_000,
  "claude-3-opus": 200_000,
  "claude-3-haiku": 200_000,
  "gpt-4o": 128_000,
  "gpt-4-turbo": 128_000,
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.5-flash": 1_000_000,
  "codestral": 256_000,
  "deepseek-v3": 128_000,
  "deepseek-v4": 200_000,
  "qwen3.5": 128_000,
  "qwen-coder": 128_000,
};

function resolveContextCap(providerName: string, modelName: string | undefined): number {
  const key = modelName?.toLowerCase() ?? providerName.toLowerCase();
  for (const [k, cap] of Object.entries(PROVIDER_CAPS)) {
    if (key.includes(k.toLowerCase())) return cap;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ─── Plugin entry ────────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-headroom loaded");

  // Settings are string/boolean/select only — parse thresholds from strings
  const settings = bb.settings.define({
    warningThreshold: {
      type: "string" as const,
      label: "Warning threshold (%)",
      default: "70",
      description: "Log a warning when context usage exceeds this percentage.",
    },
    criticalThreshold: {
      type: "string" as const,
      label: "Critical threshold (%)",
      default: "85",
      description: "Log a critical alert when context usage exceeds this percentage.",
    },
  });

  let { warningThreshold, criticalThreshold } = await settings.get();
  let warnPct = parseInt(warningThreshold, 10) || 70;
  let critPct = parseInt(criticalThreshold, 10) || 85;

  // Re-read thresholds on setting changes without a plugin reload.
  settings.onChange((next) => {
    warningThreshold = next.warningThreshold;
    criticalThreshold = next.criticalThreshold;
    warnPct = parseInt(warningThreshold, 10) || 70;
    critPct = parseInt(criticalThreshold, 10) || 85;
    bb.log.info(`[headroom] thresholds updated: warn ${warnPct}%, crit ${critPct}%`);
  });

  // ── Context usage helpers ─────────────────────────────────────────

  interface UsageReading {
    usedTokens: number;
    modelContextWindow: number;
    estimated: boolean;
  }

  // Prefer the real context-window usage event; fall back to a
  // message-count × per-message estimate.
  async function readContextUsage(threadId: string): Promise<UsageReading | null> {
    try {
      // Real usage: most recent thread/contextWindowUsage/updated row.
      const usageRows = await bb.sdk.threads.events.list({
        threadId,
        types: ["thread/contextWindowUsage/updated"],
        order: "desc",
        limit: "1",
      });
      if (usageRows.length > 0) {
        const data = (usageRows[0] as any).data as {
          contextWindowUsage?: {
            estimated?: boolean;
            modelContextWindow?: number | null;
            usedTokens?: number | null;
          };
        };
        const usage = data?.contextWindowUsage;
        if (usage && typeof usage.usedTokens === "number" && typeof usage.modelContextWindow === "number") {
          return {
            usedTokens: usage.usedTokens,
            modelContextWindow: usage.modelContextWindow || DEFAULT_CONTEXT_WINDOW,
            estimated: !!usage.estimated,
          };
        }
      }
    } catch {
      // fall through to estimate
    }

    try {
      // Fallback estimate: count real messages via the conversation outline
      // (each item is one user/assistant message).
      const outline = await bb.sdk.threads.conversationOutline({ threadId });
      const messageCount = outline.items?.length ?? 0;
      return {
        usedTokens: messageCount * TOKENS_PER_MESSAGE_ESTIMATE,
        modelContextWindow: DEFAULT_CONTEXT_WINDOW,
        estimated: true,
      };
    } catch {
      return null;
    }
  }

  // ── Agent tool: headroom_status ───────────────────────────────────

  bb.agents.registerTool({
    name: "headroom_status",
    description:
      "Check your context budget: how much of the model's context window is used, " +
      "estimated tokens remaining, and a recommendation (green/yellow/red). " +
      "Call this before starting a large batch of work or when you notice the " +
      "conversation getting long.",
    parameters: z.object({}),
    async execute(_args, { threadId }) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (!thread) return "headroom_status: thread not found";

        const providerName = (thread as any).providerId ?? "unknown";
        const modelName = (thread as any).model;

        const reading = await readContextUsage(threadId);
        if (!reading) return "headroom_status: could not read context usage for this thread.";

        const pct = Math.round((reading.usedTokens / reading.modelContextWindow) * 100);
        const remaining = reading.modelContextWindow - reading.usedTokens;

        let recommendation: string;
        if (pct >= critPct) {
          recommendation = "RED — critical: summarize immediately or start a fresh thread.";
        } else if (pct >= warnPct) {
          recommendation = "YELLOW — consider summarizing soon, or keep this batch short.";
        } else {
          recommendation = "GREEN — plenty of headroom, carry on.";
        }

        return [
          `headroom status for thread ${threadId}:`,
          `  Provider:       ${providerName}`,
          `  Model:          ${modelName ?? "default"}`,
          `  Context window: ${reading.modelContextWindow.toLocaleString()} tokens`,
          `  Used:           ${reading.usedTokens.toLocaleString()} tokens (${pct}%)${reading.estimated ? " (estimated from message count)" : ""}`,
          `  Est. remaining: ${remaining.toLocaleString()} tokens`,
          `  Recommendation: ${recommendation}`,
        ].join("\n");
      } catch (err: any) {
        return `headroom_status error: ${err.message ?? String(err)}`;
      }
    },
  });

  // ── Background monitor: log per-thread context usage ──────────────
  // Log-based only: watches thread activity and logs when a thread crosses
  // the warning threshold. It does not inject messages into threads.

  const lastWarned = new Map<string, number>();

  function checkThreshold(threadId: string) {
    readContextUsage(threadId).then((reading) => {
      if (!reading) return;
      const pct = Math.round((reading.usedTokens / reading.modelContextWindow) * 100);
      const last = lastWarned.get(threadId) ?? 0;
      if (pct >= critPct && last < critPct) {
        bb.log.info(
          `[headroom] thread ${threadId}: CRITICAL ${pct}% (~${reading.usedTokens.toLocaleString()} tokens)`,
        );
        lastWarned.set(threadId, pct);
      } else if (pct >= warnPct && last < warnPct) {
        bb.log.info(
          `[headroom] thread ${threadId}: WARNING ${pct}% (~${reading.usedTokens.toLocaleString()} tokens)`,
        );
        lastWarned.set(threadId, pct);
      }
    }).catch((err) => {
      bb.log.warn(`[headroom] monitor check failed for ${threadId}: ${err.message ?? err}`);
    });
  }

  bb.events.on("thread.created", ({ thread }) => {
    lastWarned.delete(thread.id);
  });

  bb.events.on("thread.active", ({ thread }) => {
    checkThreshold(thread.id);
  });

  bb.events.on("thread.idle", ({ thread }) => {
    checkThreshold(thread.id);
  });

  bb.events.on("thread.archived", ({ thread }) => {
    lastWarned.delete(thread.id);
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    lastWarned.delete(thread.id);
  });

  // ── Cleanup ──────────────────────────────────────────────────────

  bb.onDispose(() => {
    lastWarned.clear();
    bb.log.info("bb-plugin-headroom disposed");
  });
}
