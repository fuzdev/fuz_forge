/**
 * Release script for publishing the fuz_forge binaries to GitHub releases.
 *
 * Usage: deno task release
 * (chains gro build → this script)
 *
 * Creates a GitHub release of the `fuzf` client and `fuzfd` server binaries,
 * each under its platform name (`-linux-x86_64`, a glibc build) plus a SHA-512
 * sidecar hashed from the bytes shipped. A binary built for another target
 * (`FUZ_FORGE_BUILD_TARGET=x86_64-unknown-linux-musl`, say) is refused rather
 * than shipped under that name. Requires `gh` CLI authenticated and a clean git
 * working tree.
 *
 * @module
 */

import { file_exists, log_ok, run } from './setup_helpers.ts';

const REPO = 'fuzdev/fuz_forge';

// Client (`fuzf`) and server (`fuzfd`) artifacts — both shipped per release.
const CLIENT_BINARY_PATH = 'dist_artifacts/fuzf';
const CLIENT_HASH_PATH = 'dist_artifacts/fuzf.sha512';
const SERVER_BINARY_PATH = 'dist_artifacts/fuzfd';
const SERVER_HASH_PATH = 'dist_artifacts/fuzfd.sha512';

// Platform-named assets for GitHub releases.
const CLIENT_PLATFORM_BINARY = 'dist_artifacts/fuzf-linux-x86_64';
const CLIENT_PLATFORM_HASH = 'dist_artifacts/fuzf-linux-x86_64.sha512';
const SERVER_PLATFORM_BINARY = 'dist_artifacts/fuzfd-linux-x86_64';
const SERVER_PLATFORM_HASH = 'dist_artifacts/fuzfd-linux-x86_64.sha512';

console.log('fuz_forge release');
console.log();

// Read version from package.json
const pkg = JSON.parse(await Deno.readTextFile('package.json'));
const version: string = pkg.version;
const tag = `v${version}`;
console.log(`Version: ${version} (tag: ${tag})`);
console.log();

// The binaries carry the Cargo version, so a release names them only when it
// matches package.json's.
const cargo_toml = await Deno.readTextFile('Cargo.toml');
const workspace_package = /^\[workspace\.package\]$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargo_toml)?.[1];
const cargo_version = workspace_package && /^version\s*=\s*"([^"]*)"/m.exec(workspace_package)?.[1];
if (cargo_version !== version) {
	console.error(
		`  [error] Cargo.toml [workspace.package] version is ${cargo_version ? `"${cargo_version}"` : 'missing'}, package.json is "${version}"`
	);
	console.error('  Bump both to the same version');
	Deno.exit(1);
}

// Validate binaries exist
console.log('Checks:');
for (const path of [CLIENT_BINARY_PATH, CLIENT_HASH_PATH, SERVER_BINARY_PATH, SERVER_HASH_PATH]) {
	if (!(await file_exists(path))) {
		console.error(`  [error] ${path} not found — run gro build first`);
		Deno.exit(1);
	}
	log_ok(`${path} exists`);
}

// Check git status
const git_status = await run(['git', 'status', '--porcelain']);
if (!git_status.success) {
	console.error('  [error] git status failed');
	Deno.exit(1);
}
if (git_status.stdout !== '') {
	console.error('  [error] Working tree is not clean:');
	console.error(git_status.stdout);
	Deno.exit(1);
}
log_ok('Working tree clean');

// Check gh auth
const gh_auth = await run(['gh', 'auth', 'status']);
if (!gh_auth.success) {
	console.error('  [error] gh not authenticated — run: gh auth login');
	Deno.exit(1);
}
log_ok('gh authenticated');

// Check if release already exists
const existing = await run(['gh', 'release', 'view', tag, '--repo', REPO]);
if (existing.success) {
	console.error(`  [error] Release ${tag} already exists`);
	console.error('  Bump version in package.json and Cargo.toml [workspace.package], or delete the existing release');
	Deno.exit(1);
}
log_ok(`Release ${tag} does not exist yet`);

console.log();
console.log('Preparing assets:');

