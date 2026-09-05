create unique index runner_enrollment_tokens_one_active_per_workspace_idx
  on runner_enrollment_tokens (workspace_id)
  where revoked_at is null;
