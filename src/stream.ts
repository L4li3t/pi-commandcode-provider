/**
 * Wire-protocol dispatch.
 *
 * Command Code fronts three protocols behind one base URL. This module routes
 * each model to Pi's built-in API implementation for its `model.api`, so
 * message conversion, tool handling, usage accounting, cancellation and the
 * request-inspection hooks all behave exactly like a built-in provider.
 *
 * It also injects the zero-data-retention header when CMD_ZDR=1, matching the
 * Command Code CLI's CMD_ZDR opt-in.
 */

import {
	anthropicMessagesApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type {
	Api,
	AssistantMessageEventStream,
	Model,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { ZDR_HEADER, isZdrEnabled } from "./endpoints.ts";

type ChatApiId = "openai-completions" | "openai-responses" | "anthropic-messages";

let implementations: Record<ChatApiId, ProviderStreams> | undefined;

function implementationsByApi(): Record<ChatApiId, ProviderStreams> {
	implementations ??= {
		"openai-completions": openAICompletionsApi(),
		"openai-responses": openAIResponsesApi(),
		"anthropic-messages": anthropicMessagesApi(),
	};
	return implementations;
}

function implementationFor(model: Model<Api>): ProviderStreams {
	const impl = implementationsByApi()[model.api as ChatApiId];
	if (!impl) throw new Error(`Command Code provider has no implementation for API "${model.api}"`);
	return impl;
}

function applyZdr<T extends StreamOptions>(options: T | undefined): T | undefined {
	if (!isZdrEnabled()) return options;
	const next: StreamOptions = { ...(options ?? {}) };
	next.headers = { ...(next.headers ?? {}), [ZDR_HEADER]: "1" };
	return next as T;
}

export function streamCommandCode(
	model: Model<Api>,
	context: TranscriptContext,
	options?: StreamOptions,
): AssistantMessageEventStream {
	return implementationFor(model).stream(model, context, applyZdr(options));
}

export function streamSimpleCommandCode(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return implementationFor(model).streamSimple(model, context, applyZdr(options));
}
