const express = require("express");
const { randomUUID } = require("node:crypto");
const { pool } = require("../db/pool");
const { transferSchema } = require("../utils/validation");
const { createHttpError } = require("../middleware/errors");

const router = express.Router();

// Bonus: POST /api/transfers
// Both account rows are locked in sorted UUID order to reduce deadlock risk.
router.post("/", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = transferSchema.parse(req.body);
    await client.query("BEGIN");

    const accountIds = [input.from_account_id, input.to_account_id].sort();
    const locked = await client.query(
      "SELECT id, balance FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [accountIds]
    );

    if (locked.rowCount !== 2) {
      throw createHttpError(404, "ACCOUNT_NOT_FOUND", "Both source and destination accounts must exist.");
    }

    const byId = new Map(locked.rows.map((row) => [row.id, row]));
    const source = byId.get(input.from_account_id);
    const destination = byId.get(input.to_account_id);
    const sourceBalance = Number(source.balance);
    const destinationBalance = Number(destination.balance);

    if (sourceBalance < input.amount) {
      throw createHttpError(422, "INSUFFICIENT_BALANCE", "The source account does not have sufficient balance.");
    }

    // Reference IDs are unique per account. Check both sides before inserting.
    const sourceRef = `transfer:${input.reference_id}:debit`;
    const destinationRef = `transfer:${input.reference_id}:credit`;
    const duplicate = await client.query(
      `SELECT account_id FROM transactions
       WHERE (account_id = $1 AND reference_id = $3)
          OR (account_id = $2 AND reference_id = $4)`,
      [input.from_account_id, input.to_account_id, sourceRef, destinationRef]
    );
    if (duplicate.rowCount > 0) {
      throw createHttpError(409, "DUPLICATE_TRANSFER", "A transfer with this reference_id has already been processed.");
    }

    const debit = await client.query(
      `INSERT INTO transactions (id, account_id, type, amount, description, reference_id)
       VALUES ($1, $2, 'debit', $3, $4, $5)
       RETURNING id, account_id, type, amount, description, reference_id, created_at`,
      [randomUUID(), input.from_account_id, input.amount.toFixed(2), input.description, sourceRef]
    );
    const credit = await client.query(
      `INSERT INTO transactions (id, account_id, type, amount, description, reference_id)
       VALUES ($1, $2, 'credit', $3, $4, $5)
       RETURNING id, account_id, type, amount, description, reference_id, created_at`,
      [randomUUID(), input.to_account_id, input.amount.toFixed(2), input.description, destinationRef]
    );

    await client.query("UPDATE accounts SET balance = $1 WHERE id = $2", [
      (sourceBalance - input.amount).toFixed(2), input.from_account_id
    ]);
    await client.query("UPDATE accounts SET balance = $1 WHERE id = $2", [
      (destinationBalance + input.amount).toFixed(2), input.to_account_id
    ]);

    await client.query("COMMIT");
    res.status(201).json({
      data: {
        transfer_reference_id: input.reference_id,
        debit_transaction: debit.rows[0],
        credit_transaction: credit.rows[0],
        balances: {
          [input.from_account_id]: (sourceBalance - input.amount).toFixed(2),
          [input.to_account_id]: (destinationBalance + input.amount).toFixed(2)
        }
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
