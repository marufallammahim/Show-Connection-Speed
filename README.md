# Network Speed — GNOME Shell Extension

Shows live download (↓) and upload (↑) rates in the GNOME top panel, refreshing approximately once per second.

## Compatibility

`metadata.json` currently declares GNOME Shell 51. The extension uses GNOME Shell's modern ES module API and asynchronous Gio file reads. Other Shell versions should only be added to `shell-version` after testing on those versions.

## Install

Copy the `network-speed@marufallammahim.github.io` directory into `~/.local/share/gnome-shell/extensions/`, then log out and back in if required, and enable it in GNOME Extensions.

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r network-speed@marufallammahim.github.io ~/.local/share/gnome-shell/extensions/
gnome-extensions enable network-speed@marufallammahim.github.io
```

If an older copy of this extension uses a different UUID, disable and remove that old copy or keep its original UUID consistently in `metadata.json` and the installation directory.
