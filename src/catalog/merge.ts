/**
 * Merge the live Command Code model list with the bundled catalog and family
 * fallbacks. Precedence, highest first:
 *
 *   1. live /models        id, display name, context window, endpoints
 *   2. bundled catalog     cost, maxTokens, vision, reasoning, compat, thinking
 *   3. family heuristics   keeps brand-new models usable between syncs
 *
 * The merge is pure and dependency-free so it can be unit-tested directly.
 */

import { chooseEndpoint, apiForEndpoint } from "../endpoints.ts";
import { defaultsFor, familyOf } from "./family.ts";
import type { CatalogCost, CatalogEntry, MergedModel, RemoteModel } from "./types.ts";

const ZERO_COST: CatalogCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface MergeOptions {
	/** Treat ids containing ":free" (or flagged free in the catalog) as zero cost. */
	honorFreeTier?: boolean;
}

function isFreeModel(id: string, entry: CatalogEntry | undefined): boolean {
	if (/:free$/i.test(id)) return true;
	return entry?.cost !== undefined && entry.cost.input === 0 && entry.cost.output === 0;
}

/**
 * Resolve one live model against the bundled catalog and family defaults.
 */
export function mergeModel(
	remote: RemoteModel,
	entry: CatalogEntry | undefined,
	options: MergeOptions = {},
): MergedModel {
	const honorFree = options.honorFreeTier ?? true;
	const endpoint = chooseEndpoint(remote.supported_endpoints ?? entry?.endpoints, remote.id);
	const api = entry?.api ?? apiForEndpoint(endpoint);
	const family = familyOf(remote.id);
	const fallback = defaultsFor(family, api);

	const input = entry?.input ?? fallback.input;
	const reasoning = entry?.reasoning ?? fallback.reasoning;
	const contextWindow = remote.context_length ?? entry?.contextWindow ?? 0;
	const maxTokens = entry?.maxTokens ?? fallback.maxTokens;

	// Hide reasoning metadata for models the catalog says are not reasoning.
	const thinkingLevelMap = reasoning ? (entry?.thinkingLevelMap ?? fallback.thinkingLevelMap) : undefined;

	let cost = entry?.cost ?? fallback.cost ?? ZERO_COST;
	if (honorFree && isFreeModel(remote.id, entry)) cost = ZERO_COST;

	return {
		id: remote.id,
		name: remote.name ?? entry?.name ?? remote.id,
		api,
		contextWindow,
		maxTokens: contextWindow > 0 ? Math.min(maxTokens, contextWindow) : maxTokens,
		input,
		reasoning,
		thinkingLevelMap,
		promptCache: entry?.promptCache ?? fallback.promptCache,
		cost,
		compat: entry?.compat ?? fallback.compat,
		endpoints: remote.supported_endpoints ?? [],
		created: remote.created,
		hidden: entry?.hidden,
		remote,
		source: entry ? "catalog" : "family",
	};
}

/** Merge a whole live catalog. */
export function mergeCatalog(
	remoteModels: readonly RemoteModel[],
	entries: readonly CatalogEntry[],
	options: MergeOptions = {},
): MergedModel[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return remoteModels
		.filter((model) => typeof model?.id === "string" && model.id.length > 0)
		.map((model) => mergeModel(model, byId.get(model.id), options));
}

/**
 * Baseline catalog used before (or without) any network refresh: the bundled
 * snapshot with its recorded context windows and endpoints.
 */
export function catalogToModels(entries: readonly CatalogEntry[]): MergedModel[] {
	return entries.map((entry) => {
		const family = familyOf(entry.id);
		const api = entry.api ?? apiForEndpoint(chooseEndpoint(entry.endpoints, entry.id));
		const fallback = defaultsFor(family, api);
		const contextWindow = entry.contextWindow ?? 0;
		const maxTokens = entry.maxTokens ?? fallback.maxTokens;
		return {
			id: entry.id,
			name: entry.name ?? entry.id,
			api,
			contextWindow,
			maxTokens: contextWindow > 0 ? Math.min(maxTokens, contextWindow) : maxTokens,
			input: entry.input ?? fallback.input,
			reasoning: entry.reasoning ?? fallback.reasoning,
			thinkingLevelMap: entry.reasoning === false ? undefined : (entry.thinkingLevelMap ?? fallback.thinkingLevelMap),
			promptCache: entry.promptCache ?? fallback.promptCache,
			cost: entry.cost ?? fallback.cost ?? ZERO_COST,
			compat: entry.compat ?? fallback.compat,
			endpoints: entry.endpoints ?? [],
			hidden: entry.hidden,
			source: "catalog" as const,
		};
	});
}

/** Stable, order-independent fingerprint used to detect catalog changes. */
export function catalogFingerprint(models: readonly MergedModel[]): string {
	const ids = models
		.map((model) => `${model.id}:${model.api}`)
		.sort()
		.join("|");
	let hash = 0;
	for (let index = 0; index < ids.length; index += 1) {
		hash = (hash * 31 + ids.charCodeAt(index)) >>> 0;
	}
	return `${models.length}-${hash.toString(16)}`;
}

export function shouldRefreshCatalog(input: {
	checkedAt: number;
	now: number;
	ttlMs: number;
	force?: boolean;
	hasModels: boolean;
	hasCredential: boolean;
}): boolean {
	if (!input.hasCredential) return false;
	if (input.force) return true;
	if (!input.hasModels) return true;
	return input.now - input.checkedAt >= input.ttlMs;
}
