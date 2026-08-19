export type DeveloperImageArchitecture = "arm64" | "x64";

export interface DeveloperImageAssetRelease {
  gondolinArchitecture: "aarch64" | "x86_64";
  gondolinBuildId: string;
  manifestSha256: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

export interface DeveloperImageRelease {
  id: string;
  assets: Record<DeveloperImageArchitecture, DeveloperImageAssetRelease>;
}

export const DEVELOPER_IMAGE_RELEASE: DeveloperImageRelease = {
  id: "mvp-1",
  assets: {
    arm64: {
      gondolinArchitecture: "aarch64",
      gondolinBuildId: "4d414669-47ce-5bde-9fb0-da2014333aae",
      manifestSha256: "4d3da4bf4017e9c8e7de6d53f3bc894726dbab5eaa399c3f97eb4f45bc637982",
      url:
        "https://github.com/meln1k/openorb/releases/download/developer-image-mvp-1/gondolin-image-openorb-developer-mvp-1-aarch64.tar.gz",
      sizeBytes: 102_182_441,
      sha256: "7931b50fdb77dfd215365a4e775804ec164d8157c82eb077051ceb63d21bf7e4",
    },
    x64: {
      gondolinArchitecture: "x86_64",
      gondolinBuildId: "bc7af3ee-c7f1-5d60-b50d-16319637cb8c",
      manifestSha256: "0532180ffef55eb41cc5705331bd931b243c3bde792aac30f6cd7fc37be8ab2a",
      url:
        "https://github.com/meln1k/openorb/releases/download/developer-image-mvp-1/gondolin-image-openorb-developer-mvp-1-x86_64.tar.gz",
      sizeBytes: 106_657_808,
      sha256: "257d53f7cca910ca0822af07eba6d8ca17e63d33afadad692e4595c25e5c4a3c",
    },
  },
};
