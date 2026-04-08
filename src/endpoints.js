import express from 'express';
import { createServer } from 'http';
import { port } from './config.js';

class EndpointRegistry {
	constructor() {
		this.app = express();
		this.server = createServer(this.app);
		this.app.use(express.json());

		this.app.use((err, req, res, next) => {
			console.error(err.stack);
			res.status(500).json({ error: 'internal server error' });
		});
	}

	registerEndpoint(namespace, routes, options = {}) {
		const { prefix = true, middleware = [] } = options;
		const router = express.Router();

		middleware.forEach(mw => router.use(mw));

		Object.entries(routes).forEach(([path, handlers]) => {
			Object.entries(handlers).forEach(([method, handler]) => {
				router[method.toLowerCase()](path, async (req, res, next) => {
					try {
						await handler(req, res, next);
					} catch (error) {
						next(error);
					}
				});
			});
		});

		const routePath = prefix ? `/api/${namespace}` : `/${namespace}`;
		this.app.use(routePath, router);
	}

	start() {
		return new Promise((resolve) => {
			this.server.listen(port, () => {
				console.log(`listening on port ${port}`);
				resolve();
			});
		});
	}

	stop() {
		return new Promise((resolve) => {
			this.server.close(resolve);
		});
	}
}

export const endpoints = new EndpointRegistry();
