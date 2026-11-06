/**
 * `@fuzdev/fuz_schema` twin of the Zod `RepoId` (`repo_id.ts`), under the
 * same name, for schemas written in fuz_schema.
 *
 * One grammar and one output: fuz_schema's `uuid` is the grammar of
 * `@fuzdev/fuz_app`'s `Uuid` that the Zod `RepoId` mirrors, so every input gets
 * the same verdict and the same lowercase output from both, and a test holds
 * their rendered JSON Schema patterns equal.
 *
 * The twin is `@nodocs` while the Zod `RepoId` stays, as the docs build
 * refuses two exports of one name.
 *
 * @module
 */

import { pipe, string, to_lower_case, uuid, type Infer } from '@fuzdev/fuz_schema/schema.ts';

/**
 * The wire/dir/URL handle for a forge repo, the twin of the Zod `RepoId`,
 * whose doc has the grammar and why it is unbranded: a UUID of RFC 9562 in
 * either case, output in lowercase, the form Postgres renders a `uuid` in.
 *
 * @nodocs
 */
export const RepoId = pipe(string, uuid, to_lower_case);
/** @nodocs */
export type RepoId = Infer<typeof RepoId>;
