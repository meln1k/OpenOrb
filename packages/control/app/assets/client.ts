import { type ResolveFrameOptions, run } from "remix/ui";

const app = run({
  async loadModule(moduleUrl, exportName) {
    const module = await import(moduleUrl);
    return module[exportName];
  },
  resolveFrame(src, options) {
    const headers = new Headers({ accept: "text/html" });
    if (options?.target) headers.set("x-remix-target", options.target);

    return fetch(src, {
      body: getRequestBody(options),
      headers,
      method: options?.method,
      signal: options?.signal,
    });
  },
});

function getRequestBody(options?: ResolveFrameOptions): BodyInit | undefined {
  const formData = options?.formData;
  if (!formData || options.method?.toLowerCase() === "get") return;
  if (options.encType !== "application/x-www-form-urlencoded") return formData;

  const body = new URLSearchParams();
  for (const [name, value] of formData) {
    body.append(name, typeof value === "string" ? value : value.name);
  }
  return body;
}

app.addEventListener("error", (event) => {
  console.error(event.error);
});

await app.ready();
