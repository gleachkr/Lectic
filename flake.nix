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
    in
    {

      packages.sqlite-vec = pkgs.callPackage ./nix/sqlite-vec.nix { 
        inherit sqlite-vec-repo; 
      };

      packages.default = lectic;

      packages.lectic = lectic;

      packages.lectic-appimage = nix-appimage.bundlers.${system}.default lectic;

      packages.lectic-nvim = pkgs.vimUtils.buildVimPlugin {
        pname = "lectic-nvim";
        version = "0.0.1";
        src = ./extra/lectic.nvim;
      };

      apps.default = {
        type = "app";
        program = "${self.packages.${system}.default}/bin/lectic";
      };

      devShell = with pkgs; mkShell {
        buildInputs =  [
          importNpmLock.hooks.linkNodeModulesHook
          bun
          jq
        ];
        npmDeps = importNpmLock.buildNodeModules {
          npmRoot = ./.;
          inherit nodejs;
        };
      };
    }
  );
}
