/**
 * zap configuration for a fuz_forge server at `<forge-host>`.
 *
 * Hardened production setup with:
 * - Dedicated 'fuz_forge' user (not root)
 * - SSH hardening (root login disabled, key-only auth)
 * - Systemd hardening (NoNewPrivileges, ProtectSystem, ProtectHome)
 * - PostgreSQL over the Unix socket as the service account (peer auth)
 * - Compiled `fuzfd` binary (no JS runtime on the server)
 * - One-shot bootstrap token for first-time keeper account creation
 *
 * Target: `<forge-host>` (a Debian 13 droplet; SSH target from `DEPLOY_HOST`, public
 * hostname from `DEPLOY_DOMAIN`)
 *
 * ## Verification Checkpoints
 *
 * The setup includes verification checkpoints that abort if critical
 * operations fail:
 * - verify-post-firewall: Ensures SSH works after firewall changes
 * - verify-pre-hardening: Final check before SSH hardening
 *
 * ## SSH Lockout Prevention
 *
 * Order of operations is designed for recovery:
 * 1. fuz_forge user created early (alternate SSH access)
 * 2. Firewall verified before continuing
 * 3. SSH hardening last (after everything works)
 *
 * A root password for console recovery is *not* set here — it's a one-time
 * out-of-band step (see the Phase 1 note below), so console recovery only
 * exists if the operator set one manually.
 *
 * @module
 */

// The `ZapBuilder` import is type-only (erased at eval); the recipe imports below are
// real and resolve through `node_modules/@fuzdev/zap`.
import type { ZapBuilder } from '@fuzdev/zap/zap.ts';
import { fail2ban_jail } from '@fuzdev/zap/recipe_fail2ban.ts';
import { SSHD_VALIDATE, ssh_hardening, ssh_hardening_verify } from '@fuzdev/zap/recipe_ssh.ts';
import { debian_ssh_service } from '@fuzdev/zap/recipe_debian_ssh.ts';
import {
	ssl_params,
	SSL_PARAMS_PATH,
	rate_limit_zone,
	NGINX_VALIDATE,
	nginx_config_verify
} from '@fuzdev/zap/recipe_nginx.ts';
import {
	debian_nginx_spa_site,
	debian_nginx_catch_all
} from '@fuzdev/zap/recipe_debian_nginx.ts';
import { hardened_systemd_unit } from '@fuzdev/zap/recipe_debian_systemd.ts';
import { postgres_apt_repo } from '@fuzdev/zap/recipe_debian_postgres.ts';
import {
	debian_certbot_reload_nginx_hook,
	debian_certbot_standalone_issue
} from '@fuzdev/zap/recipe_debian_certbot.ts';
import { certbot_webroot_switch } from '@fuzdev/zap/recipe_certbot.ts';
import { spa_csp } from '@fuzdev/zap/recipe_csp.ts';
import { fuz_app_bootstrap_token } from '@fuzdev/zap/recipe_bootstrap.ts';
import { fuz_app_env_base, fuz_app_trusted_proxies } from '@fuzdev/zap/recipe_env.ts';
import {
	FORGE_FILE_STORE_MAX_BYTES,
	forge_nginx_locations
} from './src/lib/nginx_locations.ts';

//
// Constants
//

const DEPLOY_USER = 'fuz_forge';
const APP_DIR = `/home/${DEPLOY_USER}/app`;
const SERVICE_NAME = 'fuz_forge';
const RELEASES_DIR = `${APP_DIR}/releases`;
const SHARED_DIR = `${APP_DIR}/shared`;
const CURRENT_LINK = `${APP_DIR}/current`;

//
// Template Constants
//

// Environment template — the shared fuz_app base (`recipe_env`) + the forge's
// allowed-origins, trusted-proxies, and file-store-cap stanza.
const ENV_BASE = {
	user: DEPLOY_USER,
	service: SERVICE_NAME,
	config_dir: `/home/${DEPLOY_USER}/.fuz_forge`
};
const ENV_EXTRA = `
# Security - allowed origins for API requests
FUZ_ALLOWED_ORIGINS='https://{{domain}}'

${fuz_app_trusted_proxies({ env_prefix: 'FORGE' })}

# File store - the upload cap, matching nginx's client_max_body_size
FUZ_FORGE_FILE_STORE_MAX_BYTES=${FORGE_FILE_STORE_MAX_BYTES}`;

