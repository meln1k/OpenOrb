alter table runner_enrollment_tokens
  add column token text not null,
  add constraint runner_enrollment_tokens_token_check check (
    token like 'openorb_enroll_%'
    and length(token) between 16 and 128
  );
