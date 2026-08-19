import { assertEquals } from "@std/assert";

import { canonicalizeGitHubRepository } from "@/app/actions/projects/project-input.ts";

Deno.test("canonicalizes only supported GitHub repository forms", () => {
  for (
    const input of [
      "openorb-dev/openorb",
      "https://github.com/openorb-dev/openorb",
      "https://github.com/openorb-dev/openorb.git",
      " https://GITHUB.com/openorb-dev/openorb/ ",
    ]
  ) {
    assertEquals(
      canonicalizeGitHubRepository(input),
      "https://github.com/openorb-dev/openorb.git",
    );
  }

  for (
    const input of [
      "git@github.com:openorb-dev/openorb.git",
      "ssh://git@github.com/openorb-dev/openorb.git",
      "http://github.com/openorb-dev/openorb",
      "https://gitlab.com/openorb-dev/openorb",
      "https://token@github.com/openorb-dev/openorb",
      "https://github.com/openorb-dev/openorb/issues",
      "https://github.com/openorb-dev/openorb?token=value",
      "https://@github.com/openorb-dev/openorb",
      "https://github.com/openorb-dev/openorb?",
      "https://github.com/openorb-dev/openorb#",
      "openorb-dev",
    ]
  ) {
    assertEquals(canonicalizeGitHubRepository(input), null, input);
  }
});
