import * as s from '@fuzdev/fuz_schema/schema.ts';
import { fs } from '@fuzdev/gro/fs.ts';
import { create_fs_paths } from '@fuzdev/gro/fs_paths.ts';
import { GIT_LOCAL_PASS_ENV, to_git_program } from '@fuzdev/gro/git.ts';
import { process } from '@fuzdev/gro/process.ts';
import { spawn } from '@fuzdev/gro/spawn.ts';
import type { Task } from '@fuzdev/gro/task.ts';

import { GH_PROGRAM_OPTIONS, run_release } from '#lib/release.ts';

export const Args = s.object({});
export type Args = s.Infer<typeof Args>;

/** `npm run release` */
export const task: Task<Args> = {
	summary: 'build fuzf and fuzfd and publish them as a GitHub release',
	Args,
	run: async ({ invoke_task }) => {
		const env = process.env.narrow(['FUZ_FORGE_BUILD_TARGET', 'FUZ_FORGE_BUILD_SKIP_SERVER']);
		await run_release({
			project: fs.project,
			paths: create_fs_paths(fs),
			// the working-tree check only reads the local repo
			git: to_git_program(spawn, { pass_env: GIT_LOCAL_PASS_ENV }),
			gh: spawn.find('gh', GH_PROGRAM_OPTIONS),
			build: () => invoke_task('build'),
			build_env: {
				FUZ_FORGE_BUILD_TARGET: env.get('FUZ_FORGE_BUILD_TARGET'),
				FUZ_FORGE_BUILD_SKIP_SERVER: env.get('FUZ_FORGE_BUILD_SKIP_SERVER')
			}
		});
	}
};
