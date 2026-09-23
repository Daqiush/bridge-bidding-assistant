CREATE TABLE IF NOT EXISTS bidding_rules (
  generation_id TEXT NOT NULL,
  system TEXT NOT NULL CHECK (system IN ('JQA','CBB','NBS','ASY')),
  sequence TEXT NOT NULL,
  explanation TEXT NOT NULL,
  has_explanation INTEGER NOT NULL CHECK (has_explanation IN (0,1)),
  is_alert INTEGER NOT NULL CHECK (is_alert IN (0,1)),
  source_order INTEGER NOT NULL,
  PRIMARY KEY (generation_id, system, sequence)
);
CREATE INDEX IF NOT EXISTS idx_bidding_rules_lookup ON bidding_rules(generation_id, system, sequence);
CREATE TABLE IF NOT EXISTS dataset_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_generation_id TEXT,
  previous_generation_id TEXT,
  last_success_at INTEGER,
  last_checked_at INTEGER,
  retry_after INTEGER,
  lease_owner TEXT,
  lease_until INTEGER,
  lease_token INTEGER NOT NULL DEFAULT 0,
  next_step_not_before INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dataset_generations (
  generation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('staging','active','previous','failed','cleanup')),
  source_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_token INTEGER NOT NULL,
  cleanup_system TEXT,
  cleanup_sequence TEXT
);
CREATE TABLE IF NOT EXISTS dataset_imports (
  generation_id TEXT NOT NULL REFERENCES dataset_generations(generation_id) ON DELETE CASCADE,
  system TEXT NOT NULL CHECK (system IN ('JQA','CBB','NBS','ASY')),
  stage TEXT NOT NULL CHECK (stage IN ('source','download_zip','extract_txt','import_chunks','validate_system','complete','failed')),
  zip_key TEXT,
  txt_key TEXT,
  byte_cursor INTEGER NOT NULL DEFAULT 0,
  line_no INTEGER NOT NULL DEFAULT 0,
  valid_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  final_count INTEGER NOT NULL DEFAULT 0,
  pending_delete_keys TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (generation_id, system)
);
CREATE INDEX IF NOT EXISTS idx_dataset_generations_status ON dataset_generations(status, generation_id);
CREATE TABLE IF NOT EXISTS explanation_cache (
  cache_key TEXT PRIMARY KEY,
  explanation TEXT NOT NULL,
  is_alert INTEGER NOT NULL CHECK (is_alert IN (0,1)),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explanation_cache_expires_at ON explanation_cache(expires_at);
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_updated_at ON rate_limit_buckets(updated_at);
