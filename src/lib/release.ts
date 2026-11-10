/**
 * Publishing the `fuzf` client and `fuzfd` server binaries to GitHub Releases.
 *
 * `run_release` checks what it can before building: the version agrees
 * between `package.json` and `Cargo.toml`, nothing would make the build's cargo
 * step skip a binary or cross-build (`FUZ_FORGE_BUILD_TARGET`,
 * `FUZ_FORGE_BUILD_SKIP_SERVER`, a missing sibling `../fuz`), the git working
 * tree is clean, `gh` is installed and authenticated, and the tag has no
 * release yet. Then it builds, checks the build left the tree clean, and ships
 * each binary under its platform name (`-linux-x86_64`, a glibc build) plus a
 * SHA-512 sidecar hashed from the bytes shipped. A binary built for another
 * target is still refused rather than shipped under that name, as is one whose
 * build sidecar disagrees with its bytes.
 *
 * @module
 */

import { hash_sha512 } from '@fuzdev/fuz_util/hash.ts';
import { spawn_result_is_ok, to_spawn_result_message } from '@fuzdev/gro/cli.ts';
import type { FsDir } from '@fuzdev/gro/fs.ts';
import type { FsPaths } from '@fuzdev/gro/fs_paths.ts';
import type { SpawnOutput, SpawnProgram, SpawnProgramOptions } from '@fuzdev/gro/spawn.ts';
import { TaskError } from '@fuzdev/gro/task.ts';

/** The GitHub repo releases are created in. */
export const RELEASE_REPO = 'fuzdev/fuz_forge';

/** Where `gro build` writes the binaries and their `.sha512` sidecars. */
const ARTIFACTS_DIR = 'dist_artifacts';

/**
 * The binaries a release ships, an exact allowlist, each with the platform
 * name its asset takes.
 */
const RELEASE_BINARIES: ReadonlyArray<{ name: string; asset: string }> = [
	{ name: 'fuzf', asset: 'fuzf-linux-x86_64' },
	{ name: 'fuzfd', asset: 'fuzfd-linux-x86_64' }
];

/**
 * The host variables `gh` needs beyond the spawn base set (`PATH`, `HOME`,
 * `TMPDIR`, `TERM`): its own `GH_*` settings (`GH_TOKEN`, `GH_HOST`,
 * `GH_CONFIG_DIR`, ...) and the `GITHUB_*` token names it also reads, the XDG
 * directories its config, state, and cache resolve under, the session bus and
 * runtime dir its keyring-stored token is read through, the proxy variables
 * its HTTP client honors, and the CA bundle overrides its TLS reads.
 */
export const GH_PASS_ENV: ReadonlyArray<string> = [
	'GH_*',
	'GITHUB_TOKEN',
	'GITHUB_ENTERPRISE_TOKEN',
	'XDG_CONFIG_HOME',
	'XDG_STATE_HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'XDG_RUNTIME_DIR',
	'DBUS_SESSION_BUS_ADDRESS',
	'HTTPS_PROXY',
	'HTTP_PROXY',
	'NO_PROXY',
	'https_proxy',
	'http_proxy',
	'no_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR'
];

/**
 * How `gh` is spawned: `GH_PASS_ENV`, and `GH_PROMPT_DISABLED` set, so a
 * release that would need an answer fails instead of waiting on the terminal
 * `gh release create` runs attached to.
 */
export const GH_PROGRAM_OPTIONS: SpawnProgramOptions = {
	pass_env: GH_PASS_ENV,
	env: { GH_PROMPT_DISABLED: '1' }
};

/**
 * The host variables the cargo step of `gro build` reads (`gro.config.ts`),
 * either of which makes a build a release can't ship: `FUZ_FORGE_BUILD_TARGET`
 * cross-builds and `FUZ_FORGE_BUILD_SKIP_SERVER=1` skips `fuzfd`.
 */
export interface ReleaseBuildEnv {
	FUZ_FORGE_BUILD_TARGET: string | undefined;
	FUZ_FORGE_BUILD_SKIP_SERVER: string | undefined;
}

/** The project files a release reads and the assets it writes beside the build output. */
export type ReleaseProject = Pick<FsDir, 'exists' | 'read' | 'read_text' | 'write' | 'remove'>;

/** Capabilities for `run_release`. */
export interface ReleaseDeps {
	/** The project directory. */
	project: ReleaseProject;
	/** `git`, for the working-tree check. */
	git: Pick<SpawnProgram, 'out'>;
	/** `gh`, `null` when it isn't on `PATH`. */
	gh: Pick<SpawnProgram, 'out' | 'run'> | null;
	/** Runs `gro build`, which writes the binaries and their sidecars. */
	build: () => Promise<void>;
	/** The host's values of the variables the build's cargo step reads. */
	build_env: ReleaseBuildEnv;
	/** Opens the sibling `../fuz` checkout the cargo step needs. */
	paths: Pick<FsPaths, 'open_dir_path'>;
}

const log_ok = (message: string): void => {
	console.log(`  [ok] ${message}`);
};

