/**
 * The output sink of the setup flows and the dev-DB status.
 *
 * fuz_app's `SetupLogger` carries the bracketed status lines its setup
 * helpers print; the flows also print plain lines (headings, blank lines,
 * next steps, the status report), so their sink adds those to it. One sink
 * takes both, so the flows' output keeps its order wherever it goes.
 *
 * @module
 */

import { default_setup_logger, type SetupLogger } from '@fuzdev/fuz_app/dev/setup.ts';

/** fuz_app's `SetupLogger` plus the flows' unprefixed lines. */
export interface SetupFlowLogger extends SetupLogger {
	/** Prints `msg` as it is to stdout; `''` prints a blank line. */
	print: (msg: string) => void;
	/** Prints `msg` as it is to stderr, unlike `error`'s bracketed status line. */
	print_error: (msg: string) => void;
}

/** The console sink the tasks pass: fuz_app's bracket-format logger and plain `console` lines. */
export const console_setup_flow_logger: SetupFlowLogger = {
	...default_setup_logger,
	print: (msg) => console.log(msg),
	print_error: (msg) => console.error(msg)
};
