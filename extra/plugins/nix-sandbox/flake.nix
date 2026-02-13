{
  description = "Lectic nix-sandbox plugin";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        defaultContainerPackages = with pkgs; [
          bashInteractive
          coreutils
          findutils
          gnugrep
          gnused
          gawk
          git
          jq
          curl
          cacert
          util-linux
        ];

        extraPackagesFile = builtins.getEnv "LECTIC_NIX_SANDBOX_EXTRA_PKGS_FILE";

        normalizeExtraPackages = value:
          if builtins.isList value then
            value
          else if builtins.isAttrs value && value ? packages then
            if builtins.isList value.packages then
              value.packages
            else
              throw "extra packages file: 'packages' must be a list"
          else
            throw (
              "extra packages file must evaluate to a list, or an attrset "
              + "with a 'packages' list"
            );

        loadedExtra =
          if extraPackagesFile == "" then
            [ ]
          else
            let
              imported = import extraPackagesFile;
              evaluated =
                if builtins.isFunction imported then
                  imported {
                    inherit pkgs;
                    callPackage = pkgs.callPackage;
                  }
                else
                  imported;
            in
            normalizeExtraPackages evaluated;

        rootfs = pkgs.buildEnv {
          name = "lectic-nix-sandbox-rootfs";
          paths = defaultContainerPackages ++ loadedExtra;
          pathsToLink = [
            "/bin"
            "/etc/ssl/certs"
          ];
        };
      in
      {
        packages.containerImage = pkgs.dockerTools.buildImage {
          name = "lectic/nix-sandbox";
          tag = "0.1.0";
          copyToRoot = rootfs;
          config = {
            Cmd = [ "/bin/bash" ];
            Env = [
              "PATH=/bin"
              "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
            ];
            WorkingDir = "/";
          };
        };

        packages.default = pkgs.writeShellApplication {
          name = "lectic-nix-sandbox";
          runtimeInputs = with pkgs; [
            bash
            coreutils
            findutils
            gnugrep
            gnused
            nix
            podman
          ];
          text = builtins.readFile ./lectic-nix-sandbox;
        };

        apps.default = {
          type = "app";
          program =
            "${self.packages.${system}.default}/bin/"
            + "lectic-nix-sandbox";
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bash
            nix
            podman
            bubblewrap
          ];
        };
      }
    );
}
