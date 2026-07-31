import http from "node:http";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { closePool } from "./db.js";
import { runMigrations } from "./migrate.js";

const start = async () => {
  await runMigrations();
  const config = getConfig();
  const server = http.createServer(createApp());
  server.listen(config.PORT, "0.0.0.0", () => {
    console.log(`Peileme API listening on 0.0.0.0:${config.PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

start().catch(async (error) => {
  console.error(error);
  await closePool();
  process.exit(1);
});
