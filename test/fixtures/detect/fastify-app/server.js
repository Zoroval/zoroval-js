const fastify = require("fastify")({ logger: true });
fastify.post("/chat", async (request) => ({ id: request.body.threadId }));
fastify.listen({ port: 3000 });
