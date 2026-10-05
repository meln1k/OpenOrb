import { clientEntry } from "remix/component";
import { object, optional, parseSafe, string } from "remix/data-schema";
import { tryAsync } from "../../../../../../result/src/index.ts";

const chatGPTPollResponseSchema = object({
  status: optional(string()),
  message: optional(string()),
  redirect: optional(string()),
});

export const ChatGPTAuthorizationPolling = clientEntry<{
  actionHref: string;
  csrfToken: string;
  intervalSeconds: number;
  statusId: string;
}>(
  import.meta.url,
  function ChatGPTAuthorizationPolling(handle) {
    handle.queueTask(() => {
      const status = document.getElementById(handle.props.statusId);
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const poll = async () => {
        const [response, requestError] = await tryAsync(
          fetch(handle.props.actionHref, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              _csrf: handle.props.csrfToken,
              intent: "poll-chatgpt",
            }),
            signal: handle.signal,
          }),
          () => true,
        );
        if (requestError !== undefined) {
          if (!handle.signal.aborted && status) {
            status.textContent = "Connection check failed. Try again.";
          }
          return;
        }
        const [body, readError] = await tryAsync(response.json(), () => true);
        if (readError !== undefined) {
          if (status) status.textContent = "Connection check failed. Try again.";
          return;
        }
        const parsed = parseSafe(chatGPTPollResponseSchema, body);
        if (!parsed.success) {
          if (status) status.textContent = "Connection check failed. Try again.";
          return;
        }
        const result = parsed.value;
        if (result.status === "complete" && result.redirect) {
          globalThis.location.assign(result.redirect);
          return;
        }
        if (!response.ok || result.status === "error") {
          if (status) {
            status.textContent = result.message ?? "Connection check failed. Try again.";
          }
          return;
        }
        timeout = globalThis.setTimeout(poll, handle.props.intervalSeconds * 1_000);
      };

      timeout = globalThis.setTimeout(poll, handle.props.intervalSeconds * 1_000);
      handle.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    });
    return () => null;
  },
);
