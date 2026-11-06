/**
 * Shared record framers for the `server/git/parse` suites.
 *
 * `git log` with our format emits each record terminated by `%x1e` (RS), with
 * `%x00` (NUL) between the fields inside one. The framers below build that
 * shape by hand, so a parser change that moves either separator fails against
 * bytes the tests own rather than against a captured stream.
 *
 * @module
 */

/** Record separator — what `%x1e` writes at the end of every record. */
export const RS = '\x1e';

/** Field separator — the `%x00` between fields inside one record. */
export const FS = '\x00';

/** UTF-8 bytes of a hand-built stream, the shape every parser takes. */
export const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Build one record the way real `git log --format=<fmt>%x1e` writes it.
 * `--format=` is a *tformat*, so git appends an LF after every record's RS
 * — including the last — which means every record after the first arrives
 * with the previous record's LF attached. Fixtures that omit it can't see
 * a parser that fails to trim it (which is exactly what hid the leading-LF
 * bug: every `sha` past `commits[0]` came back as `"\n<sha>"`).
 */
export const make_record = (
	sha: string,
	short: string,
	subject: string,
	author_name: string,
	email: string,
	date: string,
	parents: string
): string => [sha, short, subject, author_name, email, date, parents].join(FS) + RS + '\n';

/** The same record without git's trailing LF — the shape a bare RS split yields. */
export const make_record_no_lf = (
	sha: string,
	short: string,
	subject: string,
	author_name: string,
	email: string,
	date: string,
	parents: string
): string => [sha, short, subject, author_name, email, date, parents].join(FS) + RS;
