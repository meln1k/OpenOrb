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

const MVP_7: GuestImageRelease = {
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

// Retain immutable entries when changing the default: existing session disks depend on them.
// Every entry must remain compatible with this runner's Gondolin integration.
export const GUEST_IMAGE_RELEASES: readonly GuestImageRelease[] = [MVP_7];
export const GUEST_IMAGE_RELEASE = MVP_7;
