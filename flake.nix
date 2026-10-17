{
  description = "firefox-addon-live: drive a throwaway Firefox with your add-on loaded, for live tests and README captures";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # Everything a session needs: vanilla Firefox, a private X server, real
      # pointer input, screenshots and GIF encoding.
      tools = pkgs: with pkgs; [
        firefox
        imagemagick
        ffmpeg-full # x11grab, for recording GIFs
        fontconfig
        xdotool
        xorg-server # Xvfb
      ];

      # Points FIREFOX_BINARY at nixpkgs' Firefox and links this library into
      # the project as `.firefox-addon-live`, which package.json depends on as
      # "firefox-addon-live": "file:.firefox-addon-live". The flake input, not
      # npm, decides the version.
      shellHook = pkgs: ''
        export FIREFOX_BINARY=${pkgs.firefox}/bin/firefox
        firefox_addon_live_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
        ln -sfn ${self} "$firefox_addon_live_root/.firefox-addon-live"
        unset firefox_addon_live_root
      '';

      # A complete dev shell: Node 22, the tools above, and the link.
      devShell = { pkgs, packages ? [ ], shellHook ? "" }: pkgs.mkShell {
        packages = [ pkgs.nodejs_22 ] ++ tools pkgs ++ packages;
        shellHook = (self.lib.shellHook pkgs) + shellHook;
      };
    in
    {
      lib = { inherit tools shellHook devShell; };
    }
    // flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ] ++ tools pkgs;
          shellHook = ''
            export FIREFOX_BINARY=${pkgs.firefox}/bin/firefox
            echo "firefox-addon-live: npm install, then npm test / npm run test:live"
          '';
        };
      });
}
