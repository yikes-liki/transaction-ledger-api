CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL CHECK (length(trim(name)) > 0),
  balance NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  type VARCHAR(10) NOT NULL CHECK (type IN ('credit', 'debit')),
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  description VARCHAR(500) NOT NULL DEFAULT '',
  reference_id VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT transactions_account_reference_unique UNIQUE (account_id, reference_id)
);

CREATE INDEX IF NOT EXISTS transactions_account_created_idx
  ON transactions (account_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS transactions_account_type_created_idx
  ON transactions (account_id, type, created_at DESC, id DESC);
