import { create_node_runtime } from '@fuzdev/fuz_app/runtime/node.ts';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { process } from '@fuzdev/gro/process.ts';
import type { Task } from '@fuzdev/gro/task.ts';

import { run_dev_setup, to_dev_fuz_forge_home } from '#lib/setup/dev_setup.ts';

export const Args = s.object({});
export type Args = s.Infer<typeof Args>;

/** `npm run dev:setup` */
export const task: Task<Args> = {
	summary: 'first-time dev setup: .env.development, the bootstrap token, the database',
	Args,
	run: async () => {
		await run_dev_setup(create_node_runtime([]), {
			fuz_forge_home: to_dev_fuz_forge_home(process.cwd())
		});
	}
};
