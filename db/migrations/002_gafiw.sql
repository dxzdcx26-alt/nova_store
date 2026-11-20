INSERT INTO api_providers (id, name, base_url)
VALUES ('gafiw', 'GAFIW Shop', 'https://gafiwshop.xyz/api')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS gafiw_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  api_key_ciphertext TEXT,
  api_key_iv TEXT,
  api_key_tag TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  connection_status TEXT NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (connection_status IN ('CONNECTED', 'DISCONNECTED', 'ERROR')),
  last_tested_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (api_key_ciphertext IS NULL AND api_key_iv IS NULL AND api_key_tag IS NULL)
    OR
    (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL AND api_key_tag IS NOT NULL)
  )
);

INSERT INTO gafiw_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS gafiw_products (
  type_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT,
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  price_vip NUMERIC(12, 2) NOT NULL CHECK (price_vip >= 0),
  stock INTEGER NOT NULL CHECK (stock >= 0),
  category TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gafiw_products_category_idx
  ON gafiw_products (category);

CREATE TABLE IF NOT EXISTS gafiw_api_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint TEXT NOT NULL,
  http_status INTEGER,
  response_code TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gafiw_api_logs_created_at_idx
  ON gafiw_api_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS gafiw_claims (
  order_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  submission_status TEXT NOT NULL CHECK (
    submission_status IN ('SUBMITTING', 'SUBMITTED', 'UNKNOWN', 'REJECTED')
  ),
  claim_time TEXT,
  claim_status TEXT,
  claim_text TEXT,
  response_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
