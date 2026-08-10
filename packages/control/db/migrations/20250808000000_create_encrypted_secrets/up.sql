create table encrypted_secrets (
  id uuid primary key,
  key text not null unique,
  key_version integer not null check (key_version >= 1),
  ciphertext text not null,
  created_at text not null,
  updated_at text not null
);
