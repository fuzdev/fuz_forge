/**
 * Shared parsing primitives for read-only git operations.
 *
 * The `git log` / `git show` family produces records whose subject lines,
 * author names, and committer emails can contain arbitrary text. To
 * survive that, callers ask git to emit each record with `%x1e` (RS)
 * between records and `%x00` (NUL) between fields — both bytes are
 * forbidden in the placeholders fuz_forge uses (`%H %h %s %an %ae %aI %P`),
 * so a parser keyed off them is unambiguous.
 *
 * Used by every reader in `server/git/read.ts` — `read_log`,
 * `read_default_branch_tip`, `read_commit`, `read_refs`, `read_tree`,
 * `read_blob` — and any future subprocess wrapper that needs the same record
 * shapes. The ref-name/path validators live here too because they gate every
 * callsite that passes a branch/tag or path argument to `git`, as do the
 * stderr classifiers that decide which git failures are 404s. Structural twin of
 * `crates/fuz_forge_server/src/forge_git/parse.rs` — same validators, same
 * stderr classifiers, and same format constants. The stream/record split is
 * shared by most but not all of the parsers: the log and ref readers split the
 * same way on both sides (`parse_log_records` frames the RS-delimited stream
 * git emits and `parse_record` reads one record out of it, mirroring the Rust
 * `parse_log_records` / `parse_log_record` pair; `parse_ref_records` /
 * `parse_ref_record` likewise), while `parse_tree_records` inlines its per-line
 * body here and the Rust side factors out a `parse_tree_record` — the one
 * asymmetry in the pairing.
 *
 * @module
 */

/**
 * git-log format string. `%x1e` (RS) terminates each record; `%x00`
 * (NUL) separates fields within a record. See module-level docs for
 * why these separators are unambiguous.
 *
 * Field order: `H h s an ae aI P` →
 * (full_sha, short_sha, subject, author_name, author_email, author_date_iso, parents).
 */
export const LOG_RECORD_FORMAT = '%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%P';

/**
 * git-show format string for the single-commit metadata fetch.
 * Extends `LOG_RECORD_FORMAT` with
 * committer fields and the raw body (`%B` = subject + blank line +
 * body, so the body field carries the full commit message verbatim).
 *
 * Field order: `H h s an ae aI cn ce cI P B` → 11 fields.
 *
 * No trailing `%x1e` — a single-commit fetch yields exactly one
 * record, and the parser is happy with or without the terminator.
 */
export const COMMIT_DETAIL_FORMAT =
	'%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%P%x00%B';

const RECORD_SEPARATOR = 0x1e;
const FIELD_SEPARATOR = 0x00;

/**
 * One parsed `git log` record matching `LOG_RECORD_FORMAT`. The
 * wire-side schema is `FuzForgeRepoCommitSummary` in `action_specs.ts` —
 * the field set matches exactly so handlers can pass parsed records
 * through without remapping.
 */
export interface LogRecord {
	/** Full 40-char object id. */
	sha: string;
	/** Abbreviated object id (git default — typically 7-12 chars). */
	short_sha: string;
	subject: string;
	author_name: string;
	author_email: string;
	/** ISO-8601 author date. */
	author_date: string;
	/** Parent SHAs (space-separated by git; we split into an array). */
	parents: Array<string>;
}

/**
 * Validate a git ref name against a conservative subset of
 * `git check-ref-format` rules. Defense-in-depth — subprocess args are
 * passed as a vector, not via a shell, so injection isn't possible, but
 * a malformed branch name could still be interpreted as a `-`-prefixed
 * flag or a pathspec. Reject anything that doesn't look like a plain
 * branch name.
 *
 * The rules mirror `git check-ref-format` (no leading `.`/`/`, trailing
 * `.`/`/`/`.lock`, `..`, `//`, `@{`, lone `@`, per-component `.`-start /
 * `.lock`-end, no control chars / space / `~^:?*[\`) plus a stricter leading-
 * dash guard, so the name can never be confused with an option flag or
 * pathspec. The Rust twin (`is_safe_ref_name` in `forge_git/parse.rs`) implements the
 * identical rules byte-for-byte — a ref accepted/rejected here is
 * accepted/rejected there too, git-valid exotic names like `feat@2`
 * included.
 */
