alter table runner_enrollment_tokens
  add column token text,
  add constraint runner_enrollment_tokens_token_check check (
    token is null or (
      token like 'openorb_enroll_%'
      and length(token) between 16 and 128
    )
  );
