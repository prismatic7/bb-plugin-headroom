// bb-plugin-headroom — context budget monitoring for BB coding agents.
//
// Registers `headroom_status` as a native agent tool that reports:
//   - context window size (model provider cap)
//   - estimated tokens used (message count × rough average)
//   - remaining headroom
//   - recommendation: green / yellow / red
//
// Also runs a background monitor that tracks per-thread message counts
// and logs when a thread crosses the warning threshold.
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── Model context caps (fallback defaults — bb.sdk.providers may override) ───

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

  const { warningThreshold, criticalThreshold } = await settings.get();
  const warnPct = parseInt(warningThreshold, 10) || 70;
  const critPct = parseInt(criticalThreshold, 10) || 85;

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

        // Count messages from event stream
        let messageCount = 0;
        try {
          const events = await bb.sdk.threads.events.list({ threadId, limit: "500" });
          messageCount = events.filter(
            (e: any) => e.role === "user" || e.role === "assistant",
          ).length;
        } catch {
          // Fallback: estimate from what we can get
          messageCount = (thread as any).eventCount ?? 0;
        }

        const estimatedTokens = messageCount * TOKENS_PER_MESSAGE_ESTIMATE;
        const providerName = (thread as any).provider ?? "unknown";
        const modelName = (thread as any).model;
        const contextCap = resolveContextCap(providerName, modelName);
        const pct = Math.round((estimatedTokens / contextCap) * 100);
        const remaining = contextCap - estimatedTokens;

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
          `  Context window: ${contextCap.toLocaleString()} tokens`,
          `  Messages:       ${messageCount}`,
          `  Est. used:      ${estimatedTokens.toLocaleString()} tokens (${pct}%)`,
          `  Est. remaining: ${remaining.toLocaleString()} tokens`,
          `  Recommendation: ${recommendation}`,
        ].join("\n");
      } catch (err: any) {
        return `headroom_status error: ${err.message ?? String(err)}`;
      }
    },
  });

  // ── Background monitor: watch thread event counts ──────────────────

  const threadCounts = new Map<string, { count: number; lastWarnedPct: number }>();

  bb.events.on("thread.created", ({ thread }) => {
    threadCounts.set(thread.id, { count: 0, lastWarnedPct: 0 });
  });

  bb.events.on("thread.active", ({ thread }) => {
    if (!threadCounts.has(thread.id)) {
      threadCounts.set(thread.id, { count: 0, lastWarnedPct: 0 });
    }
    const entry = threadCounts.get(thread.id)!;
    entry.count += 1;
    checkThreshold(thread.id, entry);
  });

  bb.events.on("thread.idle", ({ thread }) => {
    const entry = threadCounts.get(thread.id);
    if (entry) entry.count += 1;
    checkThreshold(thread.id, entry);
  });

  bb.events.on("thread.archived", ({ thread }) => {
    threadCounts.delete(thread.id);
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    threadCounts.delete(thread.id);
  });

  function checkThreshold(
    threadId: string,
    entry?: { count: number; lastWarnedPct: number },
  ) {
    const e = entry ?? threadCounts.get(threadId);
    if (!e) return;

    const estimatedTokens = e.count * TOKENS_PER_MESSAGE_ESTIMATE;
    const pct = Math.round((estimatedTokens / DEFAULT_CONTEXT_WINDOW) * 100);

    if (pct >= critPct && e.lastWarnedPct < critPct) {
      bb.log.info(
        `[headroom] thread ${threadId}: CRITICAL ${pct}% (~${estimatedTokens.toLocaleString()} tokens)`,
      );
      e.lastWarnedPct = pct;
    } else if (pct >= warnPct && e.lastWarnedPct < warnPct) {
      bb.log.info(
        `[headroom] thread ${threadId}: WARNING ${pct}% (~${estimatedTokens.toLocaleString()} tokens)`,
      );
      e.lastWarnedPct = pct;
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────

  bb.onDispose(() => {
    threadCounts.clear();
    bb.log.info("bb-plugin-headroom disposed");
  });
}