export const is_safe_ref_name = (ref: string): boolean => {
	// The 255 cap is a defensive sanity bound (git has none; the structural
	// rules below are the real validation). UTF-16 length here vs the Rust
	// twin's `chars().count()` differs only for >255 astral-plane chars — a
	// non-case for branch names, which are ASCII in practice.
	if (ref.length === 0 || ref.length > 255) return false;
	// Leading `-` is stricter than git itself — an arg-injection guard so a ref
	// can never be read as a `git` flag.
	if (ref.startsWith('-') || ref.startsWith('.') || ref.startsWith('/')) return false;
	if (ref.endsWith('.') || ref.endsWith('/') || ref.endsWith('.lock')) return false;
	// `..`, `//`, `@{`, and the single `@` are all rejected by check-ref-format.
	if (ref.includes('..') || ref.includes('//') || ref.includes('@{') || ref === '@') return false;
	// Per-component rules: no slash-separated component may begin with `.` or
	// end with `.lock` (the whole-ref checks above only cover the first/last).
	for (const segment of ref.split('/')) {
		if (segment.startsWith('.') || segment.endsWith('.lock')) return false;
	}
	for (const ch of ref) {
		const code = ch.codePointAt(0)!;
		if (code <= 0x20 || code === 0x7f) return false;
		if (
			ch === '~' ||
			ch === '^' ||
			ch === ':' ||
			ch === '?' ||
			ch === '*' ||
			ch === '[' ||
			ch === '\\'
		) {
			return false;
		}
	}
	return true;
};

/**
 * A full 40-char lowercase-hex SHA-1 object id.
 *
 * Gates every callsite that puts a client-supplied object id into an argv slot
 * (`read_log`'s cursor, `read_commit`'s sha) and the `rev-parse` outputs the
 * readers parse back. Twin of `is_full_sha` in `forge_git/parse.rs`, which
 * applies the identical lowercase-only grammar — git resolves an uppercase sha
 * happily, so admitting `A-F` on one backend would page a `fuz_forge_repo_log`
 * cursor the other answers with the empty page.
 */
export const is_full_sha = (s: string): boolean => /^[0-9a-f]{40}$/.test(s);

/**
 * Parse the byte stream produced by `git log --format=<LOG_RECORD_FORMAT>`.
 *
 * Decodes UTF-8 once per field — git defaults to UTF-8 output and the
 * format placeholders fuz_forge uses don't carry arbitrary binary content
 * (parent SHAs are hex; subject lines are committer-supplied UTF-8 text).
 */
export const parse_log_records = (output: Uint8Array): Array<LogRecord> => {
	if (output.length === 0) return [];
	const records: Array<LogRecord> = [];
	const decoder = new TextDecoder('utf-8');

	// Trim a trailing record separator so the final split doesn't yield
	// a blank record. `git log` appends `%x1e` after the last record
	// with the format strings fuz_forge uses; the leading-trim path catches
	// the (less common) case where the output starts with one too.
	let start = 0;
	let end = output.length;
	while (start < end && output[start] === RECORD_SEPARATOR) start++;
	while (end > start && output[end - 1] === RECORD_SEPARATOR) end--;
	// `--format=` is a tformat, so git writes `<record> RS LF` for EVERY
	// record including the last — the per-record leading-LF trim in
	// `parse_record` is what makes records 2..n parse; this strips the
	// stream's own final LF so the last split doesn't yield a blank record.
	if (end > start && output[end - 1] === 0x0a) end--;

	let cursor = start;
	while (cursor < end) {
		const record_end_idx = index_of_byte(output, RECORD_SEPARATOR, cursor, end);
		const record_end = record_end_idx === -1 ? end : record_end_idx;
		// Skip empty records (consecutive separators).
		if (record_end > cursor) {
			const record = output.subarray(cursor, record_end);
			const parsed = parse_record(record, decoder);
			if (parsed) records.push(parsed);
		}
		cursor = record_end + 1;
	}

	return records;
};

const index_of_byte = (buf: Uint8Array, byte: number, from: number, to: number): number => {
	for (let i = from; i < to; i++) {
		if (buf[i] === byte) return i;
	}
	return -1;
};

/**
 * Parsed single-commit detail matching `COMMIT_DETAIL_FORMAT`.
 * Superset of `LogRecord` — adds committer fields + the raw
 * commit body (which includes the subject line on its first line per
 * git's `%B` placeholder).
 */
export interface CommitDetailRecord extends LogRecord {
	committer_name: string;
	committer_email: string;
	committer_date: string;
	body: string;
}

/**
 * Split git's space-separated parent SHAs (`%P`) into an array; a root
 * commit (empty field) yields `[]`.
 */
