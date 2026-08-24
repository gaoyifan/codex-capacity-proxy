{
  buildNpmPackage,
  lib,
}:
buildNpmPackage {
  pname = "codex-capacity-proxy";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ../.;
    filter = path: type: let
      name = baseNameOf path;
    in
      name
      != ".git"
      && name != "node_modules"
      && name != "result";
  };

  npmDepsHash = "sha256-Q083hRfCYJ9eitLgbd0LiwheCzcvNhqfGBQnpnmt1PA=";

  meta = {
    description = "Transparent retry proxy for the ChatGPT Codex backend";
    homepage = "https://github.com/gaoyifan/codex-capacity-proxy";
    mainProgram = "codex-capacity-proxy";
    platforms = lib.platforms.linux;
  };
}
