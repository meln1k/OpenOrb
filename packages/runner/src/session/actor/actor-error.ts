import { Data } from "effect";

/** Failure exposed by the session actor boundary. */
export class SessionActorError extends Data.TaggedError("SessionActorError")<{
  readonly message: string;
  readonly cause: unknown;
}> {
  constructor(message: string, cause: unknown) {
    super({ message, cause });
  }
}

export function actorError(cause: unknown): SessionActorError {
  return cause instanceof SessionActorError
    ? cause
    : new SessionActorError("The session actor operation failed.", cause);
}