const parse_parents = (raw: string): Array<string> => {
	const trimmed = raw.trim();
	return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
};

/**
 * Parse the byte stream produced by `git show --no-patch
 * --format=<COMMIT_DETAIL_FORMAT>` for a single commit. Returns
 * `null` for malformed output (wrong field count) so the handler can
 * map to 404 rather than throwing.
 *
 * The body field (`%B`) is allowed to contain `%x00` only by the
 * committer typing one — vanishingly rare and treated as "extra
 * fields" → reassembled into the body so a pathological commit
 * message can't truncate the parsed output.
 *
 * The record must carry the full 11 fields: the first ten NUL separators
 * are required, and everything past the tenth is the body. Fewer is
 * `null` — the same rule the Rust twin's `splitn(11)` + required 11th
 * part applies, so a truncated record is refused identically on both
 * backends instead of yielding a record whose `body` repeats `%P`.
 */
export const parse_commit_detail = (output: Uint8Array): CommitDetailRecord | null => {
	if (output.length === 0) return null;
	const decoder = new TextDecoder('utf-8');
	// Strip a single trailing newline if git appended one.
	let end = output.length;
	if (end > 0 && output[end - 1] === 0x0a) end--;
	const trimmed = output.subarray(0, end);
	const fields: Array<Uint8Array> = [];
	let cursor = 0;
	// The body (last field) may legitimately contain NULs only if the
	// committer wrote them — preserve them by consuming exactly the first
	// ten separators and taking the whole remainder as the 11th field.
	while (fields.length < 10) {
		const sep = index_of_byte(trimmed, FIELD_SEPARATOR, cursor, trimmed.length);
		if (sep === -1) return null;
		fields.push(trimmed.subarray(cursor, sep));
		cursor = sep + 1;
	}
	// Remainder is the body field — NULs inside it are preserved.
	fields.push(trimmed.subarray(cursor));
	const sha = decoder.decode(fields[0]);
	const short_sha = decoder.decode(fields[1]);
	const subject = decoder.decode(fields[2]);
	const author_name = decoder.decode(fields[3]);
	const author_email = decoder.decode(fields[4]);
	const author_date = decoder.decode(fields[5]);
	const committer_name = decoder.decode(fields[6]);
	const committer_email = decoder.decode(fields[7]);
	const committer_date = decoder.decode(fields[8]);
	const parents = parse_parents(decoder.decode(fields[9]));
	const body = decoder.decode(fields[10]);
	return {
		sha,
		short_sha,
		subject,
		author_name,
		author_email,
		author_date,
		committer_name,
		committer_email,
		committer_date,
		parents,
		body
	};
};

/**
 * `git for-each-ref` format. NUL-separated fields, one record per
 * line. Field order: `refname objecttype objectname *objectname
 * committerdate:iso-strict`.
 *
 * `*objectname` resolves to the target sha of an annotated tag (empty
 * for lightweight tags and for branches) — keeping it in the format
 * lets the client distinguish "tag points at commit X" from "tag is
 * an annotated tag whose target is commit X".
 *
 * `committerdate` is empty for tags (where the date is in the tag
 * object, not a commit) — left empty rather than fabricated so the UI
 * can decide whether to fall back to taggerdate.
 */
export const REF_RECORD_FORMAT =
	'%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(committerdate:iso-strict)';

/**
 * One parsed `git for-each-ref` record. `name` is the full ref path
 * (`refs/heads/main`, `refs/tags/v1.0`); the handler / UI is responsible
 * for stripping the `refs/heads/` or `refs/tags/` prefix when displaying.
 */
export interface RefRecord {
	name: string;
	/** `'commit' | 'tag'` in practice; left wide for forward-compat. */
	object_type: string;
	sha: string;
	/** Target sha for annotated tags; empty string otherwise. */
	target_sha: string;
	/** ISO-8601 committer date; empty for tags without a fallback. */
	committer_date: string;
}

export const parse_ref_records = (output: Uint8Array): Array<RefRecord> => {
	if (output.length === 0) return [];
	const records: Array<RefRecord> = [];
	const decoder = new TextDecoder('utf-8');
	let end = output.length;
	if (end > 0 && output[end - 1] === 0x0a) end--;
	// `for-each-ref` defaults to LF between records, not RS. Split on LF.
	let cursor = 0;
	while (cursor < end) {
		const line_end_idx = index_of_byte(output, 0x0a, cursor, end);
		const line_end = line_end_idx === -1 ? end : line_end_idx;
		if (line_end > cursor) {
			const parsed = parse_ref_record(output.subarray(cursor, line_end), decoder);
			if (parsed) records.push(parsed);
		}
		cursor = line_end + 1;
	}
	return records;
};

