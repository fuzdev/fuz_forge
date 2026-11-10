/**
 * Tests for `#lib/release.ts` over a real temp directory with fake `git`,
 * `gh`, and build: the checks that refuse before building, the platform and
 * sidecar checks on the built binaries, the assets `gh release create` is
 * handed, and their cleanup.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { createHash } from 'node:crypto';
import { fs, type FsDir } from '@fuzdev/gro/fs.ts';
import { spawn, type SpawnOutput, type SpawnResult } from '@fuzdev/gro/spawn.ts';
import { is_task_error } from '@fuzdev/gro/task.ts';

import {
	describe_platform_mismatch,
	GH_PROGRAM_OPTIONS,
	parse_cargo_workspace_version,
	RELEASE_REPO,
	run_release,
	type ReleaseBuildEnv,
	type ReleaseDeps
} from '#lib/release.ts';
import { capture_console } from './capture_console.ts';

const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const GLIBC_INTERP = '/lib64/ld-linux-x86-64.so.2';
const MUSL_INTERP = '/lib/ld-musl-x86_64.so.1';

interface ElfOptions {
	machine?: number;
	/** `null` for a static binary, with no `PT_INTERP`. */
	interp?: string | null;
	elf_class?: number;
	data?: number;
}

/**
 * A minimal ELF64 image: the header, a `PT_LOAD` program header, and a
 * `PT_INTERP` one pointing at the interpreter string after them.
 */
const make_elf = (options: ElfOptions = {}): Uint8Array => {
	const { machine = EM_X86_64, interp = GLIBC_INTERP, elf_class = 2, data = 1 } = options;
	const phnum = interp === null ? 1 : 2;
	const interp_offset = 64 + phnum * 56;
	const interp_bytes = new TextEncoder().encode(interp === null ? '' : `${interp}\0`);
	const bytes = new Uint8Array(interp_offset + interp_bytes.length + 16);
	const view = new DataView(bytes.buffer);
	bytes.set([0x7f, 0x45, 0x4c, 0x46, elf_class, data, 1]);
	view.setUint16(16, 3, true); // ET_DYN
	view.setUint16(18, machine, true);
	view.setUint32(20, 1, true);
	view.setBigUint64(32, 64n, true); // e_phoff
	view.setUint16(52, 64, true);
	view.setUint16(54, 56, true); // e_phentsize
	view.setUint16(56, phnum, true);
	view.setUint32(64, 1, true); // PT_LOAD
	if (interp !== null) {
		const header = 64 + 56;
		view.setUint32(header, 3, true); // PT_INTERP
		view.setBigUint64(header + 8, BigInt(interp_offset), true);
		view.setBigUint64(header + 32, BigInt(interp_bytes.length), true);
		bytes.set(interp_bytes, interp_offset);
	}
	return bytes;
};

/** The `sha512sum` digest, computed apart from the module under test. */
const sha512_hex = (bytes: Uint8Array): string => createHash('sha512').update(bytes).digest('hex');

const output = (code: number, stdout = '', stderr = ''): SpawnOutput => ({
	kind: 'exited',
	code,
	stdout,
	stderr,
	truncated: false
});

interface Scenario {
	package_version?: string;
	cargo_version?: string;
	git_status?: SpawnOutput;
	/** The `git status` output after the build, `git_status` when absent. */
	git_status_after_build?: SpawnOutput;
	gh_missing?: boolean;
	build_env?: Partial<ReleaseBuildEnv>;
	/** Whether the sibling `../fuz` checkout is absent. */
	fuz_missing?: boolean;
	gh_auth?: SpawnOutput;
	gh_view?: SpawnOutput;
	gh_create?: SpawnResult;
	/** What the fake build writes for each binary, `null` to write nothing. */
	built?: Partial<Record<'fuzf' | 'fuzfd', { bytes: Uint8Array; sidecar?: string } | null>>;
}

