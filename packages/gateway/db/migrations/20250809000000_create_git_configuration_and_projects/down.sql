drop table projects;

alter table git_credentials
  drop constraint git_credentials_secret_owner_fk;

delete from encrypted_secrets
using git_credentials
where encrypted_secrets.id = git_credentials.encrypted_secret_id;

drop table git_credentials;
drop table git_author_configuration;
