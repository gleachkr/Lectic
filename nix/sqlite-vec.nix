{
  stdenv,
  sqlite-vec-repo,
  envsubst,
  sqlite,
  lib
} : 

stdenv.mkDerivation (finalAttrs: {
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
    license = lib.licenses.mit;
    homepage = "https://github.com/asg017/sqlite-vec";
  };
})
