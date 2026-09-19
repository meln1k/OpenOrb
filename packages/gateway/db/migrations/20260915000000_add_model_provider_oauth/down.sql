delete from model_provider_credentials
where credential_type = 'oauth';

delete from encrypted_secrets
where purpose = 'provider-oauth';

alter table model_provider_credentials
  drop constraint model_provider_credentials_type_check,
  drop column credential_type;

alter table encrypted_secrets
  drop constraint encrypted_secrets_purpose_check,
  add constraint encrypted_secrets_purpose_check check (
    purpose in ('generic-secret', 'provider-api-key', 'git-credential')
  );
