/**
 * Authentication for the Command Code Provider API.
 *
 * Resolution order (handled by Pi's Models layer plus this module):
 *   1. credential stored through /login (auth.json)
 *   2. COMMANDCODE_API_KEY, then CMD_API_KEY
 *   3. the Command Code CLI's own ~/.commandcode/auth.json (migration aid)
 *
 * The interactive login validates the key against GET /models so a typo is
 * caught immediately instead of surfacing as a stream error later.
 */

import { envApiKeyAuth, type ApiKeyAuth, type ApiKeyCredential } from "@earendil-works/pi-ai";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE_URL, ENV_API_KEY, ENV_API_KEY_ALT, PROVIDER_NAME } from "./endpoints.ts";
import { CatalogHttpError, fetchCatalog } from "./remote.ts";

const LEGACY_CLI_AUTH = join(homedir(), ".commandcode", "auth.json");

interface LegacyCache {
	mtimeMs: number;
	key: string | undefined;
}

let legacyCache: LegacyCache | undefined;

/** Read the API key from the Command Code CLI's auth file, cached by mtime. */
export function readLegacyCliKey(): string | undefined {
	try {
		const stats = statSync(LEGACY_CLI_AUTH);
		if (legacyCache && legacyCache.mtimeMs === stats.mtimeMs) return legacyCache.key;
		const parsed = JSON.parse(readFileSync(LEGACY_CLI_AUTH, "utf8")) as { apiKey?: unknown };
		const key =
			typeof parsed.apiKey === "string" && parsed.apiKey.trim().length > 0 ? parsed.apiKey.trim() : undefined;
		legacyCache = { mtimeMs: stats.mtimeMs, key };
		return key;
	} catch {
		return undefined;
	}
}

async function validateKey(key: string, signal: AbortSignal): Promise<void> {
	try {
		await fetchCatalog({ baseUrl: DEFAULT_BASE_URL, apiKey: key, signal });
	} catch (error) {
		if (error instanceof CatalogHttpError && error.status === 401) {
			throw new Error(`Command Code rejected that API key (401). Create one under Studio -> API keys.`);
		}
		if (error instanceof CatalogHttpError && error.status === 403) {
			throw new Error(
				`That key cannot use the Provider API (403${error.providerCode ? ` ${error.providerCode}` : ""}). ` +
					`Every Command Code plan except Go has API access; upgrade in Studio and run /login again.`,
			);
		}
		// Network hiccups and 5xx should not block storing a probably-fine key.
	}
}

export function commandCodeAuth(): ApiKeyAuth {
	const base = envApiKeyAuth(`${PROVIDER_NAME} API key`, [ENV_API_KEY, ENV_API_KEY_ALT]);
	return {
		...base,
		login: async (interaction): Promise<ApiKeyCredential> => {
			interaction.signal.throwIfAborted();
			const key = (
				await interaction.prompt({
					type: "secret",
					message: "Paste your Command Code API key (Studio -> API keys)",
					placeholder: "user_...",
				})
			).trim();
			if (!key) throw new Error("No API key provided.");
			await validateKey(key, interaction.signal);
			return { type: "api_key", key };
		},
		resolve: async (input) => {
			const resolved = await base.resolve?.(input);
			if (resolved) return resolved;
			const legacy = readLegacyCliKey();
			if (legacy) return { auth: { apiKey: legacy }, source: "~/.commandcode/auth.json" };
			return undefined;
		},
	};
}
