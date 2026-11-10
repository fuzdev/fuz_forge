import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import type { Task } from '@fuzdev/gro/task.ts';

import { run_prod_setup } from '#lib/setup/prod_setup.ts';

export const Args = s.object({});
export type Args = s.Infer<typeof Args>;

/** `npm run prod:setup` */
export const task: Task<Args> = {
	summary: "create the forge target's .env.production from its example and list what's unset",
	Args,
	run: async () => {
		await run_prod_setup(create_node_runtime([]));
	}
};
