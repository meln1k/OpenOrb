import { run } from "remix/ui";

const app = run({
  async loadModule(moduleUrl, exportName) {
    const module = await import(moduleUrl);
    return module[exportName];
  },
  async resolveFrame(src, signal, target) {
    const headers = new Headers({ accept: "text/html" });
    if (target) headers.set("x-remix-target", target);

    const response = await fetch(src, { headers, signal });
    return response.body ?? await response.text();
  },
});

app.addEventListener("error", (event) => {
  console.error(event.error);
});

await app.ready();
