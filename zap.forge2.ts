/**
 * zap configuration for `<forge2-host>` — the **Alpine/OpenRC** production
 * mirror of `zap.ts` (the Debian forge at `<forge-host>`).
 *
 * Same fuz_forge deployment, different host family: apk + OpenRC instead of
 * apt + systemd. It imports the `recipe_alpine_*` family (the Debian config
 * imports `recipe_debian_*`); the neutral recipes (`ssl_params`,
 * `rate_limit_zone`, `ssh_hardening`, `fuz_app_*`, the certbot issuance scripts)
 * are shared verbatim.
 *
 * Apply it against a forge2-specific operator env (the `DEPLOY_*` /
 * `SECRET_*` references resolve from a `--env-file` pointing at `<forge2-host>`),
 * i.e. `npm run apply:forge2` (the dry run, which records the plan) then
 * `npm run apply:forge2 -- --wetrun` (which runs only that plan).
 *
 * ## Alpine divergences from `zap.ts` (all distro-shaped, no engine difference)
 *
 * - **shadow/bash/sudo prerequisites** — BusyBox lacks `useradd`/`usermod` and
 *   `/bin/bash`, and Alpine's `sudo` is a `community` package, so the `user`
 *   resource declares them as `zap.pkg` deps (the Debian base ships all three).
 * - **OpenRC service** — `hardened_openrc_service` (a `supervise-daemon`
 *   init script with Tier-A privilege hardening + Tier-B bubblewrap FS isolation)
 *   replaces the systemd unit.
 * - **nginx `http.d/` layout** — site + rate-limit live in the auto-included
 *   `http.d/` (Alpine's `conf.d/` is the *main* context); the SSL snippet stays
 *   in `snippets/` (auto-including it re-declares the `shared:SSL` zone). No
 *   `sites-enabled` symlink — `http.d/*.conf` is loaded directly.
 * - **PostgreSQL from `community`** — `apk add postgresql18` (+ `-openrc`,
 *   `-contrib`); no third-party repo. `apk` doesn't init the cluster like `apt`,
 *   so `alpine_postgres_setup` runs the OpenRC `setup` before the service starts.
 *   The OpenRC service is the version-agnostic `postgresql`.
 * - **certbot renewal via cron** — Alpine ships no `certbot.timer`, so a daily
 *   `/etc/periodic/daily/certbot-renew` script + a running `crond` stand in; the
 *   nginx reload after a renewal is a deploy hook file, as on Debian.
 * - **nftables firewall** — the native nftables backend (a declarative `inet filter`
 *   ruleset loaded with `nft -f`) instead of the Debian forge's ufw, with port/proto
 *   rules (22 / 80 / 443 tcp); a separate nftables service makes it boot-persistent.
 *
 * Service hardening runs both tiers: Tier A (OpenRC-native privilege drop) and
 * Tier B (bubblewrap filesystem isolation — read-only root, private /tmp, with
 * the app/config/log dirs bound read-write) are enabled.
 *
 * @module
 */

import type { ZapBuilder } from '@fuzdev/zap/zap.ts';
import { fail2ban_jail } from '@fuzdev/zap/recipe_fail2ban.ts';
import { SSHD_VALIDATE, ssh_hardening, ssh_hardening_verify } from '@fuzdev/zap/recipe_ssh.ts';
import { alpine_ssh_service } from '@fuzdev/zap/recipe_alpine_ssh.ts';
import {
	ssl_params,
	SSL_PARAMS_PATH,
	rate_limit_zone,
	NGINX_VALIDATE,
	nginx_config_verify
} from '@fuzdev/zap/recipe_nginx.ts';
import {
	alpine_nginx_spa_site,
	alpine_nginx_catch_all
} from '@fuzdev/zap/recipe_alpine_nginx.ts';
import { hardened_openrc_service } from '@fuzdev/zap/recipe_alpine_openrc.ts';
import { alpine_postgres_setup } from '@fuzdev/zap/recipe_alpine_postgres.ts';
import {
	LINK_PROTECTION_SYSCTL_PATH,
	LINK_PROTECTION_SYSCTLS,
	sysctl_apply,
	sysctl_conf
} from '@fuzdev/zap/recipe_sysctl.ts';
import { alpine_web_firewall } from '@fuzdev/zap/recipe_alpine_firewall.ts';
import {
	alpine_certbot_standalone_issue,
	alpine_certbot_reload_nginx_hook,
	alpine_certbot_renew_cron,
	alpine_periodic_daily_file
} from '@fuzdev/zap/recipe_alpine_certbot.ts';
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
const CONFIG_DIR = `/home/${DEPLOY_USER}/.fuz_forge`;
const ENV_FILE = `${SHARED_DIR}/.env.production`;
// The installed PostgreSQL major — pinned to the Debian forge's PG18 so forge2
// can mirror forge1's data (replication/restore compatibility).
const POSTGRES_VERSION = 18;

