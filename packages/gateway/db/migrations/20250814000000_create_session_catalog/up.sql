create table sessions (
  user_id uuid not null references users(id) on delete cascade,
  id uuid not null,
  project_id uuid not null,
  created_at text not null,
  initial_prompt_preview text not null check (
    char_length(initial_prompt_preview) between 1 and 200
  ),
  primary key (user_id, id),
  constraint sessions_project_owner_fk foreign key (user_id, project_id)
    references projects(user_id, id) on delete restrict
);

create table deleted_sessions (
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid not null,
  deleted_at text not null,
  primary key (user_id, session_id)
);
