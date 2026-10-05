/**
 * Provider lifecycle tests against Pi's real Models runtime: baseline models,
 * a forced network refresh, persistence, offline restore and TTL caching.
 *
 * Requires a Command Code API key (skips otherwise). This is the closest
 * possible test to what Pi itself does at startup and on /commandcode refresh.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, createModels } from "@earendil-works/pi-ai";
import { CATALOG } from "../src/catalog/models.generated.ts";
import { PROVIDER_ID } from "../src/endpoints.ts";
import { createCommandCodeProvider } from "../src/provider.ts";

function loadKey(): string | undefined {
	if (process.env.COMMANDCODE_API_KEY?.trim()) return process.env.COMMANDCODE_API_KEY.trim();
	if (process.env.CMD_API_KEY?.trim()) return process.env.CMD_API_KEY.trim();
	const legacy = join(homedir(), ".commandcode", "auth.json");
	if (existsSync(legacy)) {
		try {
			const key = JSON.parse(readFileSync(legacy, "utf8")).apiKey;
			if (typeof key === "string" && key.trim()) return key.trim();
		} catch {
			/* ignore */
		}
	}
	return undefined;
}

const API_KEY = loadKey();
const skip = API_KEY ? false : "no Command Code API key";

async function setup() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(PROVIDER_ID, async () => ({ type: "api_key" as const, key: API_KEY as string }));
	const store = new InMemoryModelsStore();
	const models = createModels({ credentials, modelsStore: store });
	models.setProvider(createCommandCodeProvider());
	return { models, store };
}

test("offline startup exposes the bundled catalog before any network", { skip }, async () => {
	const { models } = await setup();
	await models.refresh({ allowNetwork: false, providers: [PROVIDER_ID] });
	const bundled = models.getModels(PROVIDER_ID);
	assert.equal(bundled.length, CATALOG.length);
	assert.ok(bundled.every((model) => model.provider === PROVIDER_ID));
});

test("forced refresh fetches, merges and persists the live catalog", { skip }, async () => {
	const { models, store } = await setup();
	await models.refresh({ allowNetwork: false, providers: [PROVIDER_ID] });
	await models.refresh({ allowNetwork: true, force: true, providers: [PROVIDER_ID] });

	const live = models.getModels(PROVIDER_ID);
	assert.ok(live.length > 0);
	assert.ok(live.every((model) => typeof model.contextWindow === "number" && model.contextWindow > 0));

	const persisted = await store.read(PROVIDER_ID);
	assert.ok(persisted, "expected a persisted catalog entry");
	assert.ok(typeof persisted.checkedAt === "number");
	assert.ok(typeof persisted.etag === "string" && persisted.etag.length > 0);
	assert.equal(persisted.models.length, live.length);
	// The raw remote entry must survive persistence so re-merges stay possible.
	const raw = persisted.models.find((model) => model.id === live[0].id) as { cc?: { remote?: unknown } };
	assert.ok(raw?.cc?.remote, "expected cc.remote metadata on persisted models");
});

test("a fresh runtime restores the persisted catalog offline", { skip }, async () => {
	const first = await setup();
	await first.models.refresh({ allowNetwork: true, force: true, providers: [PROVIDER_ID] });
	const liveCount = first.models.getModels(PROVIDER_ID).length;

	const second = createModels({ credentials: new InMemoryCredentialStore(), modelsStore: first.store });
	second.setProvider(createCommandCodeProvider());
	await second.refresh({ allowNetwork: false, providers: [PROVIDER_ID] });
	assert.equal(second.getModels(PROVIDER_ID).length, liveCount);
});

test("TTL caching skips the network while the catalog is fresh", { skip }, async () => {
	const { models } = await setup();
	await models.refresh({ allowNetwork: true, force: true, providers: [PROVIDER_ID] });

	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
		calls += 1;
		return originalFetch(...args);
	}) as typeof fetch;
	try {
		await models.refresh({ allowNetwork: true, providers: [PROVIDER_ID] });
		assert.equal(calls, 0, "expected no network call within the TTL window");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