/**
 * Describe what an ELF binary was built for, or `null` when it is the
 * `-linux-x86_64` platform the assets are named for: a 64-bit little-endian
 * x86-64 executable linked against glibc's loader. A static build (no
 * `PT_INTERP`, which is what the musl cross-build produces) or one using musl's
 * loader is something else, and so is any other architecture.
 */
const describe_platform_mismatch = (bytes: Uint8Array): string | null => {
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
		const interp = new TextDecoder().decode(bytes.subarray(offset, offset + size)).replace(/\0+$/, '');
		if (interp.includes('ld-linux-x86-64')) return null;
		return interp.includes('ld-musl-')
			? `dynamically linked against musl (${interp})`
			: `dynamically linked against ${interp}, not glibc's loader`;
	}
	return 'statically linked (a musl build?), not a glibc build';
};

const sha512_hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest('SHA-512', bytes)), (b) =>
		b.toString(16).padStart(2, '0')
	).join('');

// Copy each binary to its platform-named asset, refuse it unless it was built for
// that platform, and write its hash file from the copied bytes — the ones shipped —
// cross-checked against the build's sidecar.
const prepare_platform_asset = async (
	binary_path: string,
	hash_path: string,
	platform_binary: string,
	platform_hash: string,
	platform_name: string
): Promise<void> => {
	await Deno.copyFile(binary_path, platform_binary);
	log_ok(`Copied ${binary_path} → ${platform_binary}`);

	const bytes = await Deno.readFile(platform_binary);
	const mismatch = describe_platform_mismatch(bytes);
	if (mismatch !== null) {
		await Deno.remove(platform_binary).catch(() => {});
		console.error(`  [error] ${binary_path} is ${mismatch}; it would ship as ${platform_name}`);
		console.error('  Rebuild for the host glibc target: gro build without FUZ_FORGE_BUILD_TARGET');
		Deno.exit(1);
	}
	log_ok(`${binary_path} is an x86-64 glibc build`);

	const hash = await sha512_hex(bytes);
	const sidecar_hash = (await Deno.readTextFile(hash_path)).split(/\s+/)[0];
	if (sidecar_hash !== hash) {
		await Deno.remove(platform_binary).catch(() => {});
		console.error(`  [error] ${hash_path} does not match ${binary_path} — run gro build again`);
		Deno.exit(1);
	}
	await Deno.writeTextFile(platform_hash, `${hash}  ${platform_name}\n`);
	log_ok(`Created ${platform_hash}`);
};

await prepare_platform_asset(
	CLIENT_BINARY_PATH,
	CLIENT_HASH_PATH,
	CLIENT_PLATFORM_BINARY,
	CLIENT_PLATFORM_HASH,
	'fuzf-linux-x86_64'
);
await prepare_platform_asset(
	SERVER_BINARY_PATH,
	SERVER_HASH_PATH,
	SERVER_PLATFORM_BINARY,
	SERVER_PLATFORM_HASH,
	'fuzfd-linux-x86_64'
);

const platform_assets = [
	CLIENT_PLATFORM_BINARY,
	CLIENT_PLATFORM_HASH,
	SERVER_PLATFORM_BINARY,
	SERVER_PLATFORM_HASH
];

console.log();
console.log('Creating release:');

// Create GitHub release
const release_result = await run([
	'gh',
	'release',
	'create',
	tag,
	...platform_assets,
	'--repo',
	REPO,
	'--title',
	`fuz_forge ${tag}`,
	'--latest',
	'--generate-notes'
]);

if (!release_result.success) {
	console.error('  [error] gh release create failed:');
	console.error(release_result.stderr);
	// Clean up temp files
	for (const asset of platform_assets) {
		await Deno.remove(asset).catch(() => {});
	}
	Deno.exit(1);
}
log_ok(`Created release ${tag}`);
if (release_result.stdout) {
	console.log(`  ${release_result.stdout}`);
}

// Clean up platform-named copies
for (const asset of platform_assets) {
	await Deno.remove(asset);
}
log_ok('Cleaned up temp assets');

console.log();
console.log('Done.');
