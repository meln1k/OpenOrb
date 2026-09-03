import { assertMatch, assertStringIncludes } from "@std/assert";
import { renderToString } from "remix/ui/server";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/app/ui/components/index.ts";

Deno.test("tooltip composes an accessible trigger and positioned content", async () => {
  const html = await renderToString(
    <TooltipProvider delay={100}>
      <Tooltip id="vm-tooltip">
        <TooltipTrigger id="vm-status" tabIndex={0}>Status</TooltipTrigger>
        <TooltipContent side="bottom" align="end" sideOffset={8}>
          Gondolin VM: Active
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );

  assertStringIncludes(html, 'data-slot="tooltip-provider"');
  assertMatch(
    html,
    /id="vm-status" tabindex="0" aria-describedby="[^"]+-content" data-slot="tooltip-trigger"/,
  );
  assertMatch(
    html,
    /id="[^"]+-content" role="tooltip" data-align="end" data-side="bottom" data-slot="tooltip-content"/,
  );
  assertStringIncludes(html, "Gondolin VM: Active");
  assertStringIncludes(html, 'aria-hidden="true" data-slot="tooltip-arrow"');
});
