import type { Middleware } from "remix/router";
import { redirect } from "remix/response/redirect";

export function redirectUnauthorizedPages(): Middleware {
  return async (context, next) => {
    const response = await next();
    const { pathname } = context.url;
    const isProtectedPage = pathname === "/app" || pathname.startsWith("/app/") ||
      pathname === "/auth/logout";

    return response.status === 401 && isProtectedPage ? redirect("/") : response;
  };
}
