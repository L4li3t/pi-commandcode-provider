import assert from "node:assert/strict";
import test from "node:test";
import {
	catalogFingerprint,
	catalogToModels,
	mergeCatalog,
	mergeModel,
	shouldRefreshCatalog,
} from "../src/catalog/merge.ts";
import type { CatalogEntry, RemoteModel } from "../src/catalog/types.ts";

const remote = (overrides: Partial<RemoteModel> = {}): RemoteModel => ({
	id: "deepseek/deepseek-v4.1-flash",
	name: "DeepSeek V4.1 Flash",
	context_length: 1_000_000,
	supported_endpoints: ["/chat/completions", "/responses"],
	created: 1,
	...overrides,
});

test("bundled catalog metadata wins over family fallbacks", () => {
	const entry: CatalogEntry = {
		id: "deepseek/deepseek-v4.1-flash",
		cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		maxTokens: 384_000,
		input: ["text", "image"],
		reasoning: true,
		compat: { thinkingFormat: "deepseek" },
	};
	const model = mergeModel(remote(), entry);
	assert.equal(model.source, "catalog");
	assert.deepEqual(model.cost, entry.cost);
	assert.equal(model.maxTokens, 384_000);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(model.compat, { thinkingFormat: "deepseek" });
});

test("live catalog wins for id, name, context window and endpoints", () => {
	const entry: CatalogEntry = { id: "deepseek/deepseek-v4.1-flash", contextWindow: 123, name: "Old Name" };
	const model = mergeModel(remote({ name: "Fresh Name", context_length: 2_000_000 }), entry);
	assert.equal(model.name, "Fresh Name");
	assert.equal(model.contextWindow, 2_000_000);
	assert.deepEqual(model.endpoints, ["/chat/completions", "/responses"]);
});

test("family fallback keeps an unknown model usable", () => {
	const model = mergeModel(remote({ id: "brand-new/model-1", name: "Brand New", context_length: 50_000 }), undefined);
	assert.equal(model.source, "family");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.contextWindow, 50_000);
	assert.ok(model.maxTokens > 0);
});

test("Claude models route to the Anthropic protocol", () => {
	const model = mergeModel(remote({ id: "claude-opus-5", name: "Claude Opus 5", supported_endpoints: ["/messages"] }), undefined);
	assert.equal(model.api, "anthropic-messages");
});

test(":free models are zero-cost", () => {
	const entry: CatalogEntry = {
		id: "inclusionai/ling-3.1-flash:free",
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
	};
	const model = mergeModel(
		remote({ id: "inclusionai/ling-3.1-flash:free", supported_endpoints: ["/chat/completions"] }),
		entry,
	);
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("mergeCatalog skips malformed live entries", () => {
	const models = mergeCatalog(
		[remote(), remote({ id: "" }), undefined as unknown as RemoteModel],
		[],
	);
	assert.equal(models.length, 1);
});

test("catalogToModels builds an offline baseline with recorded endpoints", () => {
	const entries: CatalogEntry[] = [
		{
			id: "claude-opus-5",
			name: "Claude Opus 5",
			contextWindow: 1_000_000,
			endpoints: ["/messages"],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			reasoning: true,
			input: ["text", "image"],
		},
	];
	const models = catalogToModels(entries);
	assert.equal(models.length, 1);
	assert.equal(models[0].api, "anthropic-messages");
	assert.equal(models[0].contextWindow, 1_000_000);
});

test("catalogFingerprint is stable across ordering", () => {
	const a = catalogToModels([
		{ id: "b", endpoints: ["/chat/completions"] },
		{ id: "a", endpoints: ["/chat/completions"] },
	]);
	const b = catalogToModels([
		{ id: "a", endpoints: ["/chat/completions"] },
		{ id: "b", endpoints: ["/chat/completions"] },
	]);
	assert.equal(catalogFingerprint(a), catalogFingerprint(b));
});

test("shouldRefreshCatalog obeys TTL, force and credential rules", () => {
	const base = { checkedAt: 1_000, now: 2_000, ttlMs: 5_000, hasModels: true, hasCredential: true };
	assert.equal(shouldRefreshCatalog(base), false);
	assert.equal(shouldRefreshCatalog({ ...base, now: 7_000 }), true);
	assert.equal(shouldRefreshCatalog({ ...base, force: true }), true);
	assert.equal(shouldRefreshCatalog({ ...base, hasCredential: false, force: true }), false);
	assert.equal(shouldRefreshCatalog({ ...base, hasModels: false }), true);
});
