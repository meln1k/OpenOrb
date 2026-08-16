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
    settings: form("settings"),
  }),
  api: route("api", {
    runners: route("runners", {
      enroll: post("enroll"),
      connect: get("connect"),
    }),
  }),
});
