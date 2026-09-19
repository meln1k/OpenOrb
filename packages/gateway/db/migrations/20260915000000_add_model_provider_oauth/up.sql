alter table encrypted_secrets
  drop constraint encrypted_secrets_purpose_check,
  add constraint encrypted_secrets_purpose_check check (
    purpose in ('generic-secret', 'provider-api-key', 'provider-oauth', 'git-credential')
  );

alter table model_provider_credentials
  add column credential_type text not null default 'api_key',
  add constraint model_provider_credentials_type_check check (
    credential_type in ('api_key', 'oauth')
  );

alter table model_provider_credentials
  alter column credential_type drop default;