interface Calls {
	git: Array<ReadonlyArray<string>>;
	gh_out: Array<ReadonlyArray<string>>;
	gh_run: Array<ReadonlyArray<string>>;
	builds: number;
	/** The paths opened through `paths`. */
	opened: Array<string>;
	/** The files `gh release create` was handed, read at the time of the call. */
	uploaded: Map<string, Uint8Array>;
}

const setup = async (
	dir: FsDir,
	scenario: Scenario
): Promise<{ deps: ReleaseDeps; calls: Calls }> => {
	const { package_version = '1.2.3', cargo_version = package_version } = scenario;
	await dir.write('package.json', JSON.stringify({ name: 'x', version: package_version }));
	await dir.write(
		'Cargo.toml',
		`[workspace]\nmembers = []\n\n[workspace.package]\nversion = "${cargo_version}"\nedition = "2024"\n\n[workspace.dependencies]\nversion = "9.9.9"\n`
	);
	const calls: Calls = {
		git: [],
		gh_out: [],
		gh_run: [],
		opened: [],
		builds: 0,
		uploaded: new Map()
	};
	const deps: ReleaseDeps = {
		project: dir,
		paths: {
			open_dir_path: async (path) => {
				calls.opened.push(path);
				return scenario.fuz_missing ? null : { dir, path: '' };
			}
		},
		build_env: {
			FUZ_FORGE_BUILD_TARGET: undefined,
			FUZ_FORGE_BUILD_SKIP_SERVER: undefined,
			...scenario.build_env
		},
		git: {
			out: async (args) => {
				calls.git.push(args);
				if (calls.builds > 0 && scenario.git_status_after_build) {
					return scenario.git_status_after_build;
				}
				return scenario.git_status ?? output(0);
			}
		},
		gh: scenario.gh_missing
			? null
			: {
					out: async (args) => {
						calls.gh_out.push(args);
						if (args[0] === 'auth') return scenario.gh_auth ?? output(0);
						if (args[0] === 'release' && args[1] === 'view') {
							return scenario.gh_view ?? output(1, '', 'release not found');
						}
						throw new Error(`unexpected gh ${args.join(' ')}`);
					},
					run: async (args) => {
						calls.gh_run.push(args);
						for (const arg of args) {
							if (arg.startsWith('dist_artifacts/')) calls.uploaded.set(arg, await dir.read(arg));
						}
						return scenario.gh_create ?? { kind: 'exited', code: 0 };
					}
				},
		build: async () => {
			calls.builds++;
			await dir.mkdir('dist_artifacts', { exists_ok: true });
			for (const name of ['fuzf', 'fuzfd'] as const) {
				const built =
					scenario.built?.[name] === undefined ? { bytes: make_elf() } : scenario.built[name];
				if (built === null) continue;
				await dir.write(`dist_artifacts/${name}`, built.bytes);
				await dir.write(
					`dist_artifacts/${name}.sha512`,
					built.sidecar ?? `${sha512_hex(built.bytes)}  ${name}\n`
				);
			}
		}
	};
	return { deps, calls };
};

/** Run the release, returning the `TaskError` message it refused with. */
const refusal = async (deps: ReleaseDeps): Promise<string> => {
	const { restore } = capture_console();
	try {
		await run_release(deps);
	} catch (error) {
		assert.ok(is_task_error(error), `expected a TaskError, got ${error}`);
		return error.message;
	} finally {
		restore();
	}
	assert.fail('expected the release to refuse');
};

const ASSETS = [
	'dist_artifacts/fuzf-linux-x86_64',
	'dist_artifacts/fuzf-linux-x86_64.sha512',
	'dist_artifacts/fuzfd-linux-x86_64',
	'dist_artifacts/fuzfd-linux-x86_64.sha512'
];

const assert_no_assets = async (dir: FsDir): Promise<void> => {
	for (const path of ASSETS) assert.isFalse(await dir.exists(path), path);
};

