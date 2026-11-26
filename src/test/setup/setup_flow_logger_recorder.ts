import type { SetupFlowLogger } from '#lib/setup/setup_flow_logger.ts';

/** One call a `RecordingSetupFlowLogger` got: the method and its message. */
export type SetupFlowLogEntry = [method: keyof SetupFlowLogger, msg: string];

/** A `SetupFlowLogger` that records each call, in order, instead of printing. */
export interface RecordingSetupFlowLogger extends SetupFlowLogger {
	entries: Array<SetupFlowLogEntry>;
}

/** @returns a logger that records each call in its `entries` */
export const create_recording_setup_flow_logger = (): RecordingSetupFlowLogger => {
	const entries: Array<SetupFlowLogEntry> = [];
	return {
		entries,
		ok: (msg) => void entries.push(['ok', msg]),
		skip: (msg) => void entries.push(['skip', msg]),
		error: (msg) => void entries.push(['error', msg]),
		print: (msg) => void entries.push(['print', msg]),
		print_error: (msg) => void entries.push(['print_error', msg])
	};
};

/**
 * The messages of one method's calls.
 *
 * @param log - the recorder
 * @param method - which calls
 * @returns their messages, in order
 */
export const messages_of = (
	log: RecordingSetupFlowLogger,
	method: keyof SetupFlowLogger
): Array<string> => log.entries.filter(([m]) => m === method).map(([, msg]) => msg);
