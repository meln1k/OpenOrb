import { createHash } from "node:crypto";
import { join } from "node:path";

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Cause, Effect, Exit, Scope } from "effect";

import {
  ensureGuestImage,
  type GuestImage,
} from "@/src/environment/gondolin/guest-image/installer.ts";
import {
  GUEST_IMAGE_RELEASE,
  type GuestImageRelease,
} from "@/src/environment/gondolin/guest-image/release.ts";
import { makeGondolinAgentEnvironmentProvider } from "@/src/environment/gondolin/layer.ts";

const MVP_5: GuestImageRelease = {
  id: "mvp-5",
  assets: {
    arm64: {
      gondolinArchitecture: "aarch64",
      gondolinBuildId: "63090235-6080-5dd3-ac23-516a3f2435a8",
      manifestSha256: "2b479497365f057b9c7367a836936921e148715fa37908841d2539f3f4679edb",
      url:
        "https://github.com/meln1k/openorb/releases/download/guest-image-mvp-5/gondolin-image-openorb-guest-mvp-5-aarch64.tar.gz",
      sizeBytes: 816_776_397,
      sha256: "6e48c41b22e3082d2bb1a889af84c108737abcb53f329bcdbe3e389291eb4665",
    },
    x64: {
      gondolinArchitecture: "x86_64",
      gondolinBuildId: "02e784cb-e063-5138-b1c4-334e8a3307a9",
      manifestSha256: "8f876ae487fd8c8fd640fafcb5658596db8185fdcce8e3c0ea748856219031a2",
      url:
        "https://github.com/meln1k/openorb/releases/download/guest-image-mvp-5/gondolin-image-openorb-guest-mvp-5-x86_64.tar.gz",
      sizeBytes: 838_270_875,
      sha256: "3c94f55880898993ccc9dc62818218a874b41e1b2b37fb61bdcbbdc3dff99cbe",
    },
  },
};

const MVP_6: GuestImageRelease = {
  id: "mvp-6",
  assets: {
    arm64: {
      gondolinArchitecture: "aarch64",
      gondolinBuildId: "6f91329b-2a19-5d4b-8497-59ca20bc893b",
      manifestSha256: "f0dbe0d8ae07be7e8d47ef9c8fb6a5cb056b23c1db35bc616a09d0e5fa6ceb36",
      url:
        "https://github.com/meln1k/openorb/releases/download/guest-image-mvp-6/gondolin-image-openorb-guest-mvp-6-aarch64.tar.gz",
      sizeBytes: 816_901_913,
      sha256: "b116bbae2dcaa62ce1b198e0c76c32d642b6962d74eb843dd9c29d61f01e0d2f",
    },
    x64: {
      gondolinArchitecture: "x86_64",
      gondolinBuildId: "10689eb6-d019-5f32-b0d4-18443743278f",
      manifestSha256: "22b12f566823102467cc0109a917bf045a415f3b39b0642e3af3a2d1ab78f8ed",
      url:
        "https://github.com/meln1k/openorb/releases/download/guest-image-mvp-6/gondolin-image-openorb-guest-mvp-6-x86_64.tar.gz",
      sizeBytes: 838_420_591,
      sha256: "11eadfae7e223ef135136cb591c9e84da21faf6ca0c6e1987231d77dc3578501",
    },
  },
};

const RELEASES = [MVP_5, GUEST_IMAGE_RELEASE] as const;
const MEMORY_MIB = 4096;
const textDecoder = new TextDecoder();

