{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.openjdk17
    pkgs.gradle
    pkgs.unzip
    pkgs.wget
  ];
}
