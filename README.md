# fuz_forge

> a personal-scale forge for self-hosting git repos, signed releases, and files 🎛️ pre-alpha

> ⚠️ **Not ready to be used.** There is no release, no supported install, and no
> public instance. APIs, wire shapes, and on-disk formats break without notice,
> and its security is not ready to be trusted.

fuz_forge is a self-hosted forge: git repos mirrored by push and kept behind
auth, a reader for their history and diffs, and signed release artifacts in a
content-addressed file store, which is where `fuz` installs first-party tools
from. It is a Rust server (`fuzfd`) and client CLI (`fuzf`) on the spine crates in
[Fuz](https://github.com/fuzdev/fuz), a SvelteKit dashboard on
[fuz_app](https://github.com/fuzdev/fuz_app), and a TypeScript reference server
held to wire parity with the Rust one. Hosts are provisioned and deployed with
[Zap](https://github.com/fuzdev/zap).

fuz_forge is part of the Fuz stack
([fuz.dev](https://www.fuz.dev/), [@fuzdev](https://github.com/fuzdev)).

AI disclosure: this codebase is LLM-generated with uneven human review.

## Development

Building needs [Fuz](https://github.com/fuzdev/fuz) checked out beside this repo
as `fuz/`, plus Node, a Rust toolchain, PostgreSQL, git, and Python 3 (the
repo hooks). Deploying also needs the `zap` binary and `fgro`
([install](https://zap.fuz.dev/docs/install)). Start with `gro check`; the full command list is in [CLAUDE.md](CLAUDE.md), and the
design and operator docs are in [docs/](docs/).

## Contributing

[fuz.dev/contributing](https://www.fuz.dev/contributing)

## Security

Report vulnerabilities through the [fuzdev security policy](https://github.com/fuzdev/.github/blob/main/SECURITY.md).

## License [🐦](https://wikipedia.org/wiki/Free_and_open-source_software)

[0BSD](LICENSE)
