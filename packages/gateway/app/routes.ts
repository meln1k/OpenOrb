import { form, get, post, route } from "remix/routes";

export const routes = route({
  assets: get("/assets/*path"),
  health: get("/healthz"),
  home: "/",
  auth: route("auth", {
    setup: form("setup"),
    login: form("login"),
    logout: post("logout"),
  }),
  app: route("app", {
    index: get("/"),
    projects: form("projects"),
    sessions: route("sessions", {
      create: post("/"),
      detail: get(":sessionId"),
      message: post(":sessionId/messages"),
      retry: post(":sessionId/retry"),
    }),
    settings: form("settings"),
  }),
  api: route("api", {
    runners: route("runners", {
      enroll: post("enroll"),
      connect: get("connect"),
    }),
    sessions: route("sessions", {
      events: get(":sessionId/events"),
    }),
  }),
});
