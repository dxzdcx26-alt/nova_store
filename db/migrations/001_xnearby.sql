CREATE TABLE IF NOT EXISTS api_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO api_providers (id, name, base_url)
VALUES ('xnearby', 'xNearby', 'https://api.nearbyshop.xyz')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS api_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  slip_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  tmn_verify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  expected_receiver_name TEXT NOT NULL DEFAULT '',
  expected_bank_code TEXT NOT NULL DEFAULT '',
  expected_account_no TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO api_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  order_reference TEXT NOT NULL UNIQUE,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'THB',
  status TEXT NOT NULL CHECK (
    status IN (
      'PAYMENT_PENDING',
      'PAID',
      'PAYMENT_REJECTED',
      'PAYMENT_FAILED',
      'PAYMENT_UNKNOWN'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders (id),
  order_reference TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'xnearby',
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'THB',
  status TEXT NOT NULL CHECK (
    status IN ('VERIFYING', 'PAID', 'REJECTED', 'FAILED', 'UNKNOWN')
  ),
  provider_transaction_id TEXT UNIQUE,
  response_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_transactions_created_at_idx
  ON payment_transactions (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS one_verifying_payment_per_order_idx
  ON payment_transactions (order_id)
  WHERE status = 'VERIFYING';

CREATE TABLE IF NOT EXISTS slip_verifications (
  id UUID PRIMARY KEY,
  payment_transaction_id UUID NOT NULL UNIQUE
    REFERENCES payment_transactions (id),
  slip_sha256 CHAR(64) NOT NULL UNIQUE,
  provider_transaction_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('VERIFYING', 'VERIFIED', 'REJECTED', 'FAILED', 'UNKNOWN')
  ),
  actual_amount NUMERIC(12, 2),
  receiver_name TEXT,
  receiver_bank_code TEXT,
  receiver_account_no_masked TEXT,
  response_code TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS slip_verifications_created_at_idx
  ON slip_verifications (created_at DESC);

CREATE TABLE IF NOT EXISTS truemoney_transactions (
  id UUID PRIMARY KEY,
  voucher_hash CHAR(64) NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'xnearby',
  phone_hash CHAR(64) NOT NULL,
  phone_masked TEXT NOT NULL,
  owner_name TEXT,
  amount NUMERIC(12, 2),
  available_tickets INTEGER,
  provider_status TEXT,
  is_expired BOOLEAN,
  verification_status TEXT NOT NULL CHECK (
    verification_status IN ('VERIFYING', 'VERIFIED', 'FAILED', 'UNKNOWN')
  ),
  redemption_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED' CHECK (
    redemption_status IN (
      'NOT_REQUESTED',
      'DRY_RUN_PENDING',
      'DRY_RUN_SUCCEEDED',
      'DRY_RUN_FAILED',
      'REDEEMING',
      'REDEEMED',
      'FAILED',
      'UNKNOWN'
    )
  ),
  response_code TEXT,
  redeemed_amount NUMERIC(12, 2),
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS truemoney_transactions_created_at_idx
  ON truemoney_transactions (created_at DESC);

CREATE TABLE IF NOT EXISTS api_request_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  http_status INTEGER,
  response_code TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_request_logs_created_at_idx
  ON api_request_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS api_error_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  http_status INTEGER,
  error_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_error_logs_created_at_idx
  ON api_error_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'admin',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx
  ON audit_logs (created_at DESC);
