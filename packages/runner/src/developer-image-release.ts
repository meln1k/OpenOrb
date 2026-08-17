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
      gondolinBuildId: "4cbb4faa-569d-531c-946f-f1e693a8d692",
      manifestSha256: "55a39d932ecf768582313d47587f9d97786a17e230d435f57bdc1fd104d5ccdc",
      url:
        "https://github.com/meln1k/openorb/releases/download/developer-image-mvp-1/gondolin-image-openorb-developer-mvp-1-aarch64.tar.gz",
      sizeBytes: 102_182_390,
      sha256: "6efe43605c2632307cd878b62123008f21820a271105844e2a45ef8e05d272fd",
    },
    x64: {
      gondolinArchitecture: "x86_64",
      gondolinBuildId: "46977640-e4fa-5bf8-95a5-e9426b603ee2",
      manifestSha256: "b5f1adbcb90e832528595fedf654039e4f848f8e9a757a45961cecce8abbdfe0",
      url:
        "https://github.com/meln1k/openorb/releases/download/developer-image-mvp-1/gondolin-image-openorb-developer-mvp-1-x86_64.tar.gz",
      sizeBytes: 106_657_475,
      sha256: "44e6cafbfd100ad1e868a570adeef6b112a05df3fd8e0f61f3d495b7bf446d91",
    },
  },
};
