{ bashInteractive,
dockerTools,
writeText,
writeShellScriptBin,
bash,
podman
} : 

let dockerImage = dockerTools.buildImage {
  name = "sandbox";
  tag = "latest";
  config = {
    Cmd = [ "${bashInteractive}/bin/bash" ];
  };
};

  defaultPolicyJson = writeText "policy.json" ''
    {
        "default": [
            {
                "type": "insecureAcceptAnything"
            }
        ]
    }
    '';
  defaultRegistriesConf = writeText "registries.conf" ''
    # Minimal registries.conf to satisfy Podman
    # No actual registries need to be defined for 'podman load'.
    unqualified-search-registries = []
  '';

in writeShellScriptBin "run-container-with-config" ''
#!${bash}/bin/bash
set -euo pipefail # Exit on error, unbound variable, or pipe failure

IMAGE_TAR_PATH="${dockerImage}" # Path to the built OCI image tarball
IMAGE_NAME_TAG="sandbox:latest" # Must match 'name' and 'tag' from buildImage
PODMAN_CMD="${podman}/bin/podman"
TEMP_STORAGE=$(mktemp -d)
trap 'chmod -R u+w "$TEMP_STORAGE" 2>/dev/null || true; rm -rf "$TEMP_STORAGE"' EXIT

IMAGE_TAR_PATH="${dockerImage}"
IMAGE_NAME_TAG="sandbox:latest" # Make sure this matches your ociImage name/tag

echo "Nix has built the OCI image at: $IMAGE_TAR_PATH"
echo "Attempting to load image into Podman..."

# Load the image into Podman.
$PODMAN_CMD --root "$TEMP_STORAGE" load \
  --signature-policy "${defaultPolicyJson}" \
  --registries-conf "${defaultRegistriesConf}" \
  -i "$IMAGE_TAR_PATH"

echo "Image '$IMAGE_NAME_TAG' loaded."
echo "Running container. You will enter an interactive shell. Type 'exit' to leave."

# Run the container interactively, removing it on exit
$PODMAN_CMD --root "$TEMP_STORAGE" run \
  --signature-policy "${defaultPolicyJson}" \
  --registries-conf "${defaultRegistriesConf}" \
  --rm \
  -it \
  "$IMAGE_NAME_TAG"
''
