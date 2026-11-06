// Registers ambient types for the `virtual:svelte-docinfo` module (Vite plugin).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference types="svelte-docinfo/virtual-svelte-docinfo.js" />

// Injected by Vite `define` in vite.config.ts
declare const __GIT_COMMIT__: string;
declare const __GIT_BRANCH__: string;
declare const __BUILD_TIMESTAMP__: string;
declare module 'virtual:fuz.css' {
	const css: string;
	export default css;
}
declare module 'virtual:pkg.json' {
	import type { PkgJson } from '@fuzdev/fuz_util/pkg_json.ts';
	const pkg_json: PkgJson;
	export default pkg_json;
}
