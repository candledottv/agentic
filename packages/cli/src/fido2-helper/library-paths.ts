/**
 * Ember Phase 2 (BE-140, ED-11, BE-198): where `candle-fido2` looks for libfido2, and what it says
 * when it is not there. Pure, with no `bun:ffi` import, so the CLI side can share the install
 * instruction without pulling the FFI backend into a process that only needs the wording.
 *
 * **Every candidate is an absolute path, on both platforms.** An earlier revision put the bare
 * soname first (`libfido2.dylib`, `libfido2.so.1`) so the loader's own search would find whichever
 * copy the machine had. That search includes the current working directory, and the helper
 * inherits the CLI's, so a `libfido2.dylib` sitting in a cloned repo or a downloads folder was
 * loaded ahead of Homebrew's: code of the planter's choosing inside the one process that holds the
 * PIN and returns the `hmac-secret` output the vault key is unwrapped from (CWE-427). The
 * candidates below are therefore the install locations themselves, and nothing here is ever
 * resolved relative to where the operator happened to be standing. A machine whose libfido2 is
 * somewhere else is a typed `LIBRARY_MISSING` naming the install command, which is a refusal the
 * operator can act on, and never a path an attacker can occupy.
 */

/** Where the library is looked for, in order. Absolute paths only: see the note above. */
export function libraryCandidates(platform: string): string[] {
  if (platform === "darwin") {
    return [
      "/opt/homebrew/lib/libfido2.dylib",
      "/opt/homebrew/opt/libfido2/lib/libfido2.dylib",
      "/usr/local/lib/libfido2.dylib",
      "/usr/local/opt/libfido2/lib/libfido2.dylib",
    ]
  }
  return [
    "/usr/lib/x86_64-linux-gnu/libfido2.so.1",
    "/usr/lib/aarch64-linux-gnu/libfido2.so.1",
    "/usr/lib64/libfido2.so.1",
    "/usr/lib/libfido2.so.1",
    "/usr/local/lib/libfido2.so.1",
  ]
}

export function libraryInstallInstruction(platform: string): string {
  return platform === "darwin"
    ? "Install it with: brew install libfido2"
    : "Install your distribution's libfido2 package (Debian and Ubuntu: apt install libfido2-1; Fedora: dnf install libfido2; Arch: pacman -S libfido2)"
}

/**
 * The one human line for a machine without the library: what to install, then the short list of
 * places that were checked. Deliberately not the loader's own diagnostics, which ran to about 3 KB
 * of `tried:` lines for six candidates and told the operator nothing the install instruction does
 * not.
 */
export function libraryMissingMessage(platform: string, candidates = libraryCandidates(platform)): string {
  return `candle-fido2 could not load libfido2 on this machine. ${libraryInstallInstruction(platform)}. Checked: ${candidates.join(", ")}.`
}