Deno.test({
  name: "published MVP images verify current persistence and expose old compatibility limits",
  ignore: Deno.env.get("OPENORB_RUN_PUBLISHED_IMAGE_TESTS") !== "1" ||
    Deno.build.os !== "linux" || Deno.build.arch !== "x86_64",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const workingDirectory = await Deno.makeTempDir({ prefix: "openorb-published-images-" });
    try {
      const oldImage = await install(workingDirectory, MVP_5);
      const newImage = await install(workingDirectory, GUEST_IMAGE_RELEASE);
      assertEquals(oldImage.releaseId, "mvp-5");
      assertEquals(newImage.releaseId, "mvp-7");

      const oldDisk = join(workingDirectory, "sessions", "old", "root-disk.qcow2");
      await Deno.mkdir(join(workingDirectory, "sessions", "old"), { recursive: true });
      const oldProvider = makeGondolinAgentEnvironmentProvider(oldImage, true);
      await Effect.runPromise(oldProvider.initializeRootDisk(oldDisk));
      await expectMissingResize2fs(oldProvider, oldDisk);
      const oldBacking = await backingFilename(oldDisk);
      assertEquals(oldBacking, join(oldImage.path, "rootfs.ext4"));

      // Force restore to exercise catalog-pinned recovery instead of merely reusing cached assets.
      await Deno.remove(oldImage.path, { recursive: true });
      const upgradedProvider = makeGondolinAgentEnvironmentProvider(newImage, true, {
        releases: RELEASES,
      });
      await Effect.runPromise(upgradedProvider.initializeRootDisk(oldDisk));
      assertEquals(await backingFilename(oldDisk), oldBacking);
      await expectMissingResize2fs(upgradedProvider, oldDisk);
      await assertInstalledImage(oldImage.path);

      const newDisk = join(workingDirectory, "sessions", "new", "root-disk.qcow2");
      await Deno.mkdir(join(workingDirectory, "sessions", "new"), { recursive: true });
      await Effect.runPromise(upgradedProvider.initializeRootDisk(newDisk));
      await useEnvironment(upgradedProvider, newDisk, async (environment) => {
        await assertGuestIdentity(environment, "mvp-7");
        await writeMarkers(environment, "new-image-marker");
      });
      const restartedProvider = makeGondolinAgentEnvironmentProvider(newImage, true, {
        releases: RELEASES,
      });
      await useEnvironment(restartedProvider, newDisk, async (environment) => {
        await assertGuestIdentity(environment, "mvp-7");
        await assertMarkers(environment, "new-image-marker");
      });

      const diskDigest = await sha256File(oldDisk);
      const runtimePath = join(workingDirectory, "sessions", "old", "runtime.json");
      const oldRuntime = await Deno.readTextFile(runtimePath);
      await Deno.writeTextFile(
        runtimePath,
        JSON.stringify({
          version: 1,
          releaseId: newImage.releaseId,
          architecture: newImage.architecture,
          manifestSha256: newImage.manifestSha256,
        }),
      );
      const mismatchScope = await Effect.runPromise(Scope.make());
      try {
        const mismatch = await Effect.runPromiseExit(
          restartedProvider.make(environmentOptions(oldDisk)).pipe(
            Effect.provideService(Scope.Scope, mismatchScope),
          ),
        );
        assert(Exit.isFailure(mismatch));
        assertStringIncludes(
          Cause.pretty(mismatch.cause),
          "persistent root disk does not match its pinned backing image",
        );
        assertEquals(await sha256File(oldDisk), diskDigest);
      } finally {
        await Effect.runPromise(Scope.close(mismatchScope, Exit.void));
        await Deno.writeTextFile(runtimePath, oldRuntime);
      }
    } finally {
      await Deno.remove(workingDirectory, { recursive: true });
    }
  },
});

Deno.test({
  name: "published MVP-6 either persists across an upgrade or proves its artifact limitation",
  ignore: Deno.env.get("OPENORB_RUN_PUBLISHED_IMAGE_TESTS") !== "1" ||
    Deno.build.os !== "linux" || Deno.build.arch !== "x86_64",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const workingDirectory = await Deno.makeTempDir({ prefix: "openorb-published-mvp6-" });
    try {
      const image = await install(workingDirectory, MVP_6);
      assertEquals(image.releaseId, "mvp-6");
      assertEquals(image.gondolinBuildId, MVP_6.assets.x64.gondolinBuildId);
      assertEquals(image.manifestSha256, MVP_6.assets.x64.manifestSha256);

      const rootDiskPath = join(workingDirectory, "session", "root-disk.qcow2");
      await Deno.mkdir(join(workingDirectory, "session"), { recursive: true });
      const provider = makeGondolinAgentEnvironmentProvider(image, true);
      await Effect.runPromise(provider.initializeRootDisk(rootDiskPath));

      const scope = await Effect.runPromise(Scope.make());
      const started = await Effect.runPromiseExit(
        provider.make(environmentOptions(rootDiskPath)).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      if (Exit.isFailure(started)) {
        try {
          assertStringIncludes(Cause.pretty(started.cause), "rootfs.size requires resize2fs");
          await assertResize2fsAbsent(join(image.path, "rootfs.ext4"));
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
        return;
      }

      try {
        await assertGuestIdentity(started.value, "mvp-6");
        await writeMarkers(started.value, "mvp-6-marker");
        await Effect.runPromise(started.value.stop);
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void));
      }

      const newImage = await install(workingDirectory, GUEST_IMAGE_RELEASE);
      const restartedProvider = makeGondolinAgentEnvironmentProvider(newImage, true, {
        releases: [MVP_6, GUEST_IMAGE_RELEASE],
      });
      await useEnvironment(restartedProvider, rootDiskPath, async (environment) => {
        await assertGuestIdentity(environment, "mvp-6");
        await assertMarkers(environment, "mvp-6-marker");
      });
    } finally {
      await Deno.remove(workingDirectory, { recursive: true });
    }
  },
});

