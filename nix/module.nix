{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.codex-capacity-proxy;
in {
  options.services.codex-capacity-proxy = {
    enable = lib.mkEnableOption "Codex capacity proxy";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "codex-capacity-proxy.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "Codex capacity proxy package to run.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address on which the proxy listens.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8788;
      description = "TCP port on which the proxy listens.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.codex-capacity-proxy = {
      description = "Codex capacity proxy";
      wantedBy = ["multi-user.target"];
      serviceConfig = {
        Type = "simple";
        DynamicUser = true;
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = "5s";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
        ];
      };
      environment = {
        CODEX_PROXY_HOST = cfg.listenAddress;
        CODEX_PROXY_PORT = toString cfg.port;
      };
    };
  };
}
