/**
 * The forge-specific nginx `location` blocks, shared by both deploy configs.
 *
 * `zap.ts` (Debian/systemd) and `zap.forge2.ts` (Alpine/OpenRC) differ only in
 * distro shape — package manager, service manager, nginx include layout — and
 * both document the server block as identical. Holding these blocks in one
 * place is what makes that claim true: hand-duplicated copies drift, and a
 * copy that drops `X-Forwarded-Proto` on the git route has the daemon read
 * HTTPS pushes as plaintext.
 *
 * `{{port}}` stays a literal placeholder for zap's template engine.
 *
 * @module
 */

/**
 * The file-store upload cap on a deployed host, in bytes: nginx's
 * `client_max_body_size` on the file-store location, and the host's
 * `FUZ_FORGE_FILE_STORE_MAX_BYTES` (both deploy configs append it to the host
 * env), so the edge and the backend refuse at the same size.
 */
export const FORGE_FILE_STORE_MAX_BYTES = 900 * 1024 * 1024;

/**
 * Build the forge `extra_locations` block for `{debian,alpine}_nginx_spa_site`.
 *
 * Three blocks the generic SPA recipe doesn't carry: the loopback-only
 * `/internal` 404, the large-body file store, and git smart-HTTP.
 *
 * None of them sets `add_header`, which is load-bearing — nginx drops every
 * inherited `add_header` in a block that declares one of its own, so staying
 * silent is what keeps the server-level security headers applying here.
 *
 * Neither the file store nor the git route carries `limit_req`, and that is
 * deliberate rather than an omission. nginx selects them over `location /api`
 * (the file store as a `^~` prefix, which also keeps the git regex off its paths;
 * the git route as a regex, which beats any plain prefix), so the `/api` rate
 * limit never applies — which is what you want for a large push or a slow clone,
 * where a request-rate cap would reject legitimate traffic long before it
 * deterred anyone. The git regex matches exactly the daemon's git route shape,
 * `/<org>/<repo>.git/…`, so no other `/api` path escapes the rate limit or the
 * default body cap through it; an `/api/<repo>.git/…` path is the git route for
 * an org named `api`. Their bound is
 * the body-size cap plus the daemon's own auth, which refuses a git Basic
 * password without an API token's shape before any query, so junk credentials
 * cost no database work. If edge throttling is ever wanted
 * here it needs a connection limit (`limit_conn`, with its `limit_conn_zone`
 * at the `http` level, outside these blocks), not a request rate.
 *
 * @returns the `extra_locations` text, indented to the server-block level with
 * no leading or trailing blank line.
 */
export const forge_nginx_locations = (): string =>
	`    # /internal/* is loopback-only on the daemon (post-receive callback,
    # repo-config lookup, etc.) — the daemon already gates on the raw TCP
    # connection IP, but the public listener should never forward these
    # paths at all. Explicit 404 here is the load-bearing layer; the
    # code-side check is defense-in-depth.
    location ~ ^/internal(/|$) {
        return 404;
    }

    # File store API — forwards Authorization header for bearer auth from CLI.
    # \`^~\`: the longest matching prefix, and nginx skips the regex locations,
    # so neither /api's rate limit nor the git route applies to file-store paths.
    location ^~ /api/fuz_forge/files {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;

        # Large uploads, capped at the backend's FUZ_FORGE_FILE_STORE_MAX_BYTES
        client_max_body_size ${FORGE_FILE_STORE_MAX_BYTES};
    }

    # Forge smart-HTTP — \`/<org>/<repo>.git/*\` paths go to the daemon's git
    # http-backend handler. The slug is exactly two segments, as the daemon's
    # route takes it. Preserves Authorization header for HTTP Basic auth (the
    # password is an API token; the username is ignored but must be non-empty).
    # Push/clone bodies can be large and slow — turn off buffering and
    # raise timeouts.
    location ~ ^/[^/]+/[^/]+\\.git/ {
        proxy_pass http://127.0.0.1:{{port}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;

        client_max_body_size 5g;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }`;
