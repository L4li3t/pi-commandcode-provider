/**
 * Classifier support: Command Code serves TypeSafe's `typesafe/jev` decision
 * model on POST {baseUrl}/systemone, which is the same System One protocol Pi
 * already implements for the `typesafe` provider.
 *
 * The built-in classifier implementation lives behind the `./api/*` subpath
 * export rather than `/compat`, so it is loaded lazily: a failure to load (for
 * example on an older Pi) degrades to an error ClassifierResult instead of
 * breaking extension startup.
 */

import type {
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
} from "@earendil-works/pi-ai";

export async function classifyCommandCode(
	model: ClassifierModel<string>,
	context: ClassifierContext,
	options?: ClassifierOptions,
): Promise<ClassifierResult> {
	try {
		const module = await import("@earendil-works/pi-ai/api/typesafe-system-one.lazy");
		return await module.typesafeSystemOneApi().classify(model as ClassifierModel<string>, context, options);
	} catch (error) {
		return {
			api: model.api,
			provider: model.provider,
			model: model.id,
			answers: {},
			stopReason: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		};
	}
}