describe('run_release', () => {
	test('builds, then creates the release with the platform assets, then removes them', async () => {
		await using dir = await fs.temp_dir();
		const fuzf = make_elf();
		const fuzfd = make_elf({ interp: '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2' });
		const { deps, calls } = await setup(dir, {
			built: { fuzf: { bytes: fuzf }, fuzfd: { bytes: fuzfd } }
		});
		const { restore } = capture_console();
		try {
			await run_release(deps);
		} finally {
			restore();
		}
		assert.deepEqual(calls.git, [
			['status', '--porcelain'],
			['status', '--porcelain']
		]);
		assert.deepEqual(calls.gh_out, [
			['auth', 'status'],
			['release', 'view', 'v1.2.3', '--repo', RELEASE_REPO]
		]);
		assert.strictEqual(calls.builds, 1);
		assert.deepEqual(calls.gh_run, [
			[
				'release',
				'create',
				'v1.2.3',
				...ASSETS,
				'--repo',
				RELEASE_REPO,
				'--title',
				'fuz_forge v1.2.3',
				'--latest',
				'--generate-notes'
			]
		]);
		const text = (path: string) => new TextDecoder().decode(calls.uploaded.get(path));
		assert.deepEqual(calls.uploaded.get('dist_artifacts/fuzf-linux-x86_64'), fuzf);
		assert.deepEqual(calls.uploaded.get('dist_artifacts/fuzfd-linux-x86_64'), fuzfd);
		assert.strictEqual(
			text('dist_artifacts/fuzf-linux-x86_64.sha512'),
			`${sha512_hex(fuzf)}  fuzf-linux-x86_64\n`
		);
		assert.strictEqual(
			text('dist_artifacts/fuzfd-linux-x86_64.sha512'),
			`${sha512_hex(fuzfd)}  fuzfd-linux-x86_64\n`
		);
		await assert_no_assets(dir);
		assert.ok(await dir.exists('dist_artifacts/fuzf'), 'the build output stays');
	});

	test('a dirty working tree refuses, listing it, before gh or the build', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			git_status: output(0, ' M src/lib/release.ts\n?? notes.txt\n')
		});
		const message = await refusal(deps);
		assert.include(message, 'Working tree is not clean');
		assert.include(message, ' M src/lib/release.ts\n?? notes.txt');
		assert.deepEqual(calls.gh_out, []);
		assert.strictEqual(calls.builds, 0);
	});

	test('a build that dirties the tree refuses, before writing assets or creating anything', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			git_status_after_build: output(0, ' M package-lock.json\n')
		});
		// the release writes its assets through `project`, so a write before the
		// check fails the test rather than being cleaned up unseen
		deps.project = {
			exists: (path) => dir.exists(path),
			read: (path) => dir.read(path),
			read_text: (path) => dir.read_text(path),
			write: async (path) => assert.fail(`wrote ${path}`),
			remove: (path, options) => dir.remove(path, options)
		};
		const message = await refusal(deps);
		assert.include(message, 'gro build left the working tree dirty');
		assert.include(message, ' M package-lock.json');
		assert.strictEqual(calls.builds, 1);
		assert.deepEqual(calls.gh_run, []);
		await assert_no_assets(dir);
	});

	test('a failed git status refuses rather than reading as clean', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			git_status: output(128, '', 'fatal: not a git repository\n')
		});
		const message = await refusal(deps);
		assert.include(message, 'git status failed (code 128): fatal: not a git repository');
		assert.strictEqual(calls.builds, 0);
	});

	test('truncated git status output refuses', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			git_status: { ...output(0), truncated: true }
		});
		assert.include(await refusal(deps), 'git status failed');
		assert.strictEqual(calls.builds, 0);
	});

	test('a Cargo version unlike package.json refuses before anything runs', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, { package_version: '1.2.3', cargo_version: '1.2.4' });
		const message = await refusal(deps);
		assert.include(message, 'version is "1.2.4", package.json is "1.2.3"');
		assert.deepEqual(calls.git, []);
		assert.strictEqual(calls.builds, 0);
	});

	test('a package.json without a version refuses', async () => {
		await using dir = await fs.temp_dir();
		const { deps } = await setup(dir, {});
		await dir.write('package.json', '{"name": "x"}');
		assert.include(await refusal(deps), 'package.json has no version');
	});

	test('a missing gh refuses with the install hint, before the build', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, { gh_missing: true });
		assert.include(await refusal(deps), 'gh not found on PATH');
		assert.strictEqual(calls.builds, 0);
	});

	test("an unauthenticated gh refuses with gh's own output, before the build", async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			gh_auth: output(1, '', 'github.com\n  X Failed to log in using keyring\n')
		});
		const message = await refusal(deps);
		assert.include(message, 'gh not authenticated (code 1)');
		assert.include(message, 'X Failed to log in using keyring');
		assert.include(message, 'gh auth login');
		assert.strictEqual(calls.builds, 0);
	});

	test('a set FUZ_FORGE_BUILD_TARGET refuses, before git or the build', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			build_env: { FUZ_FORGE_BUILD_TARGET: 'x86_64-unknown-linux-musl' }
		});
		const message = await refusal(deps);
		assert.include(message, 'FUZ_FORGE_BUILD_TARGET is set (x86_64-unknown-linux-musl)');
		assert.deepEqual(calls.git, []);
		assert.strictEqual(calls.builds, 0);
	});

	test('FUZ_FORGE_BUILD_SKIP_SERVER=1 refuses, before git or the build', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, { build_env: { FUZ_FORGE_BUILD_SKIP_SERVER: '1' } });
		assert.include(await refusal(deps), 'FUZ_FORGE_BUILD_SKIP_SERVER=1');
		assert.deepEqual(calls.git, []);
		assert.strictEqual(calls.builds, 0);
	});

	test('values the build reads as unset pass: an empty target, a skip other than 1', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			build_env: { FUZ_FORGE_BUILD_TARGET: '', FUZ_FORGE_BUILD_SKIP_SERVER: '0' }
		});
		const { restore } = capture_console();
		try {
			await run_release(deps);
		} finally {
			restore();
		}
		assert.strictEqual(calls.gh_run.length, 1);
	});

	test('a missing ../fuz refuses, before git or the build', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, { fuz_missing: true });
		assert.include(await refusal(deps), '../fuz not found');
		assert.deepEqual(calls.opened, ['../fuz']);
		assert.deepEqual(calls.git, []);
		assert.strictEqual(calls.builds, 0);
	});

	test('an existing release refuses, before the build', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, { gh_view: output(0, 'title: fuz_forge v1.2.3') });
		assert.include(await refusal(deps), 'Release v1.2.3 already exists');
		assert.strictEqual(calls.builds, 0);
	});

	test('a musl build refuses, writing no assets and creating nothing', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			built: { fuzfd: { bytes: make_elf({ interp: null }) } }
		});
		const message = await refusal(deps);
		assert.include(message, 'dist_artifacts/fuzfd is statically linked');
		assert.include(message, 'fuzfd-linux-x86_64');
		assert.include(message, 'run it on an x86-64 glibc machine');
		assert.deepEqual(calls.gh_run, []);
		await assert_no_assets(dir);
	});

	test('a sidecar unlike its binary refuses, writing no assets', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, {
			built: { fuzf: { bytes: make_elf(), sidecar: `${'0'.repeat(128)}  fuzf\n` } }
		});
		assert.include(await refusal(deps), 'dist_artifacts/fuzf.sha512 does not match');
		assert.deepEqual(calls.gh_run, []);
		await assert_no_assets(dir);
	});

	test('a binary the build skipped refuses', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, { built: { fuzfd: null } });
		assert.include(await refusal(deps), 'dist_artifacts/fuzfd not found after gro build');
		assert.deepEqual(calls.gh_run, []);
	});

	test('a failed gh release create refuses and still removes the assets', async () => {
		await using dir = await fs.temp_dir();
		const { deps, calls } = await setup(dir, { gh_create: { kind: 'exited', code: 1 } });
		assert.include(await refusal(deps), 'gh release create failed (code 1)');
		assert.strictEqual(calls.uploaded.size, ASSETS.length);
		await assert_no_assets(dir);
	});
});

