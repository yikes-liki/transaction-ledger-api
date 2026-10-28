# Testing the Transaction Ledger API

Automated tests live in `tests/ledger.test.js`. They use Node.js's built-in test runner and Supertest against a real PostgreSQL database.

The suite talks only to a database named `transaction_ledger_test`. It refuses to start if `TEST_DATABASE_URL` is missing or points at any other database, including the development database `transaction_ledger`. It does not truncate, drop, or modify `transaction_ledger`.

## Setup

1. Install Node.js 20 or newer and PostgreSQL.
2. Install dependencies from the project root:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` if you have not already, and set `DATABASE_URL` to your development database (`transaction_ledger`). Leave that value pointed at development data. Do not point it at the test database just to run tests.

4. Create the dedicated test database. From `psql`:

   ```sql
   CREATE DATABASE transaction_ledger_test;
   ```

   The test suite also creates `transaction_ledger_test` when it is missing. That step connects to the `postgres` maintenance database only, and only issues `CREATE DATABASE transaction_ledger_test`. It never opens `transaction_ledger`.

5. Add `TEST_DATABASE_URL` to `.env`. Use the same host, port, and credentials as your local PostgreSQL user, and set the database name to `transaction_ledger_test`:

   ```text
   TEST_DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/transaction_ledger_test
   ```

   Replace `USER` and `PASSWORD` locally. Do not commit real credentials. Do not copy `DATABASE_URL` unchanged if that URL uses `transaction_ledger`.

6. Run the tests:

   ```bash
   npm test
   ```

You do not need to run `npm run db:init` for the test database. Before the tests, the suite reads `src/db/schema.sql` and applies it to `transaction_ledger_test`. `npm run db:init` uses `DATABASE_URL`, so keep that command for the development database only.

## What the suite does

- Loads the Express app in-process and calls it with Supertest. It does not start `src/server.js`.
- Checks `current_database()` before applying the schema or deleting rows. If the connection is not `transaction_ledger_test`, it closes the pool and stops.
- Deletes rows from `transactions` and `accounts` in the test database before each test and after the suite. Do not store data you need in `transaction_ledger_test`.
- Closes the PostgreSQL pool when the suite finishes.
- Runs tests one at a time so cleanup cannot race.
- During the rollback test only, installs a PostgreSQL trigger that raises an exception after a transfer debit is inserted. The test then drops that trigger and function. The trigger is not part of `schema.sql` and is not installed on `transaction_ledger`.

## Scenarios

1. Account creation, trimmed names, and invalid account names. A client-supplied balance is rejected and the stored balance stays `0.00`.
2. Credit increases the balance. Debit decreases it when funds are available.
3. A debit of the exact balance succeeds. A larger debit returns `422 INSUFFICIENT_BALANCE` and does not change the balance.
4. History is newest first and supports `type`, `page`, and `limit`. Invalid pagination or type values return `400`.
5. A duplicate reference ID for the same account returns `409 DUPLICATE_TRANSACTION` and does not create another row. The same reference ID can be used on a different account.
6. A transfer moves money between two accounts and returns both ledger entries and both balances.
7. A transfer with insufficient funds, or a transfer to the same account, leaves balances unchanged.
8. Invalid UUIDs return `400`. Missing accounts return `404` and do not change an existing balance.
9. A duplicate transfer reference returns `409 DUPLICATE_TRANSFER` and is not applied twice.
10. If a transfer fails after the debit insert, the database rolls the debit back. Neither balance changes, and the transfer reference can be used again.
11. After a failed debit, a later credit succeeds. The failed attempt does not leave the connection unusable and does not consume the reference ID.

There is no transaction update or delete route. Those requests return `404 ROUTE_NOT_FOUND`.
