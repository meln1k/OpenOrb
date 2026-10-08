// Native celld fixture: only provider HTTP is synthetic; DO storage and alarms are real.
import worker from "../src/worker.ts";
import { Workspace as ConfigurationWorkspace } from "../src/workspace.ts";

export class Workspace extends ConfigurationWorkspace {
  fetch(): never {
    throw new Error("DO fetch forwarding is forbidden: the Worker must call named RPC methods");
  }
}

export default worker;

const networkFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== "https://auth.openai.com") return networkFetch(input, init);
  switch (url.pathname) {
    case "/api/accounts/deviceauth/usercode":
      return Response.json({
        device_auth_id: String(Date.now()),
        user_code: "TEST-CODE",
        interval: 2,
      });
    case "/api/accounts/deviceauth/token": {
      const body: { device_auth_id: string } = await request.json();
      // Time survives a process restart without adding mock persistence to the production object.
      if (Date.now() - Number(body.device_auth_id) < 15_000) {
        return new Response(null, { status: 403 });
      }
      return Response.json({ authorization_code: "test-code", code_verifier: "test-verifier" });
    }
    case "/oauth/token": {
      const payload = btoa(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
      );
      return Response.json({
        access_token: `e30.${payload}.test-signature`,
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
      });
    }
    case "/oauth/revoke":
      return new Response(null, { status: 200 });
    default:
      return new Response(null, { status: 404 });
  }
};
