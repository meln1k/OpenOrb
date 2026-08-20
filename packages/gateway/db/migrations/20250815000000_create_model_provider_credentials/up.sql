create table model_provider_credentials (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  provider_id text not null check (
    length(provider_id) between 1 and 64 and
    provider_id ~ '^[a-z0-9][a-z0-9._-]*$'
  ),
  encrypted_secret_id uuid not null unique,
  created_at text not null,
  updated_at text not null,
  unique (user_id, provider_id),
  constraint model_provider_credentials_secret_owner_fk
    foreign key (user_id, encrypted_secret_id)
    references encrypted_secrets(user_id, id) on delete restrict
);
