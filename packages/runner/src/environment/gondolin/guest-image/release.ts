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
  id: "mvp-2",
  assets: {
    arm64: {
      gondolinArchitecture: "aarch64",
      gondolinBuildId: "aa1462cb-82f6-52e8-b4b1-1f1b2552e097",
      manifestSha256: "0e410bd4d312260114c783741dd40db76bad57f63702cbbcbf94eea5d909bc93",
      url:
        "https://github.com/meln1k/openorb/releases/download/developer-image-mvp-2/gondolin-image-openorb-developer-mvp-2-aarch64.tar.gz",
      sizeBytes: 102_182_786,
      sha256: "247922ee87ab66de364b89213eca16e135912c317d7e4e2b2aea50d1629d4050",
    },
    x64: {
      gondolinArchitecture: "x86_64",
      gondolinBuildId: "77fc416d-2645-5204-b18a-87d011d50d24",
      manifestSha256: "fd16f03c2fb0088d0e564e7058696784db238ffd246370e293d95454fe32599a",
      url:
        "https://github.com/meln1k/openorb/releases/download/developer-image-mvp-2/gondolin-image-openorb-developer-mvp-2-x86_64.tar.gz",
      sizeBytes: 106_657_391,
      sha256: "dd8e233d20cd7a410891f2e284ee159da3366304cc7f972737d713c1d19eaef2",
    },
  },
};
