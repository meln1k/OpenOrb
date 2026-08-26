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

export const GUEST_IMAGE_RELEASE: GuestImageRelease = {
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
