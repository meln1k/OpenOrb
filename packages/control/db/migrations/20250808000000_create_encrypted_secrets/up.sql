create table encrypted_secrets (
  id uuid primary key,
  user_id integer not null references users(id) on delete cascade,
  key text not null,
  key_version integer not null check (key_version >= 1),
  ciphertext text not null,
  created_at text not null,
  updated_at text not null,
  unique (user_id, key),
  unique (user_id, id)
);