const parse_ref_record = (record: Uint8Array, decoder: TextDecoder): RefRecord | null => {
	const fields: Array<Uint8Array> = [];
	let cursor = 0;
	while (cursor <= record.length) {
		const sep = index_of_byte(record, FIELD_SEPARATOR, cursor, record.length);
		const end = sep === -1 ? record.length : sep;
		fields.push(record.subarray(cursor, end));
		if (sep === -1) break;
		cursor = sep + 1;
	}
	if (fields.length !== 5) return null;
	return {
		name: decoder.decode(fields[0]),
		object_type: decoder.decode(fields[1]),
		sha: decoder.decode(fields[2]),
		target_sha: decoder.decode(fields[3]),
		committer_date: decoder.decode(fields[4])
	};
};

/**
 * One entry in a `git ls-tree -l` listing. `git ls-tree -l` emits
 * lines like `<mode> <type> <sha> <size>\t<name>` — tab between
 * size and name (because the name can contain spaces but never tabs
 * unless `-z` is used; we don't pass `-z` because the size column
 * before the tab is plain ASCII and parsing is straightforward).
 *
 * `size` is `'-'` for trees (directories) and submodules per `git
 * ls-tree -l` semantics — we keep the string verbatim and let the UI
 * decide how to render it. For files (`blob`), it's a decimal byte
 * count.
 */
export interface TreeEntry {
	/** Git mode string, e.g. `'100644'`, `'100755'`, `'040000'`, `'120000'`, `'160000'`. */
	mode: string;
	/** `'blob' | 'tree' | 'commit'` (commit = submodule). */
	type: string;
	sha: string;
	/** Decimal byte count for blobs; `'-'` for trees / submodules. */
	size: string;
	/** Entry name (single path segment — no `/`). */
	name: string;
}

/**
 * Parse the output of `git ls-tree -l <rev>:<path>`. Returns an empty
 * array for empty input; skips malformed lines defensively.
 *
 * Format per line: `<mode> SP <type> SP <sha> SP* <size> HT <name> LF`.
 * The size column is right-aligned with spaces, so we split mode/type/
 * sha by single-space and then split off everything before the tab as
 * the size column.
 */
export const parse_tree_records = (output: Uint8Array): Array<TreeEntry> => {
	if (output.length === 0) return [];
	const decoder = new TextDecoder('utf-8');
	const text = decoder.decode(output);
	const entries: Array<TreeEntry> = [];
	for (const raw_line of text.split('\n')) {
		if (raw_line.length === 0) continue;
		const tab = raw_line.indexOf('\t');
		if (tab === -1) continue;
		const header = raw_line.slice(0, tab);
		const name = raw_line.slice(tab + 1);
		// `<mode> SP <type> SP <sha> SP* <size>` — collapse runs of
		// spaces, then split into exactly 4 fields.
		const parts = header.split(/\s+/).filter((p) => p.length > 0);
		if (parts.length !== 4) continue;
		entries.push({
			mode: parts[0]!,
			type: parts[1]!,
			sha: parts[2]!,
			size: parts[3]!,
			name
		});
	}
	return entries;
};

/**
 * Conservative blob/tree path validator. Defense-in-depth: paths land
 * in `git ls-tree <rev>:<path>` / `git cat-file blob <rev>:<path>`
 * argv slots before `--`. A leading `-` could be a flag; absolute
 * paths, `..` segments, control chars, NULs all rejected. Empty
 * string is allowed and means "the root tree".
 */
export const is_safe_path = (path: string): boolean => {
	if (path.length === 0) return true;
	if (path.length > 4096) return false;
	if (path.startsWith('-') || path.startsWith('/')) return false;
	if (path.endsWith('/')) return false;
	for (const ch of path) {
		const code = ch.codePointAt(0)!;
		if (code === 0 || code === 0x7f) return false;
		if (code < 0x20 && ch !== '\t') return false;
	}
	for (const seg of path.split('/')) {
		if (seg.length === 0) return false; // empty segment / "//"
		if (seg === '..' || seg === '.') return false;
	}
	return true;
};