//
// Template Constants
//

// Environment template — the shared fuz_app base (`recipe_env`) + the forge's
// allowed-origins, trusted-proxies, and file-store-cap stanza. Identical to the Debian config.
const ENV_BASE = {
	user: DEPLOY_USER,
	service: SERVICE_NAME,
	config_dir: CONFIG_DIR
};
const ENV_EXTRA = `
# Security - allowed origins for API requests
FUZ_ALLOWED_ORIGINS='https://{{domain}}'

${fuz_app_trusted_proxies({ env_prefix: 'FORGE' })}

# File store - the upload cap, matching nginx's client_max_body_size
FUZ_FORGE_FILE_STORE_MAX_BYTES=${FORGE_FILE_STORE_MAX_BYTES}`;

// Content-Security-Policy for the prerendered SPA — the locked-down fuz_app
// baseline (distro-neutral; identical to the Debian config).
const CSP = spa_csp();

// Nginx config — the fuz_app SPA site recipe (Alpine wrapper: the SSL snippet
// include resolves to `snippets/`, not the auto-included `http.d/`). zap owns the
// full config including SSL directives; certbot only manages cert files (never
// `--nginx`). `extra_locations` carries the forge-specific surface the generic
// recipe doesn't: the loopback-only `/internal` 404, the large-body file store,
// and git smart-HTTP (`*.git/*`). Byte-identical server block to the Debian forge.
const nginx_config = (site: { domain: string; port: string }) =>
	alpine_nginx_spa_site({
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
	zap.target({
		host: zap.env('DEPLOY_HOST'),
		user: zap.env('DEPLOY_USER'),
		// The stock Alpine image login user, for a fresh/rebuilt host: `zap apply
		// --bootstrap` connects as this to provision + harden (which then creates
		// `fuz_forge` and locks `alpine` out); every later run omits `--bootstrap`.
		bootstrap_user: zap.env('BOOTSTRAP_USER'),
		package_manager: 'apk',
		service_manager: 'openrc'
	});

	//
	// Phase 1: Foundation & Recovery
	//

	// Root password for console recovery is a one-time bootstrap, not convergence
	// state — set it out-of-band on first console access.

	zap.swap({
		id: 'swap-file',
		name: '2GB swap file',
		size: '2G'
	});

	//
	// Phase 2: User Management
	//

	// shadow supplies `useradd`/`usermod` (BusyBox lacks `usermod`, which the
	// idempotent shell-fix step needs), bash supplies the `/bin/bash` login shell,
	// and sudo (community) backs the NOPASSWD `/etc/sudoers.d/<user>` drop-in — all
	// stock on Debian, explicit `apk` deps here.
	zap.pkg({ id: 'shadow', name: 'shadow (useradd/usermod)', from: { apk: 'shadow' } });
	zap.pkg({ id: 'bash', name: 'bash login shell', from: { apk: 'bash' } });
	zap.pkg({ id: 'sudo', name: 'sudo (community)', from: { apk: 'sudo' } });

	zap.user({
		id: 'create-user',
		name: 'Create fuz_forge user with SSH keys and sudo',
		username: DEPLOY_USER,
		shell: '/bin/bash',
		home_mode: '711', // Allow nginx to traverse home directory
		ssh_keys: { copy_from: 'root' },
		sudo: 'nopasswd',
		depends_on: ['swap-file', 'shadow', 'bash', 'sudo']
	});

	//
	// Phase 3: Packages
	//

	zap.pkg({ id: 'curl', name: 'curl', from: { apk: 'curl' } });
	zap.pkg({ id: 'unzip', name: 'unzip', from: { apk: 'unzip' } });
	// `git` creates bare repos and serves them over smart-HTTP (git http-backend).
	zap.pkg({ id: 'git', name: 'git', from: { apk: 'git' } });
	// The repo hooks (`pre-receive` / `post-receive`) are python3 scripts that
	// git runs on every push.
	zap.pkg({ id: 'python3', name: 'python3 (repo hooks)', from: { apk: 'python3' } });

	// No JS runtime on the host: `fuzfd` is a self-contained Rust binary and
	// provisioning runs through the standalone `zap` binary.

	zap.pkg({ id: 'fail2ban', name: 'fail2ban intrusion prevention', from: { apk: 'fail2ban' } });
	// `apk add nginx` pulls `nginx-openrc` (the OpenRC service) automatically.
	zap.pkg({ id: 'nginx', name: 'nginx web server', from: { apk: 'nginx' } });
	zap.pkg({ id: 'certbot', name: 'certbot SSL tool', from: { apk: 'certbot' } });
	// `apk add nftables` provides the `nft` CLI and the nftables OpenRC service.
	zap.pkg({ id: 'nftables', name: 'nftables firewall', from: { apk: 'nftables' } });
	// Tier-B filesystem isolation wraps the service command in a `bwrap` sandbox.
	zap.pkg({ id: 'bubblewrap', name: 'bubblewrap sandbox', from: { apk: 'bubblewrap' } });

	// PostgreSQL 18 from Alpine's repos (no third-party repo). `-openrc` provides
	// the version-agnostic `postgresql` OpenRC service; `-contrib` matches the
	// Debian forge's `postgresql-contrib`-equivalent surface.
	zap.pkg({
		id: 'postgresql',
		name: 'PostgreSQL 18 database',
		from: { apk: `postgresql${POSTGRES_VERSION}` }
	});
	zap.pkg({
		id: 'postgresql-openrc',
		name: 'PostgreSQL OpenRC service',
		from: { apk: `postgresql${POSTGRES_VERSION}-openrc` },
		depends_on: ['postgresql']
	});
	zap.pkg({
		id: 'postgresql-contrib',
		name: 'PostgreSQL contrib modules',
		from: { apk: `postgresql${POSTGRES_VERSION}-contrib` },
		depends_on: ['postgresql']
	});

	//
	// Phase 4: Security
	//

	// The kernel's link and file protections; Alpine sets only the first two of them
	zap.file({
		id: 'sysctl-link-protection',
		name: 'kernel link protections',
		path: LINK_PROTECTION_SYSCTL_PATH,
		content: { type: 'inline', content: sysctl_conf(LINK_PROTECTION_SYSCTLS) }
	});
	zap.script({
		id: 'sysctl-link-protection-applied',
		name: 'kernel link protections in force',
		...sysctl_apply(LINK_PROTECTION_SYSCTL_PATH, LINK_PROTECTION_SYSCTLS),
		depends_on: ['sysctl-link-protection']
	});

	// Alpine has no /var/log/auth.log — busybox syslog writes sshd auth to
	// /var/log/messages, which fail2ban's sshd jail watches instead.
	zap.file({
		id: 'fail2ban-config',
		name: 'fail2ban jail.local',
		path: '/etc/fail2ban/jail.local',
		content: {
			type: 'inline',
			content: fail2ban_jail({ sshd_logpath: '/var/log/messages', banaction: 'nftables' })
		},
		depends_on: ['fail2ban']
	});

	// busybox syslog produces /var/log/messages (fail2ban's logpath). The cloud image
	// starts it but doesn't add it to a runlevel, so enable it — otherwise it (and the
	// log fail2ban needs) would vanish on reboot.
	zap.service({
		id: 'syslog-service',
		name: 'busybox syslog',
		service: 'syslog',
		enabled: true,
		running: true
	});

	zap.service({
		id: 'fail2ban-service',
		name: 'fail2ban service',
		service: 'fail2ban',
		enabled: true,
		running: true,
		restart_on: ['fail2ban-config'],
		depends_on: ['fail2ban-config', 'syslog-service']
	});

	// Firewall — the native nftables backend (a declarative inet filter ruleset). zap
	// writes /etc/nftables.nft and loads it with `nft -f`; the established/loopback
	// accepts precede the default-drop policy, so applying it never severs the live SSH
	// session. Port/proto rules only — nftables has no ufw-style app profiles.
	// The SSH + HTTP + HTTPS allow set and the boot-persistence service come from the
	// shared recipe (one baseline across the fuz_app deploys; the service reloads
	// /etc/nftables.nft at boot, the firewall resource writes + applies it live).
	const fw = alpine_web_firewall();
	zap.firewall({
		id: 'nftables-firewall',
		name: 'Configure nftables firewall',
		...fw.firewall,
		depends_on: ['nftables']
	});
	zap.service({
		id: 'nftables-service',
		name: 'nftables firewall service',
		...fw.service,
		depends_on: ['nftables-firewall']
	});

	zap.verify({
		id: 'verify-post-firewall',
		name: 'Verify SSH after firewall',
		assertions: [{ type: 'command', run: 'true' }],
		depends_on: ['nftables-service']
	});

	//
	// Phase 5: PostgreSQL Initialization
	//

	// Alpine's `apk` doesn't init the data cluster (Debian's `apt` does), so run
	// the OpenRC `setup` once before the service starts.
	zap.script({
		id: 'postgres-cluster-init',
		name: 'Initialize the PostgreSQL data cluster',
		...alpine_postgres_setup({ version: POSTGRES_VERSION }),
		depends_on: ['postgresql-openrc', 'verify-post-firewall']
	});

	zap.service({
		id: 'postgresql-service',
		name: 'PostgreSQL service',
		service: 'postgresql',
		enabled: true,
		running: true,
		depends_on: ['postgres-cluster-init']
	});

	zap.database({
		id: 'postgresql-init',
		name: 'Initialize PostgreSQL database',
		engine: 'postgresql',
		database_name: SERVICE_NAME,
		username: DEPLOY_USER,
		depends_on: ['postgresql-service']
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
		path: CONFIG_DIR,
		mode: '700',
		owner: DEPLOY_USER,
		group: DEPLOY_USER,
		depends_on: ['create-user']
	});

	//
	// Phase 7: Configuration Files
	//

	zap.script({
		id: 'bootstrap-token',
		name: 'Create bootstrap token',
		...fuz_app_bootstrap_token({
			user: DEPLOY_USER,
			service: SERVICE_NAME,
			config_dir: CONFIG_DIR
		}),
		depends_on: ['fuz_forge-config-dir', 'postgresql-init']
	});

	zap.file({
		id: 'env-production',
		name: 'Production environment',
		path: ENV_FILE,
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

	// OpenRC service — supervise-daemon + Tier-A hardening (drop to fuz_forge,
	// drop all capabilities, no_new_privs). The env file is read as data into the
	// daemon's environment, as the service user (OpenRC has no EnvironmentFile=, so the
	// recipe checks it before start and exports it after the drop). Tier-B bwrap isolation
	// is enabled (read-only root + private /tmp + the declared rw binds), layered
	// over the Tier-A privilege drop.
	zap.file({
		id: 'openrc-service',
		name: 'OpenRC service script',
		path: `/etc/init.d/${SERVICE_NAME}`,
		mode: '755',
		content: {
			type: 'inline',
			content: hardened_openrc_service({
				name: SERVICE_NAME,
				description: 'fuz_forge server (fuzfd)',
				command: `${CURRENT_LINK}/dist_artifacts/fuzfd`,
				command_args: 'start',
				user: DEPLOY_USER,
				working_directory: CURRENT_LINK,
				env_file: ENV_FILE,
				ulimit_nofile: 65535,
				uses: ['postgresql'],
				isolation: {
					// Bind read-write everything fuzfd writes at runtime: the app/release tree,
					// the config/state dir, and the (self-provisioned) log dir. Postgres is reached
					// over its Unix socket in /run/postgresql, which the read-only root bind already
					// shows (connecting needs no write), so no extra bind is needed.
					read_write_paths: [APP_DIR, CONFIG_DIR, `/var/log/${SERVICE_NAME}`]
				},
				// The recipe self-provisions this dir via its `start_pre()` checkpath hook
				// (creating and chowning the parent to the service user, as root, before the
				// privilege drop), so no separate directory resource is needed.
				log_file: `/var/log/${SERVICE_NAME}/server.log`
			})
		},
		depends_on: ['env-production', 'bubblewrap']
	});

	zap.service({
		id: 'fuz_forge-service',
		name: `${SERVICE_NAME} service`,
		service: SERVICE_NAME,
		enabled: true,
		// Don't set running: true — the service fails until the first deploy lands
		// the binary.
		// A changed init script or env file restarts the daemon so it runs on the new values.
		restart_on: ['openrc-service', 'env-production'],
		depends_on: ['openrc-service', 'fuz_forge-config-dir']
	});

	//
	// Phase 8: SSL Certificate
	//
	// Bootstrap issues via certbot certonly --standalone (briefly stopping nginx
	// to free port 80); renewal runs unattended from cron and switches to
	// --webroot so it works while nginx holds port 80.
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
		...alpine_certbot_standalone_issue(),
		depends_on: ['nginx', 'certbot']
	});

	// The switch re-issues the certificate, and certbot runs deploy hooks only for
	// `renew` before 5.3, so it runs the reload hook itself.
	const certbot_reload_hook = alpine_certbot_reload_nginx_hook();
	zap.script({
		id: 'certbot-renewal-webroot',
		name: 'Switch cert renewal to webroot',
		...certbot_webroot_switch({ deploy_hook: certbot_reload_hook }),
		depends_on: ['certbot-webroot-dir', 'nginx-service', 'certbot-deploy-hook']
	});

	// Alpine ships no certbot.timer — a daily periodic script + a running crond
	// replace it. `crond` is provided by the BusyBox base; just enable + run it.
	zap.file({
		id: 'certbot-renew-cron',
		name: 'Daily certbot renewal cron',
		...alpine_periodic_daily_file({ name: 'certbot-renew', body: alpine_certbot_renew_cron() }),
		depends_on: ['certbot']
	});

	zap.service({
		id: 'crond-service',
		name: 'crond (periodic cron)',
		service: 'crond',
		enabled: true,
		running: true,
		depends_on: ['certbot-renew-cron']
	});

	// The cron renews but reloads nothing, so nginx would keep serving the old
	// certificate: certbot runs this hook after each renewal to reload it.
	zap.file({
		id: 'certbot-deploy-hook',
		name: 'Reload nginx after certbot renews',
		...certbot_reload_hook,
		depends_on: ['certbot']
	});

	//
	// Phase 9: Nginx Configuration
	// Alpine layout: site + rate-limit in the auto-included http.d/; the SSL
	// snippet in snippets/ (not auto-included); no sites-enabled symlink.
	//

	// Alpine's nginx package ships no snippets/ dir, but zap's file write creates the
	// parent automatically (mode 755 — the mkdir default root needs for traversal), so no
	// dedicated `directory` resource is required.
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
		// http.d/ (http context), NOT conf.d/ — Alpine includes conf.d at the main
		// context, where `limit_req_zone` is invalid.
		path: '/etc/nginx/http.d/rate_limit.conf',
		content: { type: 'inline', content: rate_limit_zone() },
		validate: NGINX_VALIDATE,
		depends_on: ['nginx']
	});

	zap.file({
		id: 'nginx-config',
		name: 'nginx site config',
		// http.d/*.conf is auto-included — the site loads with no symlink.
		path: `/etc/nginx/http.d/${zap.env('DEPLOY_DOMAIN')}.conf`,
		content: nginx_config({ domain: zap.env('DEPLOY_DOMAIN'), port: '4040' }),
		validate: NGINX_VALIDATE,
		depends_on: ['nginx', 'ssl-certificate', 'nginx-ssl-params', 'nginx-rate-limit']
	});

	// One-time: remove the stock http.d/default.conf and validate config.
	const nginx_catch_all = alpine_nginx_catch_all();
	zap.script({
		id: 'nginx-remove-default',
		name: 'Remove default nginx site',
		...nginx_catch_all.remove_default,
		depends_on: ['nginx-config']
	});
	// A host name no site serves gets no answer (444, and no TLS handshake)
	zap.file({
		id: 'nginx-catch-all',
		name: 'nginx catch-all server',
		...nginx_catch_all.catch_all,
		depends_on: ['nginx-remove-default']
	});

	zap.service({
		id: 'nginx-service',
		name: 'nginx service',
		service: 'nginx',
		enabled: true,
		running: true,
		reload_on: ['nginx-config', 'nginx-ssl-params', 'nginx-rate-limit', 'nginx-catch-all'],
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
	// Phase 10: SSH Hardening (LAST — after everything works)
	//

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
		...alpine_ssh_service({ reload_on: ['ssh-hardened-config', 'ssh-old-hardened-config-removed'] }),
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

	// The release mechanism is distro-neutral (build → tarball → scp → extract →
	// atomic swap → restart the service via OpenRC → poll /ready). The service
	// restart routes through the OpenRC arm automatically (the target declares
	// service_manager: 'openrc').
	zap.deploy({
		// forge2 is Alpine (musl) — cross-compile fuzfd/fuzf as static musl binaries via
		// cargo-zigbuild (the gro cargo plugin reads FUZ_FORGE_BUILD_TARGET). A host glibc
		// build (the Debian forge's plain `gro build`) would not run on Alpine.
		build: 'FUZ_FORGE_BUILD_TARGET=x86_64-unknown-linux-musl gro build',
		artifacts: ['build/', 'dist_artifacts/'],
		path: APP_DIR,
		releases: 5,
		service: SERVICE_NAME,
		health: { domain: zap.env('DEPLOY_DOMAIN'), path: '/ready' }
	});
};
