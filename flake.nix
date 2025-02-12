{
  inputs = {
    utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, utils }: utils.lib.eachDefaultSystem (system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {

      packages.default = with pkgs; stdenv.mkDerivation {
        name = "lectic";
        src = ./.;
        buildPhase = ''
          mkdir -p $out/bin
          bun build --compile src/main.ts --outfile lectic
          mv lectic $out/bin
        '';
        buildInputs = [
          importNpmLock.hooks.linkNodeModulesHook
          nodejs
          bun
        ];
        npmDeps = importNpmLock.buildNodeModules {
          npmRoot = ./.;
          inherit nodejs;
        };
      };

      devShell = with pkgs; mkShell {
        buildInputs =  [
          importNpmLock.hooks.linkNodeModulesHook
          nodejs
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