/**
 * git's "no such ref" stderr vocabulary. Converged branch-for-branch with the
 * Rust twin (`is_no_such_ref_stderr` in `forge_git/parse.rs`).
 *
 * Which message git emits for the same absent ref is decided by the argv
 * shape, so all three of the forge's rev-bearing shapes need a branch here
 * (wordings from git 2.47):
 *
 * - `git log … <rev> --` (`read_log`) → `bad revision '<rev>'`. Every read that
 *   passes the `--` separator lands here: the separator settles the
 *   rev-vs-pathspec question up front, so git never reaches the
 *   `ambiguous argument` wording.
 * - `git rev-parse <ref>` (`resolve_sha` for `read_tree` — no `--verify`, no
 *   `--`) → `ambiguous argument '<ref>': unknown revision or path not in the
 *   working tree.` This is why the `ambiguous argument` / `unknown revision`
 *   branches stay load-bearing.
 * - `git rev-parse --verify refs/heads/<b>` (`resolve_sha` for
 *   `read_default_branch_tip`) → `Needed a single revision`. `--verify` reports
 *   the arity failure without ever naming the rev, and it is the wording for an
 *   empty repo, for a repo whose configured default branch was never pushed,
 *   and for a deleted branch alike.
 *
 * `does not have any commits yet` is git's unborn-HEAD wording for a bare
 * `git log` with *no* rev argument; the forge always passes a rev, so that
 * branch is defensive rather than reachable from a current argv.
 *
 * Over-matching is bounded: `Needed a single revision` is also what
 * `git rev-parse --verify <ref>:<path>` prints, but that call (`read_blob`'s
 * resolve and its ref-only disambiguation probe) keys on the exit code alone
 * and never consults this predicate.
 *
 * Without these branches an absent branch, an empty repo, and a
 * force-push-GC'd cursor all answer 503 instead of the empty page / `null` tip
 * the readers document.
 */
export const is_no_such_ref_stderr = (stderr: string): boolean =>
	stderr.includes('unknown revision') ||
	stderr.includes('ambiguous argument') ||
	stderr.includes('bad revision') ||
	stderr.includes('Needed a single revision') ||
	stderr.includes('does not have any commits yet');

/**
 * git's "that path isn't in this tree-ish" stderr vocabulary. Converged
 * branch-for-branch with the Rust twin (`is_no_such_path_stderr` in
 * `forge_git/parse.rs`) — the two classifiers must agree or the same repo
 * answers 404 on one backend and 503 on the other.
 *
 * Three message families, all kept on both sides:
 *
 * - `Not a valid object name <rev>:<path>` — git's plain `get_oid` miss, what
 *   `git ls-tree <sha>:<path>` emits (the only caller today, via
 *   `read_tree` in `server/git/read.ts`), on a bare repo and a worktree alike.
 *   git prints the same wording when the **rev** half is the miss
 *   (`git ls-tree <absent-sha>:README.md`), so a caller that passed an
 *   unresolved rev would answer 404 `path` where 404 `ref` is the truth.
 *   Latent, not reachable: `read_tree` resolves the rev with its own
 *   `git rev-parse` first and only ever interpolates a sha git just returned.
 *   The day a reader passes an unresolved rev, a `<rev>:` shape check belongs
 *   here — and in the Rust twin the same day, or the same repo answers
 *   differently on each backend.
 * - `not a tree object` — three producers share this one wording, all from the
 *   same `git ls-tree <sha>:<path>`: the path resolves but names a **blob** (a
 *   client asking for a tree listing at a file path), it names a **gitlink**
 *   (a submodule entry, whose commit object isn't in this repo), or the tree
 *   object is **missing/corrupt** in the object store. The first two are
 *   genuine 404 `path`; the third is repo corruption folded into the same 404
 *   — a deliberate trade, since a client can't tell the difference and a 503
 *   would misreport the two common cases as transient.
 *   TODO: disambiguate with a `cat-file -t <sha>:<path>` probe if operators
 *   ever need corruption to surface as a 503 instead of a 404.
 * - `path '<p>' does not exist in '<rev>'` and `path '<p>' exists on disk, but
 *   not in '<rev>'` — git's `diagnose_invalid_oid_path` forms, emitted by the
 *   `git show` / `git cat-file` `<rev>:<path>` family. Reachable on a bare
 *   repo: `git -C <bare> show <sha>:config` prints the "exists on disk" form,
 *   because the bare dir's own `config` file exists next to git's cwd. Kept so
 *   a future `<rev>:<path>` reader classifies instead of falling through to a
 *   503.
 */
