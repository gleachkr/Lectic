{ 
  stdenv,
  importNpmLock,
  bun,
  nodejs
} :

stdenv.mkDerivation {
  pname = "lectic";
  version = "0.0.0";
  src = ./..;
  buildPhase = ''
  runHook preBuild

  bun build src/main.ts src/lsp/parserWorker.ts --compile --minify --sourcemap --outfile lectic

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
    npmRoot = ./..;
    inherit nodejs;
  };
}
