/**
 * Fetching the live Command Code model catalog (GET {baseUrl}/models).
 *
 * The endpoint does not send ETag or Last-Modified headers, so freshness is
 * handled by the caller's TTL and a content fingerprint. The payload is small
 * (~85 entries), which keeps unconditional refreshs cheap.
 */

import type { RemoteModel } from "./catalog/types.ts";

export class CatalogHttpError extends Error {
	readonly status: number;
	readonly providerCode: string | undefined;
	readonly providerType: string | undefined;

	constructor(message: string, status: number, providerCode?: string, providerType?: string) {
		super(message);
		this.name = "CatalogHttpError";
		this.status = status;
		this.providerCode = providerCode;
		this.providerType = providerType;
	}
}

export interface RemoteCatalog {
	models: RemoteModel[];
	/** Highest `created` timestamp in the list, useful as a coarse change signal. */
	created?: number;
}

interface ErrorEnvelope {
	error?: {
		message?: unknown;
		code?: unknown;
		type?: unknown;
	};
}

function parseError(status: number, body: string): CatalogHttpError {
	let message = `Command Code /models failed with HTTP ${status}`;
	let code: string | undefined;
	let type: string | undefined;
	try {
		const parsed = JSON.parse(body) as ErrorEnvelope;
		const error = parsed.error;
		if (typeof error?.message === "string" && error.message) message = error.message;
		if (typeof error?.code === "string") code = error.code;
		if (typeof error?.type === "string") type = error.type;
	} catch {
		if (body.trim()) message = `${message}: ${body.slice(0, 160)}`;
	}
	return new CatalogHttpError(message, status, code, type);
}

export async function fetchCatalog(input: {
	baseUrl: string;
	apiKey: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<RemoteCatalog> {
	const url = `${input.baseUrl.replace(/\/+$/u, "")}/models`;
	const timeout = AbortSignal.timeout(input.timeoutMs ?? 30_000);
	const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${input.apiKey}`,
				Accept: "application/json",
				"User-Agent": "pi-commandcode-provider",
			},
			signal,
		});
	} catch (error) {
		if (signal.aborted && !input.signal?.aborted) {
			throw new Error("Command Code /models timed out");
		}
		throw error;
	}

	if (!response.ok) {
		throw parseError(response.status, await response.text().catch(() => ""));
	}

	const body = (await response.json()) as { data?: unknown } | unknown;
	const list = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : undefined;
	if (!list) throw new Error("Command Code /models returned an unexpected payload");

	const models: RemoteModel[] = [];
	let created: number | undefined;
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const model = raw as RemoteModel;
		if (typeof model.id !== "string" || model.id.length === 0) continue;
		models.push(model);
		if (typeof model.created === "number" && (created === undefined || model.created > created)) {
			created = model.created;
		}
	}

	return { models, created };
}
