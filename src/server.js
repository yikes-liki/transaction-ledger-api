require("dotenv").config();
const app = require("./app");
const { pool } = require("./db/pool");

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => {
  console.log(`Transaction Ledger API listening on http://localhost:${port}`);
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
