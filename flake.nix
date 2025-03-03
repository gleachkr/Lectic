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
      sqlite-vec = with pkgs; stdenv.mkDerivation (finalAttrs: {
        pname = "sqlite-vec";
        version = "v0.1.6";

        src = sqlite-vec-repo;

        makeFlags = [
          "loadable"
          "static"
        ];

        installPhase = ''
          runHook preInstall

          install -Dm444 -t "$out/lib" \
            "dist/libsqlite_vec0${stdenv.hostPlatform.extensions.staticLibrary}" \
            "dist/vec0${stdenv.hostPlatform.extensions.sharedLibrary}"

          runHook postInstall
        '';

        buildInputs = [
          envsubst
          sqlite
        ];

        meta = {
          description = "sqlite extension for vector queries";
          license = licenses.mit;
          homepage = "https://github.com/asg017/sqlite-vec";
        };
      });
      lectic = with pkgs; stdenv.mkDerivation {
        pname = "lectic";
        version = "0.0.0";
        src = ./.;
        buildPhase = ''
          runHook preBuild
          
          bun build src/main.ts --compile --minify --sourcemap --outfile lectic

          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/bin

          cp lectic $out/bin/

          runHook postInstall
        '';

        dontFixup = true;

        buildInputs = [
          importNpmLock.hooks.linkNodeModulesHook
          bun
        ];
        npmDeps = importNpmLock.buildNodeModules {
          npmRoot = ./.;
          inherit nodejs;
        };
      };
    in
    {

      packages.sqlite-vec = sqlite-vec;

      packages.default = lectic;

      packages.lectic = lectic;

      packages.lectic-nvim = pkgs.vimUtils.buildVimPlugin {
        pname = "lectic-nvim";
        version = "0.0.1";
        src = ./extra/lectic.nvim;
      };

      packages.lectic-appimage = nix-appimage.bundlers.${system}.default lectic;

      apps.default = {
        type = "app";
        program = "${self.packages.${system}.default}/bin/lectic";
      };

      devShell = with pkgs; mkShell {
        buildInputs =  [
          importNpmLock.hooks.linkNodeModulesHook
          bun
        ];
        npmDeps = importNpmLock.buildNodeModules {
          npmRoot = ./.;
          inherit nodejs;
        };
      };
    }
  );
}
