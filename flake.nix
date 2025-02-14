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
        pname = "lectic";
        name = "lectic";
        src = ./.;
        buildPhase = ''
          runHook preBuild
          
          bun build src/main.ts --compile --minify --bytecode --sourcemap --outfile lectic

          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/bin

          cp lectic $out/bin/

          du $out/bin/lectic > $out/usage

          runHook postInstall
        '';

        dontFixup = true;

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
