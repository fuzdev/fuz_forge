import { create_db } from '@fuzdev/fuz_app/db/create_db.ts';
import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import type { Task } from '@fuzdev/gro/task.ts';

import { run_db_status } from '#lib/setup/db_status.ts';

export const Args = s.object({});
export type Args = s.Infer<typeof Args>;

/** `npm run db:status` */
export const task: Task<Args> = {
	summary: "the dev database's connectivity, tables, and migrations, read-only",
	Args,
	run: async () => {
		await run_db_status({
			runtime: create_node_runtime([]),
			connect: (database_url) => create_db(database_url)
		});
	}
};