describe('describe_platform_mismatch', () => {
	test('accepts an x86-64 glibc executable', () => {
		assert.isNull(describe_platform_mismatch(make_elf()));
	});

	test('names a musl-linked executable', () => {
		assert.strictEqual(
			describe_platform_mismatch(make_elf({ interp: MUSL_INTERP })),
			`dynamically linked against musl (${MUSL_INTERP})`
		);
	});

	test('names another loader', () => {
		assert.strictEqual(
			describe_platform_mismatch(make_elf({ interp: '/lib/ld-other.so' })),
			"dynamically linked against /lib/ld-other.so, not glibc's loader"
		);
	});

	test('names a static executable', () => {
		assert.strictEqual(
			describe_platform_mismatch(make_elf({ interp: null })),
			'statically linked (a musl build?), not a glibc build'
		);
	});

	test('names another architecture', () => {
		assert.strictEqual(
			describe_platform_mismatch(make_elf({ machine: EM_AARCH64 })),
			'built for ELF machine 183, not x86-64'
		);
	});

	test('refuses 32-bit and big-endian ELF', () => {
		assert.strictEqual(
			describe_platform_mismatch(make_elf({ elf_class: 1 })),
			'not a 64-bit little-endian ELF'
		);
		assert.strictEqual(
			describe_platform_mismatch(make_elf({ data: 2 })),
			'not a 64-bit little-endian ELF'
		);
	});

	test('refuses what is not ELF, short input included', () => {
		assert.strictEqual(describe_platform_mismatch(new Uint8Array(0)), 'not an ELF binary');
		assert.strictEqual(
			describe_platform_mismatch(new TextEncoder().encode('#!/bin/sh\n'.padEnd(80, ' '))),
			'not an ELF binary'
		);
		assert.strictEqual(describe_platform_mismatch(make_elf().subarray(0, 32)), 'not an ELF binary');
	});

	test('refuses program headers past the end', () => {
		assert.strictEqual(
			describe_platform_mismatch(make_elf().subarray(0, 64 + 56 + 10)),
			'truncated ELF program headers'
		);
	});

	test('reads a view into a larger buffer at its own offset', () => {
		const elf = make_elf({ interp: MUSL_INTERP });
		const padded = new Uint8Array(elf.length + 8);
		padded.set(elf, 8);
		assert.strictEqual(
			describe_platform_mismatch(padded.subarray(8)),
			`dynamically linked against musl (${MUSL_INTERP})`
		);
	});
});

describe('parse_cargo_workspace_version', () => {
	test("reads [workspace.package]'s version, not another table's", () => {
		assert.strictEqual(
			parse_cargo_workspace_version(
				'[workspace.dependencies]\nversion = "9"\n\n[workspace.package]\nedition = "2024"\nversion = "0.3.1"\n'
			),
			'0.3.1'
		);
	});

	test('is undefined without the table or its version', () => {
		assert.isUndefined(parse_cargo_workspace_version('[package]\nversion = "1.0.0"\n'));
		assert.isUndefined(
			parse_cargo_workspace_version('[workspace.package]\nedition = "2024"\n[x]\nversion = "1"\n')
		);
	});
});

describe('GH_PROGRAM_OPTIONS', () => {
	test('sets GH_PROMPT_DISABLED, so gh fails rather than waits on a prompt', async () => {
		const printenv = spawn.find('printenv', GH_PROGRAM_OPTIONS);
		assert.ok(printenv);
		assert.strictEqual((await printenv.out(['GH_PROMPT_DISABLED'])).stdout, '1\n');
	});
});
