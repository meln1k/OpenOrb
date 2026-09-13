export type GuestImageArchitecture = "arm64" | "x64";

export interface GuestImageAssetRelease {
  gondolinArchitecture: "aarch64" | "x86_64";
  gondolinBuildId: string;
  manifestSha256: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

export interface GuestImageRelease {
  id: string;
  assets: Record<GuestImageArchitecture, GuestImageAssetRelease>;
}

export const MVP_7: GuestImageRelease = {
  id: "mvp-7",
  assets: {
    arm64: {
      gondolinArchitecture: "aarch64",
      gondolinBuildId: "afff4c38-c758-5afa-af40-6842ffd0445f",
      manifestSha256: "4718872688e1c96e9d0c774c2267f44b07d98df89ac748679f17e500001a989d",
      url:
        "https://github.com/meln1k/openorb/releases/download/guest-image-mvp-7/gondolin-image-openorb-guest-mvp-7-aarch64.tar.gz",
      sizeBytes: 819_511_832,
      sha256: "147900b6b91cce3a210037b34215d8272de052972f930616a6418bc28527a96f",
    },
    x64: {
      gondolinArchitecture: "x86_64",
      gondolinBuildId: "637428c8-97a1-5e0e-8a6d-52545c7529b6",
      manifestSha256: "a9b5e6787ad96c0b30a834f3b54e12e5e7c7f70a3b9f6ec0077c5ebe29c9492f",
      url:
        "https://github.com/meln1k/openorb/releases/download/guest-image-mvp-7/gondolin-image-openorb-guest-mvp-7-x86_64.tar.gz",
      sizeBytes: 839_344_878,
      sha256: "ec628308b30315d968a931d43a2c1139a66c5341b615c11b1122800401a344f4",
    },
  },
};

export const RELEASE_1: GuestImageRelease = {
  id: "release-1",
  assets: {
    arm64: {
      gondolinArchitecture: "aarch64",
      gondolinBuildId: "7ebace0a-2463-56b4-8b7e-806c28e754e7",
      manifestSha256: "f496ff7a727ed968e3bffddf1ffe20b3eb4221e26fbd9b6c8104e2900d0ed86a",
      url:
        "https://github.com/meln1k/openorb/releases/download/guest-image-release-1/gondolin-image-openorb-guest-release-1-aarch64.tar.gz",
      sizeBytes: 776_922_835,
      sha256: "e0d0ebc27bc06f6b4dfb7dd2a00c2087775ff733f8ea744b311bdb442e310e9e",
    },
    x64: {
      gondolinArchitecture: "x86_64",
      gondolinBuildId: "5e6d58f2-2f50-527a-aaa0-13511ad4b001",
      manifestSha256: "7dac33ac65e848724235b588df9e79e9855e1d8aae97b28844350632f0bd7330",
      url:
        "https://github.com/meln1k/openorb/releases/download/guest-image-release-1/gondolin-image-openorb-guest-release-1-x86_64.tar.gz",
      sizeBytes: 796_290_881,
      sha256: "e192e5747bff805d92e7c2b81c45a2ce2a0de54509f01c98512f4be1f2f885bf",
    },
  },
};

// Retain immutable entries when changing the default: existing session disks depend on them.
// Every entry must remain compatible with this runner's Gondolin integration.
export const GUEST_IMAGE_RELEASES: readonly GuestImageRelease[] = [MVP_7, RELEASE_1];
export const GUEST_IMAGE_RELEASE = RELEASE_1;
