# Example for --nix-packages-file
#
# You may return either:
# 1) a list of derivations, or
# 2) an attrset with `packages = [ ... ]`.
#
# The file may be a function receiving:
# - pkgs
# - callPackage

{ pkgs, callPackage }:

{
  packages = with pkgs; [
    ripgrep
    fd
    python3

    # Example of using callPackage for local derivations:
    # (callPackage ./nix/my-tool.nix { })
  ];
}
