alter table runners add column capabilities text not null default '[]';
alter table runners alter column capabilities drop default;
