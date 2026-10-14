import { test } from "vite-plus/test";
import { assertEquals } from "@jsr/std__assert";

import { ORB_SIZE_RESOURCES, ORB_SIZES } from "../src/index.ts";

test("defines the fixed orb provisioning sizes", () => {
  assertEquals(ORB_SIZES, ["tiny", "small", "medium", "large", "xxlarge"]);
  assertEquals(ORB_SIZE_RESOURCES, {
    tiny: { cpuCount: 1, memoryMiB: 2048 },
    small: { cpuCount: 2, memoryMiB: 4096 },
    medium: { cpuCount: 4, memoryMiB: 8192 },
    large: { cpuCount: 8, memoryMiB: 16_384 },
    xxlarge: { cpuCount: 16, memoryMiB: 32_768 },
  });
});
