/**
 * Command Code provider assembly.
 *
 * Offline-first: the bundled catalog exposes models immediately. When a
 * credential is available and the catalog is stale, a live /models fetch
 * replaces the list, merges the bundled metadata, and persists the merged
 * catalog through Pi's model store so the next startup is instant.
 *
 * Model lists are gated on the provider having usable auth by Pi itself; this
 * provider only owns routing, metadata, refresh and caching.
 */

import type {
	AnyModel,
	Api,
	ClassifierModel,
	Credential,
	Model,
	Provider,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { commandCodeAuth, readLegacyCliKey } from "./auth.ts";
import { classifyCommandCode } from "./classify.ts";
import { CATALOG, CATALOG_GENERATED_AT } from "./catalog/models.generated.ts";
import { catalogFingerprint, catalogToModels, mergeCatalog, mergeModel, shouldRefreshCatalog } from "./catalog/merge.ts";
import type { CatalogEntry, ChatApiId, MergedModel, RemoteModel } from "./catalog/types.ts";
import {
	DEFAULT_BASE_URL,
	ENV_API_KEY,
	ENV_API_KEY_ALT,
	PROVIDER_ID,
	PROVIDER_NAME,
	baseUrlForApi,
	catalogTtlMs,
} from "./endpoints.ts";
import { fetchCatalog } from "./remote.ts";
import { streamCommandCode, streamSimpleCommandCode } from "./stream.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Custom field carried on persisted models so they can be re-merged later. */
interface PersistedModel extends Model<Api> {
	cc?: {
		remote?: RemoteModel;
	};
}

const CLASSIFIER_MODEL: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "typesafe/jev",
	name: "JEV (Command Code System One)",
	api: "typesafe-system-one",
	provider: PROVIDER_ID,
	baseUrl: DEFAULT_BASE_URL,
	contextWindow: 1_000_000,
	cost: { ...ZERO_COST },
	input: ["text"],
};

function credentialKey(credential: Credential | undefined): string | undefined {
	if (credential && credential.type === "api_key" && credential.key) return credential.key;
	return undefined;
}

function resolveCatalogKey(credential: Credential | undefined): string | undefined {
	return (
		credentialKey(credential) ??
		process.env[ENV_API_KEY] ??
		process.env[ENV_API_KEY_ALT] ??
		readLegacyCliKey()
	);
}

export function createCommandCodeProvider(options: { baseUrl?: string } = {}): Provider {
	const baseUrl = options.baseUrl ?? process.env.COMMANDCODE_BASE_URL ?? DEFAULT_BASE_URL;
	const snapshot: CatalogEntry[] = CATALOG;
	const snapshotById = new Map(snapshot.map((entry) => [entry.id, entry]));
	const baseline = catalogToModels(snapshot);

	let dynamic: MergedModel[] = [];
	let checkedAt = 0;
	let fingerprint = "";

	const activeModels = () => (dynamic.length > 0 ? dynamic : baseline);

	function toModel(merged: MergedModel): PersistedModel {
		return {
			id: merged.id,
			name: merged.name,
			api: merged.api,
			provider: PROVIDER_ID,
			baseUrl: baseUrlForApi(baseUrl, merged.api),
			input: merged.input,
			cost: merged.cost,
			contextWindow: merged.contextWindow,
			maxTokens: merged.maxTokens,
			reasoning: merged.reasoning,
			...(merged.thinkingLevelMap ? { thinkingLevelMap: merged.thinkingLevelMap } : {}),
			...(merged.promptCache ? { promptCache: merged.promptCache } : {}),
			...(merged.compat ? { compat: merged.compat } : {}),
			cc: { remote: merged.remote },
		} as PersistedModel;
	}

	/** Rebuild a MergedModel from persisted data, preferring a fresh re-merge. */
	function restoreModel(raw: unknown): MergedModel | undefined {
		if (!raw || typeof raw !== "object") return undefined;
		const model = raw as PersistedModel;
		if (typeof model.id !== "string" || model.id.length === 0) return undefined;
		if ((model as { type?: string }).type === "classifier") return undefined;

		const remote = model.cc?.remote;
		if (remote && typeof remote.id === "string") {
			return mergeModel(remote, snapshotById.get(remote.id));
		}

		// No raw remote attached (older persistence): trust the stored fields.
		return {
			id: model.id,
			name: model.name ?? model.id,
			api: (model.api as ChatApiId) ?? "openai-completions",
			contextWindow: model.contextWindow ?? 0,
			maxTokens: model.maxTokens ?? 0,
			input: model.input ?? ["text"],
			reasoning: Boolean(model.reasoning),
			thinkingLevelMap: model.thinkingLevelMap as MergedModel["thinkingLevelMap"],
			promptCache: model.promptCache,
			cost: model.cost ?? { ...ZERO_COST },
			compat: model.compat as Record<string, unknown> | undefined,
			endpoints: [],
			source: "catalog",
		};
	}

	return {
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl,
		auth: { apiKey: commandCodeAuth() },

		getModels: () => activeModels().filter((model) => !model.hidden).map(toModel),

		getAllModels: (): readonly AnyModel[] => [
			...activeModels().filter((model) => !model.hidden).map(toModel),
			CLASSIFIER_MODEL,
		],

		async refreshModels(context: RefreshModelsContext): Promise<void> {
			// Phase 1: restore the persisted catalog (no network, no credential).
			const stored = context.stored;
			if (stored?.models?.length) {
				const restored = stored.models
					.map(restoreModel)
					.filter((model): model is MergedModel => model !== undefined);
				if (restored.length > 0) {
					await context.publish({
						update: () => {
							dynamic = restored;
						},
					});
					checkedAt = stored.checkedAt ?? 0;
					fingerprint = stored.etag ?? catalogFingerprint(restored);
				}
			}

			if (!context.allowNetwork || context.signal.aborted) return;

			const apiKey = resolveCatalogKey(context.credential);
			if (!apiKey) return;

			const fresh = !shouldRefreshCatalog({
				checkedAt,
				now: Date.now(),
				ttlMs: catalogTtlMs(),
				force: context.force,
				hasModels: dynamic.length > 0,
				hasCredential: true,
			});
			if (fresh) return;

			const remote = await fetchCatalog({ baseUrl, apiKey, signal: context.signal });
			if (context.signal.aborted) return;

			const merged = mergeCatalog(remote.models, snapshot);
			const nextFingerprint = catalogFingerprint(merged);
			const changed = nextFingerprint !== fingerprint || dynamic.length === 0;

			await context.publish({
				persist: {
					models: merged.map(toModel),
					checkedAt: Date.now(),
					etag: nextFingerprint,
				},
				update: changed
					? () => {
							dynamic = merged;
						}
					: undefined,
			});

			checkedAt = Date.now();
			fingerprint = nextFingerprint;
			if (changed) dynamic = merged;
		},

		stream: streamCommandCode,
		streamSimple: streamSimpleCommandCode,
		classify: classifyCommandCode as Provider["classify"],
	};
}

export { CATALOG_GENERATED_AT };
