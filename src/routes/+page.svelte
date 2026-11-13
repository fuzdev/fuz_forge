<main class="box mx_auto pt_xl5 pb_xl9">
	<section class="box">
		<header class="box">
			<h1 class="mt_0 font_size_xl5">fuz_forge</h1>
			<aside class="font_size_lg">
				a personal-scale forge for self-hosting git repos, signed releases, and files
			</aside>
		</header>
	</section>

	<section class="width_atmost_md">
		<h2 class="mt_0">What is <code>fuz_forge</code>?</h2>
		<blockquote>
			⚠️ <strong class="color_e_50">Not ready to be used.</strong> There is no release, no supported
			install, and no public instance. APIs and formats break without notice, and its security is
			<span class="color_c_50">not ready to be trusted</span>.
		</blockquote>
		<div>
			<p>
				<a href="https://github.com/fuzdev/fuz_forge"><code>fuz_forge</code></a> is a self-hosted
				forge: git repos mirrored by push and kept behind auth, a reader for their history and
				diffs, and a content-addressed file store that <code>fuz</code> installs signed first-party
				tools from.
			</p>
			<ul>
				<li>
					<strong>repos</strong>: git repos mirrored by an ordinary <code>git push</code>; the forge
					only receives, and every repo surface needs an admin
				</li>
				<li>
					<strong>history</strong>: the commit log and single commits with their diffs
				</li>
				<li>
					<strong>file store</strong>: content-addressed blake3 facts plus path-keyed cells —
					immutable bytes, mutable refs
				</li>
				<li>
					<strong>signed artifacts</strong>: ed25519-signed, blake3-pinned release binaries, kept in
					the file store
				</li>
				<li>
					<strong>web UI</strong>: a prerendered SvelteKit dashboard for repos and files
				</li>
			</ul>
		</div>

		<h2>How it fits together</h2>
		<p>
			A Rust server and a <code>fuzf</code> client CLI, with nginx in front. <code>fuz_forge</code>
			doesn't deploy itself: <a href="https://github.com/fuzdev/zap"><code>zap</code></a> deploys
			the forge, and <code>fuz</code> only reads from it, verifying the signed artifacts it pulls.
		</p>
	</section>
</main>
