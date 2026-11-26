/**
 * The `unit` project's `setupFiles` entry (`vite.config.ts`): refuses the
 * default database factory (`install_unit_db_guard`), so a test that opens a
 * database without the `.db.test.ts` suffix fails naming the fix rather than
 * starting a database in a parallel worker.
 *
 * @module
 */

import { install_unit_db_guard } from '@fuzdev/fuz_app/testing/db.ts';

install_unit_db_guard();