// Content-Security-Policy for the prerendered SPA — the locked-down fuz_app
// baseline. See `@fuzdev/zap/recipe_csp.ts` for the 'unsafe-inline' / blake3
// 'wasm-unsafe-eval' rationale; connect-src carries the WS endpoint as the
// `wss://{{domain}}` template placeholder.
const CSP = spa_csp();

// Nginx config — the fuz_app SPA site recipe. zap owns the full config including
// SSL directives (certbot only manages cert files, never `--nginx`, so it can't
// drift the file on a second apply). `extra_locations` carries the forge-specific
// surface the generic recipe doesn't: the loopback-only `/internal` 404, the
// large-body `/api/fuz_forge/files` store, and git smart-HTTP (`*.git/*`).
const nginx_config = (site: { domain: string; port: string }) =>
	debian_nginx_spa_site({
		...site,
		root: `${CURRENT_LINK}/build`,
		csp: CSP,
		ssl: 'snippet',
		spa_try_files: '$uri /200.html',
		extra_locations: forge_nginx_locations()
	});

//
// zap Configuration
//

export default (zap: ZapBuilder): void => {
	//
	// Target: remote server via SSH
	// Uses fuz_forge user after initial setup (root login is disabled after SSH hardening)
	// Fresh servers: the fuz_forge user doesn't exist yet, and zap never falls back to
	// another user. The first apply runs with `--bootstrap` (`npm run apply:bootstrap`,
	// preview, then `-- --wetrun`) and connects as `bootstrap_user`, root on a stock Debian
	// image; every later run omits it and connects as fuz_forge.

	zap.target({
		host: zap.env('DEPLOY_HOST'),
		user: zap.env('DEPLOY_USER'),
		bootstrap_user: 'root',
		package_manager: 'apt',
		service_manager: 'systemd'
	});

	//
	// Phase 1: Foundation & Recovery
	//

	// Root password for console recovery is a one-time bootstrap, not convergence
	// state — set it manually out-of-band (`sudo passwd root` on first console
	// access). The convergence engine forbids ambient env reads in configs
	// (env-dependence is expressed as inert `zap.env('VAR')` references), so an optional,
	// conditionally-declared recovery step cannot live here.

	// Swap file - prevents OOM on small-RAM droplets
	zap.swap({
		id: 'swap-file',
		name: '2GB swap file',
		size: '2G'
	});

	//
	// Phase 2: User Management
	//

	// Create deploy user with full sudo access.
	// Narrowing this to a `sudo_commands` allowlist is deferred: apply needs
	// broad root (apt, systemd, nginx, certbot, postgres, ufw), so the
	// allowlist would have to enumerate every recipe's commands and would drift
	// with each one. Revisit if the recipe set stabilizes.
	zap.user({
		id: 'create-user',
		name: 'Create fuz_forge user with SSH keys and sudo',
		username: DEPLOY_USER,
		shell: '/bin/bash',
		home_mode: '711', // Allow nginx to traverse home directory
		ssh_keys: { copy_from: 'root' },
		sudo: 'nopasswd',
		depends_on: ['swap-file']
	});

	//
	// Phase 3: Packages
	// Cache update and batching handled automatically by the planner.
	//

	zap.pkg({ id: 'curl', name: 'curl', from: { apt: 'curl' } });
	zap.pkg({ id: 'unzip', name: 'unzip', from: { apt: 'unzip' } });
	// `git` is required by the forge server: it creates bare repos
	// (`git init --bare`) and serves them over smart-HTTP (`git http-backend`).
	zap.pkg({ id: 'git', name: 'git', from: { apt: 'git' } });
	// The repo hooks (`pre-receive` / `post-receive`) are python3 scripts that
	// git runs on every push.
	zap.pkg({ id: 'python3', name: 'python3 (repo hooks)', from: { apt: 'python3' } });

	// No JS runtime on the host: the deployed `fuzfd` binary is a
	// self-contained Rust binary, and provisioning runs through
	// the standalone `zap` binary — neither evaluates `.ts` on the host.

	zap.pkg({ id: 'fail2ban', name: 'fail2ban intrusion prevention', from: { apt: 'fail2ban' } });
	zap.pkg({ id: 'nginx', name: 'nginx web server', from: { apt: 'nginx' } });
	zap.pkg({ id: 'certbot', name: 'certbot SSL tool', from: { apt: 'certbot' } });
	zap.pkg({ id: 'ufw', name: 'ufw firewall', from: { apt: 'ufw' } });
	zap.pkg({
		id: 'needrestart',
		name: 'needrestart auto-restart helper',
		from: { apt: 'needrestart' }
	});

	// PostgreSQL 18 from the official PGDG apt repository (recipe defaults: key
	// under /usr/share/keyrings, list at sources.list.d/pgdg.list).
	zap.apt_repo({
		id: 'postgresql-repo',
		name: 'PostgreSQL apt repository',
		...postgres_apt_repo(),
		depends_on: ['curl']
	});

	zap.pkg({
		id: 'postgresql',
		name: 'PostgreSQL 18 database',
		from: { apt: 'postgresql-18' },
		depends_on: ['postgresql-repo']
	});

	//
	// Phase 4: Security
	//

	zap.file({
		id: 'fail2ban-config',
		name: 'fail2ban jail.local',
		path: '/etc/fail2ban/jail.local',
		content: { type: 'inline', content: fail2ban_jail() },
		depends_on: ['fail2ban']
	});

	zap.service({
		id: 'fail2ban-service',
		name: 'fail2ban service',
		service: 'fail2ban',
		enabled: true,
		running: true,
		restart_on: ['fail2ban-config'],
		depends_on: ['fail2ban-config']
	});

	// Firewall
	zap.firewall({
		id: 'ufw-firewall',
		name: 'Configure ufw firewall',
		backend: 'ufw',
		allow: ['OpenSSH', 'Nginx Full'],
		depends_on: ['nginx', 'ufw']
	});

	// Verification checkpoint: Ensure SSH still works after firewall
	zap.verify({
		id: 'verify-post-firewall',
		name: 'Verify SSH after firewall',
		assertions: [{ type: 'command', run: 'true' }],
		depends_on: ['ufw-firewall']
	});

	//
	// Phase 5: PostgreSQL Initialization
	//

	zap.database({
		id: 'postgresql-init',
		name: 'Initialize PostgreSQL database',
		engine: 'postgresql',
		database_name: SERVICE_NAME,
		username: DEPLOY_USER,
		depends_on: ['postgresql', 'verify-post-firewall']
	});

	//
	// Phase 6: Directory Structure
	//

	zap.directory({
		id: 'app-dir',
		name: 'Application directory',
		path: APP_DIR,
		mode: '755',
		owner: DEPLOY_USER,
		group: DEPLOY_USER,
		depends_on: ['verify-post-firewall', 'create-user']
	});

	zap.directory({
		id: 'releases-dir',
		name: 'Releases directory',
		path: RELEASES_DIR,
		mode: '755',
		owner: DEPLOY_USER,
		group: DEPLOY_USER,
		depends_on: ['app-dir']
	});

	zap.directory({
		id: 'shared-dir',
		name: 'Shared directory',
		path: SHARED_DIR,
		mode: '755',
		owner: DEPLOY_USER,
		group: DEPLOY_USER,
		depends_on: ['app-dir']
	});

	zap.directory({
		id: 'fuz_forge-config-dir',
		name: 'fuz_forge config directory',
		path: `/home/${DEPLOY_USER}/.fuz_forge`,
		mode: '700',
		owner: DEPLOY_USER,
		group: DEPLOY_USER,
		depends_on: ['create-user']
	});

	// The fact store (`~/.fuz_forge/facts`) and bare-repo store
	// (`~/.fuz_forge/repos`) both nest under the config dir above and are
	// created by the daemon on first write — no separate directory resources.
	// The file store is cell-primary (bytes land in the fact store), so there
	// is no distinct on-disk file directory either. `FUZ_FORGE_HOME` would
	// relocate all three at once; production leaves it unset and uses
	// `~/.fuz_forge/`.

	//
	// Phase 7: Configuration Files
	//

	// Bootstrap token for first-time keeper account creation — the fuz_app
	// bootstrap-token recipe. See `@fuzdev/zap/recipe_bootstrap.ts` for the
	// token-file / `bootstrap_lock` check; to rotate a stuck token, remove the
	// token file and reset the `bootstrap_lock` row so the next apply re-mints.
	zap.script({
		id: 'bootstrap-token',
		name: 'Create bootstrap token',
		...fuz_app_bootstrap_token({
			user: DEPLOY_USER,
			service: SERVICE_NAME,
			config_dir: `/home/${DEPLOY_USER}/.fuz_forge`
		}),
		depends_on: ['fuz_forge-config-dir', 'postgresql-init']
	});

	// Environment file
	zap.file({
		id: 'env-production',
		name: 'Production environment',
		path: `${SHARED_DIR}/.env.production`,
		content: fuz_app_env_base({
			...ENV_BASE,
			port: '4040',
			cookie_keys: zap.env('SECRET_FUZ_COOKIE_KEYS'),
			extra: {
				template: ENV_EXTRA,
				vars: {
					domain: zap.env('DEPLOY_DOMAIN')
				},
				kinds: {
					domain: 'hostname'
				}
			}
		}),
		mode: '600',
		owner: DEPLOY_USER,
		group: DEPLOY_USER,
		depends_on: ['shared-dir', 'postgresql-init']
	});

	// Systemd service file
	zap.file({
		id: 'systemd-service',
		name: 'systemd service unit',
		path: `/etc/systemd/system/${SERVICE_NAME}.service`,
		content: {
			type: 'inline',
			content: hardened_systemd_unit({
				description: 'fuz_forge server (fuzfd)',
				exec_start: `${CURRENT_LINK}/dist_artifacts/fuzfd start`,
				user: DEPLOY_USER,
				working_directory: CURRENT_LINK,
				read_write_paths: [APP_DIR, `/home/${DEPLOY_USER}/.fuz_forge`],
				env_file: `${SHARED_DIR}/.env.production`,
				after: ['network.target', 'postgresql.service'],
				wants: ['postgresql.service'],
				hardening_comment: `# Additional sandboxing — all safe for an Axum/tokio daemon that shells out to
# git http-backend + python3 hooks and talks to local PostgreSQL. (Not added:
# MemoryDenyWriteExecute — too likely to break the git subprocess.)
# AF_UNIX+AF_INET[6] cover the TCP listener, the Postgres socket, and the hooks'
# loopback callbacks.`
			})
		},
		depends_on: ['env-production']
	});

	zap.service({
		id: 'fuz_forge-service',
		name: `${SERVICE_NAME} service`,
		service: SERVICE_NAME,
		enabled: true,
		// Don't set running: true - service will fail until first deploy
		// A changed unit or env file restarts the daemon so it runs on the new values.
		restart_on: ['systemd-service', 'env-production'],
		// `fuz_forge-config-dir` (`~/.fuz_forge`) must exist before start: it's
		// in the unit's ReadWritePaths and is the parent of the fact + repo
		// stores the daemon creates on first write.
		depends_on: ['systemd-service', 'fuz_forge-config-dir']
	});

	//
	// Phase 8: SSL Certificate
	//
	// FRESH-HOST BOOTSTRAP uses certbot certonly --standalone (never --nginx, so
	// certbot never edits nginx config): it briefly stops nginx to free port 80,
	// issues the first cert, then nginx-config brings nginx back with the SSL
	// block. RENEWAL, however, runs unattended from certbot.timer and CANNOT stop
	// nginx — so `certbot-renewal-webroot` below re-issues once via --webroot
	// (nginx serves the challenge on port 80) to switch the renewal authenticator
	// to webroot. Standalone renewal would fail ("port 80 already in use").
	//
	zap.directory({
		id: 'certbot-webroot-dir',
		name: 'ACME challenge webroot',
		path: '/var/www/certbot',
		mode: '755',
		owner: 'root',
		group: 'root',
		depends_on: ['create-user']
	});

	zap.script({
		id: 'ssl-certificate',
		name: 'SSL certificate via certbot (bootstrap)',
		...debian_certbot_standalone_issue(),
		depends_on: ['nginx', 'certbot']
	});

	// Switch the renewal authenticator to webroot so the unattended
	// certbot.timer renewal works while nginx holds port 80. Idempotent: once
	// the renewal config records webroot, the check passes and this is skipped.
	// Re-issues once via --webroot (nginx must be up serving the
	// /.well-known/acme-challenge/ location), which rewrites the renewal params.
	// The switch re-issues the certificate, and certbot runs deploy hooks only for
	// `renew` before 5.3, so it runs the reload hook itself.
	const certbot_reload_hook = debian_certbot_reload_nginx_hook();
	zap.script({
		id: 'certbot-renewal-webroot',
		name: 'Switch cert renewal to webroot',
		...certbot_webroot_switch({ deploy_hook: certbot_reload_hook }),
		depends_on: ['certbot-webroot-dir', 'nginx-service', 'certbot-deploy-hook']
	});

	// certbot.timer renews but reloads nothing, so nginx would keep serving the old
	// certificate: certbot runs this hook after each renewal to reload it.
	zap.file({
		id: 'certbot-deploy-hook',
		name: 'Reload nginx after certbot renews',
		...certbot_reload_hook,
		depends_on: ['certbot']
	});

	//
	// Phase 9: Nginx Configuration
	// Nginx config includes SSL directives — zap owns the full config, certbot never touches it.
	// Depends on ssl-certificate so cert files exist when nginx starts.
	//

	// Nginx shared config files: the TLS snippet at SSL_PARAMS_PATH, which the server
	// blocks include, and the rate-limit zone, loaded in the http context via conf.d/
	zap.file({
		id: 'nginx-ssl-params',
		name: 'nginx shared SSL parameters',
		path: SSL_PARAMS_PATH,
		content: { type: 'inline', content: ssl_params() },
		validate: NGINX_VALIDATE,
		depends_on: ['nginx']
	});

	zap.file({
		id: 'nginx-rate-limit',
		name: 'nginx rate limit zone',
		path: '/etc/nginx/conf.d/rate_limit.conf',
		content: { type: 'inline', content: rate_limit_zone() },
		validate: NGINX_VALIDATE,
		depends_on: ['nginx']
	});

	zap.file({
		id: 'nginx-config',
		name: 'nginx site config',
		path: `/etc/nginx/sites-available/${zap.env('DEPLOY_DOMAIN')}`,
		content: nginx_config({ domain: zap.env('DEPLOY_DOMAIN'), port: '4040' }),
		validate: NGINX_VALIDATE,
		depends_on: ['nginx', 'ssl-certificate', 'nginx-ssl-params', 'nginx-rate-limit']
	});

	zap.link({
		id: 'nginx-enabled',
		name: 'Enable nginx site',
		path: `/etc/nginx/sites-enabled/${zap.env('DEPLOY_DOMAIN')}`,
		target: `/etc/nginx/sites-available/${zap.env('DEPLOY_DOMAIN')}`,
		depends_on: ['nginx-config']
	});

	// One-time: remove default site and validate config
	const nginx_catch_all = debian_nginx_catch_all();
	zap.script({
		id: 'nginx-remove-default',
		name: 'Remove default nginx site',
		...nginx_catch_all.remove_default,
		depends_on: ['nginx-enabled']
	});
	// A host name no site serves gets no answer (444, and no TLS handshake)
	zap.file({
		id: 'nginx-catch-all',
		name: 'nginx catch-all server',
		...nginx_catch_all.catch_all,
		depends_on: ['nginx-remove-default']
	});

	// Reload nginx when any config file changes
	zap.service({
		id: 'nginx-service',
		name: 'nginx service',
		service: 'nginx',
		enabled: true,
		running: true,
		reload_on: [
			'nginx-config',
			'nginx-ssl-params',
			'nginx-rate-limit',
			'nginx-enabled',
			'nginx-catch-all'
		],
		depends_on: ['nginx-catch-all']
	});

	// Re-check the on-disk config every plan — see `nginx_config_verify`.
	zap.verify({
		id: 'nginx-config-valid',
		name: 'nginx config passes nginx -t',
		...nginx_config_verify(),
		depends_on: ['nginx-service']
	});

	//
	// Phase 10: SSH Hardening (LAST - after everything works)
	// Disables root login and password auth. Only fuz_forge user with SSH key can connect.
	//

	// Final verification before hardening SSH - this is the last chance to abort
	// before root login is disabled. Re-verify everything critical.
	zap.verify({
		id: 'verify-pre-hardening',
		name: 'Final verification before SSH hardening',
		assertions: [
			{
				type: 'path_exists',
				path: `/home/${DEPLOY_USER}/.ssh/authorized_keys`,
				mode: '600',
				owner: DEPLOY_USER,
				not_empty: true
			},
			{ type: 'command', run: 'sudo whoami', expect: 'root' }
		],
		depends_on: ['nginx-service']
	});

	// One options object for the drop-in and its verify, so the two can't drift
	const hardening = { user: DEPLOY_USER };

	// `00-` so the hardening sorts before any other drop-in: sshd keeps the first
	// value it reads, so a later one (a cloud image's `50-cloud-init.conf`) can't
	// re-enable password auth
	zap.file({
		id: 'ssh-hardened-config',
		name: 'SSH hardening config',
		path: '/etc/ssh/sshd_config.d/00-hardened.conf',
		content: { type: 'inline', content: ssh_hardening(hardening) },
		validate: SSHD_VALIDATE,
		depends_on: ['verify-pre-hardening']
	});

	// The drop-in's earlier name; removed after its replacement is in place.
	// TODO: drop once every host has converged off it
	zap.script({
		id: 'ssh-old-hardened-config-removed',
		name: 'Remove the old 99-hardened.conf SSH drop-in',
		check: "sudo test ! -e '/etc/ssh/sshd_config.d/99-hardened.conf'",
		run: "sudo rm -f -- '/etc/ssh/sshd_config.d/99-hardened.conf'",
		depends_on: ['ssh-hardened-config']
	});

	zap.service({
		id: 'ssh-service',
		name: 'sshd',
		...debian_ssh_service({ reload_on: ['ssh-hardened-config', 'ssh-old-hardened-config-removed'] }),
		depends_on: ['ssh-hardened-config', 'ssh-old-hardened-config-removed']
	});

	// Re-asserts the hardening in sshd's effective config on every plan
	zap.verify({
		id: 'ssh-hardening-valid',
		name: 'Effective sshd config is hardened',
		...ssh_hardening_verify(hardening),
		depends_on: ['ssh-service']
	});

	//
	// Deployment Configuration
	//

	// Env is owned entirely by the systemd unit: `apply` provisions the absolute
	// `shared/.env.production` (the `env-production` file resource) and the unit
	// injects it via `EnvironmentFile`. The binary reads process env, not a
	// release-relative file, so no per-release `shared` symlink is needed.
	zap.deploy({
		build: 'gro build',
		artifacts: ['build/', 'dist_artifacts/'],
		path: APP_DIR,
		releases: 5,
		service: SERVICE_NAME,
		// Poll `https://<DEPLOY_DOMAIN>/ready` after restart. `/ready` is
		// the schema-drift gate (the spine probe over the committed
		// `expected_schema.json`): a drifted or DB-unreachable release returns 503 and
		// rolls back rather than promoting code that can't serve its schema. Also fails
		// the deploy if the forge doesn't come up at all.
		health: { domain: zap.env('DEPLOY_DOMAIN'), path: '/ready' }
	});
};
