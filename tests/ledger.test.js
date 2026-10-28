"use strict";

// Integration tests for the Transaction Ledger API.
// The application pool reads DATABASE_URL when it is first imported, so the
// guard below must run before requiring the app. These tests never connect
// to the development database (transaction_ledger).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { after, before, beforeEach, describe, it } = require("node:test");
const request = require("supertest");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const REQUIRED_TEST_DATABASE = "transaction_ledger_test";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const configuredDatabaseUrl = process.env.DATABASE_URL;

function databaseName(connectionString) {
  if (typeof connectionString !== "string" || connectionString.trim() === "") {
    throw new Error("Refusing to run tests: the database URL is empty.");
  }

  try {
    const pathname = new URL(connectionString).pathname;
    const name = decodeURIComponent(pathname.replace(/^\//, "").split("/")[0]);
    if (name) return name;
  } catch {
    // Some passwords are not valid in a WHATWG URL. Fall back to the path only.
  }

  const withoutQuery = connectionString.split("?")[0];
  const slash = withoutQuery.lastIndexOf("/");
  if (slash === -1 || slash === withoutQuery.length - 1) {
    throw new Error("Refusing to run tests: the database name could not be read from the connection URL.");
  }
  return decodeURIComponent(withoutQuery.slice(slash + 1));
}

function withDatabase(connectionString, database) {
  const queryIndex = connectionString.indexOf("?");
  const base = queryIndex === -1 ? connectionString : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex);
  const replaced = base.replace(/\/[^/]*$/, `/${database}`);
  if (databaseName(replaced) !== database) {
    throw new Error(`Refusing to open database "${databaseName(replaced)}" while preparing ${database}.`);
  }
  return replaced;
}

function assertSafeTestDatabase(connectionString) {
  if (!connectionString) {
    throw new Error(
      "Refusing to run tests: TEST_DATABASE_URL is not set. Create a database named transaction_ledger_test and set TEST_DATABASE_URL to that database only."
    );
  }

  const name = databaseName(connectionString);
  if (name !== REQUIRED_TEST_DATABASE) {
    throw new Error(
      `Refusing to run tests against database "${name}". Tests only run against ${REQUIRED_TEST_DATABASE} and will not modify transaction_ledger.`
    );
  }

  if (configuredDatabaseUrl && connectionString === configuredDatabaseUrl) {
    const configuredName = databaseName(configuredDatabaseUrl);
    if (configuredName !== REQUIRED_TEST_DATABASE) {
      throw new Error("Refusing to run tests because TEST_DATABASE_URL is the application database URL.");
    }
  }
}

function safeDbError(error) {
  const message = String(error && error.message ? error.message : error).split("\n")[0];
  if (message.includes("://") || message.includes("@")) {
    return error && error.code ? error.code : "database error";
  }
  return [error && error.code, message].filter(Boolean).join(" ");
}

assertSafeTestDatabase(testDatabaseUrl);
process.env.DATABASE_URL = testDatabaseUrl;

const app = require("../src/app");
const { pool } = require("../src/db/pool");

const schemaPath = path.join(__dirname, "..", "src", "db", "schema.sql");
let poolClosed = false;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function closePool() {
  if (poolClosed) return;
  poolClosed = true;
  await pool.end();
}

async function assertConnectedToTestDatabase() {
  const result = await pool.query("SELECT current_database() AS name");
  const name = result.rows[0].name;
  if (name !== REQUIRED_TEST_DATABASE) {
    await closePool();
    throw new Error(
      `Refusing to continue: the connection is using "${name}", not ${REQUIRED_TEST_DATABASE}.`
    );
  }
}

async function ensureTestDatabase() {
  assertSafeTestDatabase(testDatabaseUrl);
  const { Client } = require("pg");
  const adminUrl = withDatabase(testDatabaseUrl, "postgres");
  const client = new Client({
    connectionString: adminUrl,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000
  });

  await client.connect();
  try {
    const current = await client.query("SELECT current_database() AS name");
    if (current.rows[0].name !== "postgres") {
      throw new Error("Refusing to prepare the test database from a connection that is not the postgres maintenance database.");
    }

    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [REQUIRED_TEST_DATABASE]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${REQUIRED_TEST_DATABASE}`);
    }
  } finally {
    await client.end();
  }
}

async function applySchema() {
  await assertConnectedToTestDatabase();
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schemaSql);
}

async function removeTestArtifacts() {
  const client = await pool.connect();
  try {
    const current = await client.query("SELECT current_database() AS name");
    if (current.rows[0].name !== REQUIRED_TEST_DATABASE) {
      throw new Error(
        `Refusing to delete rows from "${current.rows[0].name}". Cleanup is limited to ${REQUIRED_TEST_DATABASE}.`
      );
    }

    await client.query("BEGIN");
    await client.query("DROP TRIGGER IF EXISTS test_fail_transfer_after_debit ON transactions");
    await client.query("DROP FUNCTION IF EXISTS test_fail_transfer_after_debit()");
    await client.query("DELETE FROM transactions");
    await client.query("DELETE FROM accounts");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.message && error.message.startsWith("Refusing")) {
      await closePool();
    }
    throw error;
  } finally {
    client.release();
  }
}

function assertError(response, status, code, message) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.ok(response.body.error, JSON.stringify(response.body));
  assert.equal(response.body.error.code, code);
  if (message !== undefined) {
    assert.equal(response.body.error.message, message);
  }
}

async function createAccount(name) {
  const response = await request(app).post("/api/accounts").send({ name });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

async function postTransaction(accountId, body) {
  return request(app).post(`/api/accounts/${accountId}/transactions`).send(body);
}

async function getBalance(accountId) {
  const response = await request(app).get(`/api/accounts/${accountId}/balance`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.balance;
}

async function seedCredit(accountId, amount, referenceId) {
  const response = await postTransaction(accountId, {
    type: "credit",
    amount,
    description: referenceId,
    reference_id: referenceId
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
}

describe("Transaction Ledger API", { concurrency: 1 }, () => {
  before(async () => {
    try {
      await ensureTestDatabase();
      await assertConnectedToTestDatabase();
      await applySchema();
      await removeTestArtifacts();
    } catch (error) {
      await closePool();
      if (error.message && error.message.startsWith("Refusing")) throw error;
      throw new Error(`Could not prepare ${REQUIRED_TEST_DATABASE}: ${safeDbError(error)}`);
    }
  });

  beforeEach(async () => {
    await removeTestArtifacts();
  });

  after(async () => {
    try {
      if (!poolClosed) await removeTestArtifacts();
    } finally {
      await closePool();
    }
  });

  it("refuses database names other than transaction_ledger_test", () => {
    assert.equal(databaseName("postgresql://localhost:5432/transaction_ledger_test"), REQUIRED_TEST_DATABASE);
    assert.throws(
      () => assertSafeTestDatabase("postgresql://localhost:5432/transaction_ledger"),
      /Refusing to run tests against database "transaction_ledger"/
    );
    assert.throws(
      () => assertSafeTestDatabase("postgresql://localhost:5432/postgres"),
      /Refusing to run tests against database "postgres"/
    );
    assert.throws(
      () => assertSafeTestDatabase(""),
      /TEST_DATABASE_URL is not set/
    );
  });

  describe("account creation", () => {
    it("creates an account with a zero balance and a trimmed name", async () => {
      const response = await request(app).post("/api/accounts").send({ name: "  Likhitha  " });
      assert.equal(response.status, 201, JSON.stringify(response.body));

      const account = response.body.data;
      assert.match(account.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.equal(account.name, "Likhitha");
      assert.equal(account.balance, "0.00");
      assert.match(account.created_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(await getBalance(account.id), "0.00");
    });

    it("accepts an account name of 120 characters", async () => {
      const name = "a".repeat(120);
      const account = await createAccount(name);
      assert.equal(account.name, name);
      assert.equal(account.balance, "0.00");
    });

    it("rejects invalid account names", async () => {
      const cases = [
        {},
        { name: "" },
        { name: "   " },
        { name: "a".repeat(121) },
        { name: 42 }
      ];

      for (const body of cases) {
        const response = await request(app).post("/api/accounts").send(body);
        assertError(response, 400, "VALIDATION_ERROR", "Request validation failed.");
        assert.ok(Array.isArray(response.body.error.details));
        assert.ok(response.body.error.details.some((detail) => detail.field === "name"));
      }

      const count = await pool.query("SELECT COUNT(*)::int AS total FROM accounts");
      assert.equal(count.rows[0].total, 0);
    });

    it("rejects a client-supplied balance and other unknown fields", async () => {
      const response = await request(app)
        .post("/api/accounts")
        .send({ name: "Ada", balance: 100 });

      assertError(response, 400, "VALIDATION_ERROR", "Request validation failed.");
      assert.match(JSON.stringify(response.body.error.details), /balance/);

      const count = await pool.query("SELECT COUNT(*)::int AS total FROM accounts");
      assert.equal(count.rows[0].total, 0);
    });
  });

  describe("credit and debit transactions", () => {
    it("credits an account and increases its balance", async () => {
      const account = await createAccount("Salary");
      const response = await postTransaction(account.id, {
        type: "credit",
        amount: 100,
        description: "Salary",
        reference_id: "salary-oct-001"
      });

      assert.equal(response.status, 201, JSON.stringify(response.body));
      const transaction = response.body.data.transaction;
      assert.match(transaction.id, /^[0-9a-f-]{36}$/i);
      assert.equal(transaction.account_id, account.id);
      assert.equal(transaction.type, "credit");
      assert.equal(transaction.amount, "100.00");
      assert.equal(transaction.description, "Salary");
      assert.equal(transaction.reference_id, "salary-oct-001");
      assert.match(transaction.created_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(response.body.data.balance, "100.00");
      assert.equal(await getBalance(account.id), "100.00");
    });

    it("debits an account when funds are available", async () => {
      const account = await createAccount("Groceries");
      await seedCredit(account.id, 100, "opening");

      const response = await postTransaction(account.id, {
        type: "debit",
        amount: 25.5,
        description: "Groceries",
        reference_id: "groceries-001"
      });

      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.transaction.type, "debit");
      assert.equal(response.body.data.transaction.amount, "25.50");
      assert.equal(response.body.data.transaction.description, "Groceries");
      assert.equal(response.body.data.balance, "74.50");
      assert.equal(await getBalance(account.id), "74.50");
    });

    it("stores an empty description when one is omitted", async () => {
      const account = await createAccount("No Description");
      const response = await postTransaction(account.id, {
        type: "credit",
        amount: 5,
        reference_id: "plain-credit"
      });

      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.transaction.description, "");
      assert.equal(response.body.data.balance, "5.00");
    });

    it("rejects an invalid transaction payload without changing the balance", async () => {
      const account = await createAccount("Invalid Payload");
      const response = await postTransaction(account.id, {
        type: "transfer",
        amount: -5,
        reference_id: ""
      });

      assertError(response, 400, "VALIDATION_ERROR", "Request validation failed.");
      assert.equal(await getBalance(account.id), "0.00");
      const count = await pool.query("SELECT COUNT(*)::int AS total FROM transactions");
      assert.equal(count.rows[0].total, 0);
    });
  });

  describe("exact-balance debit and insufficient balance", () => {
    it("debits an amount equal to the current balance", async () => {
      const account = await createAccount("Exact");
      await seedCredit(account.id, 40, "seed");

      const response = await postTransaction(account.id, {
        type: "debit",
        amount: 40,
        description: "Close out",
        reference_id: "exact-debit"
      });

      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.data.balance, "0.00");
      assert.equal(await getBalance(account.id), "0.00");
    });

    it("rejects a debit that exceeds the balance and leaves it unchanged", async () => {
      const account = await createAccount("Short");
      await seedCredit(account.id, 20, "seed");

      const response = await postTransaction(account.id, {
        type: "debit",
        amount: 21,
        description: "Too much",
        reference_id: "overdraft"
      });

      assertError(response, 422, "INSUFFICIENT_BALANCE", "The account does not have sufficient balance.");
      assert.equal(await getBalance(account.id), "20.00");

      const rows = await pool.query(
        "SELECT reference_id FROM transactions WHERE account_id = $1 ORDER BY reference_id",
        [account.id]
      );
      assert.deepEqual(rows.rows.map((row) => row.reference_id), ["seed"]);
    });

    it("rejects a debit when the balance is already zero", async () => {
      const account = await createAccount("Empty");
      await seedCredit(account.id, 15, "seed");
      const exact = await postTransaction(account.id, {
        type: "debit",
        amount: 15,
        reference_id: "spend-all"
      });
      assert.equal(exact.status, 201, JSON.stringify(exact.body));

      const response = await postTransaction(account.id, {
        type: "debit",
        amount: 0.01,
        reference_id: "one-cent"
      });

      assertError(response, 422, "INSUFFICIENT_BALANCE", "The account does not have sufficient balance.");
      assert.equal(await getBalance(account.id), "0.00");
    });
  });

  describe("transaction history, filtering, and pagination", () => {
    async function record(accountId, type, amount, referenceId) {
      const response = await postTransaction(accountId, {
        type,
        amount,
        description: referenceId,
        reference_id: referenceId
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      await sleep(20);
      return response.body.data.transaction;
    }

    it("returns an empty page for an account with no transactions", async () => {
      const account = await createAccount("Empty History");
      const response = await request(app).get(`/api/accounts/${account.id}/transactions`);

      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body.data, []);
      assert.deepEqual(response.body.pagination, {
        current_page: 1,
        page_size: 10,
        total_records: 0,
        total_pages: 0
      });
    });

    it("returns newest transactions first and does not include other accounts", async () => {
      const account = await createAccount("History");
      const other = await createAccount("Other");
      await record(account.id, "credit", 10, "first");
      await record(account.id, "credit", 20, "second");
      await record(account.id, "debit", 5, "third");
      await record(account.id, "credit", 1, "fourth");
      await record(other.id, "credit", 99, "other-account");

      const response = await request(app).get(`/api/accounts/${account.id}/transactions`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body.data.map((row) => row.reference_id), ["fourth", "third", "second", "first"]);
      assert.equal(response.body.data[0].amount, "1.00");
      assert.equal(response.body.data[0].type, "credit");
      assert.deepEqual(response.body.pagination, {
        current_page: 1,
        page_size: 10,
        total_records: 4,
        total_pages: 1
      });

      for (let index = 1; index < response.body.data.length; index += 1) {
        const previous = response.body.data[index - 1];
        const current = response.body.data[index];
        assert.ok(previous.created_at >= current.created_at);
      }
    });

    it("filters history by transaction type", async () => {
      const account = await createAccount("Filtered");
      await record(account.id, "credit", 10, "credit-a");
      await record(account.id, "debit", 4, "debit-a");
      await record(account.id, "credit", 3, "credit-b");

      const credits = await request(app).get(`/api/accounts/${account.id}/transactions?type=credit`);
      assert.equal(credits.status, 200, JSON.stringify(credits.body));
      assert.deepEqual(credits.body.data.map((row) => row.reference_id), ["credit-b", "credit-a"]);
      assert.ok(credits.body.data.every((row) => row.type === "credit"));
      assert.equal(credits.body.pagination.total_records, 2);

      const debits = await request(app).get(`/api/accounts/${account.id}/transactions?type=debit`);
      assert.equal(debits.status, 200, JSON.stringify(debits.body));
      assert.deepEqual(debits.body.data.map((row) => row.reference_id), ["debit-a"]);
      assert.equal(debits.body.pagination.total_records, 1);
      assert.equal(debits.body.pagination.total_pages, 1);
    });

    it("paginates history without repeating records", async () => {
      const account = await createAccount("Pages");
      await record(account.id, "credit", 30, "page-1");
      await record(account.id, "credit", 1, "page-2");
      await record(account.id, "debit", 1, "page-3");
      await record(account.id, "credit", 1, "page-4");
      await record(account.id, "credit", 1, "page-5");

      const page1 = await request(app).get(`/api/accounts/${account.id}/transactions?page=1&limit=2`);
      const page2 = await request(app).get(`/api/accounts/${account.id}/transactions?page=2&limit=2`);
      const page3 = await request(app).get(`/api/accounts/${account.id}/transactions?page=3&limit=2`);
      const page4 = await request(app).get(`/api/accounts/${account.id}/transactions?page=4&limit=2`);

      assert.equal(page1.status, 200, JSON.stringify(page1.body));
      assert.deepEqual(page1.body.data.map((row) => row.reference_id), ["page-5", "page-4"]);
      assert.deepEqual(page1.body.pagination, {
        current_page: 1,
        page_size: 2,
        total_records: 5,
        total_pages: 3
      });
      assert.deepEqual(page2.body.data.map((row) => row.reference_id), ["page-3", "page-2"]);
      assert.equal(page2.body.pagination.current_page, 2);
      assert.deepEqual(page3.body.data.map((row) => row.reference_id), ["page-1"]);
      assert.equal(page3.body.pagination.total_pages, 3);
      assert.deepEqual(page4.body.data, []);
      assert.equal(page4.body.pagination.current_page, 4);
      assert.equal(page4.body.pagination.total_records, 5);

      const seen = new Set([
        ...page1.body.data,
        ...page2.body.data,
        ...page3.body.data
      ].map((row) => row.id));
      assert.equal(seen.size, 5);
    });

    it("rejects invalid pagination and transaction type filters", async () => {
      const accountId = randomUUID();
      const cases = [
        `page=0`,
        `page=-1`,
        `page=abc`,
        `limit=0`,
        `limit=101`,
        `limit=10.5`
      ];

      for (const query of cases) {
        const response = await request(app).get(`/api/accounts/${accountId}/transactions?${query}`);
        assertError(
          response,
          400,
          "INVALID_PAGINATION",
          "page and limit must be positive integers; limit cannot exceed 100."
        );
      }

      const invalidType = await request(app).get(`/api/accounts/${accountId}/transactions?type=transfer`);
      assertError(invalidType, 400, "INVALID_TRANSACTION_TYPE", "type must be either credit or debit.");

      const uppercaseType = await request(app).get(`/api/accounts/${accountId}/transactions?type=CREDIT`);
      assertError(uppercaseType, 400, "INVALID_TRANSACTION_TYPE", "type must be either credit or debit.");
    });

    it("does not expose transaction update or delete routes", async () => {
      const account = await createAccount("Immutable");
      const transactionId = randomUUID();
      const putResponse = await request(app)
        .put(`/api/accounts/${account.id}/transactions/${transactionId}`)
        .send({ amount: 10 });
      const deleteResponse = await request(app)
        .delete(`/api/accounts/${account.id}/transactions/${transactionId}`);

      assertError(putResponse, 404, "ROUTE_NOT_FOUND");
      assert.match(putResponse.body.error.message, /^Route PUT /);
      assertError(deleteResponse, 404, "ROUTE_NOT_FOUND");
      assert.match(deleteResponse.body.error.message, /^Route DELETE /);
    });
  });

  describe("duplicate transaction reference ids", () => {
    it("rejects a duplicate reference id for the same account", async () => {
      const account = await createAccount("Duplicates");
      const first = await postTransaction(account.id, {
        type: "credit",
        amount: 15,
        description: "Invoice",
        reference_id: "invoice-1"
      });
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const duplicate = await postTransaction(account.id, {
        type: "credit",
        amount: 15,
        description: "Invoice again",
        reference_id: "invoice-1"
      });

      assertError(
        duplicate,
        409,
        "DUPLICATE_TRANSACTION",
        "A transaction with this reference_id already exists for this account."
      );
      assert.equal(await getBalance(account.id), "15.00");

      const count = await pool.query(
        "SELECT COUNT(*)::int AS total FROM transactions WHERE account_id = $1",
        [account.id]
      );
      assert.equal(count.rows[0].total, 1);
    });

    it("allows the same reference id on a different account", async () => {
      const first = await createAccount("First");
      const second = await createAccount("Second");

      const firstCredit = await postTransaction(first.id, {
        type: "credit",
        amount: 8,
        reference_id: "shared-ref"
      });
      const secondCredit = await postTransaction(second.id, {
        type: "credit",
        amount: 9,
        reference_id: "shared-ref"
      });

      assert.equal(firstCredit.status, 201, JSON.stringify(firstCredit.body));
      assert.equal(secondCredit.status, 201, JSON.stringify(secondCredit.body));
      assert.equal(await getBalance(first.id), "8.00");
      assert.equal(await getBalance(second.id), "9.00");
    });
  });

  describe("transfers", () => {
    it("transfers money between two accounts", async () => {
      const source = await createAccount("Source");
      const destination = await createAccount("Destination");
      await seedCredit(source.id, 100, "source-seed");
      await seedCredit(destination.id, 40, "destination-seed");

      const response = await request(app).post("/api/transfers").send({
        from_account_id: source.id,
        to_account_id: destination.id,
        amount: 25,
        reference_id: "transfer-001",
        description: "Shared expenses"
      });

      assert.equal(response.status, 201, JSON.stringify(response.body));
      const body = response.body.data;
      assert.equal(body.transfer_reference_id, "transfer-001");
      assert.equal(body.debit_transaction.account_id, source.id);
      assert.equal(body.debit_transaction.type, "debit");
      assert.equal(body.debit_transaction.amount, "25.00");
      assert.equal(body.debit_transaction.description, "Shared expenses");
      assert.equal(body.debit_transaction.reference_id, "transfer:transfer-001:debit");
      assert.equal(body.credit_transaction.account_id, destination.id);
      assert.equal(body.credit_transaction.type, "credit");
      assert.equal(body.credit_transaction.amount, "25.00");
      assert.equal(body.credit_transaction.reference_id, "transfer:transfer-001:credit");
      assert.deepEqual(body.balances, {
        [source.id]: "75.00",
        [destination.id]: "65.00"
      });
      assert.equal(await getBalance(source.id), "75.00");
      assert.equal(await getBalance(destination.id), "65.00");
    });

    it("leaves both balances unchanged when the source has insufficient funds", async () => {
      const source = await createAccount("Poor Source");
      const destination = await createAccount("Waiting");
      await seedCredit(source.id, 10, "source-seed");
      await seedCredit(destination.id, 4, "destination-seed");

      const response = await request(app).post("/api/transfers").send({
        from_account_id: source.id,
        to_account_id: destination.id,
        amount: 25,
        reference_id: "too-large"
      });

      assertError(response, 422, "INSUFFICIENT_BALANCE", "The source account does not have sufficient balance.");
      assert.equal(await getBalance(source.id), "10.00");
      assert.equal(await getBalance(destination.id), "4.00");

      const rows = await pool.query(
        "SELECT reference_id FROM transactions WHERE reference_id LIKE 'transfer:too-large:%'"
      );
      assert.equal(rows.rowCount, 0);
    });

    it("rejects a transfer to the same account without changing its balance", async () => {
      const account = await createAccount("Same");
      await seedCredit(account.id, 15, "seed");

      const response = await request(app).post("/api/transfers").send({
        from_account_id: account.id,
        to_account_id: account.id,
        amount: 5,
        reference_id: "self"
      });

      assertError(response, 400, "VALIDATION_ERROR", "Request validation failed.");
      assert.ok(response.body.error.details.some((detail) => detail.field === "to_account_id"));
      assert.equal(await getBalance(account.id), "15.00");
      const rows = await pool.query("SELECT COUNT(*)::int AS total FROM transactions WHERE reference_id LIKE 'transfer:self:%'");
      assert.equal(rows.rows[0].total, 0);
    });

    it("rejects a duplicate transfer reference without applying it twice", async () => {
      const source = await createAccount("From");
      const destination = await createAccount("To");
      await seedCredit(source.id, 100, "source-seed");
      await seedCredit(destination.id, 5, "destination-seed");

      const payload = {
        from_account_id: source.id,
        to_account_id: destination.id,
        amount: 30,
        reference_id: "rent-once",
        description: "Rent"
      };
      const first = await request(app).post("/api/transfers").send(payload);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const duplicate = await request(app).post("/api/transfers").send(payload);
      assertError(
        duplicate,
        409,
        "DUPLICATE_TRANSFER",
        "A transfer with this reference_id has already been processed."
      );

      assert.equal(await getBalance(source.id), "70.00");
      assert.equal(await getBalance(destination.id), "35.00");

      const count = await pool.query(
        "SELECT COUNT(*)::int AS total FROM transactions WHERE reference_id LIKE 'transfer:rent-once:%'"
      );
      assert.equal(count.rows[0].total, 2);
    });
  });

  describe("invalid uuids and missing accounts", () => {
    it("rejects invalid uuids and missing accounts without changing an existing balance", async () => {
      const source = await createAccount("Existing");
      await seedCredit(source.id, 40, "seed");
      const missingId = randomUUID();

      const invalidBalance = await request(app).get("/api/accounts/not-a-uuid/balance");
      assertError(invalidBalance, 400, "VALIDATION_ERROR", "Request validation failed.");

      const missingBalance = await request(app).get(`/api/accounts/${missingId}/balance`);
      assertError(missingBalance, 404, "ACCOUNT_NOT_FOUND", "Account was not found.");

      const invalidTransaction = await request(app)
        .post("/api/accounts/not-a-uuid/transactions")
        .send({ type: "credit", amount: 1, reference_id: "bad-account" });
      assertError(invalidTransaction, 400, "VALIDATION_ERROR", "Request validation failed.");

      const missingTransaction = await request(app)
        .post(`/api/accounts/${missingId}/transactions`)
        .send({ type: "credit", amount: 1, reference_id: "missing-account" });
      assertError(missingTransaction, 404, "ACCOUNT_NOT_FOUND", "Account was not found.");

      const invalidHistory = await request(app).get("/api/accounts/not-a-uuid/transactions");
      assertError(invalidHistory, 400, "VALIDATION_ERROR", "Request validation failed.");

      const missingHistory = await request(app).get(`/api/accounts/${missingId}/transactions`);
      assertError(missingHistory, 404, "ACCOUNT_NOT_FOUND", "Account was not found.");

      const invalidTransfer = await request(app).post("/api/transfers").send({
        from_account_id: "not-a-uuid",
        to_account_id: source.id,
        amount: 5,
        reference_id: "bad-uuid"
      });
      assertError(invalidTransfer, 400, "VALIDATION_ERROR", "Request validation failed.");

      const missingDestination = await request(app).post("/api/transfers").send({
        from_account_id: source.id,
        to_account_id: randomUUID(),
        amount: 5,
        reference_id: "missing-destination"
      });
      assertError(
        missingDestination,
        404,
        "ACCOUNT_NOT_FOUND",
        "Both source and destination accounts must exist."
      );

      const missingSource = await request(app).post("/api/transfers").send({
        from_account_id: randomUUID(),
        to_account_id: source.id,
        amount: 5,
        reference_id: "missing-source"
      });
      assertError(
        missingSource,
        404,
        "ACCOUNT_NOT_FOUND",
        "Both source and destination accounts must exist."
      );

      assert.equal(await getBalance(source.id), "40.00");
      const rows = await pool.query(
        "SELECT reference_id FROM transactions WHERE account_id = $1",
        [source.id]
      );
      assert.deepEqual(rows.rows.map((row) => row.reference_id), ["seed"]);
    });
  });

  describe("transfer rollback", () => {
    async function installFailureTrigger() {
      await assertConnectedToTestDatabase();
      await pool.query(`
        CREATE OR REPLACE FUNCTION test_fail_transfer_after_debit()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
        BEGIN
          IF NEW.type = 'debit' AND NEW.reference_id LIKE 'transfer:%:debit' THEN
            RAISE EXCEPTION 'simulated transfer failure after debit insert';
          END IF;
          RETURN NEW;
        END;
        $fn$
      `);
      await pool.query(`
        CREATE TRIGGER test_fail_transfer_after_debit
        AFTER INSERT ON transactions
        FOR EACH ROW
        EXECUTE PROCEDURE test_fail_transfer_after_debit()
      `);
    }

    async function dropFailureTrigger() {
      await assertConnectedToTestDatabase();
      await pool.query("DROP TRIGGER IF EXISTS test_fail_transfer_after_debit ON transactions");
      await pool.query("DROP FUNCTION IF EXISTS test_fail_transfer_after_debit()");
    }

    it("rolls back a transfer that fails after the debit insert", async () => {
      const source = await createAccount("Rollback Source");
      const destination = await createAccount("Rollback Destination");
      await seedCredit(source.id, 80, "seed-source");
      await seedCredit(destination.id, 20, "seed-destination");

      await installFailureTrigger();
      const logged = [];
      const originalError = console.error;
      console.error = (...args) => {
        logged.push(args.map((arg) => (arg && arg.message) || String(arg)).join(" "));
      };

      try {
        const response = await request(app).post("/api/transfers").send({
          from_account_id: source.id,
          to_account_id: destination.id,
          amount: 30,
          reference_id: "rollback-1",
          description: "Should roll back"
        });

        assertError(response, 500, "INTERNAL_SERVER_ERROR", "An unexpected server error occurred.");
        assert.match(logged.join("\n"), /simulated transfer failure after debit insert/);
      } finally {
        console.error = originalError;
        await dropFailureTrigger();
      }

      assert.equal(await getBalance(source.id), "80.00");
      assert.equal(await getBalance(destination.id), "20.00");

      const rolledBack = await pool.query(
        "SELECT reference_id FROM transactions WHERE reference_id LIKE 'transfer:rollback-1:%'"
      );
      assert.equal(rolledBack.rowCount, 0);

      const remaining = await pool.query(
        "SELECT reference_id FROM transactions WHERE account_id = ANY($1::uuid[]) ORDER BY reference_id",
        [[source.id, destination.id]]
      );
      assert.deepEqual(
        remaining.rows.map((row) => row.reference_id),
        ["seed-destination", "seed-source"]
      );

      const retry = await request(app).post("/api/transfers").send({
        from_account_id: source.id,
        to_account_id: destination.id,
        amount: 30,
        reference_id: "rollback-1",
        description: "Retry after rollback"
      });

      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      assert.equal(await getBalance(source.id), "50.00");
      assert.equal(await getBalance(destination.id), "50.00");
      const committed = await pool.query(
        "SELECT type, reference_id FROM transactions WHERE reference_id LIKE 'transfer:rollback-1:%' ORDER BY type"
      );
      assert.deepEqual(
        committed.rows.map((row) => `${row.type}:${row.reference_id}`),
        ["credit:transfer:rollback-1:credit", "debit:transfer:rollback-1:debit"]
      );
    });
  });

  describe("requests after a failed transaction", () => {
    it("completes a later transaction after a failed debit", async () => {
      const account = await createAccount("Recovered");
      await seedCredit(account.id, 30, "opening");

      const failed = await postTransaction(account.id, {
        type: "debit",
        amount: 31,
        description: "Rejected",
        reference_id: "retry-me"
      });
      assertError(failed, 422, "INSUFFICIENT_BALANCE", "The account does not have sufficient balance.");
      assert.equal(await getBalance(account.id), "30.00");

      const recovered = await postTransaction(account.id, {
        type: "credit",
        amount: 12.5,
        description: "Accepted after failure",
        reference_id: "retry-me"
      });

      assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
      assert.equal(recovered.body.data.transaction.reference_id, "retry-me");
      assert.equal(recovered.body.data.balance, "42.50");
      assert.equal(await getBalance(account.id), "42.50");

      const history = await request(app).get(`/api/accounts/${account.id}/transactions`);
      assert.equal(history.status, 200, JSON.stringify(history.body));
      assert.deepEqual(history.body.data.map((row) => row.reference_id), ["retry-me", "opening"]);
      assert.equal(history.body.pagination.total_records, 2);
    });
  });
});
