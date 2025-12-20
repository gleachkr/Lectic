{
  inputs = {
    utils.url = "github:numtide/flake-utils";
    nix-appimage.url = "github:ralismark/nix-appimage";
    sqlite-vec-repo = {
      url = "github:asg017/sqlite-vec";
      flake = false;
    };
  };
  outputs = { self, nixpkgs, utils, sqlite-vec-repo, nix-appimage }: utils.lib.eachDefaultSystem (system:
    let
      pkgs = nixpkgs.legacyPackages.${system};

      lectic = pkgs.callPackage ./nix/lectic.nix { };

      nix-sandbox = pkgs.callPackage ./extra/sandbox.nix { };
    in
    {

      packages.sqlite-vec = pkgs.callPackage ./nix/sqlite-vec.nix { 
        inherit sqlite-vec-repo; 
      };

      packages.default = self.packages.${system}.lectic-core;

      packages.lectic-core = lectic;

      packages.lectic-full = with pkgs; stdenvNoCC.mkDerivation {
        name = "lectic-full";
        src = ./.;
        buildPhase = ''
          mkdir $out
          cp ${lectic}/bin/lectic $out
          find $src/extra -type f -name "lectic-*" -exec cp {} $out \;
        '';
      };

      packages.lectic-appimage = nix-appimage.bundlers.${system}.default lectic;

      packages.lectic-nvim = pkgs.vimUtils.buildVimPlugin {
        pname = "lectic-nvim";
        version = "0.0.0-beta7";
        src = ./extra/lectic.nvim;
      };

      apps.default = {
        type = "app";
        program = "${self.packages.${system}.default}/bin/lectic";
      };

      apps.nix-sandbox= {
        type = "app";
        program = "${nix-sandbox}/bin/run-container-with-config";
      };

      devShell = with pkgs; mkShell {
        buildInputs =  [
          importNpmLock.hooks.linkNodeModulesHook
          bun
          jq
        ];
        npmDeps = importNpmLock.buildNodeModules {
          inherit nodejs;
          npmRoot = ./.;
        };
      };
    }
  );
}
