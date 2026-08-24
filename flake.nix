{
  description = "Transparent retry proxy for the ChatGPT Codex backend";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
      package = pkgs.callPackage ./nix/package.nix {};
    in {
      codex-capacity-proxy = package;
      default = package;
    });

    nixosModules.default = import ./nix/module.nix {inherit self;};
  };
}
