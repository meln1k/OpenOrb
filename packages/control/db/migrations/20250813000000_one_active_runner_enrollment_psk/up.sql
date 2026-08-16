with active_tokens as (
  select
    id,
    first_value(created_at) over (
      partition by user_id
      order by created_at desc, id desc
    ) as replacement_created_at,
    row_number() over (
      partition by user_id
      order by created_at desc, id desc
    ) as active_rank
  from runner_enrollment_tokens
  where revoked_at is null
)
update runner_enrollment_tokens as tokens
set revoked_at = active_tokens.replacement_created_at
from active_tokens
where tokens.id = active_tokens.id
  and active_tokens.active_rank > 1;

create unique index runner_enrollment_tokens_one_active_per_user_idx
  on runner_enrollment_tokens (user_id)
  where revoked_at is null;
