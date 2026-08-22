alter table encrypted_secrets
  add column purpose text;

update encrypted_secrets
set purpose = 'git-credential'
from git_credentials
where encrypted_secrets.id = git_credentials.encrypted_secret_id;

update encrypted_secrets
set purpose = 'generic-secret'
where purpose is null;

alter table encrypted_secrets
  alter column purpose set not null,
  add constraint encrypted_secrets_purpose_check check (
    purpose in ('generic-secret', 'provider-api-key', 'git-credential')
  );
