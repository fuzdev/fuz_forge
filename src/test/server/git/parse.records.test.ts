/**
 * Unit tests for the log-record parser and the exact-field-count contract
 * every record parser shares — `parse_log_records`, `parse_ref_records`,
 * `parse_tree_records`, `parse_commit_detail`.
 *
 * The real git subprocess is exercised end-to-end by handler-level tests
 * (`fuz_forge_repo_log_rpc.db.test.ts`) and is implicitly covered by the
 * existing `repo_git.integration` round-trip harness. These cases target the
 * parsers directly, over records framed by hand
 * (`parse_helpers.ts`), so a malformed format-string or a missed
 * escape doesn't silently corrupt the public RPC shape. The captured streams
 * are the sibling `parse.streams.test.ts`.
 *
 * The field-count and CR-framing tables are shared parity fixtures under
 * `src/test/fixtures/parity/` — the Rust twin
 * (`crates/fuz_forge_server/src/forge_git/parse/tests.rs`) reads the same
 * bytes, so a one-sided edit fails on one side against a table neither side
 * owns.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import {
	parse_commit_detail,
	parse_log_records,
	parse_ref_records,
	parse_tree_records
} from '#lib/server/git/parse.ts';
import {
	load_parity_fixture,
	parity_bool,
	parity_rows,
	parity_string
} from '../../fixtures/parity/load.ts';
import { RS, FS, encode, make_record, make_record_no_lf } from './parse_helpers.ts';

describe('parse_log_records', () => {
	test('returns [] for empty input', () => {
		const parsed = parse_log_records(new Uint8Array());
		assert.deepStrictEqual(parsed, []);
	});

	test('parses a single record with no parents (root commit)', () => {
		const sha = 'a'.repeat(40);
		const raw = make_record(
			sha,
			'aaaaaaa',
			'init',
			'Alice',
			'alice@example.com',
			'2026-01-01T00:00:00Z',
			''
		);
		const parsed = parse_log_records(new TextEncoder().encode(raw));
		assert.strictEqual(parsed.length, 1);
		assert.deepStrictEqual(parsed[0], {
			sha,
			short_sha: 'aaaaaaa',
			subject: 'init',
			author_name: 'Alice',
			author_email: 'alice@example.com',
			author_date: '2026-01-01T00:00:00Z',
			parents: []
		});
	});

	test('parses multiple records and preserves order', () => {
		const r1 = make_record(
			'1'.repeat(40),
			'1111111',
			'first',
			'Alice',
			'a@x',
			'2026-01-01T00:00:00Z',
			''
		);
		const r2 = make_record(
			'2'.repeat(40),
			'2222222',
			'second',
			'Bob',
			'b@x',
			'2026-01-02T00:00:00Z',
			'1'.repeat(40)
		);
		const r3 = make_record(
			'3'.repeat(40),
			'3333333',
			'merge it',
			'Carol',
			'c@x',
			'2026-01-03T00:00:00Z',
			`${'2'.repeat(40)} ${'1'.repeat(40)}`
		);
		const parsed = parse_log_records(new TextEncoder().encode(r1 + r2 + r3));
		assert.strictEqual(parsed.length, 3);
		// Every sha, not just `commits[0]` — records 2..n carry the previous
		// record's LF, which lands inside `sha` (and therefore inside
		// `next_cursor`) if the parser doesn't trim it.
		assert.deepStrictEqual(
			parsed.map((c) => c.sha),
			['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)]
		);
		assert.strictEqual(parsed[0]!.subject, 'first');
		assert.strictEqual(parsed[1]!.subject, 'second');
		assert.deepStrictEqual(parsed[1]!.parents, ['1'.repeat(40)]);
		assert.deepStrictEqual(parsed[2]!.parents, ['2'.repeat(40), '1'.repeat(40)]);
	});

	test('parses a stream whose last record has no trailing LF', () => {
		// `make_record` emits git's `RS LF`; the last record can also arrive
		// bare (e.g. a caller that trimmed the stream). Both shapes parse to
		// the same records.
		const r1 = make_record('1'.repeat(40), '1111111', 'first', 'A', 'a@x', '2026-01-01', '');
		const r2 = make_record_no_lf(
			'2'.repeat(40),
			'2222222',
			'second',
			'B',
			'b@x',
			'2026-01-02',
			'1'.repeat(40)
		);
		const parsed = parse_log_records(new TextEncoder().encode(r1 + r2));
		assert.deepStrictEqual(
			parsed.map((c) => c.sha),
			['1'.repeat(40), '2'.repeat(40)]
		);
	});

	test('preserves subject bytes that include funky characters', () => {
		const subject = 'tricky: emoji 🙂, quote " and tab\t inside';
		const raw = make_record(
			'a'.repeat(40),
			'aaaaaaa',
			subject,
			'Author',
			'a@x',
			'2026-01-01T00:00:00Z',
			''
		);
		const parsed = parse_log_records(new TextEncoder().encode(raw));
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0]!.subject, subject);
	});

	test('skips malformed records (wrong field count) rather than throwing', () => {
		const good = make_record(
			'a'.repeat(40),
			'aaaaaaa',
			'good',
			'Author',
			'a@x',
			'2026-01-01T00:00:00Z',
			''
		);
		// Only 3 NUL-separated fields — parser must skip it.
		const bad = `not_enough${FS}fields${FS}here${RS}`;
		const parsed = parse_log_records(new TextEncoder().encode(good + bad));
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0]!.subject, 'good');
	});

	test('tolerates a trailing newline after the last record', () => {
		const raw =
			make_record('a'.repeat(40), 'aaaaaaa', 'one', 'A', 'a@x', '2026-01-01T00:00:00Z', '') + '\n';
		const parsed = parse_log_records(new TextEncoder().encode(raw));
		assert.strictEqual(parsed.length, 1);
		assert.strictEqual(parsed[0]!.subject, 'one');
	});
});

describe('record parsers require exact field counts', () => {
	// Extra NUL-separated fields are a dropped record on both backends, not a
	// record whose last field silently absorbs them. Each side frames the bare
	// record its own reader takes: the TS parsers are stream-level, so a record
	// row is framed here and asserted by record count.
	const fixture = load_parity_fixture('git_record_field_counts');

	const framings: Record<string, [(raw: string) => number, (input: string) => string]> = {
		log: [(raw) => parse_log_records(encode(raw)).length, (input) => input + RS + '\n'],
		refs: [(raw) => parse_ref_records(encode(raw)).length, (input) => input + '\n'],
		tree: [(raw) => parse_tree_records(encode(raw)).length, (input) => input + '\n'],
		commit_detail: [(raw) => (parse_commit_detail(encode(raw)) === null ? 0 : 1), (input) => input]
	};

	for (const [table, [parse, frame]] of Object.entries(framings)) {
		for (const row of parity_rows(fixture, table)) {
			const input = parity_string(row, 'input');
			const parses = parity_bool(row, 'parses');
			test(`${table} ${parses ? 'parses' : 'drops'}: ${JSON.stringify(input)}`, () => {
				assert.strictEqual(parse(frame(input)), parses ? 1 : 0);
			});
		}
	}

	// Record framing is LF-only on both backends: a CR belongs to the record, not
	// the separator. Rust's `str::lines` would strip the trailing CR and serve
	// `foo` where this serves `foo\r`, which is why the twin frames on `\n`
	// itself. The ref case is
	// unobservable in practice — git forbids control characters in a ref name and
	// the other fields can't carry one — but the two readers use one framing rule,
	// so the fixture is the same shape.
	const streams = load_parity_fixture('git_real_streams');
	for (const [table, parse] of [
		['tree_framing_cr', (raw: string) => parse_tree_records(encode(raw))],
		['ref_framing_cr', (raw: string) => parse_ref_records(encode(raw))]
	] as const) {
		for (const row of parity_rows(streams, table)) {
			test(`${table} keeps the trailing CR inside the record`, () => {
				assert.deepStrictEqual(parse(parity_string(row, 'stream')), row.expected);
			});
		}
	}
});

describe('parse_commit_detail', () => {
	const make_detail = (
		sha: string,
		short: string,
		subject: string,
		author_name: string,
		author_email: string,
		author_date: string,
		committer_name: string,
		committer_email: string,
		committer_date: string,
		parents: string,
		body: string
	): string =>
		[
			sha,
			short,
			subject,
			author_name,
			author_email,
			author_date,
			committer_name,
			committer_email,
			committer_date,
			parents,
			body
		].join(FS);

	test('parses a typical single-parent commit', () => {
		const raw = make_detail(
			'a'.repeat(40),
			'aaaaaaa',
			'first commit',
			'Alice',
			'alice@example.com',
			'2026-05-15T00:00:00Z',
			'Alice',
			'alice@example.com',
			'2026-05-15T00:00:00Z',
			'b'.repeat(40),
			'first commit\n\nBody text spanning\nmultiple lines.\n'
		);
		const parsed = parse_commit_detail(new TextEncoder().encode(raw));
		assert.isNotNull(parsed);
		assert.strictEqual(parsed.sha, 'a'.repeat(40));
		assert.strictEqual(parsed.subject, 'first commit');
		assert.strictEqual(parsed.committer_name, 'Alice');
		assert.deepStrictEqual(parsed.parents, ['b'.repeat(40)]);
		assert.include(parsed.body, 'Body text spanning');
	});

	test('parses a root commit with empty parents', () => {
		const raw = make_detail(
			'c'.repeat(40),
			'ccccccc',
			'root',
			'Bob',
			'bob@example.com',
			'2026-01-01T00:00:00Z',
			'Bob',
			'bob@example.com',
			'2026-01-01T00:00:00Z',
			'',
			'root\n'
		);
		const parsed = parse_commit_detail(new TextEncoder().encode(raw));
		assert.isNotNull(parsed);
		assert.deepStrictEqual(parsed.parents, []);
	});

	test('parses a merge commit with multiple parents', () => {
		const parent_a = 'd'.repeat(40);
		const parent_b = 'e'.repeat(40);
		const raw = make_detail(
			'f'.repeat(40),
			'fffffff',
			'merge',
			'Carol',
			'carol@example.com',
			'2026-02-01T00:00:00Z',
			'Carol',
			'carol@example.com',
			'2026-02-01T00:00:00Z',
			`${parent_a} ${parent_b}`,
			'merge\n'
		);
		const parsed = parse_commit_detail(new TextEncoder().encode(raw));
		assert.isNotNull(parsed);
		assert.deepStrictEqual(parsed.parents, [parent_a, parent_b]);
	});

	test('preserves embedded newlines in the body field', () => {
		const body = 'subject\n\nline 1\nline 2\nline 3\n';
		const raw = make_detail(
			'1'.repeat(40),
			'1111111',
			'subject',
			'X',
			'x@x',
			'2026-01-01T00:00:00Z',
			'X',
			'x@x',
			'2026-01-01T00:00:00Z',
			'',
			body
		);
		const parsed = parse_commit_detail(new TextEncoder().encode(raw));
		assert.isNotNull(parsed);
		// A trailing newline is trimmed once; remaining body matches.
		assert.strictEqual(parsed.body, body.slice(0, -1));
	});

	test('returns null on truncated input (too few fields)', () => {
		const raw = 'sha\x00short\x00subject';
		const parsed = parse_commit_detail(new TextEncoder().encode(raw));
		assert.isNull(parsed);
	});

	test('returns null on empty input', () => {
		const parsed = parse_commit_detail(new Uint8Array(0));
		assert.isNull(parsed);
	});

	// Why `read_commit` can't trust the parse alone. Real git 2.47 output for
	// `git show --no-patch --format=<11 fields> <annotated-tag-sha> --`: exit 0,
	// the tag preamble, then the *peeled commit's* full record. So the parse
	// succeeds and `%H` comes back carrying the preamble ahead of the commit
	// sha — never the tag sha the client asked for. `read_refs` hands clients
	// that tag sha for every `refs/tags/*` annotated tag, which is what makes
	// the reader's `commit.sha !== sha` guard load-bearing rather than
	// defensive. Twin: `parse.rs`'s
	// `parse_commit_detail_succeeds_on_an_annotated_tag_preamble`.
	test("parses git's annotated-tag output, with the preamble folded into `%H`", () => {
		const tag_sha = '1bd361675e9b182695e39e13a2c66815a2bad48c';
		const commit_sha = 'fc6c0969eea2604ac4a0f3aba893967e6511bd9c';
		const raw = make_detail(
			`tag v1\nTagger: T <t@t>\n\ntag msg\n${commit_sha}`,
			'fc6c096',
			'init',
			'T',
			't@t',
			'2026-01-01T00:00:00Z',
			'T',
			't@t',
			'2026-01-01T00:00:00Z',
			'',
			'init\n'
		);
		const parsed = parse_commit_detail(new TextEncoder().encode(raw));
		assert.isNotNull(parsed);
		assert.notStrictEqual(parsed.sha, tag_sha, 'the tag sha is never echoed back');
		assert.include(parsed.sha, 'Tagger:');
		assert.isTrue(
			parsed.sha.endsWith(commit_sha),
			'`%H` carries the preamble ahead of the peeled commit sha'
		);
	});

	test('separates author and committer fields independently', () => {
		const raw = make_detail(
			'a'.repeat(40),
			'aaaaaaa',
			'rebased',
			'Original Author',
			'orig@example.com',
			'2026-01-01T00:00:00Z',
			'Rebaser',
			'rebaser@example.com',
			'2026-05-01T00:00:00Z',
			'b'.repeat(40),
			'rebased\n'
		);
		const parsed = parse_commit_detail(new TextEncoder().encode(raw));
		assert.isNotNull(parsed);
		assert.strictEqual(parsed.author_name, 'Original Author');
		assert.strictEqual(parsed.committer_name, 'Rebaser');
		assert.strictEqual(parsed.author_date, '2026-01-01T00:00:00Z');
		assert.strictEqual(parsed.committer_date, '2026-05-01T00:00:00Z');
	});
});
