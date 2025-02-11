{
  inputs = {
    crane.url = "github:ipetkov/crane";
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, utils, crane }:
    utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        cranelib = crane.mkLib pkgs;
      in
      {

        defaultPackage = cranelib.buildPackage { 
          src = cranelib.cleanCargoSource ./.; 
          buildInputs = [
            pkgs.pkg-config
            pkgs.openssl
          ];
        };

        devShell = with pkgs; mkShell {
          buildInputs = [ cargo rustc rustfmt pre-commit rustPackages.clippy ];
          RUST_SRC_PATH = rustPlatform.rustLibSrc;
        };

      }
    );
}
