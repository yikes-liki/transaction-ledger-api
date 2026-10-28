# API Documentation

Base URL: `http://localhost:4000`

All request bodies must be JSON. Monetary values are represented as decimal numbers.

## 1. Health check

`GET /health`

Success `200`:

```json
{
  "status": "ok",
  "service": "transaction-ledger-api"
}
```

## 2. Create account

`POST /api/accounts`

Request:

```json
{
  "name": "Likhitha"
}
```

The request must not include `balance`; the server initializes it to zero.

Success `201`:

```json
{
  "data": {
    "id": "generated-uuid",
    "name": "Likhitha",
    "balance": "0.00",
    "created_at": "2026-10-27T12:00:00.000Z"
  }
}
```

Errors: `400 VALIDATION_ERROR` for a missing/invalid name or extra fields.

## 3. Add credit or debit transaction

`POST /api/accounts/:accountId/transactions`

Credit request:

```json
{
  "type": "credit",
  "amount": 100,
  "description": "Salary",
  "reference_id": "salary-oct-001"
}
```

Debit request:

```json
{
  "type": "debit",
  "amount": 25.5,
  "description": "Groceries",
  "reference_id": "groceries-001"
}
```

Success `201` returns the immutable ledger entry and updated balance.

Errors:
- `400 VALIDATION_ERROR`: invalid body, invalid amount, invalid transaction type, missing reference.
- `404 ACCOUNT_NOT_FOUND`: account ID does not exist.
- `409 DUPLICATE_TRANSACTION`: reference ID already exists for this account.
- `422 INSUFFICIENT_BALANCE`: debit amount exceeds the available balance.

## 4. Get balance

`GET /api/accounts/:accountId/balance`

Success `200`:

```json
{
  "data": {
    "account_id": "account-uuid",
    "balance": "74.50"
  }
}
```

Error: `404 ACCOUNT_NOT_FOUND`.

## 5. Get transaction history

`GET /api/accounts/:accountId/transactions`

Query parameters:

| Parameter | Required | Default | Rules |
|---|---|---|---|
| `type` | No | both types | `credit` or `debit` |
| `page` | No | `1` | Positive integer |
| `limit` | No | `10` | Positive integer, maximum `100` |

Example:

`GET /api/accounts/ACCOUNT_UUID/transactions?type=debit&page=1&limit=10`

Success `200`:

```json
{
  "data": [],
  "pagination": {
    "current_page": 1,
    "page_size": 10,
    "total_records": 0,
    "total_pages": 0
  }
}
```

Results are sorted by `created_at DESC`, with transaction ID as a deterministic tie-breaker.

Errors:
- `400 INVALID_PAGINATION`: page or limit is invalid.
- `400 INVALID_TRANSACTION_TYPE`: type is not `credit` or `debit`.
- `404 ACCOUNT_NOT_FOUND`: account does not exist.

## 6. Bonus: Transfer money

`POST /api/transfers`

Request:

```json
{
  "from_account_id": "source-account-uuid",
  "to_account_id": "destination-account-uuid",
  "amount": 30,
  "reference_id": "transfer-001",
  "description": "Shared expenses"
}
```

Success `201` returns a debit transaction, a credit transaction, and both updated balances.

Errors:
- `400 VALIDATION_ERROR`: invalid request.
- `404 ACCOUNT_NOT_FOUND`: either account does not exist.
- `409 DUPLICATE_TRANSFER`: transfer reference has already been processed.
- `422 INSUFFICIENT_BALANCE`: source account lacks funds.

The source debit, destination credit, and both balance updates are committed together or rolled back together.

## Common errors

All errors use this shape:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable explanation."
  }
}
```

Unknown routes return `404 ROUTE_NOT_FOUND`; unexpected server errors return `500 INTERNAL_SERVER_ERROR`.
