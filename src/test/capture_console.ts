/**
 * Replaces `console.log` and `console.error` for a flow's progress output,
 * collecting what each received until restored.
 *
 * @returns the collected lines and the restore function
 */
export const capture_console = (): {
	logs: Array<string>;
	errors: Array<string>;
	restore: () => void;
} => {
	const saved = { log: console.log, error: console.error };
	const logs: Array<string> = [];
	const errors: Array<string> = [];
	console.log = (...args: Array<unknown>) => void logs.push(args.join(' '));
	console.error = (...args: Array<unknown>) => void errors.push(args.join(' '));
	return { logs, errors, restore: () => Object.assign(console, saved) };
};