type Provider = ReturnType<typeof makeGondolinAgentEnvironmentProvider>;
type Environment = Awaited<ReturnType<typeof openEnvironment>>["environment"];

async function install(workingDirectory: string, release: GuestImageRelease): Promise<GuestImage> {
  const [image, error] = await ensureGuestImage({
    workingDirectory,
    architecture: "x64",
    release,
  });
  if (error !== undefined) throw error;
  return image;
}

async function openEnvironment(provider: Provider, rootDiskPath: string) {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const environment = await Effect.runPromise(
      provider.make(environmentOptions(rootDiskPath)).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    return { environment, scope };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

async function useEnvironment(
  provider: Provider,
  rootDiskPath: string,
  use: (environment: Environment) => Promise<void>,
): Promise<void> {
  const opened = await openEnvironment(provider, rootDiskPath);
  try {
    await use(opened.environment);
    await Effect.runPromise(opened.environment.stop);
  } finally {
    await Effect.runPromise(Scope.close(opened.scope, Exit.void));
  }
}

async function expectMissingResize2fs(provider: Provider, rootDiskPath: string): Promise<void> {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const result = await Effect.runPromiseExit(
      provider.make(environmentOptions(rootDiskPath)).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    assert(Exit.isFailure(result));
    assertStringIncludes(Cause.pretty(result.cause), "rootfs.size requires resize2fs");
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

function environmentOptions(rootDiskPath: string) {
  return {
    rootDiskPath,
    sessionLabel: `published image E2E ${rootDiskPath}`,
    cpuCount: 2,
    memoryMiB: MEMORY_MIB,
  };
}

async function assertGuestIdentity(environment: Environment, releaseId: string): Promise<void> {
  assertEquals(
    await commandOutput(environment, ["/bin/cat", "/etc/openorb-image-release"]),
    releaseId,
  );
  assertEquals(await commandOutput(environment, ["/usr/bin/uname", "-m"]), "x86_64");
  assertEquals(
    await commandOutput(environment, ["/bin/sh", "-lc", 'printf %s "$OPENORB_GUEST"']),
    "1",
  );
}

async function writeMarkers(environment: Environment, marker: string): Promise<void> {
  const result = await Effect.runPromise(environment.runShell(
    `set -eu; printf %s '${marker}' > /workspace/runtime-e2e-marker; mkdir -p /opt/openorb-runtime-e2e; printf %s '${marker}' > /opt/openorb-runtime-e2e/marker; sync`,
    { cwd: "/workspace", onOutput: () => Effect.void },
  ));
  assertEquals(result.exitCode, 0);
}

async function assertMarkers(environment: Environment, marker: string): Promise<void> {
  assertEquals(
    await commandOutput(environment, ["/bin/cat", "/workspace/runtime-e2e-marker"]),
    marker,
  );
  assertEquals(
    await commandOutput(environment, ["/bin/cat", "/opt/openorb-runtime-e2e/marker"]),
    marker,
  );
}

async function commandOutput(
  environment: Environment,
  command: readonly string[],
): Promise<string> {
  let output = "";
  const result = await Effect.runPromise(environment.run(command, {
    onOutput: (chunk) => Effect.sync(() => output += chunk.text),
  }));
  assertEquals(result.exitCode, 0);
  return output.trim();
}

async function backingFilename(path: string): Promise<string> {
  const output = await new Deno.Command("qemu-img", {
    args: ["info", "--output=json", path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success, textDecoder.decode(output.stderr));
  return JSON.parse(textDecoder.decode(output.stdout))["backing-filename"];
}

async function assertInstalledImage(path: string): Promise<void> {
  for (const name of ["manifest.json", "vmlinuz-virt", "initramfs.cpio.lz4", "rootfs.ext4"]) {
    assert((await Deno.stat(join(path, name))).isFile);
  }
}

async function assertResize2fsAbsent(rootfsPath: string): Promise<void> {
  const output = await new Deno.Command("/usr/sbin/debugfs", {
    args: ["-R", "stat /usr/sbin/resize2fs", rootfsPath],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success);
  assertStringIncludes(
    textDecoder.decode(output.stdout) + textDecoder.decode(output.stderr),
    "File not found by ext2_lookup",
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  using file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}
