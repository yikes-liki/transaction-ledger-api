require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("./pool");

async function init() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log("Database schema initialized successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

init().catch(async (error) => {
  console.error("Database initialization failed:", error.message);
  await pool.end();
  process.exit(1);
});
