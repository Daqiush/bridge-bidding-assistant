export const tables = {
  biddingRules: ["generation_id", "system", "sequence", "explanation", "has_explanation", "is_alert", "source_order"],
  datasetState: ["id", "active_generation_id", "previous_generation_id", "last_success_at", "retry_after", "lease_owner", "lease_until", "lease_token", "next_step_not_before"],
  datasetGenerations: ["generation_id", "status", "source_fingerprint", "created_at", "updated_at", "lease_token", "cleanup_system", "cleanup_sequence"],
  datasetImports: ["generation_id", "system", "stage", "zip_key", "txt_key", "byte_cursor", "line_no", "valid_count", "duplicate_count", "invalid_count", "final_count", "pending_delete_keys"],
  explanationCache: ["cache_key", "explanation", "is_alert", "expires_at", "created_at"],
  rateLimitBuckets: ["bucket_key", "tokens", "updated_at"],
};
