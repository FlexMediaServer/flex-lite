import { defineConfig } from 'kysely-ctl';
import { db as kysely } from '../src/utils/database';

export default defineConfig({
	// replace me with a real dialect instance OR a dialect name + `dialectConfig` prop.
	kysely,
	migrations: {
		migrationFolder: '../migrations',
	},
	//   plugins: [],
	//   seeds: {
	//     seedFolder: "seeds",
	//   }
});
