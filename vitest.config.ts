import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		// Live tests drive a real Firefox; run them with `npm run test:live`.
		exclude: ['test/live/**', 'node_modules/**'],
	},
})