/** Whether a captured call exited `0` with all of its output. */
const out_is_ok = (result: SpawnOutput): boolean => spawn_result_is_ok(result) && !result.truncated;

/**
 * Refuse unless the git working tree is clean, untracked files included.
 *
 * @throws `TaskError` - when `git status` fails or lists anything
 */
const check_clean_tree = async (git: Pick<SpawnProgram, 'out'>, refusal: string): Promise<void> => {
	const git_status = await git.out(['status', '--porcelain']);
	if (!out_is_ok(git_status)) {
		throw new TaskError(
			`git status failed (${to_spawn_result_message(git_status)}): ${git_status.stderr.trim()}`
		);
	}
	if (git_status.stdout !== '') {
		throw new TaskError(`${refusal}:\n${git_status.stdout.trimEnd()}`);
	}
};

/**
 * Read the `version` of `Cargo.toml`'s `[workspace.package]` table.
 *
 * @param cargo_toml - the manifest's text
 * @returns the version, or `undefined` when the table or its `version` is missing
 */
export const parse_cargo_workspace_version = (cargo_toml: string): string | undefined => {
	const table = /^\[workspace\.package\]$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargo_toml)?.[1];
	return table && /^version\s*=\s*"([^"]*)"/m.exec(table)?.[1];
};

/**
 * Describe what an ELF binary was built for, unless it's the `-linux-x86_64`
 * platform the assets are named for: a 64-bit little-endian x86-64 executable
 * linked against glibc's loader. A static build (no `PT_INTERP`, which is what
 * the musl cross-build produces) or one using musl's loader is something else,
 * and so is any other architecture.
 *
 * @param bytes - the binary
 * @returns why it isn't an x86-64 glibc build, or `null` when it is
 */
export const describe_platform_mismatch = (bytes: Uint8Array): string | null => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const is_elf =
		bytes.length >= 64 &&
		bytes[0] === 0x7f &&
		bytes[1] === 0x45 && // E
		bytes[2] === 0x4c && // L
		bytes[3] === 0x46; // F
	if (!is_elf) return 'not an ELF binary';
	if (bytes[4] !== 2 || bytes[5] !== 1) return 'not a 64-bit little-endian ELF';
	const EM_X86_64 = 62;
	const machine = view.getUint16(18, true);
	if (machine !== EM_X86_64) return `built for ELF machine ${machine}, not x86-64`;
	const PT_INTERP = 3;
	const phoff = Number(view.getBigUint64(32, true));
	const phentsize = view.getUint16(54, true);
	const phnum = view.getUint16(56, true);
	for (let i = 0; i < phnum; i++) {
		const header = phoff + i * phentsize;
		if (header + 56 > bytes.length) return 'truncated ELF program headers';
		if (view.getUint32(header, true) !== PT_INTERP) continue;
		const offset = Number(view.getBigUint64(header + 8, true));
		const size = Number(view.getBigUint64(header + 32, true));
		const interp = new TextDecoder()
			.decode(bytes.subarray(offset, offset + size))
			.replace(/\0+$/, '');
		if (interp.includes('ld-linux-x86-64')) return null;
		return interp.includes('ld-musl-')
			? `dynamically linked against musl (${interp})`
			: `dynamically linked against ${interp}, not glibc's loader`;
	}
	return 'statically linked (a musl build?), not a glibc build';
};

/** A binary checked and hashed, ready to write as its asset. */
interface PreparedAsset {
	asset: string;
	bytes: Uint8Array;
	hash: string;
}

/**
 * Check one built binary against its platform name and its build sidecar.
 *
 * @throws `TaskError` - when the binary or its sidecar is missing, it isn't an
 * x86-64 glibc build, or the sidecar's hash isn't the binary's
 */
const prepare_asset = async (
	project: ReleaseProject,
	binary: { name: string; asset: string }
): Promise<PreparedAsset> => {
	const binary_path = `${ARTIFACTS_DIR}/${binary.name}`;
	const sidecar_path = `${binary_path}.sha512`;
	for (const path of [binary_path, sidecar_path]) {
		if (!(await project.exists(path))) {
			throw new TaskError(
				`${path} not found after gro build, whose cargo step writes both binaries unless ../fuz is missing or FUZ_FORGE_BUILD_SKIP_SERVER=1 skips fuzfd`
			);
		}
	}

	const bytes = await project.read(binary_path);
	const mismatch = describe_platform_mismatch(bytes);
	if (mismatch !== null) {
		throw new TaskError(
			`${binary_path} is ${mismatch}; it would ship as ${binary.asset}.` +
				' A release ships the host build, so run it on an x86-64 glibc machine.'
		);
	}
	log_ok(`${binary_path} is an x86-64 glibc build`);

	const hash = await hash_sha512(bytes as Uint8Array<ArrayBuffer>);
	const sidecar_hash = (await project.read_text(sidecar_path)).split(/\s+/)[0];
	if (sidecar_hash !== hash) {
		throw new TaskError(`${sidecar_path} does not match ${binary_path}; run gro build again.`);
	}
	log_ok(`${sidecar_path} matches`);
	return { asset: binary.asset, bytes, hash };
};

