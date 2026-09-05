create table sessions (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id uuid not null,
  project_id uuid not null,
  created_at text not null,
  initial_prompt_preview text not null check (
    char_length(initial_prompt_preview) between 1 and 200
  ),
  primary key (workspace_id, id),
  constraint sessions_project_owner_fk foreign key (workspace_id, project_id)
    references projects(workspace_id, id) on delete restrict
);

create table deleted_sessions (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  session_id uuid not null,
  deleted_at text not null,
  primary key (workspace_id, session_id)
);
