/**
 * Family heuristics: the fallback metadata used when neither the bundled
 * catalog nor an upstream catalog match has facts for a model.
 *
 * These are deliberately conservative. Anything important (cost, exact
 * context window, vision, reasoning, compat quirks) normally comes from the
 * generated catalog; this layer only keeps brand-new models usable between
 * snapshot updates.
 */

import type { CatalogCost, ChatApiId, CatalogThinkingLevelMap, CatalogPromptCache } from "./types.ts";

export type Family =
	| "anthropic"
	| "openai"
	| "google"
	| "deepseek"
	| "zai"
	| "moonshot"
	| "qwen"
	| "minimax"
	| "xiaomi"
	| "xai"
	| "meta"
	| "nvidia"
	| "stepfun"
	| "tencent"
	| "poolside"
	| "inclusionai"
	| "thinkingmachines"
	| "sakana"
	| "meituan"
	| "stealth"
	| "unknown";

export function familyOf(modelId: string): Family {
	const id = modelId.toLowerCase();
	if (id.startsWith("claude")) return "anthropic";
	if (/^(openai\/|gpt-|o[0-9]|codex)/.test(id)) return "openai";
	if (id.startsWith("google/") || id.startsWith("gemini")) return "google";
	if (id.includes("deepseek")) return "deepseek";
	if (id.startsWith("z-ai/") || id.startsWith("zai-org/") || id.includes("glm")) return "zai";
	if (id.includes("kimi") || id.startsWith("moonshot")) return "moonshot";
	if (id.startsWith("qwen/") || id.includes("qwen")) return "qwen";
	if (id.includes("minimax")) return "minimax";
	if (id.startsWith("xiaomi/") || id.includes("mimo")) return "xiaomi";
	if (id.startsWith("xai/") || id.includes("grok")) return "xai";
	if (id.startsWith("meta/") || id.includes("muse-spark") || id.includes("llama")) return "meta";
	if (id.startsWith("nvidia/") || id.includes("nemotron")) return "nvidia";
	if (id.startsWith("stepfun/")) return "stepfun";
	if (id.startsWith("tencent/")) return "tencent";
	if (id.startsWith("poolside/")) return "poolside";
	if (id.startsWith("inclusionai/")) return "inclusionai";
	if (id.startsWith("thinkingmachines/")) return "thinkingmachines";
	if (id.startsWith("sakana/")) return "sakana";
	if (id.startsWith("meituan/")) return "meituan";
	if (id.startsWith("stealth/")) return "stealth";
	return "unknown";
}

/** Reasoning families accept `reasoning_effort` on this gateway. */
const REASONING_FAMILIES: ReadonlySet<Family> = new Set([
	"anthropic",
	"openai",
	"google",
	"deepseek",
	"zai",
	"moonshot",
	"qwen",
	"minimax",
	"xai",
	"meta",
	"nvidia",
	"stepfun",
	"tencent",
	"inclusionai",
	"thinkingmachines",
	"sakana",
	"meituan",
	"stealth",
]);

/** Generic reasoning-effort ladder for OpenAI-compatible reasoning models. */
const EFFORT_MAP: CatalogThinkingLevelMap = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "xhigh",
};

const OFF_UNSUPPORTED: CatalogThinkingLevelMap = { off: null };

const ANTHROPIC_MAP: CatalogThinkingLevelMap = { off: null, xhigh: "xhigh", max: "max" };

const IMAGE_FAMILIES: ReadonlySet<Family> = new Set([
	"anthropic",
	"openai",
	"google",
	"qwen",
	"minimax",
	"xai",
	"meta",
	"deepseek",
]);

export interface FamilyDefaults {
	reasoning: boolean;
	maxTokens: number;
	input: Array<"text" | "image">;
	thinkingLevelMap?: CatalogThinkingLevelMap;
	promptCache?: CatalogPromptCache;
	compat?: Record<string, unknown>;
	cost?: CatalogCost;
}

export function defaultsFor(family: Family, api: ChatApiId): FamilyDefaults {
	const reasoning = REASONING_FAMILIES.has(family);
	const base: FamilyDefaults = {
		reasoning,
		maxTokens: 32000,
		input: IMAGE_FAMILIES.has(family) ? ["text", "image"] : ["text"],
	};

	if (family === "anthropic") {
		return {
			...base,
			maxTokens: 64000,
			thinkingLevelMap: ANTHROPIC_MAP,
			promptCache: api === "anthropic-messages" ? { short: 300, long: 3600 } : undefined,
		};
	}

	if (family === "openai") {
		return { ...base, maxTokens: 128000, thinkingLevelMap: EFFORT_MAP };
	}

	if (family === "google") {
		return { ...base, maxTokens: 65536, thinkingLevelMap: EFFORT_MAP };
	}

	if (family === "deepseek") {
		return {
			...base,
			maxTokens: 64000,
			thinkingLevelMap: { ...OFF_UNSUPPORTED, minimal: null, low: "low", medium: null, high: "high", max: "max" },
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
				requiresReasoningContentOnAssistantMessages: true,
				thinkingFormat: "deepseek",
				supportsStrictMode: true,
			},
		};
	}

	if (family === "zai") {
		return {
			...base,
			input: ["text"],
			maxTokens: 65536,
			thinkingLevelMap: { ...OFF_UNSUPPORTED, minimal: null, medium: null, xhigh: null },
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "zai",
			},
		};
	}

	if (family === "moonshot") {
		return {
			...base,
			maxTokens: 65536,
			thinkingLevelMap: { ...OFF_UNSUPPORTED },
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "deepseek",
			},
		};
	}

	// Remaining reasoning families use reasoning_effort with the generic ladder.
	if (reasoning) {
		return {
			...base,
			thinkingLevelMap: EFFORT_MAP,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			},
		};
	}

	// Non-reasoning families: never send reasoning fields.
	return {
		...base,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		},
	};
}
