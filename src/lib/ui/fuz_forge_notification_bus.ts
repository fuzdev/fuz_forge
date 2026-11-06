/**
 * Typed subscribe/dispatch bus for backend-initiated notifications.
 * Static `receive` handlers in `ui/fuz_forge_action_handlers.ts` call `dispatch`;
 * components subscribe via `on` (returns unsubscribe).
 *
 * @module
 */

import type { ActionSpecs, ActionInputs } from '../action_collections.ts';

/** Methods whose specs are backend-initiated `remote_notification`s. */
export type FuzForgeNotificationMethod = {
	[K in keyof ActionSpecs]: ActionSpecs[K]['kind'] extends 'remote_notification'
		? ActionSpecs[K]['initiator'] extends 'backend'
			? K
			: never
		: never;
}[keyof ActionSpecs];

export type FuzForgeNotificationHandler<M extends FuzForgeNotificationMethod> = (
	input: ActionInputs[M]
) => void;

/** Fan-out callback. Errors from individual subscribers are logged and swallowed. */
export type FuzForgeNotificationDispatch = <M extends FuzForgeNotificationMethod>(
	method: M,
	input: ActionInputs[M]
) => void;

export interface FuzForgeNotificationBus {
	/** Subscribe a handler. Returns an unsubscribe. */
	on: <M extends FuzForgeNotificationMethod>(
		method: M,
		handler: FuzForgeNotificationHandler<M>
	) => () => void;
	/** Fan out to every subscriber for `method`. */
	dispatch: FuzForgeNotificationDispatch;
}

export const create_fuz_forge_notification_bus = (): FuzForgeNotificationBus => {
	const handlers: Map<string, Set<(input: unknown) => void>> = new Map();

	const dispatch: FuzForgeNotificationDispatch = (method, input) => {
		const set = handlers.get(method);
		if (!set || set.size === 0) return;
		for (const handler of set) {
			try {
				handler(input);
			} catch (error) {
				console.error(`[fuz_forge_notification_bus] handler for ${method} threw:`, error);
			}
		}
	};

	const on = <M extends FuzForgeNotificationMethod>(
		method: M,
		handler: FuzForgeNotificationHandler<M>
	): (() => void) => {
		let set = handlers.get(method);
		if (!set) {
			set = new Set();
			handlers.set(method, set);
		}
		const untyped = handler as (input: unknown) => void;
		set.add(untyped);
		return () => {
			set.delete(untyped);
		};
	};

	return { on, dispatch };
};