export const is_no_such_path_stderr = (stderr: string): boolean =>
	(stderr.includes("path '") && stderr.includes('does not exist')) ||
	stderr.includes('Not a valid object name') ||
	stderr.includes('not a tree object') ||
	stderr.includes('exists on disk, but not in');

/**
 * The one stderr prefix git renders for a header-pattern compile failure:
 * `compile_regexp` writes `<where>'<pattern>': <errbuf>`, with `header, ` the
 * `where` for the `--author` / `--committer` / `--grep` family — of which
 * `--author` is the only member either backend puts on an argv. Twin of
 * `FATAL_HEADER_PREFIX` in `forge_git/parse.rs`.
 */
const FATAL_HEADER_PREFIX = "fatal: header, '";

/**
 * git's "that header pattern isn't a regular expression" stderr vocabulary.
 * Converged branch-for-branch with the Rust twin (`is_invalid_pattern_stderr`
 * in `forge_git/parse.rs`).
 *
 * `read_log` passes `--author=<pattern>` through unmodified, so a client can
 * hand git a pattern its regex compiler refuses (`[`, `[a-`, a trailing `\`).
 * git exits 128 with `fatal: header, '<pattern>': <compiler message>` — a
 * client-input miss, not a transient read failure, so both backends answer
 * `-32602` rather than the 503 an unclassified stderr would produce.
 *
 * Two shape decisions, both load-bearing and both mirrored on the Rust side:
 *
 * - **Anchored, not a substring search.** git echoes the *client's pattern*
 *   into this message, so a substring test would let a client write any other
 *   classifier's vocabulary into the stderr the classifiers read:
 *   `--author=bad revision [` produces `fatal: header, 'bad revision [':
 *   Invalid regular expression`, which a substring
 *   `is_no_such_ref_stderr` also matches. Requiring a line to *start
 *   with* the prefix puts the echoed pattern permanently past the anchor,
 *   where it cannot forge one.
 * - **Per line, not per message.** git may print a `warning:` line ahead of
 *   the `fatal:` one (an ambiguous refname does), so the prefix is not always
 *   at byte 0 of the stderr.
 *
 * The compiler message *after* the prefix is never consulted: that text comes
 * from the platform's `regcomp`, so the same pattern reads `Invalid regular
 * expression` on the glibc target and something else on the musl one.
 *
 * The anchor bounds what a client can forge but does not by itself make the
 * three classifiers disjoint — a pattern echoing `bad revision` still matches
 * `is_no_such_ref_stderr`. **Order** settles that: `read_log` consults
 * this predicate first, and a stderr carrying this prefix is by construction a
 * compile failure, so the pattern answer is the true one.
 */
export const is_invalid_pattern_stderr = (stderr: string): boolean =>
	stderr.split('\n').some((line) => line.startsWith(FATAL_HEADER_PREFIX));

/**
 * Parse one RS-delimited `git log` record (NUL-separated fields). Twin of
 * `parse_log_record` in `forge_git/parse.rs`, including the leading-LF trim:
 * `git log --format=<fmt>%x1e` is a tformat, so git writes `<record> RS LF`
 * and every record after the first arrives with the previous record's LF
 * still attached (which would otherwise land inside `sha`).
 */
const parse_record = (record: Uint8Array, decoder: TextDecoder): LogRecord | null => {
	let record_start = 0;
	while (
		record_start < record.length &&
		(record[record_start] === 0x0a || record[record_start] === 0x0d)
	) {
		record_start++;
	}
	const fields: Array<Uint8Array> = [];
	let cursor = record_start;
	while (cursor <= record.length) {
		const sep = index_of_byte(record, FIELD_SEPARATOR, cursor, record.length);
		const end = sep === -1 ? record.length : sep;
		fields.push(record.subarray(cursor, end));
		if (sep === -1) break;
		cursor = sep + 1;
	}
	// Need exactly 7 fields (H h s an ae aI P). Fewer means we got a
	// malformed record — defensively skip rather than blow up the whole
	// parse.
	if (fields.length !== 7) return null;
	const sha = decoder.decode(fields[0]);
	const short_sha = decoder.decode(fields[1]);
	const subject = decoder.decode(fields[2]);
	const author_name = decoder.decode(fields[3]);
	const author_email = decoder.decode(fields[4]);
	const author_date = decoder.decode(fields[5]);
	const parents = parse_parents(decoder.decode(fields[6]));
	return { sha, short_sha, subject, author_name, author_email, author_date, parents };
};
