/**
 * Endpoint + environment constants for the Command Code Provider API.
 *
 * Command Code exposes three wire protocols behind one base URL:
 *   POST {baseUrl}/chat/completions   OpenAI Chat Completions
 *   POST {baseUrl}/responses          OpenAI Responses
 *   POST {baseUrl}/messages           Anthropic Messages
 *   GET  {baseUrl}/models             model list
 *   POST {baseUrl}/systemone          TypeSafe System One decisions
 *
 * Claude models are served on /messages only; other models live on
 * /chat/completions, most of them on /responses as well. The live /models
 * response carries a `supported_endpoints` array per model and that array is
 * the source of truth for routing.
 */

import type { ChatApiId, Endpoint } from "./catalog/types.ts";

export const PROVIDER_ID = "commandcode";
export const PROVIDER_NAME = "Command Code";
export const DEFAULT_BASE_URL = "https://api.commandcode.ai/provider/v1";

/** Primary env var, matching the Command Code CLI convention. */
export const ENV_API_KEY = "COMMANDCODE_API_KEY";
/** Accepted alias used by some Command Code tooling. */
export const ENV_API_KEY_ALT = "CMD_API_KEY";
/** Zero-data-retention opt-in, same switch the CLI uses. */
export const ENV_ZDR = "CMD_ZDR";
/** Overrides the catalog TTL in milliseconds (mostly for development). */
export const ENV_CATALOG_TTL = "PI_COMMANDCODE_TTL_MS";

export const ZDR_HEADER = "x-cmd-zdr";
/** Default catalog freshness window: 6 hours. */
export const DEFAULT_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

const API_BY_ENDPOINT: Record<Endpoint, ChatApiId> = {
	"/chat/completions": "openai-completions",
	"/responses": "openai-responses",
	"/messages": "anthropic-messages",
};

export function apiForEndpoint(endpoint: Endpoint): ChatApiId {
	return API_BY_ENDPOINT[endpoint];
}

export function endpointForApi(api: ChatApiId): Endpoint {
	if (api === "anthropic-messages") return "/messages";
	if (api === "openai-responses") return "/responses";
	return "/chat/completions";
}

/**
 * Base URL a model must carry for its wire protocol.
 *
 * The OpenAI SDKs append `/chat/completions` and `/responses` to the base URL,
 * so the Provider API root (`.../provider/v1`) is correct for them. The
 * Anthropic SDK appends `/v1/messages` instead, so Claude models need the
 * parent path (`.../provider`) to reach `.../provider/v1/messages`.
 */
export function baseUrlForApi(baseUrl: string, api: ChatApiId): string {
	const trimmed = baseUrl.replace(/\/+$/u, "");
	if (api !== "anthropic-messages") return trimmed;
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

/** GPT-family models behave best on the Responses API when both are offered. */
export function preferResponses(modelId: string): boolean {
	return /^(openai\/|gpt-|o[0-9]|codex)/i.test(modelId);
}

/**
 * Pick the wire protocol for a model from its live `supported_endpoints`.
 * Falls back to name-based heuristics when the list is missing or empty.
 */
export function chooseEndpoint(supported: readonly string[] | undefined, modelId: string): Endpoint {
	const endpoints = new Set((supported ?? []).map((entry) => entry.trim()).filter(Boolean));
	const hasMessages = endpoints.has("/messages");
	const hasChat = endpoints.has("/chat/completions");
	const hasResponses = endpoints.has("/responses");

	if (hasMessages) return "/messages";
	if (hasChat && !hasResponses) return "/chat/completions";
	if (hasResponses && !hasChat) return "/responses";
	if (hasChat && hasResponses) {
		return preferResponses(modelId) ? "/responses" : "/chat/completions";
	}

	// No usable metadata: infer from the model id.
	if (/^claude/i.test(modelId)) return "/messages";
	if (preferResponses(modelId)) return "/responses";
	return "/chat/completions";
}

export function chooseApi(supported: readonly string[] | undefined, modelId: string): ChatApiId {
	return apiForEndpoint(chooseEndpoint(supported, modelId));
}

/** `CMD_ZDR=1` (or `true`) enables the zero-data-retention header. */
export function isZdrEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[ENV_ZDR];
	return value === "1" || value?.toLowerCase() === "true";
}

export function catalogTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number(env[ENV_CATALOG_TTL]);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CATALOG_TTL_MS;
}
