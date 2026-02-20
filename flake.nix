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

      packages.default = self.packages.${system}.lectic-core;

      packages.lectic-core = lectic;

      packages.lectic-full = with pkgs; stdenvNoCC.mkDerivation {
        name = "lectic-full";
        src = ./.;
        nativeBuildInputs = [ makeWrapper ];
        #don't attempt to patch shebangs of lectic subcommands
        dontFixup = true;
        installPhase = ''
          mkdir -p $out/bin $out/share
          cp ${lectic}/bin/lectic $out/bin

          cp -r "$src/extra/plugins" "$out/share/"
          cp -r "$src/extra/skills" "$out/share/"

          find "$src/extra" -type f -name "lectic-*" \
            ! -path "$src/extra/plugins/*" \
            -exec cp {} "$out/bin" \;

          wrapProgram "$out/bin/lectic" \
            --prefix LECTIC_RUNTIME : "$out/share"

          mkdir -p "$out/share/bash-completion/completions"
          cp "$src/extra/tab_complete/lectic_completion.bash" \
            "$out/share/bash-completion/completions/lectic"

          completionFile="$out/share/bash-completion/completions/lectic"
          oldLine='__LECTIC_DATA_DIR="''${LECTIC_DATA:-''${__LECTIC_XDG_DATA_HOME}/lectic}"'
          runtimeLine='LECTIC_RUNTIME="'"$out"'/share''${LECTIC_RUNTIME:+:''$LECTIC_RUNTIME}"'
          newText="$oldLine"$'\n'"$runtimeLine"

          substituteInPlace "$completionFile" \
            --replace-fail "$oldLine" "$newText"
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

      devShell = with pkgs; mkShell {
        buildInputs =  [
          importNpmLock.hooks.linkNodeModulesHook
          bun
          jq
          lychee
        ];
        npmDeps = importNpmLock.buildNodeModules {
          inherit nodejs;
          npmRoot = ./.;
        };
      };
    }
  );
}
