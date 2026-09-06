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
