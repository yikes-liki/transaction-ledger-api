const express = require("express");
const { randomUUID } = require("node:crypto");
const { pool } = require("../db/pool");
const { uuidSchema, transactionSchema, parsePositiveInteger } = require("../utils/validation");
const { createHttpError } = require("../middleware/errors");

const router = express.Router();

// POST /api/accounts/:accountId/transactions
router.post("/:accountId/transactions", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const accountId = uuidSchema.parse(req.params.accountId);
    const input = transactionSchema.parse(req.body);

    await client.query("BEGIN");

    // Lock the account row to serialize balance-changing operations on this account.
    const accountResult = await client.query(
      "SELECT id, balance FROM accounts WHERE id = $1 FOR UPDATE",
      [accountId]
    );
    if (accountResult.rowCount === 0) {
      throw createHttpError(404, "ACCOUNT_NOT_FOUND", "Account was not found.");
    }

    const duplicate = await client.query(
      "SELECT id FROM transactions WHERE account_id = $1 AND reference_id = $2",
      [accountId, input.reference_id]
    );
    if (duplicate.rowCount > 0) {
      throw createHttpError(409, "DUPLICATE_TRANSACTION", "A transaction with this reference_id already exists for this account.");
    }

    const currentBalance = Number(accountResult.rows[0].balance);
    if (input.type === "debit" && currentBalance < input.amount) {
      throw createHttpError(422, "INSUFFICIENT_BALANCE", "The account does not have sufficient balance.");
    }

    const newBalance = input.type === "credit"
      ? currentBalance + input.amount
      : currentBalance - input.amount;

    const transactionResult = await client.query(
      `INSERT INTO transactions (id, account_id, type, amount, description, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, account_id, type, amount, description, reference_id, created_at`,
      [randomUUID(), accountId, input.type, input.amount.toFixed(2), input.description, input.reference_id]
    );

    const balanceResult = await client.query(
      "UPDATE accounts SET balance = $1 WHERE id = $2 RETURNING balance",
      [newBalance.toFixed(2), accountId]
    );

    await client.query("COMMIT");
    res.status(201).json({
      data: {
        transaction: transactionResult.rows[0],
        balance: balanceResult.rows[0].balance
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

// GET /api/accounts/:accountId/transactions?type=credit&page=1&limit=10
router.get("/:accountId/transactions", async (req, res, next) => {
  try {
    const accountId = uuidSchema.parse(req.params.accountId);
    const page = parsePositiveInteger(req.query.page, 1, 1000000);
    const limit = parsePositiveInteger(req.query.limit, 10, 100);
    if (page === null || limit === null) {
      throw createHttpError(400, "INVALID_PAGINATION", "page and limit must be positive integers; limit cannot exceed 100.");
    }

    const type = req.query.type;
    if (type !== undefined && !["credit", "debit"].includes(type)) {
      throw createHttpError(400, "INVALID_TRANSACTION_TYPE", "type must be either credit or debit.");
    }

    const account = await pool.query("SELECT id FROM accounts WHERE id = $1", [accountId]);
    if (account.rowCount === 0) {
      throw createHttpError(404, "ACCOUNT_NOT_FOUND", "Account was not found.");
    }

    const values = [accountId];
    let whereClause = "account_id = $1";
    if (type) {
      values.push(type);
      whereClause += ` AND type = $${values.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM transactions WHERE ${whereClause}`,
      values
    );
    const totalRecords = countResult.rows[0].total;
    const totalPages = Math.ceil(totalRecords / limit);
    const offset = (page - 1) * limit;
    values.push(limit, offset);

    const result = await pool.query(
      `SELECT id, account_id, type, amount, description, reference_id, created_at
       FROM transactions
       WHERE ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );

    res.status(200).json({
      data: result.rows,
      pagination: {
        current_page: page,
        page_size: limit,
        total_records: totalRecords,
        total_pages: totalPages
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