/**
 * Build the binaries and create the GitHub release for `package.json`'s version.
 *
 * @param deps - the project directory, `git`, `gh`, and the build
 * @throws `TaskError` - when a check refuses, naming the fix, or `gh release create` fails
 * @mutates filesystem - writes the platform-named assets and their sidecars under
 * `dist_artifacts/` for the upload, removing them after, whether it succeeded or not
 */
export const run_release = async (deps: ReleaseDeps): Promise<void> => {
	const { project, git, gh, build, build_env, paths } = deps;

	console.log('fuz_forge release');
	console.log();

	const pkg = JSON.parse(await project.read_text('package.json'));
	const version: unknown = pkg.version;
	if (typeof version !== 'string' || !version) {
		throw new TaskError('package.json has no version');
	}
	const tag = `v${version}`;
	console.log(`Version: ${version} (tag: ${tag})`);
	console.log();

	console.log('Checks:');
	// the binaries carry the Cargo version, so a release names them only when it
	// matches package.json's
	const cargo_version = parse_cargo_workspace_version(await project.read_text('Cargo.toml'));
	if (cargo_version !== version) {
		throw new TaskError(
			`Cargo.toml [workspace.package] version is ${cargo_version === undefined ? 'missing' : `"${cargo_version}"`}, package.json is "${version}". Bump both to the same version.`
		);
	}
	log_ok('Cargo.toml and package.json versions match');

	// the cargo step's own conditions (`gro.config.ts`), refused here rather than
	// after a release build that can't ship
	if (build_env.FUZ_FORGE_BUILD_TARGET) {
		throw new TaskError(
			`FUZ_FORGE_BUILD_TARGET is set (${build_env.FUZ_FORGE_BUILD_TARGET}), so gro build would cross-build, and a release ships the host glibc build. Unset it and re-run.`
		);
	}
	if (build_env.FUZ_FORGE_BUILD_SKIP_SERVER === '1') {
		throw new TaskError(
			'FUZ_FORGE_BUILD_SKIP_SERVER=1 would make gro build skip fuzfd, which a release ships. Unset it and re-run.'
		);
	}
	if ((await paths.open_dir_path('../fuz')) === null) {
		throw new TaskError(
			'../fuz not found: gro build skips the cargo step without the sibling fuz checkout. Clone it beside this repo and re-run.'
		);
	}
	log_ok('gro build would build fuzf and fuzfd for the host');

	await check_clean_tree(git, 'Working tree is not clean');
	log_ok('Working tree clean');

	if (!gh) {
		throw new TaskError('gh not found on PATH; install the GitHub CLI, then run: gh auth login');
	}
	const auth = await gh.out(['auth', 'status']);
	if (!spawn_result_is_ok(auth)) {
		// gh's own words, since a token it can't reach (a keyring behind an
		// environment `GH_PASS_ENV` doesn't pass) reads the same as none
		const said = `${auth.stdout}${auth.stderr}`.trim();
		throw new TaskError(
			`gh not authenticated (${to_spawn_result_message(auth)})${said ? `:\n${said}` : ''}\nRun: gh auth login`
		);
	}
	log_ok('gh authenticated');

	if (spawn_result_is_ok(await gh.out(['release', 'view', tag, '--repo', RELEASE_REPO]))) {
		throw new TaskError(
			`Release ${tag} already exists. Bump the version in package.json and Cargo.toml [workspace.package], or delete the existing release.`
		);
	}
	log_ok(`Release ${tag} does not exist yet`);
	console.log();

	await build();
	// the build's sync, gen, and cargo steps can write tracked files, and a
	// build that starts dirty skips Gro's own post-build check
	await check_clean_tree(git, 'gro build left the working tree dirty');
	console.log();

	console.log('Preparing assets:');
	const prepared: Array<PreparedAsset> = [];
	for (const binary of RELEASE_BINARIES) {
		prepared.push(await prepare_asset(project, binary));
	}

	const asset_paths = prepared.flatMap(({ asset }) => [
		`${ARTIFACTS_DIR}/${asset}`,
		`${ARTIFACTS_DIR}/${asset}.sha512`
	]);
	try {
		for (const { asset, bytes, hash } of prepared) {
			await project.write(`${ARTIFACTS_DIR}/${asset}`, bytes);
			await project.write(`${ARTIFACTS_DIR}/${asset}.sha512`, `${hash}  ${asset}\n`);
			log_ok(`Created ${ARTIFACTS_DIR}/${asset} and its .sha512`);
		}

		console.log();
		console.log('Creating release:');
		const created = await gh.run([
			'release',
			'create',
			tag,
			...asset_paths,
			'--repo',
			RELEASE_REPO,
			'--title',
			`fuz_forge ${tag}`,
			'--latest',
			'--generate-notes'
		]);
		if (!spawn_result_is_ok(created)) {
			throw new TaskError(`gh release create failed (${to_spawn_result_message(created)})`);
		}
		log_ok(`Created release ${tag}`);
	} finally {
		for (const path of asset_paths) {
			await project.remove(path, { missing_ok: true });
		}
	}
	log_ok('Cleaned up the platform-named assets');

	console.log();
	console.log('Done.');
};
