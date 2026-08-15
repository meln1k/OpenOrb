create table runner_enrollment_tokens (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique check (length(token_hash) = 64),
  created_at text not null,
  revoked_at text,
  unique (user_id, id)
);

create table runners (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  enrollment_token_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 100),
  architecture text not null check (architecture in ('x64', 'arm64')),
  capabilities text not null,
  token_hash text not null unique check (length(token_hash) = 64),
  created_at text not null,
  revoked_at text,
  unique (user_id, id),
  constraint runners_enrollment_token_owner_fk
    foreign key (user_id, enrollment_token_id)
    references runner_enrollment_tokens(user_id, id) on delete restrict
);
