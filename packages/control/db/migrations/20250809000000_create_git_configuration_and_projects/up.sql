create table git_author_configuration (
  user_id integer primary key references users(id) on delete cascade,
  author_name text not null check (
    length(btrim(author_name)) between 1 and 200
  ),
  author_email text not null check (
    length(btrim(author_email)) between 3 and 254
  ),
  updated_at text not null
);

create table git_credentials (
  id uuid primary key,
  user_id integer not null references users(id) on delete cascade,
  host text not null check (host = 'github.com'),
  encrypted_secret_id uuid not null unique,
  created_at text not null,
  updated_at text not null,
  unique (user_id, host),
  constraint git_credentials_secret_owner_fk foreign key (user_id, encrypted_secret_id)
    references encrypted_secrets(user_id, id) on delete restrict
);

create table projects (
  id uuid primary key,
  user_id integer not null references users(id) on delete cascade,
  name text not null check (
    length(btrim(name)) between 1 and 100
  ),
  repository_url text not null check (
    repository_url like 'https://github.com/%.git'
  ),
  default_ref text not null check (
    length(btrim(default_ref)) between 1 and 255
  ),
  default_branch_pattern text not null check (
    length(btrim(default_branch_pattern)) between 1 and 128
  ),
  created_at text not null,
  updated_at text not null,
  unique (user_id, name),
  unique (user_id, id)
);
