const express = require("express");
const { randomUUID } = require("node:crypto");
const { pool } = require("../db/pool");
const { accountSchema, uuidSchema } = require("../utils/validation");
const { createHttpError } = require("../middleware/errors");

const router = express.Router();

// POST /api/accounts
router.post("/", async (req, res, next) => {
  try {
    const input = accountSchema.parse(req.body);
    const id = randomUUID();
    const result = await pool.query(
      `INSERT INTO accounts (id, name, balance)
       VALUES ($1, $2, 0)
       RETURNING id, name, balance, created_at`,
      [id, input.name]
    );
    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

// GET /api/accounts/:accountId/balance
router.get("/:accountId/balance", async (req, res, next) => {
  try {
    const accountId = uuidSchema.parse(req.params.accountId);
    const result = await pool.query(
      "SELECT id AS account_id, balance FROM accounts WHERE id = $1",
      [accountId]
    );
    if (result.rowCount === 0) {
      throw createHttpError(404, "ACCOUNT_NOT_FOUND", "Account was not found.");
    }
    res.status(200).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
